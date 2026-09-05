/**
 * Resolves what a run actually reviews: a scope selector becomes exactly one unified diff patch
 * plus one repo-relative file set. See `specs/council-review/review-target/spec.md` for the
 * requirements this implements, and `design.md`'s "A copied snapshot, not a git worktree and not
 * the live tree" for why the snapshot builder (Section 8) keys off `endRevision` the way it does.
 *
 * Every git invocation uses an argument array, never a shell string, and under no circumstances
 * does this module modify the caller's working tree, index, HEAD, stash or refs: the default
 * scope's fold of untracked files happens against a throwaway index file (see
 * `withThrowawayIndex`), and every other operation is read-only.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import picomatch from 'picomatch';
import { reviewsDirPath } from './report.js';

export type ScopeMode = 'worktree' | 'staged' | 'range' | 'revision';

export interface ScopeSelectors {
  staged?: boolean;
  range?: string; // 'A..B'
  revision?: string; // single rev
  paths?: string[]; // globs
  base?: string; // base-branch override
}

export interface ResolvedScope {
  mode: ScopeMode;
  patch: string; // unified diff text
  files: string[]; // repo-relative paths touched by the patch
  selectors: ScopeSelectors;
  baseBranch: string | null;
  mergeBase: string | null;
  /** Revision whose tree the snapshot must depict; null means worktree (mode 'worktree') or index (mode 'staged'). */
  endRevision: string | null;
  head: string;
  dirty: boolean;
  empty: boolean;
}

export class ScopeError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

const execFileAsync = promisify(execFile);

// Diffs on a large default scope must not be silently truncated by Node's default 1MB buffer.
const GIT_MAX_BUFFER = 1024 * 1024 * 256;

// The canonical empty-tree object, used as the "parent" of a root commit so a single-revision
// scope on a repository's first commit still produces a literal `git diff` (a full-file-addition
// patch) rather than needing special-cased handling downstream.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Resolves the repository root containing `cwd`. Synchronous, and does not require the rest of
 * this module's git plumbing, so callers (including the CLI) can use it before anything else.
 */
export function findRepoRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    throw new ScopeError(`not a git repository (or any parent up to the mount point): "${cwd}"`);
  }
}

/**
 * Detects mutually-exclusive scope selectors (e.g. `--staged` with `--range`). Callable on its
 * own, synchronously and before any git work, so the CLI can reject a conflicting invocation
 * before any snapshot or model work begins. `resolveScope` also calls this itself.
 */
export function checkScopeSelectors(selectors: ScopeSelectors): void {
  const given: string[] = [];
  if (selectors.staged) given.push('--staged');
  if (selectors.range !== undefined) given.push('--range');
  if (selectors.revision !== undefined) given.push('--revision');
  if (given.length > 1) {
    throw new ScopeError(`conflicting scope selectors: ${given.join(' and ')} may not be combined`);
  }
}

export async function resolveScope(
  repoRoot: string,
  selectors: ScopeSelectors,
  opts: { baseBranch: string },
): Promise<ResolvedScope> {
  checkScopeSelectors(selectors);

  const mode = determineMode(selectors);
  const paths = selectors.paths && selectors.paths.length > 0 ? selectors.paths : undefined;

  const head = (await runGit(['rev-parse', 'HEAD'], { cwd: repoRoot })).trim();
  const dirty =
    (await runGit(['status', '--porcelain', '--untracked-files=normal'], { cwd: repoRoot })).trim()
      .length > 0;

  let baseBranch: string | null = null;
  let mergeBase: string | null = null;
  let patch: string;
  let files: string[];
  let endRevision: string | null;

  if (mode === 'worktree') {
    const branchName = selectors.base ?? opts.baseBranch;
    const baseSha = await resolveBaseBranch(repoRoot, branchName);
    baseBranch = branchName;
    mergeBase = (await runGit(['merge-base', head, baseSha], { cwd: repoRoot })).trim();
    ({ patch, files } = await resolveWorktreeScope(repoRoot, mergeBase, paths));
    endRevision = null;
  } else if (mode === 'staged') {
    ({ patch, files } = await resolveStagedScope(repoRoot, paths));
    endRevision = null;
  } else if (mode === 'range') {
    const result = await resolveRangeScope(repoRoot, selectors.range as string, paths);
    patch = result.patch;
    files = result.files;
    endRevision = result.endRevision;
  } else {
    const result = await resolveRevisionScope(repoRoot, selectors.revision as string, paths);
    patch = result.patch;
    files = result.files;
    endRevision = result.endRevision;
  }

  files.sort();

  return {
    mode,
    patch,
    files,
    selectors,
    baseBranch,
    mergeBase,
    endRevision,
    head,
    dirty,
    empty: files.length === 0,
  };
}

