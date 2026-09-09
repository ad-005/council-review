/**
 * The extension loaded into every reviewer process. This is the security-critical module of the
 * whole package: it is the *only* capability a reviewer has, so a mistake here is a
 * data-exfiltration bug, not a rough edge. See `design.md`'s "Capability removal plus a frozen
 * snapshot, not a container" and `specs/council-review/reviewer-isolation/spec.md`.
 *
 * Structural rules, enforced by `eslint.config.js` and by `test/security/reviewer-spawn.test.ts`:
 *  - This file may import nothing but `node:` builtins. It is loaded by path (via jiti) into a
 *    foreign reviewer process; it is never imported by any other `src/` module and never by the
 *    council-review CLI process itself.
 *  - It registers exactly five tools — `council_read`, `council_grep`, `council_list`,
 *    `council_git`, `council_codegraph` — and nothing else. No shell, no write, no edit, no
 *    network capability.
 *
 * The file's default export is the extension factory pi calls: `export default function(pi) {
 * pi.registerTool(...) }`. `pi`'s real `ExtensionAPI`/`ToolDefinition` types live in
 * `@mariozechner/pi-coding-agent`, a package this file must not import (see the rule above) — so
 * the shapes below are declared locally, structurally compatible with pi's own types (confirmed
 * against pi 0.84.4's `.d.ts` files; see `SCRATCH/host-notes.md` section C). pi depends on
 * `typebox@1.3.7`, which emits schemas with no runtime symbol branding, so a hand-written plain
 * JSON Schema object literal is byte-identical to what `Type.Object(...)` would produce — see
 * CONTRACT.md's "SETTLED: reviewer-tools.ts needs no schema library". That is why `parameters`
 * below are plain object literals rather than a schema-builder call.
 *
 * Two roots matter here, and they must never be confused:
 *  - the **snapshot root** (`COUNCIL_SNAPSHOT_ROOT`) — a frozen, non-writable copy of the
 *    reviewed tree. `council_read`, `council_grep` and `council_list` operate only inside it,
 *    and `council_codegraph` queries a per-run index of it (built before the freeze).
 *  - the **real repository** (`COUNCIL_REPO_ROOT`) — has no snapshot equivalent because history
 *    metadata was deliberately not copied (see design.md). Only `council_git` touches it, and
 *    only through a fixed read-only subcommand allowlist with structured, literal arguments.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

// -------------------------------------------------------------------------------------------
// Minimal local stand-ins for pi's ExtensionAPI/ToolDefinition shapes. Deliberately not imported
// from pi's own package (see the file header) -- these are structurally compatible with pi
// 0.84.4's real types, which is all `registerTool` needs at runtime.
// -------------------------------------------------------------------------------------------

interface ToolTextContent {
  type: 'text';
  text: string;
}

interface ToolResult {
  content: ToolTextContent[];
  details?: unknown;
}

type ToolExecute = (
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: ToolResult) => void) | undefined,
  ctx: unknown,
) => Promise<ToolResult>;

interface ReviewerToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: ToolExecute;
}

/** The subset of pi's real `ExtensionAPI` this extension needs. */
export interface ReviewerExtensionAPI {
  registerTool: (tool: ReviewerToolDefinition) => void;
}

// -------------------------------------------------------------------------------------------
// Path containment. Used for every path argument to council_read/council_grep/council_list,
// including search roots and listing targets (spec: "Containment applies to every tool").
// -------------------------------------------------------------------------------------------

