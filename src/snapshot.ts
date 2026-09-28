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
 *     deny rule this module would have to maintain. Paths with no file content on disk
 *     (unstaged deletions, submodule checkouts, paths beyond a symlinked directory) are skipped.
 *   - staged: the index, materialised exactly -- each stage-0 blob listed by `git ls-files -s`,
 *     never the working-tree content.
 *   - range / revision: the tree at the range's end revision, listed by `git ls-tree -r`.
 *
 *   Both git-sourced builders skip gitlinks and fetch every blob by sha through one
 *   `git cat-file --batch` process. `Snapshot.files` and the tree hash cover exactly the paths
 *   written.
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
import { execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, copyFile, lstat, readlink, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import picomatch from 'picomatch';
import type { ResolvedScope } from './scope.js';
import type { CodegraphConfig } from './config.js';
import {
  CODEGRAPH_INDEX_DIR,
  ensureSnapshotIndex,
  resolveCodegraphBin,
  type CodegraphIndexStatus,
} from './codegraph.js';

export interface SnapshotIdentity {
  head: string;
  dirty: boolean;
  treeHash: string;
}

export interface Snapshot {
  root: string; // frozen scratch dir
  files: string[]; // snapshot-relative paths present
  identity: SnapshotIdentity;
  codegraph: CodegraphIndexStatus; // per-run index build outcome (never fails the build)
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

// A whole-tree listing (`ls-files` / `ls-tree`) must not be truncated by Node's default 1MB
// buffer. Blob content never goes through this limit: it is streamed (see `readBlobs`).
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
 *
 * `opts.codegraph` (default: disabled) controls the per-run CodeGraph index build: when enabled,
 * the snapshot is indexed after materialisation and before the freeze, so reviewers query the
 * exact tree under review. The default is deliberately *disabled* at this level (callers pass
 * their own resolved config through; `cli.ts` passes the enabled-by-default user config), which
 * keeps unit tests deterministic without the binary. Indexing never fails the build: any failure
 * is reported on the returned snapshot's `codegraph` status and reviewers fall back to grep/read.
 */
export async function buildSnapshot(
  repoRoot: string,
  scope: ResolvedScope,
  opts: {
    include?: string[];
    handleSignals?: boolean;
    scratchDir?: string;
    codegraph?: CodegraphConfig;
  } = {},
): Promise<Snapshot> {
  const handleSignals = opts.handleSignals ?? true;
  const scratchBase = resolveScratchDir(opts.scratchDir);
  const root = await mkdtemp(join(scratchBase, SNAPSHOT_PREFIX));

  try {
    // Liveness marker for `sweepOrphans` (see its own comment): written first, while the
    // root is still trivially writable, so a `gc` in another process never classifies this
    // in-progress build as an orphan during the materialisation and indexing steps below
    // (indexing alone can take up to `indexTimeoutSeconds`). Never added to
    // `narrowed`/`files` -- it lives at the top of the scratch directory, not inside the
    // reviewed tree.
    writeFileSync(join(root, LIVENESS_MARKER), String(process.pid), 'utf8');

    // Worktree candidates come from disk; the git-sourced modes list blob entries (path -> sha),
    // which is what lets them skip gitlinks and fetch content by object id, never by a
    // `<rev>:<path>` spec a file name could be misparsed inside.
    const blobs = scope.mode === 'worktree' ? null : await listBlobs(repoRoot, scope);
    const candidates = blobs ? [...blobs.keys()] : await listWorktreeCandidates(repoRoot);
    // The CLI-built index owns `<root>/.codegraph/`: a `.codegraph/` path coming from the
    // reviewed tree (tracked, or untracked-but-not-ignored) is dropped here -- after
    // narrowing, so even a patch file touching that directory cannot force it back in --
    // and is therefore never materialised, hashed, or mistaken for this run's own index by
    // the reviewer-side gate. Without this, a repo-supplied `codegraph.db` would be queried
    // as authoritative even with indexing disabled or failed.
    const narrowed = narrowCandidates(
      candidates,
      scope.selectors.paths,
      opts.include,
      scope.files,
    ).filter((f) => f !== CODEGRAPH_INDEX_DIR && !f.startsWith(`${CODEGRAPH_INDEX_DIR}/`));

    // Only what was actually written is hashed and exposed as `files`: a narrowed path with no
    // content to copy (an unstaged deletion, a submodule, a path beyond a symlink) is absent.
    const written = blobs
      ? await materializeBlobs(repoRoot, root, narrowed, blobs)
      : await materializeWorktree(repoRoot, root, narrowed);

    // Index after materialisation, before the freeze: the index must cover exactly the
    // files above, and the freeze that follows would deny the indexer its own writes. Never
    // throws for an indexing outcome -- a missing/slow/broken binary degrades to grep/read.
    const codegraph = await ensureSnapshotIndex(root, {
      bin: resolveCodegraphBin(),
      enabled: opts.codegraph?.enabled ?? false,
      timeoutSeconds: opts.codegraph?.indexTimeoutSeconds,
    });

    // A failed, timed-out, or skipped index build must leave no trace: a partial
    // `codegraph.db` would otherwise satisfy the reviewer-side existence gate and be queried
    // as a complete index, with nothing marking its results as incomplete. Removed while the
    // tree is still writable (the freeze below would require a restore-then-remove dance),
    // so after this point the directory's presence means a good index by construction.
    if (!codegraph.available) {
      removeCodegraphDir(root);
    }

    const treeHash = computeTreeHash(root, written);

    // Freeze last, immediately before this snapshot becomes visible to any caller -- nothing
    // after this point may write into the tree, except the read-only-queryable index dir below.
    freezeTree(root);

    // The CodeGraph SQLite index requires write access even for reads (verified by probe:
    // queries on a fully frozen tree fail with `attempt to write a readonly database`). Restore
    // write bits on the index directory only, and only when the build above succeeded --
    // every reviewed source file stays frozen. Freezing was never a same-user security
    // boundary (see the module header) -- the read-only guarantee comes from the tool surface.
    if (codegraph.available) {
      restoreCodegraphWritable(root);
    }

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
      files: [...written].sort(),
      identity: { head: scope.head, dirty: scope.dirty, treeHash },
      codegraph,
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

async function listWorktreeCandidates(repoRoot: string): Promise<string[]> {
  // Tracked (-c) plus untracked-not-ignored (-o --exclude-standard): the same structural
  // exclusion the design calls for, derived from git's own listing rather than a deny rule.
  return listNulSeparated(repoRoot, ['ls-files', '-z', '-c', '-o', '--exclude-standard']);
}

// A gitlink (submodule commit pointer): no content of its own in this repository to snapshot.
const GITLINK_MODE = '160000';

/**
 * Lists the blob entries of the index (staged) or of the end revision's tree (range/revision) as
 * path -> blob sha, in git's own order. Gitlinks are dropped, and for the index only stage-0
 * entries count: an unmerged path has no single staged content, exactly as `git show :<path>`
 * would refuse it.
 */
async function listBlobs(repoRoot: string, scope: ResolvedScope): Promise<Map<string, string>> {
  const blobs = new Map<string, string>();
  if (scope.mode === 'staged') {
    // `<mode> SP <sha> SP <stage> TAB <path>`, deletions-from-worktree included, since we read
    // from the index, not disk.
    for (const entry of await listNulSeparated(repoRoot, ['ls-files', '-s', '-z'])) {
      const tab = entry.indexOf('\t');
      const [mode, sha, stage] = entry.slice(0, tab).split(' ');
      if (mode !== GITLINK_MODE && stage === '0') blobs.set(entry.slice(tab + 1), sha as string);
    }
    return blobs;
  }
  // 'range' | 'revision' -- `<mode> SP <type> SP <sha> TAB <path>`; resolveScope guarantees
  // endRevision is set for both.
  for (const entry of await listNulSeparated(repoRoot, [
    'ls-tree',
    '-r',
    '-z',
    scope.endRevision as string,
  ])) {
    const tab = entry.indexOf('\t');
    const [mode, type, sha] = entry.slice(0, tab).split(' ');
    if (mode !== GITLINK_MODE && type === 'blob') blobs.set(entry.slice(tab + 1), sha as string);
  }
  return blobs;
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
 * Copies from the real working tree and returns the paths actually written. A path with no file
 * content to snapshot is skipped rather than failing the build, and is absent from the result:
 * a tracked-but-deleted-on-disk path (an unstaged delete -- the patch itself already records the
 * deletion), a directory (a submodule checkout listed by `ls-files -c`, or an untracked embedded
 * repository `ls-files -o` names with a trailing `/`), or any other non-regular file.
 *
 * A path whose parent directories are not all real directories inside `repoRoot` -- one reached
 * through a symlinked directory -- is skipped too, which is what keeps a tracked `conf/app.yml`
 * from being copied out of `~/secrets` once `conf/` is replaced by a symlink there. This is
 * git's own rule (a path "beyond a symbolic link" counts as deleted), so the snapshot agrees
 * with the patch, which records exactly that deletion.
 *
 * A symlink is stored the same way git itself would store it -- as a regular file whose content
 * is the link target text -- rather than dereferenced, so that all three builders agree on what
 * "the content of a symlink path" means (a tracked symlink's blob is exactly this; the working
 * tree has no other analogue available without picking one arbitrarily).
 */
async function materializeWorktree(
  repoRoot: string,
  root: string,
  files: string[],
): Promise<string[]> {
  const written: string[] = [];
  const realDirs = new Map<string, Promise<boolean>>();
  // Whether every component of `relDir` is a real (non-symlink) directory under `repoRoot`.
  // Memoised per directory, so each ancestor is lstat'ed once however many files it holds.
  const isRealDir = (relDir: string): Promise<boolean> => {
    if (relDir === '.') return Promise.resolve(true);
    let cached = realDirs.get(relDir);
    if (cached === undefined) {
      cached = isRealDir(dirname(relDir)).then(async (parentOk) => {
        if (!parentOk) return false;
        try {
          return (await lstat(join(repoRoot, relDir))).isDirectory();
        } catch {
          return false;
        }
      });
      realDirs.set(relDir, cached);
    }
    return cached;
  };

  for (const f of files) {
    if (f.endsWith('/')) continue; // an untracked directory git did not descend into
    if (!(await isRealDir(dirname(f)))) continue;

    const src = join(repoRoot, f);
    let st;
    try {
      st = await lstat(src);
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }

    const dest = join(root, f);
    if (st.isSymbolicLink()) {
      await mkdir(dirname(dest), { recursive: true });
      const target = await readlink(src);
      await writeFile(dest, target, 'utf8');
      written.push(f);
      continue;
    }
    if (!st.isFile()) continue;

    await mkdir(dirname(dest), { recursive: true });
    try {
      await copyFile(src, dest);
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }
    written.push(f);
  }
  return written;
}

/**
 * Materialises blobs from the object database by sha (see `listBlobs`) through a single
 * `git cat-file --batch` process -- raw blob content, the same bytes `git show` prints for a
 * blob -- and returns the paths written. Every path in `files` is a key of `blobs` by
 * construction: narrowing only ever selects from the candidates, which are those keys.
 */
async function materializeBlobs(
  repoRoot: string,
  root: string,
  files: string[],
  blobs: ReadonlyMap<string, string>,
): Promise<string[]> {
  const shas = files.map((f) => blobs.get(f) as string);
  await readBlobs(repoRoot, shas, (index, content) => {
    const dest = join(root, files[index] as string);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  });
  return [...files];
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

/** Removes the snapshot's `.codegraph/` directory when the index build did not succeed
 *  (see the call site). Best-effort and idempotent: absent means already clean. Called while
 *  the tree is still writable, so no permission restoration is needed first. */
function removeCodegraphDir(root: string): void {
  rmSync(join(root, CODEGRAPH_INDEX_DIR), { recursive: true, force: true });
}

/** Restores write bits on the snapshot's `.codegraph/` index directory only (see the call
 *  site for why reads need them). Only ever called when the index build succeeded, so the
 *  directory is always present here; a missing or non-directory path is still tolerated
 *  defensively rather than failing the build. */
function restoreCodegraphWritable(root: string): void {
  const dir = join(root, CODEGRAPH_INDEX_DIR);
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return; // no index directory (disabled or failed build): nothing to do
  }
  if (!st.isDirectory()) return;
  restoreWritableTopDown(dir);
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

/**
 * Streams each of `shas` through one `git cat-file --batch` process, calling `onBlob` with the
 * request's index and the blob's raw content, strictly in request order. Output is parsed
 * incrementally (`<sha> SP blob SP <size> LF <content> LF` per object), so no single buffer ever
 * holds more than one object plus a pipe chunk. `onBlob` must be synchronous: anything it throws,
 * and any object that is missing or not a blob, fails the whole read with a `SnapshotError`.
 */
function readBlobs(
  repoRoot: string,
  shas: readonly string[],
  onBlob: (index: number, content: Buffer) => void,
): Promise<void> {
  if (shas.length === 0) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    let failure: unknown = null;
    const fail = (err: unknown): void => {
      if (failure !== null) return;
      failure = err;
      child.kill();
    };

    let chunks: Buffer[] = [];
    let buffered = 0;
    let bodySize = -1; // -1 while awaiting the next header
    let index = 0;
    const joined = (): Buffer => {
      const all = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, buffered);
      chunks = [all];
      return all;
    };
    const consume = (n: number): Buffer => {
      const all = joined();
      const rest = all.subarray(n);
      chunks = rest.length > 0 ? [rest] : [];
      buffered = rest.length;
      return all.subarray(0, n);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (failure !== null) return;
      chunks.push(chunk);
      buffered += chunk.length;
      try {
        for (;;) {
          if (bodySize < 0) {
            if (buffered === 0) break;
            const nl = joined().indexOf(0x0a);
            if (nl < 0) break;
            const header = consume(nl + 1)
              .subarray(0, nl)
              .toString('utf8');
            const [, type, size] = header.split(' ');
            if (type !== 'blob' || size === undefined || !/^\d+$/.test(size)) {
              throw new SnapshotError(`git cat-file --batch: expected a blob, got "${header}"`);
            }
            bodySize = Number(size);
          } else {
            if (buffered < bodySize + 1) break; // content plus its trailing LF
            const content = consume(bodySize + 1).subarray(0, bodySize);
            bodySize = -1;
            onBlob(index, content);
            index += 1;
          }
        }
      } catch (err) {
        fail(err);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', fail);
    child.stdin.on('error', fail); // EPIPE when git exits early; `close` below reports why

    child.on('close', (code) => {
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      if (failure !== null) {
        reject(failure); // `buildSnapshot` wraps anything that is not already a SnapshotError
      } else if (code !== 0) {
        reject(new SnapshotError(`git cat-file --batch failed: ${detail || `exit ${code}`}`));
      } else if (index !== shas.length) {
        reject(new SnapshotError(`git cat-file --batch returned ${index} of ${shas.length} blobs`));
      } else {
        resolvePromise();
      }
    });

    child.stdin.end(`${shas.join('\n')}\n`);
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
