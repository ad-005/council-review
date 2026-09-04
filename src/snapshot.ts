/**
 * Builds the frozen review tree: a plain copy into a scratch directory, made non-writable before
 * any reviewer is launched. See `specs/council-review/review-target/spec.md` (the requirements
 * from "The patch is a run artifact, not snapshot content" onward) and `design.md`'s "A copied
 * snapshot, not a git worktree and not the live tree" for why this exists and what it does and
 * does not guarantee.
 *
 * Three builders, selected by `ResolvedScope.mode`, all producing the *whole* reviewed tree (not
 * just the diffed files) so a reviewer has surrounding context — narrowing (path globs, the
 * configured include list) is applied afterward, with the invariant that every file the patch
 * touches survives narrowing regardless:
 *
 *   - worktree: tracked files plus untracked-not-ignored files, copied from disk as they exist
 *     at run start. The candidate list comes from git's own listing (`git ls-files -c -o
 *     --exclude-standard`), which is what makes ignored-path exclusion structural rather than a
 *     deny rule this module would have to maintain.
 *   - staged: the index, materialised exactly, via `git show :<path>` per file -- the index's
 *     stage-0 blob, never the working-tree content.
 *   - range / revision: the tree at the range's end revision, via `git show <rev>:<path>` per
 *     file.
 *
 * No git worktree is ever created, and nothing here mutates the real repository's index, HEAD,
 * refs or working tree -- every git invocation is read-only plumbing, run with argument arrays,
 * never a shell string.
 *
 * Freezing (`chmod a-w`, recursive) is stated plainly in `design.md` as *not* a security boundary
 * against a same-user process -- the read-only guarantee comes from the reviewer's tool surface
 * (Section 9), not from permission bits. Freezing exists so that every reviewer reads one
 * immutable photograph and line numbers mean the same thing to all of them and to the merge step.
 */