/**
 * Resolves `requestedPath` (relative to `root`, or an absolute path) to its real, fully
 * symlink-resolved filesystem path, and rejects it unless that resolved path is `root` itself or
 * a descendant of it.
 *
 * `fs.realpathSync` resolves every path segment, not just the last one, so this single call
 * covers relative parent-directory traversal, an absolute path outside the root, a final-segment
 * symlink that escapes, and a symlink on an *intermediate* directory component that escapes —
 * all four collapse to the same check: resolve fully, then compare against the resolved root.
 *
 * An empty string and `'.'` are both accepted as spellings of "the root itself" — a reviewer
 * inspecting the tree it was given naturally reaches for an empty path when asking a snapshot
 * tool to look at the root, and rejecting that before the request even reaches the containment
 * check just burns a turn for no security benefit. This is a pure input normalisation done
 * *before* any resolution: `''` becomes `'.'`, and from there it flows through the exact same
 * `join`/`realpathSync`/prefix-check pipeline as every other path below, so it carries no
 * special-case bypass and gains no privilege a literal `'.'` didn't already have.
 *
 * The design's TOCTOU note applies here: callers must perform every filesystem operation against
 * the *returned* resolved path, never re-resolve or re-derive it from the original input.
 */
export function resolveContained(root: string, requestedPath: unknown): string {
  if (typeof requestedPath !== 'string') {
    throw new Error('path must be a string');
  }
  if (requestedPath.includes('\0')) {
    throw new Error('path must not contain a NUL byte');
  }
  const normalizedPath = requestedPath.length === 0 ? '.' : requestedPath;

  const resolvedRoot = resolveRoot(root);
  const candidate = isAbsolute(normalizedPath) ? normalizedPath : join(root, normalizedPath);
  const resolvedCandidate = safeRealpath(candidate, requestedPath || '.');

  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(resolvedRoot + sep)) {
    throw new Error(`path escapes the allowed root: ${requestedPath}`);
  }
  return resolvedCandidate;
}

/**
 * Resolves the root itself to its real path (macOS's `/tmp` -> `/private/tmp` is a common case).
 * Every relative path reported back to a reviewer must be computed against *this* resolved root,
 * not the raw `root` string passed in -- otherwise a path resolved through a symlinked root
 * produces a long, wrong `relative()` result (e.g. `../../../private/tmp/.../file.txt` instead
 * of `file.txt`) even though containment itself is correctly enforced.
 */
export function resolveRoot(root: string): string {
  return safeRealpath(root, root);
}

