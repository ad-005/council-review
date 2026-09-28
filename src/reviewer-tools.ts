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
import { createContext, runInContext } from 'node:vm';

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
    if (errorCode(err) === 'ENOENT') {
      throw new Error(`no such file or directory: ${label}`, { cause: err });
    }
    throw new Error(
      `cannot resolve path "${label}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/** Validates an integer parameter the reviewer supplied: rejects (never silently clamps) a
 *  non-integer or out-of-range value. */
function requireInt(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

/** `requireInt` for an optional parameter whose default this module applies itself. */
function clampInt(value: unknown, def: number, min: number, max: number, label: string): number {
  return value === undefined ? def : requireInt(value, min, max, label);
}

// -------------------------------------------------------------------------------------------
// Output bounds shared by every tool. A tool result goes straight into a model's context, so no
// tool may return more than MAX_TOOL_OUTPUT_CHARS; anything longer is cut with an explicit marker
// telling the reviewer how to narrow the request, never silently.
// -------------------------------------------------------------------------------------------

export const MAX_TOOL_OUTPUT_CHARS = 100_000;

/** stdout captured from a spawned binary. Past this the child is killed and the partial output
 *  truncated (reported as "more than N characters") rather than surfacing a raw ENOBUFS. */
const MAX_EXEC_BUFFER_BYTES = 1024 * 1024;

/** Cuts `text` to MAX_TOOL_OUTPUT_CHARS with a marker. `incomplete` means `text` is itself only a
 *  prefix of the real output (the exec buffer overflowed), so its length is a lower bound. */
function truncateOutput(text: string, hint: string, opts: { incomplete?: boolean } = {}): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS && !opts.incomplete) return text;
  const shown = Math.min(text.length, MAX_TOOL_OUTPUT_CHARS);
  const total = opts.incomplete
    ? `more than ${text.length} characters`
    : `${text.length} characters total`;
  return `${text.slice(0, shown)}\n[output truncated: ${total}, showing the first ${shown}; ${hint}]`;
}

/** Splits file content into lines the way git numbers them: only `\n` (optionally preceded by
 *  `\r`) ends a line, a lone `\r` is ordinary content, and a final line terminator does not start
 *  an extra empty line. */
function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function errorCode(err: unknown): unknown {
  return err && typeof err === 'object' && 'code' in err
    ? (err as { code?: unknown }).code
    : undefined;
}

/** The reviewer-facing reason a spawned binary failed: its stderr when it wrote any, otherwise
 *  the spawn error's own message. */
function execErrorMessage(err: unknown): string {
  const stderr =
    err && typeof err === 'object' && 'stderr' in err
      ? String((err as { stderr?: unknown }).stderr ?? '').trim()
      : '';
  if (stderr.length > 0) return stderr;
  return err instanceof Error ? err.message : String(err);
}

/** The stdout a failed spawn had already captured (present on ENOBUFS). */
function execPartialStdout(err: unknown): string {
  return err && typeof err === 'object' && 'stdout' in err
    ? String((err as { stdout?: unknown }).stdout ?? '')
    : '';
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
/** Room left under MAX_TOOL_OUTPUT_CHARS for the header line (whose path can be long). */
const READ_CONTENT_BUDGET = MAX_TOOL_OUTPUT_CHARS - 5_000;

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
  /** The last line actually returned: below the requested end when `truncated`. */
  endLine: number;
  /** The requested range did not fit in MAX_TOOL_OUTPUT_CHARS and was cut at a line boundary. */
  truncated: boolean;
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

  const lines = splitLines(raw);
  const totalLines = lines.length;
  const startLine = clampInt(params.startLine, 1, 1, Math.max(totalLines, 1), 'startLine');
  const requestedEnd = clampInt(params.endLine, totalLines, 1, Math.max(totalLines, 1), 'endLine');
  if (startLine > requestedEnd) {
    throw new Error('startLine must be <= endLine');
  }

  // Cut at a line boundary so the reviewer can resume at `endLine + 1`; the first line is always
  // kept, and a single line longer than the limit is left to the tool's own truncateOutput.
  let endLine = startLine;
  let size = (lines[startLine - 1] as string).length;
  while (endLine < requestedEnd) {
    const next = size + 1 + (lines[endLine] as string).length;
    if (next > READ_CONTENT_BUDGET) break;
    size = next;
    endLine += 1;
  }

  return {
    relPath: relative(resolveRoot(root), resolved) || '.',
    content: lines.slice(startLine - 1, endLine).join('\n'),
    totalLines,
    startLine,
    endLine,
    truncated: endLine < requestedEnd,
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
    let text = truncateOutput(
      `${header}\n${outcome.content}`,
      'the line is too long to show in full; use council_grep to find the part you need',
    );
    if (outcome.truncated) {
      text += `\n[output truncated at line ${outcome.endLine} of ${outcome.totalLines} (limit ${MAX_TOOL_OUTPUT_CHARS} characters); continue with startLine=${outcome.endLine + 1}]`;
    }
    return {
      content: [{ type: 'text', text }],
      details: {
        path: outcome.relPath,
        startLine: outcome.startLine,
        endLine: outcome.endLine,
        truncated: outcome.truncated,
      },
    };
  },
};

// -------------------------------------------------------------------------------------------
// council_grep
// -------------------------------------------------------------------------------------------

const MAX_GREP_FILE_BYTES = 2_000_000;
const MAX_GREP_FILES_SCANNED = 5_000;
const DEFAULT_GREP_MAX_RESULTS = 200;
/** A matching line is returned as at most this many characters (a minified bundle is one line). */
const MAX_GREP_MATCH_CHARS = 300;
/**
 * Wall-clock budget for the matching loop. The pattern is model-supplied and V8's backtracking
 * engine can take exponential time on one short line (`^(a+)+$` against 35 `a`s and a `!`), which
 * would block this whole host process. The loop therefore runs under `node:vm`'s `timeout`, whose
 * watchdog terminates the running JavaScript -- including a regex mid-backtrack -- and throws, and
 * the host process stays usable afterwards (verified empirically; pinned by
 * `reviewer-tools-containment.test.ts`). The vm context holds no capability: it only calls back
 * into the scan closure below, so it is purely a deadline, not a sandbox.
 */
const GREP_TIMEOUT_MS = 10_000;

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
  /** maxResults was reached; more matches may exist. */
  truncated: boolean;
  /** The search root holds more than MAX_GREP_FILES_SCANNED files; only the first were searched. */
  fileLimitReached: boolean;
  /** The search hit its time limit after finding `matches`; the rest of the tree is unsearched. */
  timedOut: boolean;
}

/** Collects up to `limit` real (non-symlink) files under `startAbs`. Symlinks -- whether the entry
 *  itself or an intermediate directory -- are never followed, so no per-entry realpath check is
 *  needed here: containment of the search root itself is already enforced by `resolveContained`.
 *
 *  The walk is pre-order with each directory's entries in code-unit name order, so the files kept
 *  under the limit are deterministic, and it stops as soon as a file beyond the limit is seen
 *  rather than walking the whole tree first. */
function collectFiles(startAbs: string, limit: number): { files: string[]; limitReached: boolean } {
  const stat = statSync(startAbs);
  if (stat.isFile()) return { files: [startAbs], limitReached: false };
  if (!stat.isDirectory()) {
    throw new Error('path is neither a file nor a directory');
  }

  const files: string[] = [];
  const stack: Array<{ abs: string; isDir: boolean }> = [{ abs: startAbs, isDir: true }];
  while (stack.length > 0) {
    const next = stack.pop() as { abs: string; isDir: boolean };
    if (!next.isDir) {
      if (files.length >= limit) return { files, limitReached: true };
      files.push(next.abs);
      continue;
    }
    const children = readdirSync(next.abs, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i] as (typeof children)[number];
      stack.push({ abs: join(next.abs, child.name), isDir: child.isDirectory() });
    }
  }
  return { files, limitReached: false };
}

function clipMatchText(line: string): string {
  if (line.length <= MAX_GREP_MATCH_CHARS) return line;
  return `${line.slice(0, MAX_GREP_MATCH_CHARS)} [line clipped: ${line.length} characters total]`;
}

export function grepInRoot(
  root: string,
  params: GrepParams,
  opts: { timeoutMs?: number } = {},
): GrepOutcome {
  const timeoutMs = opts.timeoutMs ?? GREP_TIMEOUT_MS;
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
  const { files, limitReached } = collectFiles(searchRootAbs, MAX_GREP_FILES_SCANNED);

  const matches: GrepMatch[] = [];
  let truncated = false;

  const scan = (): void => {
    for (const file of files) {
      if (statSync(file).size > MAX_GREP_FILE_BYTES) continue;
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\0')) continue; // skip binary files

      const lines = splitLines(content);
      const relFile = relative(resolvedRoot, file);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i] as string)) {
          matches.push({ path: relFile, line: i + 1, text: clipMatchText(lines[i] as string) });
          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }
        }
      }
    }
  };

  let timedOut = false;
  try {
    runInContext('scan()', createContext({ scan }), { timeout: timeoutMs });
  } catch (err) {
    // Matches found before the deadline are still real: return them, marked partial. Only a
    // search that found nothing at all reports the time limit as an error.
    if (errorCode(err) !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw err;
    if (matches.length === 0) {
      throw new Error(
        `council_grep stopped after ${timeoutMs}ms: the pattern is too expensive to evaluate (avoid nested quantifiers such as (a+)+) or the search is too broad; simplify the pattern or narrow path`,
        { cause: err },
      );
    }
    timedOut = true;
  }

  return {
    matches,
    filesScanned: files.length,
    truncated,
    fileLimitReached: limitReached,
    timedOut,
  };
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
  description:
    'Search text content in the reviewed snapshot with a regular expression. Searches at most 5000 files (in path order), skips binary files and files over 2 MB, clips each matching line to 300 characters, and stops a pattern that takes too long to evaluate.',
  parameters: grepParameters,
  async execute(_toolCallId, params) {
    const root = getSnapshotRoot();
    const outcome = grepInRoot(root, (params ?? {}) as GrepParams);
    const lines =
      outcome.matches.length === 0
        ? ['no matches']
        : outcome.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
    if (outcome.truncated) lines.push('[results truncated]');
    if (outcome.timedOut) {
      lines.push(
        '[search stopped at its time limit: results are partial; simplify the pattern or narrow path]',
      );
    }
    if (outcome.fileLimitReached) {
      lines.push(
        `[file limit reached: only the first ${outcome.filesScanned} files were searched; narrow path]`,
      );
    }
    return {
      content: [
        {
          type: 'text',
          text: truncateOutput(lines.join('\n'), 'lower maxResults or narrow the pattern or path'),
        },
      ],
      details: {
        matches: outcome.matches.length,
        filesScanned: outcome.filesScanned,
        truncated: outcome.truncated,
        fileLimitReached: outcome.fileLimitReached,
        timedOut: outcome.timedOut,
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
  budget: { remaining: number; skipped: boolean },
): void {
  if (budget.skipped) return;
  const entries = readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (budget.remaining <= 0) {
      budget.skipped = true;
      return;
    }
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
  // Truncated means an entry was actually left out, not merely that exactly maxEntries exist.
  let truncated: boolean;

  if (params.recursive) {
    const budget = { remaining: maxEntries, skipped: false };
    walk(resolved, '', out, budget);
    truncated = budget.skipped;
  } else {
    const entries = readdirSync(resolved, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries.slice(0, maxEntries)) {
      out.push({ path: entry.name, type: entryType(entry) });
    }
    truncated = entries.length > maxEntries;
  }

  return { entries: out, truncated };
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
    const text = lines.length > 0 ? lines.join('\n') : '(empty)';
    return {
      content: [
        {
          type: 'text',
          text: truncateOutput(text, 'lower maxEntries or list a subdirectory'),
        },
      ],
      details: { entries: outcome.entries.length, truncated: outcome.truncated },
    };
  },
};

// -------------------------------------------------------------------------------------------
// council_git -- against the REAL repository, not the snapshot. See design.md's "History reaches
// reviewers through an allowlist, not through a copied .git".
// -------------------------------------------------------------------------------------------

const GIT_SUBCOMMANDS = ['log', 'show', 'blame', 'diff'] as const;
const DEFAULT_GIT_LOG_MAX_COUNT = 50;
/** A git call that outlives this is killed (SIGKILL: a hung hook or filter may ignore SIGTERM). */
const GIT_TIMEOUT_MS = 60_000;
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
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error('path must not escape the repository root');
  }
}

/** Pseudo-refs other than HEAD (case-insensitively, for case-insensitive filesystems). Each can
 *  name a commit no branch reaches: ORIG_HEAD after a `reset` that discarded an accidental commit,
 *  MERGE_AUTOSTASH a stash, AUTO_MERGE a tree of conflicted working-tree state. */
// git's pseudo-refs other than HEAD, matched on a ref name's last segment so a per-worktree
// spelling (`main-worktree/ORIG_HEAD`, `worktrees/<id>/ORIG_HEAD`) is caught too. An explicit
// list rather than a `*_HEAD` pattern: branches such as `fix_head` are legitimate history.
const PSEUDO_REFS: ReadonlySet<string> = new Set([
  'ORIG_HEAD',
  'FETCH_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_HEAD',
  'REBASE_HEAD',
  'AUTO_MERGE',
  'MERGE_AUTOSTASH',
]);

// `@{u}` / `@{upstream}` / `@{push}` name a branch's configured remote-tracking branch, not a
// reflog entry, so they are the one `@{...}` form a revision may keep.
const TRACKING_SUFFIX = /@\{(?:u|upstream|push)\}/gi;

/**
 * A revision may name only history a branch, tag, remote or HEAD reaches. Rejected, because each
 * reaches content that was never committed to that history:
 *  - the stash (`stash`, `refs/stash`, compared case-insensitively): `git stash -u`/`--all`
 *    records untracked and *ignored* files (`.env`) as the stash's third parent, so
 *    `stash^3:.env` would read a file the snapshot deliberately excluded;
 *  - reflog syntax (`@{`): `stash@{n}`, and `HEAD@{n}` reaching commits a `reset` discarded;
 *  - `:/<text>`: finds the youngest commit whose message matches, searched from *every* ref,
 *    `refs/stash` included (`:/untracked files on` is the stash's untracked-files commit);
 *  - pseudo-refs other than HEAD (see PSEUDO_REFS).
 * Every endpoint of a `A..B`/`A...B` range and a `^A` exclusion is checked; the ref name is the
 * part before any `~`, `^` or `:` suffix. What stays reachable: a commit id, HEAD/`@`, branches,
 * tags, remote branches, ranges, and `^{/text}` (which searches only the given commit's
 * ancestors). A stash commit named by its raw object id is not caught here; nothing this tool
 * returns lists one once the names above are refused.
 */
function assertRevisionAllowed(revision: string): void {
  if (revision.replace(TRACKING_SUFFIX, '').includes('@{')) {
    throw new Error('revision must not use reflog syntax (@{...})');
  }
  if (revision.includes(':/')) {
    throw new Error('revision must not use a :/ commit-message search');
  }
  for (const endpoint of revision.split(/\.\.\.?/)) {
    const name = endpoint.replace(/^\^+/, '').split(/[~^:]/, 1)[0] as string;
    const lower = name.replace(TRACKING_SUFFIX, '').toLowerCase();
    if (lower === 'stash' || lower === 'refs/stash' || lower.endsWith('/refs/stash')) {
      throw new Error('revision must not reference the stash');
    }
    if (PSEUDO_REFS.has((lower.split('/').pop() as string).toUpperCase())) {
      throw new Error(`revision must not reference the pseudo-ref ${name}`);
    }
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
  //
  // HOME passes through to reviewers, so the user's own git config applies: `diff.external` and a
  // `textconv` driver would each run an arbitrary configured command and replace the real diff
  // text. `--no-ext-diff`/`--no-textconv` switch both off (blame knows only `--no-textconv`).
  const argv: string[] =
    subcommand === 'blame'
      ? [subcommand, '--no-textconv']
      : [subcommand, '--no-color', '--no-ext-diff', '--no-textconv'];

  if (params.maxCount !== undefined && subcommand !== 'log') {
    throw new Error('maxCount is only supported for log');
  }
  if (subcommand === 'log') {
    argv.push(
      `--max-count=${clampInt(params.maxCount, DEFAULT_GIT_LOG_MAX_COUNT, 1, 500, 'maxCount')}`,
    );
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
    assertRevisionAllowed(params.revision);
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

export function runGitHistory(
  repoRoot: string,
  params: GitParams,
  opts: { timeoutMs?: number } = {},
): string {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const argv = buildGitArgv(params);
  const hint = 'narrow with a revision range, a path, or a lower maxCount';
  try {
    const output = execFileSync('git', argv, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_EXEC_BUFFER_BYTES,
    });
    return truncateOutput(output, hint);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOBUFS') {
      return truncateOutput(execPartialStdout(err), hint, { incomplete: true });
    }
    if (code === 'ETIMEDOUT') {
      throw new Error(
        `git ${String(params.subcommand)} timed out after ${timeoutMs}ms; ${hint} and try again`,
        { cause: err },
      );
    }
    throw new Error(`git ${String(params.subcommand)} failed: ${execErrorMessage(err)}`, {
      cause: err,
    });
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
        'A single revision or revision range (e.g. "HEAD", "abc1234", "main..feature"). Optional for log/diff/blame; defaults to HEAD for show. The stash, reflog syntax (@{...}), :/ message searches and pseudo-refs such as ORIG_HEAD are refused.',
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
    'Query read-only history of the real repository: log, show, blame or diff. No other git operation is available. This runs against the live repository, not the frozen snapshot the other tools read: without a revision, diff compares the live working tree with the index and blame annotates the live working-tree file, either of which may have changed since the snapshot was taken (so their line numbers may not match council_read). Pass a revision for a stable answer.',
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
        argv.push('--max-files', String(requireInt(params.maxFiles, 1, 50, 'maxFiles')));
      }
      break;
    }
    case 'query': {
      argv.push(codegraphStringField('query', params.query));
      if (params.limit !== undefined) {
        argv.push('--limit', String(requireInt(params.limit, 1, 100, 'limit')));
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
        argv.push('--offset', String(requireInt(params.offset, 1, 1_000_000, 'offset')));
      }
      if (params.limit !== undefined) {
        if (!hasFile) {
          throw new Error('limit is only supported with file');
        }
        argv.push('--limit', String(requireInt(params.limit, 1, 1000, 'limit')));
      }
      break;
    }
    case 'callers':
    case 'callees': {
      argv.push(codegraphStringField('symbol', params.symbol));
      if (params.limit !== undefined) {
        argv.push('--limit', String(requireInt(params.limit, 1, 100, 'limit')));
      }
      break;
    }
    case 'impact': {
      argv.push(codegraphStringField('symbol', params.symbol));
      if (params.depth !== undefined) {
        argv.push('--depth', String(requireInt(params.depth, 1, 10, 'depth')));
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
        argv.push('--depth', String(requireInt(params.depth, 1, 10, 'depth')));
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
  const hint = 'narrow the query to a more specific symbol, file, or lower limit';
  try {
    const output = execFileSync(getCodegraphBin(), argv, {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_EXEC_BUFFER_BYTES,
    });
    return truncateOutput(output, hint);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOBUFS') {
      return truncateOutput(execPartialStdout(err), hint, { incomplete: true });
    }
    if (code === 'ETIMEDOUT') {
      throw new Error(
        `codegraph ${String(params.subcommand)} timed out after ${timeoutMs}ms; narrow the query to a more specific symbol or file and try again`,
        { cause: err },
      );
    }
    throw new Error(`codegraph ${String(params.subcommand)} failed: ${execErrorMessage(err)}`, {
      cause: err,
    });
  }
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
