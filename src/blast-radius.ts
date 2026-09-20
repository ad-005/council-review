/**
 * Deterministic, model-free blast-radius computation for a review run.
 *
 * The blast-radius step runs once per run (after the snapshot index is built, before any
 * reviewer launches) and maps the changed code to the symbols it touches: for each traced
 * symbol its direct callers, its transitive impact, and — for the changed files as a whole —
 * the affected tests. The rendered block is embedded verbatim in every reviewer's initial
 * prompt so all reviewers share the identical map.
 *
 * Contract (mirrors `codegraph.ts` indexing): best-effort, never fails the run. Every
 * failure degrades to "no block" (or a partial block where a per-file fallback applies) with
 * a machine-readable `BlastRadiusReason`. No model call, no clock read, no randomness; all
 * listings are sorted (codepoint order) before capping and rendering, so the same patch
 * against the same index always produces the same block.
 *
 * This module shells to the local `codegraph` binary via `execFile` with an argument array
 * (never a shell string) and builds its own argv: it must never import
 * `src/reviewer-tools.ts` (security boundary — that file loads into a foreign reviewer
 * process). The small argv-validation duplication is the established pattern (cf. the
 * `codegraphDbPath` literal). `-j/--json` shapes consumed here were verified against
 * codegraph v1.6.0 (see `test/live/codegraph-binary.test.ts`, which pins them).
 */
import { execFile } from 'node:child_process';
import { isAbsolute, normalize, sep } from 'node:path';
import { promisify } from 'node:util';

import { resolveCodegraphBin } from './codegraph.js';
import { BLAST_RADIUS_DEFAULTS } from './config.js';
import type { ResolvedScope } from './scope.js';

// -------------------------------------------------------------------------------------------
// Caps and defaults (`codegraph.blastRadius` config in `src/config.ts` is the source of
// truth for depth/maxSymbols/maxBlockChars; the constants below are the non-configurable
// query tunables)
// -------------------------------------------------------------------------------------------

/** Maximum callers shown per symbol at render time. */
export const BLAST_RADIUS_CALLERS_LIMIT = 20;

/** `--limit` passed to every `callers` query: one past the render cap, so a full page
 *  proves truncation and the block can disclose it instead of rendering a truncated
 *  list as complete. The binary reports no total count, so this detects truncation
 *  honestly without claiming an exact hidden remainder. */
export const BLAST_RADIUS_CALLERS_QUERY_LIMIT = BLAST_RADIUS_CALLERS_LIMIT + 1;

/** `impact` is traced when a symbol's caller count exceeds this, or when the symbol's kind
 *  marks it as shared surface (see `IMPACT_ALWAYS_KINDS`). Keeps the common small-change
 *  case to one query per symbol. */
export const BLAST_RADIUS_IMPACT_CALLER_THRESHOLD = 2;

/** Symbol kinds treated as exported/shared surface: `impact` is always traced for these,
 *  even with few direct callers. */
export const IMPACT_ALWAYS_KINDS: ReadonlySet<string> = new Set([
  'class',
  'function',
  'interface',
  'type',
  'enum',
]);

/** Per-query subprocess timeout. */
export const BLAST_RADIUS_QUERY_TIMEOUT_MS = 60_000;

/** Maximum concurrent `codegraph` subprocesses. */
export const BLAST_RADIUS_CONCURRENCY = 4;

// Same generous buffer as `codegraph.ts`: query output must never be truncated by Node's
// default 1MB buffer (a truncated JSON payload would misreport as `parse-failed`).
const QUERY_MAX_BUFFER = 1024 * 1024 * 256;

// -------------------------------------------------------------------------------------------
// Small deterministic helpers
// -------------------------------------------------------------------------------------------

/** Codepoint string order. Deliberately not `localeCompare`: ICU/locale differences between
 *  machines must not change the block. */
function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRefs(a: CodeRef, b: CodeRef): number {
  return (
    compareStr(a.filePath, b.filePath) ||
    a.startLine - b.startLine ||
    compareStr(a.kind, b.kind) ||
    compareStr(a.name, b.name)
  );
}

function compareSymbols(a: ChangedSymbol, b: ChangedSymbol): number {
  return compareStr(a.file, b.file) || a.startLine - b.startLine || compareStr(a.name, b.name);
}

// -------------------------------------------------------------------------------------------
// 1.1 Patch-hunk parser
// -------------------------------------------------------------------------------------------

export type PatchFileStatus = 'modified' | 'added' | 'deleted' | 'renamed';

export interface PatchHunk {
  /** 1-based start line on the new-file (+) side. 0 for a pure context-less deletion hunk
   *  (`+0,0`), which maps to no end-state symbol. */
  start: number;
  /** Number of new-side lines in the hunk (0 for deletion-only hunks). */
  count: number;
}

export interface PatchFile {
  /** Post-image path, or the pre-image path for deleted files. */
  path: string;
  /** Pre-image path. */
  oldPath: string;
  status: PatchFileStatus;
  hunks: PatchHunk[];
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Strips git's `a/`/`b/` prefix and one layer of C-style double quotes (plain paths with
 *  spaces; full octal-escape decoding is out of scope — such paths still map consistently
 *  because the same spelling flows to both the index query and the rendered block). */