function safeRealpath(target: string, label: string): string {
  try {
    return realpathSync(target);
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
    if (code === 'ENOENT') {
      throw new Error(`no such file or directory: ${label}`, { cause: err });
    }
    throw new Error(
      `cannot resolve path "${label}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

function clampInt(value: unknown, def: number, min: number, max: number, label: string): number {
  if (value === undefined) return def;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

// -------------------------------------------------------------------------------------------
// Environment: where the two roots come from.
// -------------------------------------------------------------------------------------------

export function getSnapshotRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.COUNCIL_SNAPSHOT_ROOT;
  if (!root) {
    throw new Error('COUNCIL_SNAPSHOT_ROOT is not set in the reviewer environment');
  }
  return root;
}

export function getRepoRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.COUNCIL_REPO_ROOT;
  if (!root) {
    throw new Error('COUNCIL_REPO_ROOT is not set in the reviewer environment');
  }
  return root;
}

// -------------------------------------------------------------------------------------------
// council_read
// -------------------------------------------------------------------------------------------

const MAX_READ_BYTES = 4_000_000;

export interface ReadParams {
  path?: unknown;
  startLine?: unknown;
  endLine?: unknown;
}

export interface ReadOutcome {
  relPath: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
}

export function readInRoot(root: string, params: ReadParams): ReadOutcome {
  const resolved = resolveContained(root, params.path);
  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    throw new Error('path is a directory; use council_list to inspect it');
  }
  if (!stat.isFile()) {
    throw new Error('path is not a regular file');
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `file is too large to read in full (${stat.size} bytes, limit ${MAX_READ_BYTES}); narrow with council_grep instead`,
    );
  }

  const raw = readFileSync(resolved, 'utf8');
  if (raw.includes('\0')) {
    throw new Error('file appears to be binary and cannot be read as text');
  }

  const lines = raw.split(/\r\n|\r|\n/);
  const totalLines = lines.length;
  const startLine = clampInt(params.startLine, 1, 1, Math.max(totalLines, 1), 'startLine');
  const endLine = clampInt(params.endLine, totalLines, 1, Math.max(totalLines, 1), 'endLine');
  if (startLine > endLine) {
    throw new Error('startLine must be <= endLine');
  }

  return {
    relPath: relative(resolveRoot(root), resolved) || '.',
    content: lines.slice(startLine - 1, endLine).join('\n'),
    totalLines,
    startLine,
    endLine,
  };
}

const readParameters = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'File path relative to the snapshot root (or an absolute path inside it) to read. An empty string or "." means the root itself, which is a directory and will fail -- use council_list for that.',
    },
    startLine: {
      type: 'number',
      description:
        '1-based first line to return (inclusive). Omit to start at the beginning of the file.',
    },
    endLine: {
      type: 'number',
      description: '1-based last line to return (inclusive). Omit to read to the end of the file.',
    },
  },
  required: ['path'],
  additionalProperties: false,
} as const;

export const councilReadTool: ReviewerToolDefinition = {
  name: 'council_read',
  label: 'Read file',
  description:
    'Read a file from the reviewed snapshot as text, optionally restricted to a 1-based inclusive line range.',
  parameters: readParameters,
  async execute(_toolCallId, params) {
    const root = getSnapshotRoot();
    const outcome = readInRoot(root, (params ?? {}) as ReadParams);
    const header = `${outcome.relPath} (lines ${outcome.startLine}-${outcome.endLine} of ${outcome.totalLines}):`;
    return {
      content: [{ type: 'text', text: `${header}\n${outcome.content}` }],
      details: { path: outcome.relPath, startLine: outcome.startLine, endLine: outcome.endLine },
    };
  },
};

// -------------------------------------------------------------------------------------------
// council_grep
// -------------------------------------------------------------------------------------------

const MAX_GREP_FILE_BYTES = 2_000_000;
const MAX_GREP_FILES_SCANNED = 5_000;
const DEFAULT_GREP_MAX_RESULTS = 200;

export interface GrepParams {
  pattern?: unknown;
  path?: unknown;
  ignoreCase?: unknown;
  maxResults?: unknown;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepOutcome {
  matches: GrepMatch[];
  filesScanned: number;
  truncated: boolean;
}

/** Collects real (non-symlink) files under `startAbs`. Symlinks -- whether the entry itself or an
 *  intermediate directory -- are never followed, so no per-entry realpath check is needed here:
 *  containment of the search root itself is already enforced by `resolveContained`. */
function collectFiles(startAbs: string): string[] {
  const stat = statSync(startAbs);
  if (stat.isFile()) return [startAbs];
  if (!stat.isDirectory()) {
    throw new Error('path is neither a file nor a directory');
  }

  const files: string[] = [];
  const stack: string[] = [startAbs];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

export function grepInRoot(root: string, params: GrepParams): GrepOutcome {
  if (typeof params.pattern !== 'string' || params.pattern.length === 0) {
    throw new Error('pattern must be a non-empty string');
  }
  let regex: RegExp;
  try {
    regex = new RegExp(params.pattern, params.ignoreCase ? 'i' : '');
  } catch (err) {
    throw new Error(
      `invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const maxResults = clampInt(params.maxResults, DEFAULT_GREP_MAX_RESULTS, 1, 1000, 'maxResults');
  const resolvedRoot = resolveRoot(root);
  const searchRootAbs = resolveContained(root, params.path ?? '.');
  const files = collectFiles(searchRootAbs).slice(0, MAX_GREP_FILES_SCANNED);

  const matches: GrepMatch[] = [];
  let truncated = false;

  outer: for (const file of files) {
    if (statSync(file).size > MAX_GREP_FILE_BYTES) continue;
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\0')) continue; // skip binary files

    const lines = content.split(/\r\n|\r|\n/);
    const relFile = relative(resolvedRoot, file);
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i] as string)) {
        matches.push({ path: relFile, line: i + 1, text: lines[i] as string });
        if (matches.length >= maxResults) {
          truncated = true;
          break outer;
        }
      }
    }
  }

  return { matches, filesScanned: files.length, truncated };
}

