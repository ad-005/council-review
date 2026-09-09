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
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** Index layout the real binary produces inside the indexed root: `<root>/.codegraph/codegraph.db`.
 *  The reviewer-side gate in `reviewer-tools.ts` probes this same path (it cannot import this
 *  module -- the extension may only import `node:` builtins -- so the literal is duplicated
 *  there); `snapshot.ts` imports these constants so the CLI side agrees by construction. */
export const CODEGRAPH_INDEX_DIR = '.codegraph';
export const CODEGRAPH_DB_NAME = 'codegraph.db';

export function codegraphDbPath(snapshotRoot: string): string {
  return join(snapshotRoot, CODEGRAPH_INDEX_DIR, CODEGRAPH_DB_NAME);
}

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
 *
 * Exit 0 alone is not enough for `available: true`: the artifact itself
 * (`<snapshotRoot>/.codegraph/codegraph.db`, the same marker the reviewer-side gate
 * probes) must exist, so the manifest can never claim an index every reviewer call
 * then fails to find.
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
      // SIGKILL, not the default SIGTERM: a timed-out indexer must actually be dead before
      // the caller freezes the tree and reviewers start querying it -- a child that ignores
      // SIGTERM (or one whose workers outlive it) would otherwise keep mutating the index
      // mid-review. Grandchildren that double-fork past even this are out of reach of any
      // kill signal without process-group tracking; the failure-path cleanup in
      // `buildSnapshot` removes whatever they might still be writing to.
      killSignal: 'SIGKILL',
    });
    if (!hasIndexArtifact(snapshotRoot)) {
      return { available: false, reason: 'index-failed' };
    }
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

function hasIndexArtifact(snapshotRoot: string): boolean {
  try {
    return statSync(codegraphDbPath(snapshotRoot)).isFile();
  } catch {
    return false;
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

function isTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { killed?: unknown }).killed === true;
}