function stripDiffPrefix(value: string, prefix: 'a/' | 'b/'): string {
  let v = value;
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    v = v.slice(1, -1);
  }
  if (v.startsWith(prefix)) {
    v = v.slice(prefix.length);
  }
  return v;
}

interface MutablePatchFile {
  oldPath: string;
  newPath: string;
  newFile: boolean;
  deletedFile: boolean;
  renamed: boolean;
  /** Set once the first `@@` header is seen; `---`/`+++` lines after that point are
   *  hunk content, never path headers. */
  seenHunk: boolean;
  hunks: PatchHunk[];
}

function finishPatchFile(current: MutablePatchFile | null, out: PatchFile[]): void {
  if (current === null) return;
  const deleted = current.deletedFile || current.newPath === '/dev/null';
  const added = !deleted && (current.newFile || current.oldPath === '/dev/null');
  const renamed = !deleted && !added && (current.renamed || current.oldPath !== current.newPath);
  const status: PatchFileStatus = deleted
    ? 'deleted'
    : added
      ? 'added'
      : renamed
        ? 'renamed'
        : 'modified';
  out.push({
    path: deleted ? current.oldPath : current.newPath,
    oldPath: current.oldPath,
    status,
    hunks: current.hunks,
  });
}

/**
 * Parses a unified `git diff` into per-file paths, hunk ranges, and change kinds. Pure
 * function of its input. Handles new files (`--- /dev/null`), deleted files
 * (`+++ /dev/null`), renames (`rename from/to` or differing `---`/`+++` paths), binary
 * diffs (emitted with zero hunks so they still feed the `affected` query), and multi-hunk
 * files. Only headers are inspected, and `---`/`+++` path headers are only accepted
 * before the first hunk header of each file section (real headers always precede the
 * hunks, including `/dev/null` ones): a deleted `-- x` or added `++ y` content line
 * would otherwise mimic a path header once prefixed with `-`/`+` and corrupt the paths.
 */
export function parsePatchHunks(patch: string): PatchFile[] {
  const out: PatchFile[] = [];
  let current: MutablePatchFile | null = null;
  for (const rawLine of patch.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('diff --git ')) {
      finishPatchFile(current, out);
      const rest = line.slice('diff --git '.length).trim();
      // Paths may be quoted when they contain spaces; split carefully.
      const tokens = rest.match(/"[^"]*"|\S+/g) ?? [];
      const oldTok = tokens[0] ?? '';
      const newTok = tokens[1] ?? '';
      current = {
        oldPath: stripDiffPrefix(oldTok, 'a/'),
        newPath: stripDiffPrefix(newTok, 'b/'),
        newFile: false,
        deletedFile: false,
        renamed: false,
        seenHunk: false,
        hunks: [],
      };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('new file mode')) {
      current.newFile = true;
    } else if (line.startsWith('deleted file mode')) {
      current.deletedFile = true;
    } else if (line.startsWith('rename from ')) {
      current.renamed = true;
      current.oldPath = stripDiffPrefix(line.slice('rename from '.length).trim(), 'a/');
    } else if (line.startsWith('rename to ')) {
      current.renamed = true;
      current.newPath = stripDiffPrefix(line.slice('rename to '.length).trim(), 'b/');
    } else if (line.startsWith('--- ') && !current.seenHunk) {
      const p = stripDiffPrefix(line.slice(4).trim().split('\t')[0] as string, 'a/');
      current.oldPath = p;
    } else if (line.startsWith('+++ ') && !current.seenHunk) {
      const p = stripDiffPrefix(line.slice(4).trim().split('\t')[0] as string, 'b/');
      current.newPath = p;
    } else {
      const hunk = HUNK_HEADER_RE.exec(line);
      if (hunk) {
        current.seenHunk = true;
        current.hunks.push({
          start: Number(hunk[1]),
          count: hunk[2] === undefined ? 1 : Number(hunk[2]),
        });
      }
    }
  }
  finishPatchFile(current, out);
  return out;
}

// -------------------------------------------------------------------------------------------
// 1.2 Symbols-only map parser
// -------------------------------------------------------------------------------------------

export interface FileSymbol {
  name: string;
  kind: string;
  startLine: number;
}

export type SymbolsOnlyParse =
  | { status: 'ok'; symbols: FileSymbol[]; dependents: string[] }
  | { status: 'not-in-index' }
  | { status: 'malformed' };