const grepParameters = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'A JavaScript-flavoured regular expression to search for.',
    },
    path: {
      type: 'string',
      description:
        'Directory or file to search, relative to the snapshot root. Empty string, ".", or omitting it all mean the whole snapshot root.',
    },
    ignoreCase: { type: 'boolean', description: 'Match case-insensitively.' },
    maxResults: {
      type: 'number',
      description: 'Maximum number of matching lines to return (default 200, max 1000).',
    },
  },
  required: ['pattern'],
  additionalProperties: false,
} as const;

export const councilGrepTool: ReviewerToolDefinition = {
  name: 'council_grep',
  label: 'Search content',
  description: 'Search text content in the reviewed snapshot with a regular expression.',
  parameters: grepParameters,
  async execute(_toolCallId, params) {
    const root = getSnapshotRoot();
    const outcome = grepInRoot(root, (params ?? {}) as GrepParams);
    const lines =
      outcome.matches.length === 0
        ? ['no matches']
        : outcome.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
    if (outcome.truncated) lines.push('[results truncated]');
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: {
        matches: outcome.matches.length,
        filesScanned: outcome.filesScanned,
        truncated: outcome.truncated,
      },
    };
  },
};

// -------------------------------------------------------------------------------------------
// council_list
// -------------------------------------------------------------------------------------------

const DEFAULT_LIST_MAX_ENTRIES = 2000;

export interface ListParams {
  path?: unknown;
  recursive?: unknown;
  maxEntries?: unknown;
}

export type ListEntryType = 'file' | 'dir' | 'symlink';

export interface ListEntry {
  path: string;
  type: ListEntryType;
}

export interface ListOutcome {
  entries: ListEntry[];
  truncated: boolean;
}

function entryType(dirent: { isSymbolicLink(): boolean; isDirectory(): boolean }): ListEntryType {
  if (dirent.isSymbolicLink()) return 'symlink';
  return dirent.isDirectory() ? 'dir' : 'file';
}

/** Recursion never follows a symlinked directory: a `Dirent` reports its own type, not the
 *  target's, so a symlink pointing at a directory reports `isDirectory() === false` and this
 *  simply never descends into it. */
function walk(
  dirAbs: string,
  relBase: string,
  out: ListEntry[],
  budget: { remaining: number },
): void {
  if (budget.remaining <= 0) return;
  const entries = readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (budget.remaining <= 0) return;
    const relPath = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
    const type = entryType(entry);
    out.push({ path: relPath, type });
    budget.remaining -= 1;
    if (type === 'dir') {
      walk(join(dirAbs, entry.name), relPath, out, budget);
    }
  }
}

export function listInRoot(root: string, params: ListParams): ListOutcome {
  const resolved = resolveContained(root, params.path ?? '.');
  const stat = statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error('path is not a directory');
  }
  const maxEntries = clampInt(params.maxEntries, DEFAULT_LIST_MAX_ENTRIES, 1, 10_000, 'maxEntries');
  const out: ListEntry[] = [];

  if (params.recursive) {
    walk(resolved, '', out, { remaining: maxEntries });
  } else {
    const entries = readdirSync(resolved, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (out.length >= maxEntries) break;
      out.push({ path: entry.name, type: entryType(entry) });
    }
  }

  return { entries: out, truncated: out.length >= maxEntries };
}

const listParameters = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Directory to list, relative to the snapshot root. Empty string, ".", or omitting it all mean the snapshot root itself.',
    },
    recursive: {
      type: 'boolean',
      description: 'List all descendants instead of just immediate entries.',
    },
    maxEntries: {
      type: 'number',
      description: 'Maximum number of entries to return (default 2000).',
    },
  },
  required: [],
  additionalProperties: false,
} as const;