import { execFile } from 'node:child_process';
import { chmodSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, copyFile, lstat, readlink, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import picomatch from 'picomatch';
import type { ResolvedScope } from './scope.js';

export interface SnapshotIdentity {
  head: string;
  dirty: boolean;
  treeHash: string;
}

export interface Snapshot {
  root: string; // frozen scratch dir
  files: string[]; // snapshot-relative paths present
  identity: SnapshotIdentity;
  cleanup(): void; // restores write bits, removes the dir; idempotent
}

export class SnapshotError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// Fixed scratch name prefix under the OS temp dir, so `sweepOrphans` can identify snapshots left
// behind by a run that died before it could clean up after itself.
export const SNAPSHOT_PREFIX = 'council-review-snapshot-';

/**
 * Resolves the scratch base directory: an explicit `scratchDir` wins, then the
 * `COUNCIL_SNAPSHOT_SCRATCH_DIR` test seam (same tier as `COUNCIL_PI_BIN` elsewhere in this
 * package -- an isolation seam for a test process, never documented as a CLI flag or otherwise
 * user-facing), then `os.tmpdir()`. `cli.ts` never sets either the option or the environment
 * variable, so production behaviour is exactly `os.tmpdir()` -- unaffected by this seam existing.
 * Reading the seam here (rather than only accepting it as a function parameter) is what lets a
 * caller that goes through `cli.ts`'s own unmodified `buildSnapshot`/`sweepOrphans` call sites
 * (e.g. a CLI-level test) still isolate itself, purely by setting the variable for the duration
 * of one test -- the same mechanism `providers.ts`'s `resolvePiBin` and `reviewer-spawn.ts`'s
 * `resolveHostBin` already use for their own binaries.
 */
function resolveScratchDir(scratchDir: string | undefined): string {
  return scratchDir ?? process.env.COUNCIL_SNAPSHOT_SCRATCH_DIR ?? tmpdir();
}

// Liveness marker written at the top of every snapshot root (never inside the reviewed tree
// proper -- it is written directly into `root`, not through `narrowed`/`files`), read only by
// `sweepOrphans` across process boundaries. Written before `freezeTree`, since the root is
// non-writable afterward.
const LIVENESS_MARKER = '.council-run.pid';

const execFileAsync = promisify(execFile);

// A single `git show <rev>:<path>` call must not be truncated by Node's default 1MB buffer.
const GIT_MAX_BUFFER = 1024 * 1024 * 256;

// ---------------------------------------------------------------------------------------------
// Process-wide registry: cleanup on normal exit and on a terminating signal is a safety net on
// top of the caller calling `cleanup()` itself in the ordinary success/failure path.
// ---------------------------------------------------------------------------------------------

const activeCleanups = new Set<() => void>();
let processHandlersInstalled = false;

function installProcessHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;

  const cleanupAll = (): void => {
    for (const fn of [...activeCleanups]) {
      try {
        fn();
      } catch {
        // Best-effort: a signal or exit handler must not throw.
      }
    }
  };

  // 'exit' handlers may only do synchronous work, which is exactly what `cleanup()` does.
  process.once('exit', cleanupAll);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      cleanupAll();
      // Registering our own listener suppresses Node's default terminate-on-signal behaviour,
      // so it must be restored explicitly once cleanup has run.
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * `opts.handleSignals` (default `true`) controls whether this snapshot participates in the
 * process-wide `SIGINT`/`SIGTERM` safety net below: that net calls `process.exit()` synchronously
 * once its own cleanup has run, which a caller that manages signals itself (to report an
 * interruption, or to let other in-flight work wind down before exiting) cannot race against and
 * win. Pass `handleSignals: false` for that caller; its own equivalent of `cleanup()` in a
 * `finally` block remains the sole cleanup path, and `cleanup()` staying idempotent means calling
 * it from both places is still safe if a caller ever does both.
 *
 * `opts.scratchDir` (default: see `resolveScratchDir`) is the directory `SNAPSHOT_PREFIX`-named
 * scratch directories are created under. Production code never needs it; it exists so a test can
 * isolate its own snapshots from the shared OS temp directory, where a concurrently-running,
 * unrelated test enumerating that same directory would otherwise see them too.
 */
export async function buildSnapshot(
  repoRoot: string,
  scope: ResolvedScope,
  opts: { include?: string[]; handleSignals?: boolean; scratchDir?: string } = {},
): Promise<Snapshot> {
  const handleSignals = opts.handleSignals ?? true;
  const scratchBase = resolveScratchDir(opts.scratchDir);
  const root = await mkdtemp(join(scratchBase, SNAPSHOT_PREFIX));

  try {
    const candidates = await listCandidates(repoRoot, scope);
    const narrowed = narrowCandidates(candidates, scope.selectors.paths, opts.include, scope.files);

    if (scope.mode === 'worktree') {
      await materializeWorktree(repoRoot, root, narrowed);
    } else if (scope.mode === 'staged') {
      await materializeFromGit(repoRoot, root, narrowed, ':');
    } else {
      // 'range' | 'revision': resolveScope guarantees endRevision is set for both.
      await materializeFromGit(repoRoot, root, narrowed, `${scope.endRevision}:`);
    }

    const treeHash = computeTreeHash(root, narrowed);

    // Liveness marker for `sweepOrphans` (see its own comment): written before the freeze, since
    // `root` is non-writable afterward, and never added to `narrowed`/`files` -- it lives at the
    // top of the scratch directory, not inside the reviewed tree.
    writeFileSync(join(root, LIVENESS_MARKER), String(process.pid), 'utf8');

    // Freeze last, immediately before this snapshot becomes visible to any caller -- nothing
    // after this point may write into the tree.
    freezeTree(root);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      activeCleanups.delete(cleanup);
      forceRemove(root); // recursive removal takes the liveness marker with it
    };

    if (handleSignals) {
      installProcessHandlers();
      activeCleanups.add(cleanup);
    }

    return {
      root,
      files: [...narrowed].sort(),
      identity: { head: scope.head, dirty: scope.dirty, treeHash },
      cleanup,
    };
  } catch (err) {
    // Abort-before-launch: whatever was built (or half-built) must not survive a failed build.
    forceRemove(root);
    if (err instanceof SnapshotError) throw err;
    throw new SnapshotError(`failed to build snapshot: ${errorMessage(err)}`);
  }
}

/**
 * Writes the resolved scope's patch into `destDir` (the run directory, created by Section 15 --
 * this function never creates it) and returns the written path. The patch is deliberately never
 * written into a snapshot: this function has no snapshot-shaped parameter to write into, and the
 * only path it ever touches is the one it is given.
 */
export function writePatch(destDir: string, scope: ResolvedScope): string {
  const dest = join(destDir, 'patch.diff');
  writeFileSync(dest, scope.patch, 'utf8');
  return dest;
}

/**
 * Reads a snapshot root's liveness marker and returns the PID it names, or `null` when the
 * marker is absent, unreadable, or does not parse as a positive integer -- any of which makes the
 * snapshot's root itself the orphan signal instead.
 */