function determineMode(selectors: ScopeSelectors): ScopeMode {
  if (selectors.staged) return 'staged';
  if (selectors.range !== undefined) return 'range';
  if (selectors.revision !== undefined) return 'revision';
  return 'worktree';
}

// ---------------------------------------------------------------------------------------------
// Per-mode resolution
// ---------------------------------------------------------------------------------------------

/**
 * Folds committed, staged, unstaged and untracked-not-ignored changes into one patch.
 *
 * Untracked-not-ignored files are staged with `git add --intent-to-add` into a throwaway index
 * (never the caller's real index -- see `withThrowawayIndex`). An intent-to-add entry has an
 * empty blob in the index but a real path, which is exactly what makes `git diff <mergeBase>`
 * (a single-treeish diff, which compares a tree to the *working tree*, using the index only to
 * know what the index knows) report it as a new-file addition alongside every other kind of
 * change -- all four change kinds come out of that one `git diff` call.
 */
async function resolveWorktreeScope(
  repoRoot: string,
  mergeBase: string,
  paths: string[] | undefined,
): Promise<{ patch: string; files: string[] }> {
  return withThrowawayIndex(repoRoot, async (env) => {
    const untracked = await listUntrackedNotIgnored(repoRoot);
    // Dropped here too, not just below: this is what stops a run's own artifacts from ever being
    // intent-to-add'ed into the throwaway index in the first place -- an accumulated
    // .council/reviews/ can be thousands of files deep, and there's no reason to stage any of
    // them only to filter them back out of `files` a few lines down.
    const narrowedUntracked = excludeOwnRunArtifacts(narrowByGlobs(untracked, paths), repoRoot);
    if (narrowedUntracked.length > 0) {
      await runGit(['add', '--intent-to-add', '--', ...narrowedUntracked], { cwd: repoRoot, env });
    }

    const nameOnly = await runGit(['diff', '--name-only', mergeBase], { cwd: repoRoot, env });
    const files = excludeOwnRunArtifacts(narrowByGlobs(splitLines(nameOnly), paths), repoRoot);
    if (files.length === 0) {
      return { patch: '', files: [] };
    }
    const patch = await runGit(['diff', mergeBase, '--', ...files], { cwd: repoRoot, env });
    return { patch, files };
  });
}

/** The staged scope is exactly `git diff --cached`: HEAD vs the index, nothing else. */
async function resolveStagedScope(
  repoRoot: string,
  paths: string[] | undefined,
): Promise<{ patch: string; files: string[] }> {
  const nameOnly = await runGit(['diff', '--cached', '--name-only'], { cwd: repoRoot });
  const files = excludeOwnRunArtifacts(narrowByGlobs(splitLines(nameOnly), paths), repoRoot);
  if (files.length === 0) {
    return { patch: '', files: [] };
  }
  const patch = await runGit(['diff', '--cached', '--', ...files], { cwd: repoRoot });
  return { patch, files };
}

/** A range scope is a literal diff between its two endpoints, whichever separator (`..`/`...`) was typed. */
async function resolveRangeScope(
  repoRoot: string,
  range: string,
  paths: string[] | undefined,
): Promise<{ patch: string; files: string[]; endRevision: string }> {
  const { fromRef, toRef } = splitRange(range);
  const from = await resolveRevision(repoRoot, fromRef);
  const to = await resolveRevision(repoRoot, toRef);

  const nameOnly = await runGit(['diff', '--name-only', from, to], { cwd: repoRoot });
  const files = excludeOwnRunArtifacts(narrowByGlobs(splitLines(nameOnly), paths), repoRoot);
  const patch =
    files.length === 0 ? '' : await runGit(['diff', from, to, '--', ...files], { cwd: repoRoot });
  return { patch, files, endRevision: to };
}