export const councilListTool: ReviewerToolDefinition = {
  name: 'council_list',
  label: 'List directory',
  description: 'List the contents of a directory in the reviewed snapshot.',
  parameters: listParameters,
  async execute(_toolCallId, params) {
    const root = getSnapshotRoot();
    const outcome = listInRoot(root, (params ?? {}) as ListParams);
    const lines = outcome.entries.map((e) => {
      if (e.type === 'dir') return `${e.path}/`;
      if (e.type === 'symlink') return `${e.path} (symlink, not followed)`;
      return e.path;
    });
    if (outcome.truncated) lines.push('[listing truncated]');
    return {
      content: [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : '(empty)' }],
      details: { entries: outcome.entries.length, truncated: outcome.truncated },
    };
  },
};

// -------------------------------------------------------------------------------------------
// council_git -- against the REAL repository, not the snapshot. See design.md's "History reaches
// reviewers through an allowlist, not through a copied .git".
// -------------------------------------------------------------------------------------------

const GIT_SUBCOMMANDS = ['log', 'show', 'blame', 'diff'] as const;
type GitSubcommand = (typeof GIT_SUBCOMMANDS)[number];

export interface GitParams {
  subcommand?: unknown;
  revision?: unknown;
  path?: unknown;
  maxCount?: unknown;
}

function isGitSubcommand(v: unknown): v is GitSubcommand {
  return typeof v === 'string' && (GIT_SUBCOMMANDS as readonly string[]).includes(v);
}

/** A structured field's value is passed to `git` as one literal argv entry (never through a
 *  shell), so shell metacharacters carry no special meaning. The one thing still worth rejecting
 *  is a leading '-': git parses a positional argument beginning with '-' as an option, so an
 *  un-prefixed value there could smuggle a flag onto the git command line even though it never
 *  passes through a shell. Reject rather than guess intent. */
