/**
 * CLI-side CodeGraph helper: best-effort snapshot indexing for the optional codegraph
 * reviewer tool. `ensureSnapshotIndex` runs `<bin> init <snapshotRoot>` before a reviewer
 * that wants CodeGraph assistance is launched, so the index covers exactly the frozen
 * snapshot tree every reviewer reads.
 *
 * Indexing is strictly best-effort: this module never throws for an indexing outcome.
 * Every failure mode maps to a `CodegraphIndexReason` and the caller degrades gracefully
 * (the reviewer runs without CodeGraph assistance). Only `node:` imports are needed.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type CodegraphIndexReason = 'disabled' | 'binary-missing' | 'index-timeout' | 'index-failed';

export interface CodegraphIndexStatus {
  available: boolean;
  reason?: CodegraphIndexReason;
}

const execFileAsync = promisify(execFile);

// Same generous buffer as snapshot.ts's GIT_MAX_BUFFER: index output must never be
// truncated by Node's default 1MB buffer.
const INDEX_MAX_BUFFER = 1024 * 1024 * 256;

const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * Resolves the CodeGraph binary: the `COUNCIL_CODEGRAPH_BIN` test seam wins (same tier
 * as `COUNCIL_PI_BIN` elsewhere in this package -- an isolation seam for a test process,
 * never documented as a CLI flag), otherwise the `codegraph` binary on `PATH`.
 */
export function resolveCodegraphBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.COUNCIL_CODEGRAPH_BIN ?? 'codegraph';
}

export interface EnsureSnapshotIndexOptions {
  bin?: string;
  enabled?: boolean;
  timeoutSeconds?: number;
}

/**
 * Runs `bin init <snapshotRoot>` and reports whether the index is available. Never
 * throws for an indexing outcome: a missing binary, a timeout, and any other failure
 * (nonzero exit, signal, unexpected error) each map to a `reason` string. `enabled:
 * false` short-circuits to `disabled` without spawning anything.
 */
export async function ensureSnapshotIndex(
  snapshotRoot: string,
  opts: EnsureSnapshotIndexOptions = {},
): Promise<CodegraphIndexStatus> {
  if (opts.enabled === false) {
    return { available: false, reason: 'disabled' };
  }
  const bin = opts.bin ?? resolveCodegraphBin();
  const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  try {
    await execFileAsync(bin, ['init', snapshotRoot], {
      timeout: timeoutSeconds * 1000,
      maxBuffer: INDEX_MAX_BUFFER,
    });
    return { available: true };
  } catch (err) {
    if (isEnoent(err)) {
      return { available: false, reason: 'binary-missing' };
    }
    if (isTimeout(err)) {
      return { available: false, reason: 'index-timeout' };
    }
    return { available: false, reason: 'index-failed' };
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

function isTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { killed?: unknown }).killed === true;
}
