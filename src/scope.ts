/**
 * Resolves what a run actually reviews: a scope selector becomes exactly one unified diff patch
 * plus one repo-relative file set. See `specs/council-review/review-target/spec.md` for the
 * requirements this implements, and `design.md`'s "A copied snapshot, not a git worktree and not
 * the live tree" for why the snapshot builder (Section 8) keys off `endRevision` the way it does.
 *
 * Every git invocation uses an argument array, never a shell string, and under no circumstances
 * does this module modify the caller's working tree, index, object store, HEAD, stash or refs:
 * the default scope's fold of untracked files happens against a throwaway index file and object
 * directory (see `withThrowawayIndex`), every other operation is read-only, and every call runs
 * with `--no-optional-locks` so not even a stat refresh is written back to the real index.
 *
 * Paths are data, never syntax: listings are read NUL-separated (`-z`, no C-quoting, no
 * trimming), and file names handed back to git are literal pathspecs (`--literal-pathspecs`),
 * never pathspec magic or globs.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import picomatch from 'picomatch';
import { reviewsDirPath } from './report.js';
import { CHILD_MAX_BUFFER, childErrorMessage } from './child-output.js';

export type ScopeMode = 'worktree' | 'staged' | 'range' | 'revision';

export interface ScopeSelectors {
  staged?: boolean;
  range?: string; // 'A..B' ('A...B' is accepted but diffed identically -- see resolveRangeScope)
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

// The canonical empty-tree object, used as the "parent" of a root commit so a single-revision
// scope on a repository's first commit still produces a literal `git diff` (a full-file-addition
// patch) rather than needing special-cased handling downstream.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Prepended to every git call. `--no-optional-locks` stops read-only commands (notably
// `status`) from refreshing stat data and rewriting the caller's real index under index.lock;
// `core.quotePath=false` keeps non-ASCII names readable in the patch reviewers receive (names
// with control characters, `"` or `\` are still C-quoted by git; blast-radius.ts decodes them).
const GIT_GLOBAL_ARGS: readonly string[] = ['--no-optional-locks', '-c', 'core.quotePath=false'];

// Pinned on every `git diff`, so user config cannot reshape the output: no color
// (`color.ui=always`), no external diff program (`diff.external`, attribute drivers), no
// textconv filter, and git's standard `a/`/`b/` prefixes whatever `diff.noprefix` or
// `diff.mnemonicPrefix` say (blast-radius.ts parses the patch). Binary files still render as
// git's default "Binary files ... differ" line.
const DIFF_OPTS: readonly string[] = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

// Upper bound on the pathspec bytes one `git diff` receives. `git diff` has no
// `--pathspec-from-file`, so a large file set is split across several calls instead of
// overflowing argv (E2BIG). Well under Linux's 2MB ARG_MAX and Windows' 32K command line.
const PATHSPEC_BATCH_BYTES = 24 * 1024;

/**
 * Resolves the repository root containing `cwd`. Synchronous, and does not require the rest of
 * this module's git plumbing, so callers (including the CLI) can use it before anything else.
 */