function assertLiteralArgValue(label: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain a NUL byte`);
  }
  if (value.startsWith('-')) {
    throw new Error(`${label} must not begin with '-'`);
  }
}

/** Lexical-only containment for the git `path` field: unlike the snapshot tools, this must not
 *  require the path to exist on disk right now -- history and blame legitimately target files
 *  that existed at some past revision and may since have been renamed or deleted. So this rejects
 *  an absolute path and any component that would walk above the repository root, without ever
 *  calling realpath. */
function assertRepoRelativePath(value: string): void {
  assertLiteralArgValue('path', value);
  if (isAbsolute(value)) {
    throw new Error('path must be repository-relative, not absolute');
  }
  const normalized = normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.startsWith(sep)) {
    throw new Error('path must not escape the repository root');
  }
}

export function buildGitArgv(params: GitParams): string[] {
  if (!isGitSubcommand(params.subcommand)) {
    throw new Error(
      `unsupported git subcommand: ${String(params.subcommand)} (allowed: ${GIT_SUBCOMMANDS.join(', ')})`,
    );
  }
  const subcommand = params.subcommand;
  // `--no-color` is unambiguous for log/show/diff, but `blame` has its own `--color-lines`/
  // `--color-by-age` options and rejects a bare `--no-color` as ambiguous between negating them
  // (verified empirically against a real git). `blame`'s own output has no ANSI colour to begin
  // with when stdout isn't a TTY (true here, since output is captured via execFileSync), so
  // there is nothing to suppress for it anyway.
  const argv: string[] = subcommand === 'blame' ? [subcommand] : [subcommand, '--no-color'];

  if (params.maxCount !== undefined) {
    if (subcommand !== 'log') {
      throw new Error('maxCount is only supported for log');
    }
    const maxCount = clampInt(params.maxCount, 50, 1, 500, 'maxCount');
    argv.push(`--max-count=${maxCount}`);
  }

  if (subcommand === 'blame' && (typeof params.path !== 'string' || params.path.length === 0)) {
    throw new Error('blame requires path');
  }

  let revision: string | undefined;
  if (params.revision !== undefined) {
    if (typeof params.revision !== 'string') {
      throw new Error('revision must be a string');
    }
    assertLiteralArgValue('revision', params.revision);
    revision = params.revision;
  } else if (subcommand === 'show') {
    revision = 'HEAD';
  }
  if (revision !== undefined) argv.push(revision);

  if (params.path !== undefined) {
    if (typeof params.path !== 'string') {
      throw new Error('path must be a string');
    }
    assertRepoRelativePath(params.path);
    argv.push('--', params.path);
  }

  return argv;
}

export function runGitHistory(repoRoot: string, params: GitParams): string {
  const argv = buildGitArgv(params);
  try {
    return execFileSync('git', argv, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: unknown }).stderr ?? '')
        : '';
    const message =
      stderr.trim().length > 0 ? stderr.trim() : err instanceof Error ? err.message : String(err);
    throw new Error(`git ${String(params.subcommand)} failed: ${message}`, { cause: err });
  }
}

const gitParameters = {
  type: 'object',
  properties: {
    subcommand: {
      type: 'string',
      enum: ['log', 'show', 'blame', 'diff'],
      description: 'Read-only git history operation to run.',
    },
    revision: {
      type: 'string',
      description:
        'A single revision or revision range (e.g. "HEAD", "abc1234", "main..feature"). Optional for log/diff; defaults to HEAD for show.',
    },
    path: {
      type: 'string',
      description: 'Repository-relative path to scope the operation to. Required for blame.',
    },
    maxCount: {
      type: 'number',
      description: 'For log only: maximum number of commits to return (default 50, max 500).',
    },
  },
  required: ['subcommand'],
  additionalProperties: false,
} as const;

export const councilGitTool: ReviewerToolDefinition = {
  name: 'council_git',
  label: 'Repository history',
  description:
    'Query read-only history of the real repository: log, show, blame or diff. No other git operation is available.',
  parameters: gitParameters,
  async execute(_toolCallId, params) {
    const repoRoot = getRepoRoot();
    const output = runGitHistory(repoRoot, (params ?? {}) as GitParams);
    return {
      content: [{ type: 'text', text: output.length > 0 ? output : '(no output)' }],
      details: { subcommand: (params as GitParams | undefined)?.subcommand },
    };
  },
};

// -------------------------------------------------------------------------------------------
// council_codegraph -- semantic code intelligence over the SNAPSHOT, never the real repo.
// Mirrors council_git's shape: structured params become a literal argv executed from tool code
// via execFileSync, never a model-composed command line and never through a shell. The `-p
// <snapshotRoot>` project flag is always injected server-side from the caller's root argument,
// so reviewer input can never aim a query at any other tree. The binary reads a per-run index
// of the snapshot (built before the freeze); when that index is absent the call degrades to a
// reviewer-facing fallback message instead of failing.
// -------------------------------------------------------------------------------------------

export const CODEGRAPH_SUBCOMMANDS = [
  'explore',
  'query',
  'node',
  'callers',
  'callees',
  'impact',
  'affected',
] as const;
type CodegraphSubcommand = (typeof CODEGRAPH_SUBCOMMANDS)[number];

export interface CodegraphParams {
  subcommand?: unknown;
  query?: unknown;
  symbol?: unknown;
  file?: unknown;
  files?: unknown;
  kind?: unknown;
  limit?: unknown;
  depth?: unknown;
  maxFiles?: unknown;
  offset?: unknown;
}

export const MAX_CODEGRAPH_OUTPUT_CHARS = 100_000;

export const CODEGRAPH_FALLBACK_MESSAGE =
  'The CodeGraph index is not available for this run (it was not built, is disabled, or failed ' +
  'to build). Continue the review with council_grep and council_read instead.';

export function getCodegraphBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.COUNCIL_CODEGRAPH_BIN ?? 'codegraph';
}

function isCodegraphSubcommand(v: unknown): v is CodegraphSubcommand {
  return typeof v === 'string' && (CODEGRAPH_SUBCOMMANDS as readonly string[]).includes(v);
}

/** A structured string field's value is passed to the binary as one literal argv entry (never
 *  through a shell), so shell metacharacters carry no special meaning -- same rationale as
 *  `assertLiteralArgValue` for git: only a leading '-' (option smuggling) and NUL/empty are
 *  rejected. */
function codegraphStringField(label: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  assertLiteralArgValue(label, value);
  return value;
}

