/**
 * Centralized Pi host self-update check, run once at the start of each review run.
 *
 * Reviewer agents must never update the host themselves: N parallel reviewers racing a
 * self-update of the binary they are running from is both redundant and hazardous. So the
 * CLI process performs exactly one check, before any reviewer launches, via `pi update
 * --self` -- self only, never `--all`, `--extensions`, or a named extension source.
 * Extension upgrades are deliberately out of scope.
 *
 * The check is best-effort by contract: `ensurePiCurrent` never rejects. Any failure (a
 * missing binary, a timeout, an unparseable version, a failed update) degrades to a
 * `failed` result and the run proceeds with the host as-is. Whether an update actually
 * happened is determined by comparing `pi --version` before and after, never by parsing
 * `pi update`'s human-readable stdout, which is not a stable interface.
 *
 * Skipped entirely (no subprocess spawned) when `COUNCIL_NO_PI_UPDATE=1` is set -- the
 * explicit opt-out, following this package's `COUNCIL_*` seam conventions -- or when
 * `PI_OFFLINE=1` is set, since an update check is a network operation and offline means
 * offline. Otherwise the host binary is resolved exactly as everywhere else in this
 * package: `$COUNCIL_PI_BIN` when set, else `pi` on `PATH`.
 */
import { spawn } from 'node:child_process';

import { resolveHostBin } from './reviewer-spawn.js';

/** Set to `'1'` to skip the start-of-run Pi self-update check entirely. */
export const PI_UPDATE_OPTOUT_VAR = 'COUNCIL_NO_PI_UPDATE';

/** Pi's own offline flag (`pi --help`: `--offline` is the same as `PI_OFFLINE=1`). */
export const PI_OFFLINE_VAR = 'PI_OFFLINE';

/**
 * The self-update argument vector. Pinned as a constant so the "self only, never
 * extensions" scope has exactly one spelling to audit: `pi update` already defaults to
 * self-only, and the explicit `--self` keeps it self-only even if that default ever
 * changes. There is deliberately no spelling here for `--all`, `--extensions`,
 * `--models`, or a named extension source.
 */
export const PI_SELF_UPDATE_ARGS: readonly ['update', '--self'] = ['update', '--self'];

export const PI_VERSION_ARGS: readonly ['--version'] = ['--version'];

/** `pi --version` prints a bare version and touches no network; 15s matches the host-command timeout in `providers.ts`. */
export const PI_VERSION_TIMEOUT_MS = 15_000;

/** A self-update downloads and reinstalls the host; allow it three minutes before giving up. */
export const PI_UPDATE_TIMEOUT_MS = 180_000;

export type PiUpdateStatus =
  /** An update was applied: `previousVersion` differs from `currentVersion`. */
  | 'updated'
  /** The check ran and no update was needed. */
  | 'already-latest'
  /** Deliberately not checked (opt-out or offline); no subprocess was spawned. */
  | 'skipped'
  /** Attempted but inconclusive; the run should proceed with the host as-is. */
  | 'failed';

export interface PiUpdateResult {
  status: PiUpdateStatus;
  /** Version before the update attempt; null when it could not be determined. */
  previousVersion: string | null;
  /** Best-known version after the check: the post-update version when known, else the pre-update one, else null. */
  currentVersion: string | null;
  /** Short machine-readable reason for `skipped`/`failed`; null otherwise. */
  reason: string | null;
}

export interface PiUpdateOptions {
  /** Host binary override; defaults to `$COUNCIL_PI_BIN ?? 'pi'`, like every other host-spawning module. */
  piBin?: string;
  /** Environment to read the opt-out/offline flags and `COUNCIL_PI_BIN` from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Per-call timeout overrides, principally a test seam. */
  versionTimeoutMs?: number;
  updateTimeoutMs?: number;
}

/**
 * Extracts a bare `X.Y.Z` version (optional leading `v`, optional pre-release/build
 * suffix) from `pi --version` output: the first line that is nothing but a version.
 * Line-anchored rather than a substring search, so extension banners or other chatter on
 * adjacent lines cannot corrupt the parse -- and so a JSON event stream (what a test
 * double replays when it does not model `--version`) never yields a false version.
 */