function readLivenessPid(root: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(join(root, LIVENESS_MARKER), 'utf8').trim();
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Whether `pid` names a still-running process, using `process.kill(pid, 0)` -- the standard
 * liveness probe, which sends no signal. `ESRCH` means the process is gone; `EPERM` means it
 * exists but is owned by someone else, which still counts as alive (a snapshot's owning process
 * can only ever be this same user in practice, but the probe cannot special-case that, so `EPERM`
 * is read the same way a `kill -0` check would be).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes snapshot directories under `scratchDir` (default: see `resolveScratchDir`, matching
 * `buildSnapshot`'s own default so orphans it left behind are found in the same place) matching
 * `SNAPSHOT_PREFIX` that are not named in `activeRoots` and are not still owned by a live process
 * (per each snapshot's own liveness marker) -- this is what protects a run in progress in a
 * *different* process, since `activeRoots` alone only ever names snapshots this process itself is
 * holding. A snapshot with no marker, an unreadable one, or a dead PID is an orphan and is
 * removed exactly as before. Best-effort per entry: a directory this process cannot inspect or
 * remove is skipped rather than aborting the whole sweep.
 */
export function sweepOrphans(
  activeRoots: readonly string[],
  scratchDir?: string,
): { removed: number } {
  const scratchBase = resolveScratchDir(scratchDir);
  const active = new Set(activeRoots.map((r) => resolvePath(r)));
  let removed = 0;

  let entries: string[];
  try {
    entries = readdirSync(scratchBase);
  } catch {
    return { removed: 0 };
  }

  for (const entry of entries) {
    if (!entry.startsWith(SNAPSHOT_PREFIX)) continue;
    const full = join(scratchBase, entry);
    if (active.has(resolvePath(full))) continue;

    try {
      const st = lstatSync(full);
      if (!st.isDirectory()) continue;

      const pid = readLivenessPid(full);
      if (pid !== null && isPidAlive(pid)) continue; // still owned by a live process elsewhere

      forceRemove(full);
      removed += 1;
    } catch {
      // Best-effort sweep: leave anything we can't inspect or remove for a later sweep.
    }
  }

  return { removed };
}

// ---------------------------------------------------------------------------------------------
// Candidate listing
// ---------------------------------------------------------------------------------------------

async function listCandidates(repoRoot: string, scope: ResolvedScope): Promise<string[]> {
  if (scope.mode === 'worktree') {
    // Tracked (-c) plus untracked-not-ignored (-o --exclude-standard): the same structural
    // exclusion the design calls for, derived from git's own listing rather than a deny rule.
    return listNulSeparated(repoRoot, ['ls-files', '-z', '-c', '-o', '--exclude-standard']);
  }
  if (scope.mode === 'staged') {
    // No options: `ls-files` defaults to the cached (indexed) listing -- every path git currently
    // considers staged, deletions-from-worktree included, since we read from the index, not disk.
    return listNulSeparated(repoRoot, ['ls-files', '-z']);
  }
  // 'range' | 'revision'
  return listNulSeparated(repoRoot, [
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    scope.endRevision as string,
  ]);
}

async function listNulSeparated(repoRoot: string, args: string[]): Promise<string[]> {
  const out = await runGit(repoRoot, args);
  return out.split('\0').filter((s) => s.length > 0);
}

/**
 * Combines the scope's own path globs and the configured include list as two independent
 * narrowing filters (a candidate must match both, when both are given), then force-includes
 * every patch file that exists among the candidates regardless of whether it matched -- this is
 * what makes narrowing never omit a file the patch touches. A patch file absent from the
 * candidate list (e.g. a file the diff deletes) has nothing to copy and is not forced; there is
 * no content for it in the end-state tree the snapshot depicts.
 */
function narrowCandidates(
  candidates: string[],
  selectorGlobs: string[] | undefined,
  includeGlobs: string[] | undefined,
  patchFiles: readonly string[],
): string[] {
  const candidateSet = new Set(candidates);
  const forced = patchFiles.filter((f) => candidateSet.has(f));

  let filtered = candidates;
  if (selectorGlobs && selectorGlobs.length > 0) {
    const isMatch = picomatch(selectorGlobs);
    filtered = filtered.filter((f) => isMatch(f));
  }
  if (includeGlobs && includeGlobs.length > 0) {
    const isMatch = picomatch(includeGlobs);
    filtered = filtered.filter((f) => isMatch(f));
  }

  return [...new Set([...filtered, ...forced])].sort();
}

// ---------------------------------------------------------------------------------------------
// Materialisation
// ---------------------------------------------------------------------------------------------

/**
 * Copies from the real working tree. A tracked-but-deleted-on-disk path (an unstaged delete)
 * is skipped rather than failing the build: it has no content to snapshot, and the patch itself
 * already records the deletion.
 *
 * A symlink is stored the same way git itself would store it -- as a regular file whose content
 * is the link target text -- rather than dereferenced, so that all three builders agree on what
 * "the content of a symlink path" means (`git show` on a tracked symlink returns exactly this;
 * the working tree has no other analogue available without picking one arbitrarily).
 */
async function materializeWorktree(repoRoot: string, root: string, files: string[]): Promise<void> {
  for (const f of files) {
    const src = join(repoRoot, f);
    const dest = join(root, f);
    await mkdir(dirname(dest), { recursive: true });

    let st;
    try {
      st = await lstat(src);
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }

    if (st.isSymbolicLink()) {
      const target = await readlink(src);
      await writeFile(dest, target, 'utf8');
      continue;
    }

    try {
      await copyFile(src, dest);
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }
  }
}

/** Materialises from git plumbing (`git show <refPrefix><path>`): `:` for the index (staged),
 *  or `<rev>:` for a range/revision's end tree. */
async function materializeFromGit(
  repoRoot: string,
  root: string,
  files: string[],
  refPrefix: string,
): Promise<void> {
  for (const f of files) {
    const dest = join(root, f);
    await mkdir(dirname(dest), { recursive: true });
    const content = await execFileBuffer(repoRoot, ['show', `${refPrefix}${f}`]);
    await writeFile(dest, content);
  }
}

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

/**
 * Hashes the sorted set of (path, content-hash) pairs actually present in the snapshot, so two
 * runs reviewing byte-identical file sets record equal hashes regardless of copy order, and any
 * changed file's content changes the result. Paths are separated from their hash by a NUL byte
 * and pairs by a newline, so no path or hash value can forge a collision by shifting the split
 * point.
 */
function computeTreeHash(root: string, files: readonly string[]): string {
  const combined = createHash('sha256');
  for (const f of [...files].sort()) {
    const fileHash = createHash('sha256');
    fileHash.update(readFileSync(join(root, f)));
    combined.update(`${f}\0${fileHash.digest('hex')}\n`);
  }
  return combined.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Freeze / cleanup
// ---------------------------------------------------------------------------------------------

/** Recursively clears the write bit on every file and directory under `root`, `root` included.
 *  Order does not matter for this direction: `chmod` is permitted by ownership of the target
 *  itself, not by write access to its containing directory. */
function freezeTree(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return; // never produced by the builders above, but guarded regardless
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      freezeTree(join(path, entry));
    }
  }
  chmodSync(path, st.mode & ~0o222);
}

/** Restores the write bit top-down (directories before their contents) so that removal never
 *  meets a directory it lacks permission to modify, then removes the tree. Idempotent: a path
 *  that no longer exists is treated as already clean. */
function forceRemove(root: string): void {
  try {
    restoreWritableTopDown(root);
  } catch {
    // If restoring permissions failed partway (or root never existed), still attempt removal --
    // `rm -rf`-equivalent force below tolerates a mix of writable and non-writable entries built
    // by the same user.
  }
  rmSync(root, { recursive: true, force: true });
}

function restoreWritableTopDown(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return; // already gone
  }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    chmodSync(path, st.mode | 0o700);
    for (const entry of readdirSync(path)) {
      restoreWritableTopDown(join(path, entry));
    }
  } else {
    chmodSync(path, st.mode | 0o200);
  }
}

// ---------------------------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------------------------

async function runGit(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoRoot,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    throw new SnapshotError(`git ${args.join(' ')} failed: ${errorMessage(err)}`);
  }
}

function execFileBuffer(repoRoot: string, args: string[]): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      { cwd: repoRoot, maxBuffer: GIT_MAX_BUFFER, encoding: 'buffer' },
      (err, stdout) => {
        if (err) {
          reject(new SnapshotError(`git ${args.join(' ')} failed: ${errorMessage(err)}`));
        } else {
          resolvePromise(stdout as unknown as Buffer);
        }
      },
    );
  });
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      return stderr.trim();
    }
    if (Buffer.isBuffer(stderr) && stderr.length > 0) {
      return stderr.toString('utf8').trim();
    }
  }
  return err instanceof Error ? err.message : String(err);
}