export function buildCodegraphArgv(root: string, params: CodegraphParams): string[] {
  if (!isCodegraphSubcommand(params.subcommand)) {
    throw new Error(
      `unsupported codegraph subcommand: ${String(params.subcommand)} (allowed: ${CODEGRAPH_SUBCOMMANDS.join(', ')})`,
    );
  }
  const subcommand = params.subcommand;
  const argv: string[] = [subcommand, '-p', root];

  switch (subcommand) {
    case 'explore': {
      argv.push(codegraphStringField('query', params.query));
      if (params.maxFiles !== undefined) {
        argv.push('--max-files', String(clampInt(params.maxFiles, 10, 1, 50, 'maxFiles')));
      }
      break;
    }
    case 'query': {
      argv.push(codegraphStringField('query', params.query));
      if (params.limit !== undefined) {
        argv.push('--limit', String(clampInt(params.limit, 10, 1, 100, 'limit')));
      }
      if (params.kind !== undefined) {
        argv.push('--kind', codegraphStringField('kind', params.kind));
      }
      break;
    }
    case 'node': {
      const hasSymbol = params.symbol !== undefined;
      const hasFile = params.file !== undefined;
      if (!hasSymbol && !hasFile) {
        throw new Error('node requires symbol and/or file');
      }
      if (hasSymbol) {
        argv.push(codegraphStringField('symbol', params.symbol));
      }
      if (hasFile) {
        argv.push('--file', codegraphIndexPath(root, params.file));
      }
      if (params.offset !== undefined) {
        if (!hasFile) {
          throw new Error('offset is only supported with file');
        }
        argv.push('--offset', String(clampInt(params.offset, 1, 1, 1_000_000, 'offset')));
      }
      if (params.limit !== undefined) {
        if (!hasFile) {
          throw new Error('limit is only supported with file');
        }
        argv.push('--limit', String(clampInt(params.limit, 20, 1, 1000, 'limit')));
      }
      break;
    }
    case 'callers':
    case 'callees': {
      argv.push(codegraphStringField('symbol', params.symbol));
      if (params.limit !== undefined) {
        argv.push('--limit', String(clampInt(params.limit, 20, 1, 100, 'limit')));
      }
      break;
    }
    case 'impact': {
      argv.push(codegraphStringField('symbol', params.symbol));
      if (params.depth !== undefined) {
        argv.push('--depth', String(clampInt(params.depth, 2, 1, 10, 'depth')));
      }
      break;
    }
    case 'affected': {
      if (params.files !== undefined) {
        if (!Array.isArray(params.files)) {
          throw new Error('files must be an array of strings');
        }
        for (const entry of params.files) {
          if (typeof entry !== 'string') {
            throw new Error('files must be an array of strings');
          }
          argv.push(codegraphIndexPath(root, entry));
        }
      }
      if (params.depth !== undefined) {
        argv.push('--depth', String(clampInt(params.depth, 5, 1, 10, 'depth')));
      }
      break;
    }
  }

  return argv;
}

/**
 * Validates a reviewer-supplied file path exactly like every other snapshot tool (full
 * containment check, symlink-aware), then converts it to the project-root-relative form the
 * index itself is keyed by. Passing the absolute path fails against the real binary: `node
 * --file <absolute>` answers 'No indexed file matches ...' even for indexed files, while the
 * same path relative to the project resolves (verified by probe against the installed
 * binary). Computed against `resolveRoot(root)` per that function's own warning -- the raw
 * `root` string may route through a symlinked parent (macOS `/tmp`) that would corrupt the
 * `relative()` result.
 */
function codegraphIndexPath(root: string, requestedPath: unknown): string {
  return relative(resolveRoot(root), resolveContained(root, requestedPath));
}

function hasCodegraphIndex(root: string): boolean {
  try {
    statSync(join(root, '.codegraph', 'codegraph.db'));
    return true;
  } catch {
    return false;
  }
}