export function findRepoRoot(cwd: string): string {
  try {
    // `stdio` is given explicitly so git's own stderr (e.g. "fatal: not a git repository...") is
    // discarded rather than forwarded to our stderr, which `execFileSync` does by default. The
    // `catch` below already raises a better-worded `ScopeError`, and callers like `status` treat
    // "not a git repository" as ordinary, reportable state rather than a crash -- git's own noise
    // on top of that would make a clean status report look like a failure.
    return chompLine(
      execFileSync('git', [...GIT_GLOBAL_ARGS, 'rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
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

  const head = await tryRevParse(repoRoot, 'HEAD^{commit}');
  if (head === null) {
    throw new ScopeError(
      'the repository has no commits yet (HEAD does not resolve to a commit); make a first commit before reviewing',
    );
  }
  // The tool's own run artifacts are excluded here for the same reason as everywhere else
  // (see `excludeOwnRunArtifacts`): a previous run's output must not make the tree look dirty.
  const status = await runGit(
    [
      'status',
      '--porcelain',
      '--untracked-files=normal',
      '--',
      `:(top,exclude,literal)${reviewsDirRelPath(repoRoot)}`,
    ],
    { cwd: repoRoot },
  );
  const dirty = status.length > 0;

  let baseBranch: string | null = null;
  let mergeBase: string | null = null;
  let patch: string;
  let files: string[];
  let endRevision: string | null;

  if (mode === 'worktree') {
    const branchName = selectors.base ?? opts.baseBranch;
    const baseSha = await resolveBaseBranch(repoRoot, branchName);
    baseBranch = branchName;
    mergeBase = await resolveMergeBase(repoRoot, head, baseSha, branchName);
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
//
// Every mode lists its changed paths with `--no-renames`, so a rename contributes both its old
// path (a deletion) and its new path to `files`, and `--paths` narrows each side independently.
// The patch then diffs exactly those paths with rename detection on, so a rename whose two sides
// both survive narrowing still renders as one `rename from`/`rename to` entry.
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
      // Over stdin, NUL-separated: no argv size limit, however many untracked files there are.
      await runGit(
        [
          '--literal-pathspecs',
          'add',
          '--intent-to-add',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        { cwd: repoRoot, env, input: narrowedUntracked.join('\0') },
      );
    }

    const changed = await listChangedPaths(repoRoot, [mergeBase], env);
    const files = excludeOwnRunArtifacts(narrowByGlobs(changed, paths), repoRoot);
    const patch = await diffPatch(repoRoot, [mergeBase], files, env);
    return { patch, files };
  });
}

/** The staged scope is exactly `git diff --cached`: HEAD vs the index, nothing else. */
async function resolveStagedScope(
  repoRoot: string,
  paths: string[] | undefined,
): Promise<{ patch: string; files: string[] }> {
  const changed = await listChangedPaths(repoRoot, ['--cached']);
  const files = excludeOwnRunArtifacts(narrowByGlobs(changed, paths), repoRoot);
  const patch = await diffPatch(repoRoot, ['--cached'], files);
  return { patch, files };
}

/**
 * A range scope is a literal diff between its two endpoints, whichever separator was typed.
 * This deliberately differs from `git diff A...B`, which diffs from `merge-base(A, B)` to B:
 * here `A...B` means exactly what `A..B` does, the tree at A against the tree at B.
 */
async function resolveRangeScope(
  repoRoot: string,
  range: string,
  paths: string[] | undefined,
): Promise<{ patch: string; files: string[]; endRevision: string }> {
  const { fromRef, toRef } = splitRange(range);
  const from = await resolveRevision(repoRoot, fromRef);
  const to = await resolveRevision(repoRoot, toRef);

  const changed = await listChangedPaths(repoRoot, [from, to]);
  const files = excludeOwnRunArtifacts(narrowByGlobs(changed, paths), repoRoot);
  const patch = await diffPatch(repoRoot, [from, to], files);
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

  const changed = await listChangedPaths(repoRoot, [parent, rev]);
  const files = excludeOwnRunArtifacts(narrowByGlobs(changed, paths), repoRoot);
  const patch = await diffPatch(repoRoot, [parent, rev], files);
  return { patch, files, endRevision: rev };
}

// ---------------------------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------------------------

/** Splits a range selector on its first `..` or `...` (both mean the same here -- see
 *  `resolveRangeScope`). Refnames cannot contain `..`, so the first occurrence is always the
 *  unambiguous split point regardless of which form was typed. A missing side defaults to HEAD,
 *  matching git's own range syntax. */
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

/** `git rev-parse --verify` of one spec, or null when it does not resolve. */
async function tryRevParse(repoRoot: string, spec: string): Promise<string | null> {
  try {
    return (await runGit(['rev-parse', '--verify', '--quiet', spec], { cwd: repoRoot })).trim();
  } catch {
    return null;
  }
}

async function resolveRevision(repoRoot: string, ref: string): Promise<string> {
  const sha = await tryRevParse(repoRoot, `${ref}^{commit}`);
  if (sha === null) {
    throw new ScopeError(`unresolvable revision: "${ref}"`);
  }
  return sha;
}

/** A revision's first parent, or the empty tree when it has none (a root commit). */
async function resolveParent(repoRoot: string, rev: string): Promise<string> {
  return (await tryRevParse(repoRoot, `${rev}^`)) ?? EMPTY_TREE_SHA;
}

/** Resolves a base branch name to a commit, naming it in the error on failure. Tries a local
 *  branch first, then falls back to any ref of that name (a remote-tracking ref such as
 *  `origin/main` is the common case for a base branch that isn't checked out locally). */
async function resolveBaseBranch(repoRoot: string, branch: string): Promise<string> {
  const sha =
    (await tryRevParse(repoRoot, `refs/heads/${branch}^{commit}`)) ??
    (await tryRevParse(repoRoot, `${branch}^{commit}`));
  if (sha === null) {
    throw new ScopeError(`unknown base branch: "${branch}"`);
  }
  return sha;
}

async function resolveMergeBase(
  repoRoot: string,
  head: string,
  baseSha: string,
  branch: string,
): Promise<string> {
  try {
    return (await runGit(['merge-base', head, baseSha], { cwd: repoRoot })).trim();
  } catch {
    // Both sides are verified commits, so the one way this fails is `merge-base` exiting 1
    // with no output at all: the histories share no commit (an orphan branch, an unrelated
    // import), and git's own message would be empty.
    throw new ScopeError(
      `no common ancestor between HEAD and base branch "${branch}"; pass --base <branch> or --range <A..B>`,
    );
  }
}

async function listUntrackedNotIgnored(repoRoot: string): Promise<string[]> {
  // An entry ending in `/` is an untracked embedded repository, which git lists as one directory
  // rather than descending into: none of its content belongs to this repository's change (the
  // snapshot skips it too), and `add --intent-to-add` refuses one with no commit checked out.
  return splitNul(
    await runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoRoot }),
  ).filter((f) => !f.endsWith('/'));
}

/** Paths changed between the given endpoints (`revArgs` as `git diff` takes them), with each
 *  rename split into its deletion and its addition so both paths are listed. */
async function listChangedPaths(
  repoRoot: string,
  revArgs: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string[]> {
  const out = await runGit(
    ['diff', ...DIFF_OPTS, '--no-renames', '--name-only', '-z', ...revArgs],
    { cwd: repoRoot, env },
  );
  return splitNul(out);
}

/**
 * The unified patch for exactly `files` between the given endpoints, as literal pathspecs. A
 * file set too large for one argv is diffed in batches and concatenated; the only visible
 * difference is that a rename whose two sides land in different batches renders as a deletion
 * plus an addition, which is still a correct patch.
 */
async function diffPatch(
  repoRoot: string,
  revArgs: readonly string[],
  files: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  let patch = '';
  for (const batch of pathspecBatches(files)) {
    patch += await runGit(
      ['--literal-pathspecs', 'diff', ...DIFF_OPTS, '--find-renames', ...revArgs, '--', ...batch],
      { cwd: repoRoot, env },
    );
  }
  return patch;
}

function pathspecBatches(files: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const f of files) {
    const size = Buffer.byteLength(f) + 3; // separator, plus quoting on Windows
    if (current.length > 0 && bytes + size > PATHSPEC_BATCH_BYTES) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(f);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Runs `fn` with an env pointing `GIT_INDEX_FILE` at a private copy of the repo's real index, so
 * `git add --intent-to-add` inside `fn` can never touch the caller's real index. Object writes
 * are redirected the same way: `--intent-to-add` records an empty blob, and `GIT_OBJECT_DIRECTORY`
 * sends that write into the temp directory while the real object store stays readable as an
 * alternate. The temp directory is removed once `fn` settles, success or failure.
 */
async function withThrowawayIndex<T>(
  repoRoot: string,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  // `--git-path` resolves both correctly in a linked worktree (its own index, the common object
  // store) and honours a GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY already set in the environment.
  const [realIndex, realObjects] = (
    await runGit(['rev-parse', '--git-path', 'index', '--git-path', 'objects'], { cwd: repoRoot })
  )
    .split('\n')
    .slice(0, 2)
    .map((p) => (isAbsolute(p) ? p : join(repoRoot, p)));

  const tempDir = await mkdtemp(join(tmpdir(), 'council-review-scope-'));
  const tempIndex = join(tempDir, 'index');
  const tempObjects = join(tempDir, 'objects');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: tempIndex,
    GIT_OBJECT_DIRECTORY: tempObjects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [realObjects, process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES]
      .filter((d) => d !== undefined && d.length > 0)
      .join(delimiter),
  };

  try {
    await mkdir(tempObjects);
    try {
      await copyFile(realIndex as string, tempIndex);
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

/** Splits `-z` output. Entries are taken verbatim: a path may begin or end with whitespace. */
function splitNul(s: string): string[] {
  return s.split('\0').filter((entry) => entry.length > 0);
}

/** Drops the single trailing newline git prints after a path, keeping any other whitespace. */
function chompLine(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

/** Global pathspec modes a user can set in the environment. Each changes how every pathspec
 *  below is read (`GIT_LITERAL_PATHSPECS` defeats the dirty check's exclude magic; the others
 *  are rejected outright alongside `--literal-pathspecs`), so none reaches a git call here. */
const PATHSPEC_ENV_VARS = [
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
] as const;

function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of PATHSPEC_ENV_VARS) delete env[name];
  return env;
}

async function runGit(
  args: readonly string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: string },
): Promise<string> {
  try {
    const pending = execFileAsync('git', [...GIT_GLOBAL_ARGS, ...args], {
      cwd: opts.cwd,
      env: gitEnv(opts.env),
      maxBuffer: CHILD_MAX_BUFFER,
    });
    // stdin is always closed, so no git command can ever wait on it. A write error (git exited
    // before reading its input) surfaces as the command's own failure below.
    pending.child.stdin?.on('error', () => {});
    pending.child.stdin?.end(opts.input ?? '');
    const { stdout } = await pending;
    return stdout;
  } catch (err) {
    throw new ScopeError(`git ${describeArgs(args)} failed: ${childErrorMessage(err)}`);
  }
}

/** The argv for an error message, capped: a batched diff can carry thousands of paths. */
function describeArgs(args: readonly string[]): string {
  const text = args.join(' ');
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}