/** A single revision's own change: its diff against its first parent (or the empty tree, for a root commit). */
async function resolveRevisionScope(
  repoRoot: string,
  revision: string,
  paths: string[] | undefined,
): Promise<{ patch: string; files: string[]; endRevision: string }> {
  const rev = await resolveRevision(repoRoot, revision);
  const parent = await resolveParent(repoRoot, rev);

  const nameOnly = await runGit(['diff', '--name-only', parent, rev], { cwd: repoRoot });
  const files = excludeOwnRunArtifacts(narrowByGlobs(splitLines(nameOnly), paths), repoRoot);
  const patch =
    files.length === 0
      ? ''
      : await runGit(['diff', parent, rev, '--', ...files], { cwd: repoRoot });
  return { patch, files, endRevision: rev };
}

// ---------------------------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------------------------

/** Splits a range selector on its first `..` or `...`. Refnames cannot contain `..`, so the
 *  first occurrence is always the unambiguous split point regardless of which form was typed.
 *  A missing side defaults to HEAD, matching git's own range syntax. */
function splitRange(range: string): { fromRef: string; toRef: string } {
  const match = /^(.*?)\.\.\.?(.*)$/.exec(range);
  if (!match) {
    throw new ScopeError(`invalid range: "${range}"`);
  }
  const [, left, right] = match;
  return {
    fromRef: left.trim().length > 0 ? left.trim() : 'HEAD',
    toRef: right.trim().length > 0 ? right.trim() : 'HEAD',
  };
}

async function resolveRevision(repoRoot: string, ref: string): Promise<string> {
  try {
    const out = await execFileAsync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: repoRoot,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return out.stdout.trim();
  } catch {
    throw new ScopeError(`unresolvable revision: "${ref}"`);
  }
}