export function parsePiVersion(output: string): string | null {
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/);
    if (match) return match[1]!;
  }
  return null;
}

type CommandOutcome =
  { ok: true; stdout: string } | { ok: false; reason: 'spawn-failed' | 'timeout' | 'exit-nonzero' };

/**
 * Runs one host command to completion, capturing stdout. Stderr is discarded: version
 * output lives on stdout, and update chatter is human-readable prose with no stable shape
 * worth parsing. Never rejects -- spawn failure, timeout, and non-zero exit all resolve
 * to a reasoned `ok: false`.
 */
function runCommand(
  bin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ ok: false, reason: 'spawn-failed' });
      return;
    }

    let stdout = '';
    let settled = false;
    const settle = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    // A runaway timer must never hold the CLI process open on its own.
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.on('error', () => {
      settle({ ok: false, reason: 'spawn-failed' });
    });

    child.on('close', (code) => {
      settle(code === 0 ? { ok: true, stdout } : { ok: false, reason: 'exit-nonzero' });
    });
  });
}

/**
 * Ensures the Pi host is current: read its version, run the self-only update, read the
 * version again. Never rejects -- every operational failure resolves to a `failed`
 * result naming its reason, so the one call site needs no error handling of its own.
 */
export async function ensurePiCurrent(opts: PiUpdateOptions = {}): Promise<PiUpdateResult> {
  try {
    return await ensurePiCurrentInner(opts);
  } catch {
    return { status: 'failed', previousVersion: null, currentVersion: null, reason: 'unexpected' };
  }
}

async function ensurePiCurrentInner(opts: PiUpdateOptions): Promise<PiUpdateResult> {
  const env = opts.env ?? process.env;
  if (env[PI_UPDATE_OPTOUT_VAR] === '1') {
    return { status: 'skipped', previousVersion: null, currentVersion: null, reason: 'opted-out' };
  }
  if (env[PI_OFFLINE_VAR] === '1') {
    return { status: 'skipped', previousVersion: null, currentVersion: null, reason: 'offline' };
  }

  const bin = opts.piBin ?? resolveHostBin(env);
  const versionTimeoutMs = opts.versionTimeoutMs ?? PI_VERSION_TIMEOUT_MS;
  const updateTimeoutMs = opts.updateTimeoutMs ?? PI_UPDATE_TIMEOUT_MS;

  const pre = await runCommand(bin, PI_VERSION_ARGS, versionTimeoutMs);
  if (!pre.ok) {
    const reason =
      pre.reason === 'timeout'
        ? 'version-timeout'
        : pre.reason === 'spawn-failed'
          ? 'spawn-failed'
          : 'version-exit-nonzero';
    return { status: 'failed', previousVersion: null, currentVersion: null, reason };
  }
  const previousVersion = parsePiVersion(pre.stdout);
  if (previousVersion === null) {
    // No verified starting version, so no update is attempted: without a before/after
    // comparison there is no way to tell what an update did, and a binary that does not
    // answer `--version` with a version is not one to mutate blindly.
    return {
      status: 'failed',
      previousVersion: null,
      currentVersion: null,
      reason: 'version-unparseable',
    };
  }

  const update = await runCommand(bin, PI_SELF_UPDATE_ARGS, updateTimeoutMs);
  if (!update.ok) {
    const reason =
      update.reason === 'timeout'
        ? 'update-timeout'
        : update.reason === 'spawn-failed'
          ? 'update-spawn-failed'
          : 'update-exit-nonzero';
    return { status: 'failed', previousVersion, currentVersion: previousVersion, reason };
  }

  const post = await runCommand(bin, PI_VERSION_ARGS, versionTimeoutMs);
  if (!post.ok) {
    return {
      status: 'failed',
      previousVersion,
      currentVersion: previousVersion,
      reason: 'post-version-unknown',
    };
  }
  const currentVersion = parsePiVersion(post.stdout);
  if (currentVersion === null) {
    return {
      status: 'failed',
      previousVersion,
      currentVersion: previousVersion,
      reason: 'post-version-unparseable',
    };
  }

  if (currentVersion !== previousVersion) {
    return { status: 'updated', previousVersion, currentVersion, reason: null };
  }
  return { status: 'already-latest', previousVersion, currentVersion, reason: null };
}