export function runCodegraph(
  root: string,
  params: CodegraphParams,
  opts: { timeoutMs?: number } = {},
): string {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  // Graceful degradation, checked before any validation or spawn: without an index every call
  // returns the fallback message and nothing is ever executed.
  if (!hasCodegraphIndex(root)) {
    return CODEGRAPH_FALLBACK_MESSAGE;
  }
  const argv = buildCodegraphArgv(root, params);
  let output: string;
  try {
    output = execFileSync(getCodegraphBin(), argv, {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === 'ETIMEDOUT') {
      throw new Error(
        `codegraph ${String(params.subcommand)} timed out after ${timeoutMs}ms; narrow the query to a more specific symbol or file and try again`,
        { cause: err },
      );
    }
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: unknown }).stderr ?? '')
        : '';
    const message =
      stderr.trim().length > 0 ? stderr.trim() : err instanceof Error ? err.message : String(err);
    throw new Error(`codegraph ${String(params.subcommand)} failed: ${message}`, { cause: err });
  }
  if (output.length > MAX_CODEGRAPH_OUTPUT_CHARS) {
    return (
      output.slice(0, MAX_CODEGRAPH_OUTPUT_CHARS) +
      `\n[output truncated: ${output.length} characters total, showing the first ${MAX_CODEGRAPH_OUTPUT_CHARS}; narrow the query to a more specific symbol, file, or lower limit]`
    );
  }
  return output;
}

const codegraphParameters = {
  type: 'object',
  properties: {
    subcommand: {
      type: 'string',
      enum: ['explore', 'query', 'node', 'callers', 'callees', 'impact', 'affected'],
      description: 'Read-only CodeGraph operation to run.',
    },
    query: {
      type: 'string',
      description: 'Free-text exploration or symbol-search query (explore, query).',
    },
    symbol: {
      type: 'string',
      description: 'Symbol name to look up or trace (node, callers, callees, impact).',
    },
    file: {
      type: 'string',
      description:
        'Snapshot-relative file path to read through the index (node file mode; enables offset/limit).',
    },
    files: {
      type: 'array',
      items: { type: 'string' },
      description: 'Snapshot-relative file paths whose affected tests to find (affected).',
    },
    kind: {
      type: 'string',
      description: 'Symbol-kind filter for query (e.g. "function", "class").',
    },
    limit: {
      type: 'number',
      description: 'Maximum results or lines (query, node file mode, callers, callees).',
    },
    depth: {
      type: 'number',
      description: 'Dependency-traversal depth for impact/affected (1-10).',
    },
    maxFiles: {
      type: 'number',
      description: 'Maximum files to include source from, for explore (1-50).',
    },
    offset: {
      type: 'number',
      description: '1-based first line for node file mode.',
    },
  },
  required: ['subcommand'],
  additionalProperties: false,
} as const;

export const councilCodegraphTool: ReviewerToolDefinition = {
  name: 'council_codegraph',
  label: 'Code intelligence',
  description:
    'Start here before council_grep/council_read: query the CodeGraph symbol index of the reviewed snapshot for symbol-accurate call paths and transitive impact that plain-text search misses. Use explore for an area, node for one symbol, and callers/callees/impact to trace who calls what, e.g. { "subcommand": "callers", "symbol": "functionName" }. When the index is unavailable the tool returns a fallback message instead of results; use council_grep/council_read then.',
  parameters: codegraphParameters,
  async execute(_toolCallId, params) {
    const root = getSnapshotRoot();
    const output = runCodegraph(root, (params ?? {}) as CodegraphParams);
    return {
      content: [{ type: 'text', text: output.length > 0 ? output : '(no output)' }],
      details: { subcommand: (params as CodegraphParams | undefined)?.subcommand },
    };
  },
};

// -------------------------------------------------------------------------------------------
// Extension entry point
// -------------------------------------------------------------------------------------------

export const REVIEWER_TOOLS: readonly ReviewerToolDefinition[] = [
  councilReadTool,
  councilGrepTool,
  councilListTool,
  councilGitTool,
  councilCodegraphTool,
];

export default function registerReviewerTools(pi: ReviewerExtensionAPI): void {
  for (const tool of REVIEWER_TOOLS) {
    pi.registerTool(tool);
  }
}