const SYMBOLS_SECTION_RE = /^\*\*Symbols\*\*\s*$/;
// `- `Foo` (class) — :1` — signature fragments may sit between kind and `— :LINE`.
const SYMBOL_LINE_RE = /^-\s+`([^`]+)`\s+\(([^)]+)\)\s+.*—\s*:(\d+)\s*$/;
const NOT_IN_INDEX_RE = /No indexed file matches/;
const USED_BY_RE = /used by \d+ files?:\s*(.+?)\s*$/;

/**
 * Parses `codegraph node --file <rel> --symbols-only` (text; the one subcommand with no
 * JSON mode). `not-in-index` (the binary's `No indexed file matches` message) and
 * `malformed` are distinct: the former names a removed/unindexed file, the latter degrades
 * that file to a file-level entry while other files keep symbol granularity. Unparseable
 * lines inside an otherwise well-formed map are ignored for forward compatibility; only a
 * map with no `**Symbols**` section at all is `malformed`.
 */
export function parseSymbolsOnlyMap(output: string): SymbolsOnlyParse {
  if (NOT_IN_INDEX_RE.test(output)) {
    return { status: 'not-in-index' };
  }
  const lines = output.split('\n');
  if (!lines.some((l) => SYMBOLS_SECTION_RE.test(l.trim()))) {
    return { status: 'malformed' };
  }
  const symbols: FileSymbol[] = [];
  const dependents: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const sym = SYMBOL_LINE_RE.exec(line);
    if (sym) {
      symbols.push({
        name: sym[1] as string,
        kind: sym[2] as string,
        startLine: Number(sym[3]),
      });
      continue;
    }
    const usedBy = USED_BY_RE.exec(line);
    if (usedBy) {
      for (const dep of (usedBy[1] as string).split(',')) {
        const trimmed = dep.trim();
        if (trimmed.length > 0) dependents.push(trimmed);
      }
    }
  }
  symbols.sort((a, b) => a.startLine - b.startLine || compareStr(a.name, b.name));
  dependents.sort(compareStr);
  return { status: 'ok', symbols, dependents: [...new Set(dependents)] };
}

export interface ChangedSymbol {
  name: string;
  kind: string;
  file: string;
  startLine: number;
}

/**
 * Maps each hunk to its enclosing symbol: the last symbol with
 * `startLine <= hunk.start` in the same file (end lines are inferred positionally, so a
 * hunk above the first symbol maps to nothing). Deduped and sorted by
 * (file, startLine, name).
 */
export function mapHunksToSymbols(
  file: string,
  hunks: readonly PatchHunk[],
  symbols: readonly FileSymbol[],
): ChangedSymbol[] {
  const sorted = [...symbols].sort((a, b) => a.startLine - b.startLine);
  const seen = new Set<string>();
  const out: ChangedSymbol[] = [];
  for (const hunk of hunks) {
    let enclosing: FileSymbol | null = null;
    for (const sym of sorted) {
      if (sym.startLine <= hunk.start) enclosing = sym;
      else break;
    }
    if (enclosing === null) continue;
    const key = `${enclosing.startLine}\0${enclosing.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: enclosing.name,
      kind: enclosing.kind,
      file,
      startLine: enclosing.startLine,
    });
  }
  out.sort(compareSymbols);
  return out;
}

// -------------------------------------------------------------------------------------------
// 1.3 CLI-side argv builder (never imports reviewer-tools.ts) + JSON parsing
// -------------------------------------------------------------------------------------------

function assertArgValue(label: string, value: string): void {
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

/** Lexical-only repo-relative check: absolute paths and `..` escapes are rejected without
 *  touching the filesystem (deleted files legitimately have no on-disk target). */
function assertIndexPath(label: string, value: string): void {
  assertArgValue(label, value);
  if (isAbsolute(value)) {
    throw new Error(`${label} must be snapshot-relative, not absolute`);
  }
  const normalized = normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.startsWith(sep)) {
    throw new Error(`${label} must not escape the snapshot root`);
  }
}

/** Non-throwing probe around `assertIndexPath` for partitioning data-dependent paths
 *  (from the diff) into queryable vs degraded-without-spawning. */
function isQueryablePath(value: string): boolean {
  try {
    assertIndexPath('files entry', value);
    return true;
  } catch {
    return false;
  }
}