async function resolveParent(repoRoot: string, rev: string): Promise<string> {
  try {
    const out = await execFileAsync('git', ['rev-parse', '--verify', `${rev}^`], {
      cwd: repoRoot,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return out.stdout.trim();
  } catch {
    // No parent: rev is a root commit. Diff against the empty tree instead.
    return EMPTY_TREE_SHA;
  }
}

/** Resolves a base branch name to a commit, naming it in the error on failure. Tries a local
 *  branch first, then falls back to any ref of that name (a remote-tracking ref such as
 *  `origin/main` is the common case for a base branch that isn't checked out locally). */
async function resolveBaseBranch(repoRoot: string, branch: string): Promise<string> {
  try {
    const out = await execFileAsync(
      'git',
      ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`],
      {
        cwd: repoRoot,
        maxBuffer: GIT_MAX_BUFFER,
      },
    );
    return out.stdout.trim();
  } catch {
    try {
      const out = await execFileAsync('git', ['rev-parse', '--verify', `${branch}^{commit}`], {
        cwd: repoRoot,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return out.stdout.trim();
    } catch {
      throw new ScopeError(`unknown base branch: "${branch}"`);
    }
  }
}

async function listUntrackedNotIgnored(repoRoot: string): Promise<string[]> {
  const out = await runGit(['ls-files', '--others', '--exclude-standard'], { cwd: repoRoot });
  return splitLines(out);
}

/**
 * Runs `fn` with an env pointing `GIT_INDEX_FILE` at a private copy of the repo's real index, so
 * `git add --intent-to-add` inside `fn` can never touch the caller's real index. The temp copy
 * (and its containing directory) is removed once `fn` settles, success or failure.
 */
async function withThrowawayIndex<T>(
  repoRoot: string,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const gitDirRaw = (await runGit(['rev-parse', '--git-dir'], { cwd: repoRoot })).trim();
  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : join(repoRoot, gitDirRaw);
  const realIndex = join(gitDir, 'index');

  const tempDir = await mkdtemp(join(tmpdir(), 'council-review-scope-'));
  const tempIndex = join(tempDir, 'index');
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tempIndex };

  try {
    try {
      await copyFile(realIndex, tempIndex);
    } catch {
      // No index file exists yet (nothing has ever been staged in this repo): seed the
      // throwaway index from HEAD's tree so it starts equivalent to a clean checkout.
      await runGit(['read-tree', 'HEAD'], { cwd: repoRoot, env });
    }
    return await fn(env);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Repo-relative, forward-slash path of the directory every run writes its own artifacts into
 * (manifest.json, findings.json, REPORT.md, HANDOFF.md, per-reviewer traces...). Derived from
 * `reviewsDirPath` -- report.ts's one definition of that directory -- rather than hardcoding
 * ".council/reviews" a second time here, so the two modules cannot drift apart if that layout
 * ever changes. `relative` can return backslash-separated segments on Windows; git's own path
 * output (and this module's `files` arrays) are always forward-slash, so the result is
 * normalised to match.
 */
function reviewsDirRelPath(repoRoot: string): string {
  return relative(repoRoot, reviewsDirPath(repoRoot)).split(sep).join('/');
}

/**
 * Removes the tool's own run-artifact directory from a resolved file list, unconditionally.
 *
 * A review's whole premise (see runner.ts) is that each reviewer sees only the task, the prompt
 * and the patch -- "nothing produced by any other reviewer." `.council/reviews/` is where every
 * past run's manifest, findings, report, handoff and raw per-reviewer traces live, so if the
 * default worktree scope's fold of untracked-not-ignored files (or any other scope mode) ever
 * picked those up, a run would review its own prior output: reviewer independence breaks, input
 * cost grows without bound across repeated runs, and past a few runs the accumulated patch can
 * exceed the OS argv limit outright.
 *
 * `council-review init` writes a `.gitignore` entry for this, but relying on that is exactly the
 * bug this closes: `--models`/`--pick` are documented as first-class one-off invocations that
 * never require `init` to have run, a `.gitignore` entry can be hand-edited or deleted, and
 * "untracked but not ignored" is a property of the working tree, not of what this directory is
 * for. So the exclusion here is structural -- it holds with no `.gitignore` entry at all, in
 * every scope mode below, and it is applied *after* `narrowByGlobs` in every caller specifically
 * so an explicit `--paths .council/reviews/**` cannot select these files back in. There is no
 * supported way to point this tool at a review of its own run artifacts.
 *
 * This deliberately excludes only `.council/reviews/`, not the whole `.council/` directory:
 * `.council/config.json` (the saved panel) and `.council/ignore.json` (suppressions) are
 * ordinary version-controlled files that a reviewer might legitimately need to see change -- a
 * PR that edits the panel's model list is exactly the kind of change this tool exists to review.
 * Excluding all of `.council/` would hide that from every scope mode with no way to opt back in,
 * which is a worse failure mode than the narrower rule risks: this directory's name and purpose
 * are fixed by this tool, not by user configuration, so there is no ambiguity about which half of
 * `.council/` is generated output and which half is checked-in config.
 */
function excludeOwnRunArtifacts(files: readonly string[], repoRoot: string): string[] {
  const dir = reviewsDirRelPath(repoRoot);
  const prefix = `${dir}/`;
  return files.filter((f) => f !== dir && !f.startsWith(prefix));
}

function narrowByGlobs(files: readonly string[], globs: readonly string[] | undefined): string[] {
  if (!globs || globs.length === 0) {
    return [...files];
  }
  const isMatch = picomatch(globs as string[]);
  return files.filter((f) => isMatch(f));
}

function splitLines(s: string): string[] {
  return s
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function runGit(
  args: readonly string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args as string[], {
      cwd: opts.cwd,
      env: opts.env,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    throw new ScopeError(`git ${args.join(' ')} failed: ${errorMessage(err)}`);
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      return stderr.trim();
    }
  }
  return err instanceof Error ? err.message : String(err);
}