function assertRoot(label: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain a NUL byte`);
  }
}

function assertPositiveInt(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

/** `node --file <rel> --symbols-only`: the per-file symbol map (text output). */
export function buildNodeSymbolsOnlyArgv(snapshotRoot: string, relPath: string): string[] {
  assertRoot('snapshotRoot', snapshotRoot);
  assertIndexPath('file', relPath);
  return ['node', '-p', snapshotRoot, '--file', relPath, '--symbols-only'];
}

/** `callers -j`: direct callers of one symbol as JSON. Name-only: codegraph v1.6.0
 *  accepts no file scope for `callers` (verified empirically — no flag, no
 *  `file:symbol` syntax), so same-named symbols elsewhere merge into the result. */
export function buildCallersArgv(
  snapshotRoot: string,
  symbol: string,
  limit: number = BLAST_RADIUS_CALLERS_LIMIT,
): string[] {
  assertRoot('snapshotRoot', snapshotRoot);
  assertArgValue('symbol', symbol);
  assertPositiveInt('limit', limit);
  return ['callers', '-p', snapshotRoot, symbol, '-j', '--limit', String(limit)];
}

/** `impact -j`: transitive impact of one symbol as JSON. Name-only, like `callers`:
 *  no file scope exists, so same-named symbols elsewhere merge into the result. */
export function buildImpactArgv(snapshotRoot: string, symbol: string, depth: number): string[] {
  assertRoot('snapshotRoot', snapshotRoot);
  assertArgValue('symbol', symbol);
  assertPositiveInt('depth', depth);
  return ['impact', '-p', snapshotRoot, symbol, '-j', '--depth', String(depth)];
}

/** `affected -j`: affected tests for all changed files in one call. */
export function buildAffectedArgv(snapshotRoot: string, files: readonly string[]): string[] {
  assertRoot('snapshotRoot', snapshotRoot);
  for (const f of files) assertIndexPath('files entry', f);
  return ['affected', '-p', snapshotRoot, ...files, '-j'];
}

export interface CodeRef {
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
}

export type RefsParse =
  { status: 'ok'; refs: CodeRef[] } | { status: 'not-found' } | { status: 'malformed' };

export type AffectedParse =
  { status: 'ok'; changedFiles: string[]; affectedTests: string[] } | { status: 'malformed' };

// The binary answers an unknown symbol on stdout with exit 0, e.g.
// `ℹ Symbol "foo" not found` — never JSON, never an error.
const SYMBOL_NOT_FOUND_RE = /Symbol ".+" not found/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseRefArray(value: unknown): CodeRef[] | null {
  if (!Array.isArray(value)) return null;
  const out: CodeRef[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const { name, kind, filePath, startLine } = entry;
    if (typeof name !== 'string' || name.length === 0) return null;
    if (typeof kind !== 'string' || kind.length === 0) return null;
    if (typeof filePath !== 'string' || filePath.length === 0) return null;
    if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
      return null;
    }
    out.push({ name, kind, filePath, startLine });
  }
  return out;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
  }
  return [...(value as string[])];
}

/** Parses `callers -j` (`{ symbol, callers: [...] }`). Unknown symbols yield `not-found`,
 *  not `malformed`. */
export function parseCallersJson(output: string): RefsParse {
  if (SYMBOL_NOT_FOUND_RE.test(output)) return { status: 'not-found' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { status: 'malformed' };
  }
  if (!isRecord(parsed)) return { status: 'malformed' };
  const refs = parseRefArray(parsed.callers);
  if (refs === null) return { status: 'malformed' };
  return { status: 'ok', refs };
}

/** Parses `impact -j` (`{ symbol, depth, ..., affected: [...] }`). */
export function parseImpactJson(output: string): RefsParse {
  if (SYMBOL_NOT_FOUND_RE.test(output)) return { status: 'not-found' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { status: 'malformed' };
  }
  if (!isRecord(parsed)) return { status: 'malformed' };
  const refs = parseRefArray(parsed.affected);
  if (refs === null) return { status: 'malformed' };
  return { status: 'ok', refs };
}

/** Parses `affected -j` (`{ changedFiles: [...], affectedTests: [...] }`). Unknown files
 *  simply contribute no tests — there is no not-found shape. */
export function parseAffectedJson(output: string): AffectedParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { status: 'malformed' };
  }
  if (!isRecord(parsed)) return { status: 'malformed' };
  const changedFiles = parseStringArray(parsed.changedFiles);
  const affectedTests = parseStringArray(parsed.affectedTests);
  if (changedFiles === null || affectedTests === null) return { status: 'malformed' };
  return { status: 'ok', changedFiles, affectedTests };
}

// -------------------------------------------------------------------------------------------
// 1.4 Filtering, caps, rendering
// -------------------------------------------------------------------------------------------

/**
 * Best-effort filtering for one symbol's refs (callers or impact nodes):
 * - drops same-name symbols from other files (ambiguous with this symbol's own
 *   definition; a same-name ref only counts with a file match),
 * - drops file-level-only (`kind: 'file'`) refs unless nothing else references the
 *   symbol, in which case they are kept rather than reporting zero refs,
 * - dedupes and sorts (codepoint order) for determinism.
 *
 * Residual over-approximation, stated explicitly: the queries are name-only —
 * codegraph v1.6.0 offers no file scoping for `callers`/`impact` (verified empirically:
 * no flag, no `file:symbol` syntax) and the JSON exposes no resolved definition site
 * for caller refs, which carry caller identity only. When two files define the same
 * symbol name, their callers merge indistinguishably and this filter cannot attribute
 * them, so the block over-approximates by design. Only same-name definition entries
 * (notably `impact` root nodes) are attributable, via the file match above.
 */
export function filterRefs(
  refs: readonly CodeRef[],
  opts: { symbolName: string; symbolFile: string },
): CodeRef[] {
  const disambiguated = refs.filter(
    (r) => !(r.name === opts.symbolName && r.filePath !== opts.symbolFile),
  );
  const nonFile = disambiguated.filter((r) => r.kind !== 'file');
  const kept = nonFile.length > 0 ? nonFile : disambiguated;
  const seen = new Set<string>();
  const deduped: CodeRef[] = [];
  for (const r of kept) {
    const key = `${r.kind}\0${r.filePath}\0${r.startLine}\0${r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  deduped.sort(compareRefs);
  return deduped;
}

/**
 * Whether `impact` is worth tracing for a symbol: always for shared-surface kinds, or
 * when the caller count exceeds the threshold (narrowly-referenced private symbols keep
 * the run to one query each).
 */
export function shouldTraceImpact(
  symbol: Pick<ChangedSymbol, 'kind'>,
  callerCount: number,
): boolean {
  if (IMPACT_ALWAYS_KINDS.has(symbol.kind)) return true;
  return callerCount > BLAST_RADIUS_IMPACT_CALLER_THRESHOLD;
}

export type SymbolQueryFailure = 'query-failed' | 'parse-failed';

export interface SymbolBlast {
  symbol: ChangedSymbol;
  /** Filtered direct callers. Null when the callers query itself failed. */
  callers: CodeRef[] | null;
  /** True when the callers query returned a full page (`BLAST_RADIUS_CALLERS_QUERY_LIMIT`
   *  raw refs), proving truncation: more callers may exist beyond those listed. */
  callersTruncated?: boolean;
  /** Filtered transitive impact, minus the symbol's own root entry. Null when impact was
   *  not traced (below threshold) or its query failed — see `impactTraced`/`failure`. */
  impact: CodeRef[] | null;
  impactTraced: boolean;
  /** Set when a per-symbol query failed; the symbol still renders with an in-block note. */
  failure?: SymbolQueryFailure;
}

export interface FileFallbackBlast {
  file: string;
  /** Best-effort dependents from the symbol-map header; empty when unknown. */
  dependents: string[];
}

export interface RenderInput {
  symbols: readonly SymbolBlast[];
  fileFallbacks: readonly FileFallbackBlast[];
  removedSymbols: readonly ChangedSymbol[];
  /** Files deleted by the patch. */
  removedFiles: readonly string[];
  /** Files present in the patch but absent from the index (not deleted). */
  unindexedFiles: readonly string[];
  affectedTests: readonly string[];
  /** `affected` query outcome when no test list could be produced. */
  affectedFailure?: SymbolQueryFailure;
  /** Symbols cut by `maxSymbols` (sorted first, so these are the trailing ones). */
  omittedSymbols: number;
  omittedTests?: number;
  depth: number;
  maxBlockChars: number;
}

function formatRef(r: CodeRef): string {
  return `\`${r.name}\` (${r.kind}) ${r.filePath}:${r.startLine}`;
}

function formatSymbol(s: ChangedSymbol): string {
  return `\`${s.name}\` (${s.kind}) ${s.file}:${s.startLine}`;
}

function renderRefList(refs: readonly CodeRef[], cap: number, truncated = false): string {
  if (refs.length === 0) return truncated ? 'none (+more)' : 'none';
  const shown = refs.slice(0, cap);
  const extra = refs.length - shown.length;
  const text = shown.map(formatRef).join('; ');
  if (extra > 0) {
    // An exact `(+N more)` would understate when the query itself truncated: the
    // binary reports no total count, so the hidden remainder is only bounded below.
    return truncated ? `${text} (+${extra} more, truncated)` : `${text} (+${extra} more)`;
  }
  return truncated ? `${text} (+more)` : text;
}

/**
 * Renders the blast-radius block: compact text with `file:line` anchors. Inputs are
 * re-sorted defensively so rendering is a pure, deterministic function. Overflow (symbol
 * cap) and removals are disclosed in-block; when the rendered text exceeds
 * `maxBlockChars` it is truncated to exactly the cap with a trailing truncation note.
 */
export function renderBlastRadiusBlock(input: RenderInput): string {
  const lines: string[] = ['## Deterministic blast-radius map'];
  const symbols = [...input.symbols].sort((a, b) => compareSymbols(a.symbol, b.symbol));
  const fallbacks = [...input.fileFallbacks].sort((a, b) => compareStr(a.file, b.file));
  const removedSymbols = [...input.removedSymbols].sort(compareSymbols);
  const removedFiles = [...input.removedFiles].sort(compareStr);
  const unindexedFiles = [...input.unindexedFiles].sort(compareStr);
  const affectedTests = [...input.affectedTests].sort(compareStr);

  const hasContent =
    symbols.length > 0 ||
    fallbacks.length > 0 ||
    removedSymbols.length > 0 ||
    removedFiles.length > 0 ||
    unindexedFiles.length > 0 ||
    affectedTests.length > 0 ||
    input.affectedFailure !== undefined;

  if (!hasContent) {
    lines.push('No traceable symbols, dependents, or affected tests for this change.');
    return lines.join('\n');
  }

  if (symbols.length > 0 || input.omittedSymbols > 0) {
    const total = symbols.length + input.omittedSymbols;
    const header =
      input.omittedSymbols > 0
        ? `Changed symbols (${symbols.length} of ${total}; ${input.omittedSymbols} omitted):`
        : `Changed symbols (${symbols.length}):`;
    lines.push(header);
    for (const s of symbols) {
      lines.push(`- ${formatSymbol(s.symbol)}`);
      if (s.callers === null) {
        lines.push(
          `  callers: unavailable (${s.failure === 'parse-failed' ? 'unparsable output' : 'query failed'})`,
        );
      } else {
        lines.push(
          `  callers (${s.callers.length}): ${renderRefList(s.callers, BLAST_RADIUS_CALLERS_LIMIT, s.callersTruncated === true)}`,
        );
      }
      if (!s.impactTraced && s.failure === undefined) {
        lines.push('  impact: not traced (below threshold)');
      } else if (s.impact === null) {
        lines.push(
          `  impact: unavailable (${s.failure === 'parse-failed' ? 'unparsable output' : 'query failed'})`,
        );
      } else {
        lines.push(
          `  impact (depth ${input.depth}, ${s.impact.length}): ${renderRefList(s.impact, BLAST_RADIUS_CALLERS_LIMIT)}`,
        );
      }
    }
  }

  if (fallbacks.length > 0) {
    lines.push(`File-level (symbol map unavailable) (${fallbacks.length}):`);
    for (const f of fallbacks) {
      const deps = [...f.dependents].sort(compareStr);
      lines.push(deps.length > 0 ? `- ${f.file} (dependents: ${deps.join(', ')})` : `- ${f.file}`);
    }
  }

  const removedCount = removedSymbols.length + removedFiles.length + unindexedFiles.length;
  if (removedCount > 0) {
    lines.push(
      `Removed entries (references are not computable from this index) (${removedCount}):`,
    );
    for (const s of removedSymbols) {
      lines.push(`- ${formatSymbol(s)} (removed symbol)`);
    }
    for (const f of removedFiles) {
      lines.push(`- ${f} (deleted file)`);
    }
    for (const f of unindexedFiles) {
      lines.push(`- ${f} (not in index)`);
    }
  }

  if (input.affectedFailure !== undefined) {
    lines.push(
      `Affected tests: unavailable (${input.affectedFailure === 'parse-failed' ? 'unparsable output' : 'query failed'})`,
    );
  } else {
    lines.push(
      affectedTests.length > 0
        ? `Affected tests (${affectedTests.length}): ${affectedTests.join(', ')}`
        : 'Affected tests (0): none',
    );
  }

  const full = lines.join('\n');
  if (full.length <= input.maxBlockChars) return full;
  const note = `\n[block truncated to ${input.maxBlockChars} chars]`;
  if (input.maxBlockChars <= note.length) return note.slice(0, input.maxBlockChars);
  return full.slice(0, input.maxBlockChars - note.length) + note;
}

// -------------------------------------------------------------------------------------------
// 1.5 Orchestration
// -------------------------------------------------------------------------------------------

export type BlastRadiusReason =
  'disabled' | 'index-unavailable' | 'query-failed' | 'parse-failed' | 'empty';

export interface BlastRadiusStats {
  /** Traced changed symbols rendered in the block (excludes removed/file-level entries). */
  symbols: number;
  /** Total callers listed across traced symbols. */
  callers: number;
  /** Affected tests listed. */
  tests: number;
}

export interface BlastRadiusResult {
  available: boolean;
  reason?: BlastRadiusReason;
  /** The rendered block, or '' when unavailable. */
  block: string;
  stats: BlastRadiusStats;
}

export interface ComputeBlastRadiusOptions {
  enabled?: boolean;
  indexAvailable?: boolean;
  bin?: string;
  depth?: number;
  maxSymbols?: number;
  maxBlockChars?: number;
  timeoutMs?: number;
  concurrency?: number;
}

const ZERO_STATS: BlastRadiusStats = { symbols: 0, callers: 0, tests: 0 };

const execFileAsync = promisify(execFile);

type QueryOutcome = { status: 'ok'; stdout: string } | { status: 'spawn-failed' };

async function runBlastQuery(
  bin: string,
  argv: string[],
  snapshotRoot: string,
  timeoutMs: number,
): Promise<QueryOutcome> {
  try {
    const { stdout } = await execFileAsync(bin, argv, {
      cwd: snapshotRoot,
      timeout: timeoutMs,
      maxBuffer: QUERY_MAX_BUFFER,
      // Mirror `codegraph.ts`: a timed-out query must actually be dead before the next
      // query reuses the index.
      killSignal: 'SIGKILL',
    });
    return { status: 'ok', stdout };
  } catch {
    // Binary missing, timeout, nonzero exit, signal: all degrade identically. The
    // distinguishing detail (stderr text, errno) is deliberately not surfaced — the
    // contract promises a stable reason enum, not diagnostics.
    return { status: 'spawn-failed' };
  }
}

/** Bounded-concurrency map preserving input order (completion order is timing-dependent
 *  and must never leak into the output). */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const workers: Promise<void>[] = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Computes the blast radius for one run. Never throws for a blast-radius outcome: every
 * spawn failure, timeout, and parse failure degrades to a reason (or, where a per-file /
 * per-symbol fallback applies, to a partial block with an in-block note), as do
 * data-dependent argv-validation failures (odd paths from the diff, odd symbol names
 * from the index). Throws only for caller bugs (invalid snapshot root / options),
 * matching `buildCodegraphArgv`'s validate-then-spawn precedent.
 */
export async function computeBlastRadius(
  snapshotRoot: string,
  scope: ResolvedScope,
  opts: ComputeBlastRadiusOptions = {},
): Promise<BlastRadiusResult> {
  assertRoot('snapshotRoot', snapshotRoot);
  if (opts.enabled === false) {
    return { available: false, reason: 'disabled', block: '', stats: { ...ZERO_STATS } };
  }
  if (opts.indexAvailable === false) {
    return { available: false, reason: 'index-unavailable', block: '', stats: { ...ZERO_STATS } };
  }

  const depth = opts.depth ?? BLAST_RADIUS_DEFAULTS.depth;
  const maxSymbols = opts.maxSymbols ?? BLAST_RADIUS_DEFAULTS.maxSymbols;
  const maxBlockChars = opts.maxBlockChars ?? BLAST_RADIUS_DEFAULTS.maxBlockChars;
  const timeoutMs = opts.timeoutMs ?? BLAST_RADIUS_QUERY_TIMEOUT_MS;
  const concurrency = opts.concurrency ?? BLAST_RADIUS_CONCURRENCY;
  assertPositiveInt('depth', depth);
  assertPositiveInt('maxSymbols', maxSymbols);
  assertPositiveInt('maxBlockChars', maxBlockChars);
  assertPositiveInt('timeoutMs', timeoutMs);
  assertPositiveInt('concurrency', concurrency);
  const bin = opts.bin ?? resolveCodegraphBin();

  const patchFiles = parsePatchHunks(scope.patch);
  const removedFiles: string[] = [];
  const queryFiles: PatchFile[] = [];
  for (const f of patchFiles) {
    if (f.status === 'deleted') removedFiles.push(f.path);
    else queryFiles.push(f);
  }
  queryFiles.sort((a, b) => compareStr(a.path, b.path));
  removedFiles.sort(compareStr);

  let anyQueryOk = false;
  let anySpawnFailed = false;

  // Per-file symbol maps (bounded concurrency). A malformed map — or a failed spawn —
  // degrades that file to a file-level entry, never the whole step.
  const fileOutcomes = await mapBounded(queryFiles, concurrency, async (f) => {
    let argv: string[];
    try {
      argv = buildNodeSymbolsOnlyArgv(snapshotRoot, f.path);
    } catch {
      // Data-dependent validation failure (an odd path from the diff, e.g. one
      // starting with `-`): snapshotRoot was validated above, so only the path can
      // throw here. Degrade exactly like a spawn failure — per-file fallback, never
      // a rejected run.
      anySpawnFailed = true;
      return { file: f, kind: 'fallback' as const, dependents: [] as string[] };
    }
    const outcome = await runBlastQuery(bin, argv, snapshotRoot, timeoutMs);
    if (outcome.status === 'spawn-failed') {
      anySpawnFailed = true;
      return { file: f, kind: 'fallback' as const, dependents: [] as string[] };
    }
    const parsed = parseSymbolsOnlyMap(outcome.stdout);
    if (parsed.status === 'not-in-index') {
      anyQueryOk = true;
      return { file: f, kind: 'unindexed' as const };
    }
    if (parsed.status === 'malformed') {
      return { file: f, kind: 'fallback' as const, dependents: tryParseDependents(outcome.stdout) };
    }
    anyQueryOk = true;
    return {
      file: f,
      kind: 'symbols' as const,
      symbols: mapHunksToSymbols(f.path, f.hunks, parsed.symbols),
    };
  });

  const unindexedFiles: string[] = [];
  const fallbacks: FileFallbackBlast[] = [];
  let changedSymbols: ChangedSymbol[] = [];
  for (const o of fileOutcomes) {
    if (o.kind === 'unindexed') unindexedFiles.push(o.file.path);
    else if (o.kind === 'fallback') fallbacks.push({ file: o.file.path, dependents: o.dependents });
    else changedSymbols = changedSymbols.concat(o.symbols);
  }
  changedSymbols.sort(compareSymbols);
  // Dedupe across files (defensive: one file's hunks map within that file only, but the
  // same symbol spelling could repeat after renames).
  changedSymbols = changedSymbols.filter(
    (s, i, arr) =>
      i === 0 ||
      s.file !== arr[i - 1]!.file ||
      s.startLine !== arr[i - 1]!.startLine ||
      s.name !== arr[i - 1]!.name,
  );
  const omittedSymbols = Math.max(0, changedSymbols.length - maxSymbols);
  const tracedSymbols = changedSymbols.slice(0, maxSymbols);

  // Per-symbol callers (+ selective impact), bounded.
  const removedSymbols: ChangedSymbol[] = [];
  const symbolBlasts: SymbolBlast[] = [];
  const callerOutcomes = await mapBounded(tracedSymbols, concurrency, async (symbol) => {
    let argv: string[];
    try {
      argv = buildCallersArgv(snapshotRoot, symbol.name, BLAST_RADIUS_CALLERS_QUERY_LIMIT);
    } catch {
      // Data-dependent validation failure (an odd symbol name from the index, e.g. one
      // starting with `-`): snapshotRoot and the limit were validated above, so only
      // the name can throw here. Degrade exactly like a spawn failure — a per-symbol
      // unavailable note, never a rejected run.
      const outcome: QueryOutcome = { status: 'spawn-failed' };
      return { symbol, outcome };
    }
    const outcome = await runBlastQuery(bin, argv, snapshotRoot, timeoutMs);
    return { symbol, outcome };
  });
  // Impact queries run after all callers resolve: whether impact is traced depends on the
  // caller count, and batching keeps the concurrency bound honest.
  const impactJobs: { blast: SymbolBlast }[] = [];
  for (const { symbol, outcome } of callerOutcomes) {
    if (outcome.status === 'spawn-failed') {
      anySpawnFailed = true;
      symbolBlasts.push({
        symbol,
        callers: null,
        impact: null,
        impactTraced: false,
        failure: 'query-failed',
      });
      continue;
    }
    const parsed = parseCallersJson(outcome.stdout);
    if (parsed.status === 'malformed') {
      symbolBlasts.push({
        symbol,
        callers: null,
        impact: null,
        impactTraced: false,
        failure: 'parse-failed',
      });
      continue;
    }
    anyQueryOk = true;
    if (parsed.status === 'not-found') {
      // Mapped from the end-state symbol map yet unknown to the reference index: the
      // symbol was removed (or the index is skewed) — name it as removed.
      removedSymbols.push(symbol);
      continue;
    }
    // Truncation is judged on the raw page, before filtering: the query asked for one
    // past the render cap, so a full page proves the binary had more to give — even
    // when the filter then lands exactly on the cap.
    const callersTruncated = parsed.refs.length > BLAST_RADIUS_CALLERS_LIMIT;
    const callers = filterRefs(parsed.refs, { symbolName: symbol.name, symbolFile: symbol.file });
    const blast: SymbolBlast = {
      symbol,
      callers,
      callersTruncated,
      impact: null,
      impactTraced: shouldTraceImpact(symbol, callers.length),
    };
    symbolBlasts.push(blast);
    if (blast.impactTraced) impactJobs.push({ blast });
  }

  await mapBounded(impactJobs, concurrency, async ({ blast }) => {
    const outcome = await runBlastQuery(
      bin,
      buildImpactArgv(snapshotRoot, blast.symbol.name, depth),
      snapshotRoot,
      timeoutMs,
    );
    if (outcome.status === 'spawn-failed') {
      anySpawnFailed = true;
      blast.impact = null;
      blast.failure = 'query-failed';
      return;
    }
    const parsed = parseImpactJson(outcome.stdout);
    if (parsed.status === 'malformed') {
      blast.impact = null;
      blast.failure = 'parse-failed';
      return;
    }
    anyQueryOk = true;
    if (parsed.status === 'not-found') {
      // The symbol exists (callers resolved) — treat a missing impact graph as empty.
      blast.impact = [];
      return;
    }
    // Drop the root self-entry: the symbol is not its own transitive impact.
    blast.impact = filterRefs(parsed.refs, {
      symbolName: blast.symbol.name,
      symbolFile: blast.symbol.file,
    }).filter((r) => !(r.name === blast.symbol.name && r.filePath === blast.symbol.file));
  });
  symbolBlasts.sort((a, b) => compareSymbols(a.symbol, b.symbol));
  removedSymbols.sort(compareSymbols);

  // One `affected` call over all changed (non-deleted) files. Data-dependent
  // validation failures partition, not reject: unqueryable paths (the same ones that
  // degraded to file-level fallbacks above) are dropped so one bad path cannot kill
  // the rest; when none remain the step degrades like a spawn failure.
  let affectedTests: string[] = [];
  let affectedFailure: SymbolQueryFailure | undefined;
  const affectedFiles = [...new Set(queryFiles.map((f) => f.path))].sort(compareStr);
  if (affectedFiles.length > 0) {
    const validFiles = affectedFiles.filter(isQueryablePath);
    if (validFiles.length === 0) {
      anySpawnFailed = true;
      affectedFailure = 'query-failed';
    } else {
      const outcome = await runBlastQuery(
        bin,
        buildAffectedArgv(snapshotRoot, validFiles),
        snapshotRoot,
        timeoutMs,
      );
      if (outcome.status === 'spawn-failed') {
        anySpawnFailed = true;
        affectedFailure = 'query-failed';
      } else {
        const parsed = parseAffectedJson(outcome.stdout);
        if (parsed.status === 'malformed') {
          affectedFailure = 'parse-failed';
        } else {
          anyQueryOk = true;
          affectedTests = [...new Set(parsed.affectedTests)].sort(compareStr);
        }
      }
    }
  }

  const hasRenderableContent =
    symbolBlasts.length > 0 ||
    fallbacks.length > 0 ||
    removedSymbols.length > 0 ||
    removedFiles.length > 0 ||
    unindexedFiles.length > 0 ||
    affectedTests.length > 0;

  if (!anyQueryOk) {
    // Every spawned query failed or was unparsable: nothing to embed, even partially.
    // (When no query ran at all — e.g. an empty patch — this is `empty`, not a failure.)
    const anyQueryRan =
      queryFiles.length > 0 || tracedSymbols.length > 0 || affectedFiles.length > 0;
    if (anyQueryRan) {
      return {
        available: false,
        reason: anySpawnFailed ? 'query-failed' : 'parse-failed',
        block: '',
        stats: { ...ZERO_STATS },
      };
    }
  }

  if (!hasRenderableContent && affectedFailure === undefined) {
    const block = renderBlastRadiusBlock({
      symbols: [],
      fileFallbacks: [],
      removedSymbols: [],
      removedFiles: [],
      unindexedFiles: [],
      affectedTests: [],
      omittedSymbols: 0,
      depth,
      maxBlockChars,
    });
    return { available: true, reason: 'empty', block, stats: { ...ZERO_STATS } };
  }

  const block = renderBlastRadiusBlock({
    symbols: symbolBlasts,
    fileFallbacks: fallbacks,
    removedSymbols,
    removedFiles,
    unindexedFiles,
    affectedTests,
    affectedFailure,
    omittedSymbols,
    depth,
    maxBlockChars,
  });
  const stats: BlastRadiusStats = {
    symbols: symbolBlasts.length,
    callers: symbolBlasts.reduce((n, s) => n + (s.callers?.length ?? 0), 0),
    tests: affectedTests.length,
  };
  return { available: true, block, stats };
}

/** Best-effort dependents for a malformed symbol map: the header regex either matches or
 *  it does not — no throw, no partial trust beyond the one line pattern. */
function tryParseDependents(output: string): string[] {
  for (const rawLine of output.split('\n')) {
    const usedBy = USED_BY_RE.exec(rawLine.trim());
    if (usedBy) {
      const deps: string[] = [];
      for (const dep of (usedBy[1] as string).split(',')) {
        const trimmed = dep.trim();
        if (trimmed.length > 0) deps.push(trimmed);
      }
      return [...new Set(deps)].sort(compareStr);
    }
  }
  return [];
}
