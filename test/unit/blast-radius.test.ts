/**
 * Deterministic unit tests for `src/blast-radius.ts`. Subprocess tests use tiny
 * `#!/bin/sh` stubs written to a fresh tmp dir (same precedent as
 * `test/unit/codegraph.test.ts`): no real `codegraph` binary, no network, no model calls.
 * Tmp dirs are removed after each test.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BLAST_RADIUS_CALLERS_LIMIT,
  buildAffectedArgv,
  buildCallersArgv,
  buildImpactArgv,
  buildNodeSymbolsOnlyArgv,
  computeBlastRadius,
  filterRefs,
  mapHunksToSymbols,
  parseAffectedJson,
  parseCallersJson,
  parseImpactJson,
  parsePatchHunks,
  parseSymbolsOnlyMap,
  renderBlastRadiusBlock,
  shouldTraceImpact,
  type ChangedSymbol,
  type CodeRef,
} from '../../src/blast-radius.js';
import type { ResolvedScope } from '../../src/scope.js';

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'council-blast-radius-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** Writes an executable `#!/bin/sh` stub and returns its path. */
function writeStub(dir: string, name: string, body: string): string {
  const stubPath = join(dir, name);
  writeFileSync(stubPath, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(stubPath, 0o755);
  return stubPath;
}

function makeScope(patch: string): ResolvedScope {
  return {
    mode: 'worktree',
    patch,
    files: [],
    selectors: {},
    baseBranch: null,
    mergeBase: null,
    endRevision: null,
    head: 'abc123',
    dirty: true,
    empty: patch.length === 0,
  };
}

/** `printf`-safe (no single quotes) symbols-only output in the real v1.6.0 shape. */
const SYMBOLS_ADD = [
  '**src/add.js** — 2 symbols, used by 1 file: src/use.js',
  '',
  '**Symbols**',
  '- `add` (function) (a, b) — :1',
  '- `mul` (function) (a, b) — :4',
  '',
  '> Drop `symbolsOnly` to read the source, like Read.',
].join('\n');

const PATCH_ADD = [
  'diff --git a/src/add.js b/src/add.js',
  'index 1111111..2222222 100644',
  '--- a/src/add.js',
  '+++ b/src/add.js',
  '@@ -1,2 +1,3 @@',
  ' function add(a, b) {',
  '+  // validate',
  '   return a + b;',
].join('\n');

function ref(name: string, kind: string, filePath: string, startLine: number): CodeRef {
  return { name, kind, filePath, startLine };
}

function sym(name: string, kind: string, file: string, startLine: number): ChangedSymbol {
  return { name, kind, file, startLine };
}

// -------------------------------------------------------------------------------------------
// 1.1 Patch-hunk parser
// -------------------------------------------------------------------------------------------

describe('parsePatchHunks', () => {
  it('parses a modified file with one hunk', () => {
    expect(parsePatchHunks(PATCH_ADD)).toEqual([
      {
        path: 'src/add.js',
        oldPath: 'src/add.js',
        status: 'modified',
        hunks: [{ start: 1, count: 3 }],
      },
    ]);
  });

  it('parses multiple files with multiple hunks', () => {
    const patch = [
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1,2 +1,2 @@',
      ' x',
      '@@ -10,3 +10,5 @@',
      ' y',
      'diff --git a/b.js b/b.js',
      '--- a/b.js',
      '+++ b/b.js',
      '@@ -4 +4,2 @@',
      ' z',
    ].join('\n');
    expect(parsePatchHunks(patch)).toEqual([
      {
        path: 'a.js',
        oldPath: 'a.js',
        status: 'modified',
        hunks: [
          { start: 1, count: 2 },
          { start: 10, count: 5 },
        ],
      },
      { path: 'b.js', oldPath: 'b.js', status: 'modified', hunks: [{ start: 4, count: 2 }] },
    ]);
  });

  it('defaults an omitted hunk count to 1 and keeps a zero count', () => {
    const patch = [
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1,0 +2 @@',
      ' x',
      '@@ -5,3 +5,0 @@',
      ' y',
    ].join('\n');
    expect(parsePatchHunks(patch)).toEqual([
      {
        path: 'a.js',
        oldPath: 'a.js',
        status: 'modified',
        hunks: [
          { start: 2, count: 1 },
          { start: 5, count: 0 },
        ],
      },
    ]);
  });

  it('marks a new file as added', () => {
    const patch = [
      'diff --git a/src/new.js b/src/new.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.js',
      '@@ -0,0 +1,2 @@',
      '+a',
    ].join('\n');
    expect(parsePatchHunks(patch)).toEqual([
      {
        path: 'src/new.js',
        oldPath: '/dev/null',
        status: 'added',
        hunks: [{ start: 1, count: 2 }],
      },
    ]);
  });

  it('marks a deleted file as deleted with the pre-image path', () => {
    const patch = [
      'diff --git a/src/gone.js b/src/gone.js',
      'deleted file mode 100644',
      '--- a/src/gone.js',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-a',
    ].join('\n');
    expect(parsePatchHunks(patch)).toEqual([
      {
        path: 'src/gone.js',
        oldPath: 'src/gone.js',
        status: 'deleted',
        hunks: [{ start: 0, count: 0 }],
      },
    ]);
  });

  it('marks a rename and tracks both paths', () => {
    const patch = [
      'diff --git a/src/old.js b/src/new.js',
      'similarity index 90%',
      'rename from src/old.js',
      'rename to src/new.js',
      '--- a/src/old.js',
      '+++ b/src/new.js',
      '@@ -1 +1 @@',
      ' x',
    ].join('\n');
    expect(parsePatchHunks(patch)).toEqual([
      {
        path: 'src/new.js',
        oldPath: 'src/old.js',
        status: 'renamed',
        hunks: [{ start: 1, count: 1 }],
      },
    ]);
  });

  it('emits binary diffs with zero hunks', () => {
    const patch = [
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');
    expect(parsePatchHunks(patch)).toEqual([
      { path: 'logo.png', oldPath: 'logo.png', status: 'modified', hunks: [] },
    ]);
  });

  it('strips quotes around paths with spaces', () => {
    const patch = [
      'diff --git "a/my file.js" "b/my file.js"',
      '--- "a/my file.js"',
      '+++ "b/my file.js"',
      '@@ -1 +1 @@',
      ' x',
    ].join('\n');
    expect(parsePatchHunks(patch)).toEqual([
      {
        path: 'my file.js',
        oldPath: 'my file.js',
        status: 'modified',
        hunks: [{ start: 1, count: 1 }],
      },
    ]);
  });

  it('returns [] for an empty patch', () => {
    expect(parsePatchHunks('')).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// 1.2 Symbols-only map parser + hunk mapping
// -------------------------------------------------------------------------------------------

describe('parseSymbolsOnlyMap', () => {
  it('parses symbols and dependents in v1.6.0 shape', () => {
    expect(parseSymbolsOnlyMap(SYMBOLS_ADD)).toEqual({
      status: 'ok',
      symbols: [
        { name: 'add', kind: 'function', startLine: 1 },
        { name: 'mul', kind: 'function', startLine: 4 },
      ],
      dependents: ['src/use.js'],
    });
  });

  it('parses a map with no dependents', () => {
    const out = [
      '**foo.js** — 1 symbol, no other indexed file depends on it',
      '',
      '**Symbols**',
      '- `top` (function) () — :5',
    ].join('\n');
    expect(parseSymbolsOnlyMap(out)).toEqual({
      status: 'ok',
      symbols: [{ name: 'top', kind: 'function', startLine: 5 }],
      dependents: [],
    });
  });

  it('sorts symbols and dedupes dependents', () => {
    const out = [
      '**f.js** — 2 symbols, used by 3 files: z.js, a.js, a.js',
      '',
      '**Symbols**',
      '- `b` (function) () — :9',
      '- `a` (function) () — :1',
    ].join('\n');
    expect(parseSymbolsOnlyMap(out)).toEqual({
      status: 'ok',
      symbols: [
        { name: 'a', kind: 'function', startLine: 1 },
        { name: 'b', kind: 'function', startLine: 9 },
      ],
      dependents: ['a.js', 'z.js'],
    });
  });

  it('reports not-in-index for the no-match message', () => {
    expect(
      parseSymbolsOnlyMap('No indexed file matches "src/nope.js". Codegraph indexes source files.'),
    ).toEqual({ status: 'not-in-index' });
  });

  it('reports malformed for garbage or empty output', () => {
    expect(parseSymbolsOnlyMap('total garbage\nno markers here')).toEqual({ status: 'malformed' });
    expect(parseSymbolsOnlyMap('')).toEqual({ status: 'malformed' });
  });

  it('ignores unparseable lines inside a well-formed map', () => {
    const out = [
      '**f.js** — 1 symbol',
      '',
      '**Symbols**',
      'SOME NEW LINE FORMAT',
      '- `a` (function) () — :1',
    ].join('\n');
    const parsed = parseSymbolsOnlyMap(out);
    expect(parsed).toEqual({
      status: 'ok',
      symbols: [{ name: 'a', kind: 'function', startLine: 1 }],
      dependents: [],
    });
  });
});

describe('mapHunksToSymbols', () => {
  const symbols = [
    { name: 'add', kind: 'function', startLine: 1 },
    { name: 'mul', kind: 'function', startLine: 4 },
  ];

  it('maps each hunk to its enclosing symbol', () => {
    expect(
      mapHunksToSymbols(
        'src/add.js',
        [
          { start: 2, count: 1 },
          { start: 5, count: 1 },
        ],
        symbols,
      ),
    ).toEqual([sym('add', 'function', 'src/add.js', 1), sym('mul', 'function', 'src/add.js', 4)]);
  });

  it('dedupes hunks in the same symbol and sorts', () => {
    expect(
      mapHunksToSymbols(
        'src/add.js',
        [
          { start: 6, count: 1 },
          { start: 2, count: 1 },
          { start: 3, count: 1 },
        ],
        symbols,
      ),
    ).toEqual([sym('add', 'function', 'src/add.js', 1), sym('mul', 'function', 'src/add.js', 4)]);
  });

  it('maps nothing above the first symbol or at line 0', () => {
    expect(
      mapHunksToSymbols(
        'src/add.js',
        [{ start: 0, count: 0 }],
        [{ name: 'late', kind: 'function', startLine: 10 }],
      ),
    ).toEqual([]);
    expect(
      mapHunksToSymbols(
        'src/add.js',
        [{ start: 3, count: 1 }],
        [{ name: 'late', kind: 'function', startLine: 10 }],
      ),
    ).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// 1.3 Argv builder + JSON parsing
// -------------------------------------------------------------------------------------------

describe('argv builders', () => {
  const ROOT = '/tmp/snap-root';

  it('builds node/callers/impact/affected argv exactly', () => {
    expect(buildNodeSymbolsOnlyArgv(ROOT, 'src/add.js')).toEqual([
      'node',
      '-p',
      ROOT,
      '--file',
      'src/add.js',
      '--symbols-only',
    ]);
    expect(buildCallersArgv(ROOT, 'add')).toEqual([
      'callers',
      '-p',
      ROOT,
      'add',
      '-j',
      '--limit',
      String(BLAST_RADIUS_CALLERS_LIMIT),
    ]);
    expect(buildImpactArgv(ROOT, 'add', 2)).toEqual([
      'impact',
      '-p',
      ROOT,
      'add',
      '-j',
      '--depth',
      '2',
    ]);
    expect(buildAffectedArgv(ROOT, ['a.js', 'b.js'])).toEqual([
      'affected',
      '-p',
      ROOT,
      'a.js',
      'b.js',
      '-j',
    ]);
  });

  it('rejects option smuggling, absolute and escaping paths', () => {
    expect(() => buildCallersArgv(ROOT, '--limit')).toThrow("must not begin with '-'");
    expect(() => buildNodeSymbolsOnlyArgv(ROOT, '/abs/path.js')).toThrow('not absolute');
    expect(() => buildNodeSymbolsOnlyArgv(ROOT, '../escape.js')).toThrow('must not escape');
    expect(() => buildAffectedArgv(ROOT, ['ok.js', '-x'])).toThrow("must not begin with '-'");
    expect(() => buildCallersArgv('', 'add')).toThrow('must not be empty');
    expect(() => buildCallersArgv(ROOT, 'a\0b')).toThrow('NUL');
  });

  it('rejects non-positive limits and depths', () => {
    expect(() => buildCallersArgv(ROOT, 'add', 0)).toThrow('positive integer');
    expect(() => buildImpactArgv(ROOT, 'add', -1)).toThrow('positive integer');
  });
});

describe('JSON parsing', () => {
  const CALLERS_OK = JSON.stringify({
    symbol: 'add',
    callers: [
      { name: 'usesAdd', kind: 'function', filePath: 'src/use.js', startLine: 2 },
      { name: 'add.test.js', kind: 'file', filePath: 'test/add.test.js', startLine: 1 },
    ],
  });
  const IMPACT_OK = JSON.stringify({
    symbol: 'add',
    depth: 2,
    nodeCount: 2,
    edgeCount: 1,
    affected: [
      { name: 'add', kind: 'function', filePath: 'src/add.js', startLine: 1 },
      { name: 'usesAdd', kind: 'function', filePath: 'src/use.js', startLine: 2 },
    ],
  });
  const AFFECTED_OK = JSON.stringify({
    changedFiles: ['src/add.js'],
    affectedTests: ['test/add.test.js'],
    totalDependentsTraversed: 1,
  });

  it('parses callers/impact/affected shapes', () => {
    expect(parseCallersJson(CALLERS_OK)).toEqual({
      status: 'ok',
      refs: [
        { name: 'usesAdd', kind: 'function', filePath: 'src/use.js', startLine: 2 },
        { name: 'add.test.js', kind: 'file', filePath: 'test/add.test.js', startLine: 1 },
      ],
    });
    expect(parseImpactJson(IMPACT_OK)).toEqual({
      status: 'ok',
      refs: [
        { name: 'add', kind: 'function', filePath: 'src/add.js', startLine: 1 },
        { name: 'usesAdd', kind: 'function', filePath: 'src/use.js', startLine: 2 },
      ],
    });
    expect(parseAffectedJson(AFFECTED_OK)).toEqual({
      status: 'ok',
      changedFiles: ['src/add.js'],
      affectedTests: ['test/add.test.js'],
    });
  });

  it('accepts empty result arrays', () => {
    expect(parseCallersJson(JSON.stringify({ symbol: 'mul', callers: [] }))).toEqual({
      status: 'ok',
      refs: [],
    });
    expect(
      parseAffectedJson(
        JSON.stringify({ changedFiles: ['x.js'], affectedTests: [], totalDependentsTraversed: 0 }),
      ),
    ).toEqual({ status: 'ok', changedFiles: ['x.js'], affectedTests: [] });
  });

  it('maps the not-found message to not-found, not malformed', () => {
    expect(parseCallersJson('ℹ Symbol "nope" not found')).toEqual({ status: 'not-found' });
    expect(parseImpactJson('ℹ Symbol "nope" not found')).toEqual({ status: 'not-found' });
  });

  it('maps garbage and wrong shapes to malformed', () => {
    expect(parseCallersJson('not json')).toEqual({ status: 'malformed' });
    expect(parseCallersJson('[]')).toEqual({ status: 'malformed' });
    expect(parseCallersJson(JSON.stringify({ symbol: 'a' }))).toEqual({ status: 'malformed' });
    expect(parseCallersJson(JSON.stringify({ callers: [{ name: 'x' }] }))).toEqual({
      status: 'malformed',
    });
    expect(
      parseCallersJson(
        JSON.stringify({ callers: [{ name: 'x', kind: 'function', filePath: 'f', startLine: 0 }] }),
      ),
    ).toEqual({ status: 'malformed' });
    expect(parseImpactJson(JSON.stringify({ affected: 'nope' }))).toEqual({ status: 'malformed' });
    expect(parseAffectedJson(JSON.stringify({ changedFiles: [], affectedTests: 'x' }))).toEqual({
      status: 'malformed',
    });
    expect(parseAffectedJson('')).toEqual({ status: 'malformed' });
  });
});

// -------------------------------------------------------------------------------------------
// 1.4 Filtering + rendering
// -------------------------------------------------------------------------------------------

describe('filterRefs', () => {
  const SELF = { symbolName: 'add', symbolFile: 'src/add.js' };

  it('drops file-level refs when real refs exist', () => {
    expect(
      filterRefs(
        [
          ref('usesAdd', 'function', 'src/use.js', 2),
          ref('add.test.js', 'file', 'test/add.test.js', 1),
        ],
        SELF,
      ),
    ).toEqual([ref('usesAdd', 'function', 'src/use.js', 2)]);
  });

  it('keeps file-level refs when they are the only refs', () => {
    const fileRef = ref('add.test.js', 'file', 'test/add.test.js', 1);
    expect(filterRefs([fileRef], SELF)).toEqual([fileRef]);
  });

  it('drops same-name symbols from other files but keeps same-file ones', () => {
    expect(
      filterRefs(
        [
          ref('add', 'function', 'src/other.js', 1),
          ref('add', 'function', 'src/add.js', 1),
          ref('usesAdd', 'function', 'src/use.js', 2),
        ],
        SELF,
      ),
    ).toEqual([
      ref('add', 'function', 'src/add.js', 1),
      ref('usesAdd', 'function', 'src/use.js', 2),
    ]);
  });

  it('dedupes and sorts by file, line, kind, name', () => {
    expect(
      filterRefs(
        [
          ref('z', 'function', 'b.js', 3),
          ref('a', 'function', 'a.js', 9),
          ref('z', 'function', 'b.js', 3),
          ref('m', 'class', 'a.js', 2),
        ],
        SELF,
      ),
    ).toEqual([
      ref('m', 'class', 'a.js', 2),
      ref('a', 'function', 'a.js', 9),
      ref('z', 'function', 'b.js', 3),
    ]);
  });
});

describe('shouldTraceImpact', () => {
  it('always traces shared-surface kinds', () => {
    expect(shouldTraceImpact({ kind: 'function' }, 0)).toBe(true);
    expect(shouldTraceImpact({ kind: 'class' }, 0)).toBe(true);
  });

  it('traces narrow kinds only above the caller threshold', () => {
    expect(shouldTraceImpact({ kind: 'method' }, 2)).toBe(false);
    expect(shouldTraceImpact({ kind: 'method' }, 3)).toBe(true);
  });
});

describe('renderBlastRadiusBlock', () => {
  const BASE = {
    symbols: [],
    fileFallbacks: [],
    removedSymbols: [],
    removedFiles: [],
    unindexedFiles: [],
    affectedTests: [],
    omittedSymbols: 0,
    depth: 2,
    maxBlockChars: 6000,
  };

  it('renders a full block with anchors', () => {
    const block = renderBlastRadiusBlock({
      ...BASE,
      symbols: [
        {
          symbol: sym('add', 'function', 'src/add.js', 1),
          callers: [ref('usesAdd', 'function', 'src/use.js', 2)],
          impact: [ref('top', 'function', 'foo.js', 5)],
          impactTraced: true,
        },
      ],
      affectedTests: ['test/add.test.js'],
    });
    expect(block).toBe(
      [
        '## Deterministic blast-radius map',
        'Changed symbols (1):',
        '- `add` (function) src/add.js:1',
        '  callers (1): `usesAdd` (function) src/use.js:2',
        '  impact (depth 2, 1): `top` (function) foo.js:5',
        'Affected tests (1): test/add.test.js',
      ].join('\n'),
    );
  });

  it('records nothing-traceable instead of omitting silently', () => {
    expect(renderBlastRadiusBlock(BASE)).toBe(
      [
        '## Deterministic blast-radius map',
        'No traceable symbols, dependents, or affected tests for this change.',
      ].join('\n'),
    );
  });

  it('discloses symbol overflow and caller overflow in-block', () => {
    const many = Array.from({ length: 25 }, (_, i) => ref(`c${i}`, 'function', 'f.js', i + 1));
    const block = renderBlastRadiusBlock({
      ...BASE,
      symbols: [
        {
          symbol: sym('add', 'function', 'src/add.js', 1),
          callers: many,
          impact: [],
          impactTraced: true,
        },
      ],
      omittedSymbols: 3,
    });
    expect(block).toContain('Changed symbols (1 of 4; 3 omitted):');
    expect(block).toContain('callers (25):');
    expect(block).toContain('(+5 more)');
  });

  it('marks removals with the not-computable note', () => {
    const block = renderBlastRadiusBlock({
      ...BASE,
      removedSymbols: [sym('gone', 'function', 'src/keep.js', 12)],
      removedFiles: ['src/deleted.js'],
      unindexedFiles: ['docs/notes.md'],
    });
    expect(block).toContain('Removed entries (references are not computable from this index) (3):');
    expect(block).toContain('- `gone` (function) src/keep.js:12 (removed symbol)');
    expect(block).toContain('- src/deleted.js (deleted file)');
    expect(block).toContain('- docs/notes.md (not in index)');
  });

  it('renders file fallbacks, unavailable notes, and untraced impact', () => {
    const block = renderBlastRadiusBlock({
      ...BASE,
      symbols: [
        {
          symbol: sym('a', 'method', 's.js', 1),
          callers: [],
          impact: null,
          impactTraced: false,
        },
        {
          symbol: sym('b', 'function', 's.js', 5),
          callers: null,
          impact: null,
          impactTraced: false,
          failure: 'query-failed',
        },
      ],
      fileFallbacks: [
        { file: 'src/legacy.js', dependents: ['x.js'] },
        { file: 'src/blank.js', dependents: [] },
      ],
      affectedFailure: 'parse-failed',
    });
    expect(block).toContain('impact: not traced (below threshold)');
    expect(block).toContain('callers: unavailable (query failed)');
    expect(block).toContain('- src/legacy.js (dependents: x.js)');
    expect(block).toContain('- src/blank.js');
    expect(block).toContain('Affected tests: unavailable (unparsable output)');
  });

  it('truncates to exactly maxBlockChars with a note', () => {
    const block = renderBlastRadiusBlock({
      ...BASE,
      symbols: [
        {
          symbol: sym('add', 'function', 'src/add.js', 1),
          callers: [ref('u', 'function', 'u.js', 1)],
          impact: [],
          impactTraced: true,
        },
      ],
      maxBlockChars: 100,
    });
    expect(block.length).toBe(100);
    expect(block.endsWith('\n[block truncated to 100 chars]')).toBe(true);
  });

  it('is deterministic under input reordering', () => {
    const symbols = [
      {
        symbol: sym('b', 'function', 'b.js', 1),
        callers: [ref('z', 'function', 'z.js', 1)],
        impact: [],
        impactTraced: true,
      },
      {
        symbol: sym('a', 'function', 'a.js', 1),
        callers: [],
        impact: [],
        impactTraced: true,
      },
    ];
    const opts = { ...BASE, affectedTests: ['t2', 't1'] };
    expect(renderBlastRadiusBlock({ ...opts, symbols })).toBe(
      renderBlastRadiusBlock({ ...opts, symbols: [...symbols].reverse() }),
    );
  });
});

// -------------------------------------------------------------------------------------------
// 1.5 Orchestration (stub binary)
// -------------------------------------------------------------------------------------------

describe('computeBlastRadius', () => {
  const CALLERS_ADD = JSON.stringify({
    symbol: 'add',
    callers: [{ name: 'usesAdd', kind: 'function', filePath: 'src/use.js', startLine: 2 }],
  });
  const IMPACT_ADD = JSON.stringify({
    symbol: 'add',
    depth: 2,
    nodeCount: 2,
    edgeCount: 1,
    affected: [
      { name: 'add', kind: 'function', filePath: 'src/add.js', startLine: 1 },
      { name: 'top', kind: 'function', filePath: 'foo.js', startLine: 5 },
    ],
  });
  const AFFECTED = JSON.stringify({
    changedFiles: ['src/add.js'],
    affectedTests: ['test/add.test.js'],
    totalDependentsTraversed: 1,
  });

  /** Stub dispatching on subcommand; symbol responses keyed on $4, file responses on $5. */
  function writeBlastStub(
    dir: string,
    parts: { node?: string; callers?: string; impact?: string; affected?: string; log?: string },
  ): string {
    const logLine = parts.log ? `echo "$@" >> "${parts.log}"\n  ` : '';
    return writeStub(
      dir,
      'codegraph-stub',
      [
        'case "$1" in',
        `  node) ${logLine}printf '%s' '${parts.node ?? ''}' ;;`,
        `  callers) ${logLine}printf '%s' '${parts.callers ?? ''}' ;;`,
        `  impact) ${logLine}printf '%s' '${parts.impact ?? ''}' ;;`,
        `  affected) ${logLine}printf '%s' '${parts.affected ?? ''}' ;;`,
        'esac',
      ].join('\n'),
    );
  }

  it('computes a full block and stats on the happy path', async () => {
    const dir = makeTmpDir();
    const stub = writeBlastStub(dir, {
      node: SYMBOLS_ADD,
      callers: CALLERS_ADD,
      impact: IMPACT_ADD,
      affected: AFFECTED,
    });
    const result = await computeBlastRadius(dir, makeScope(PATCH_ADD), { bin: stub });
    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.stats).toEqual({ symbols: 1, callers: 1, tests: 1 });
    expect(result.block).toBe(
      [
        '## Deterministic blast-radius map',
        'Changed symbols (1):',
        '- `add` (function) src/add.js:1',
        '  callers (1): `usesAdd` (function) src/use.js:2',
        '  impact (depth 2, 1): `top` (function) foo.js:5',
        'Affected tests (1): test/add.test.js',
      ].join('\n'),
    );
  });

  it('is byte-identical across repeated runs', async () => {
    const dir = makeTmpDir();
    const stub = writeBlastStub(dir, {
      node: SYMBOLS_ADD,
      callers: CALLERS_ADD,
      impact: IMPACT_ADD,
      affected: AFFECTED,
    });
    const opts = { bin: stub };
    const a = await computeBlastRadius(dir, makeScope(PATCH_ADD), opts);
    const b = await computeBlastRadius(dir, makeScope(PATCH_ADD), opts);
    expect(a.block).toBe(b.block);
  });

  it('passes -p root, -j, and --symbols-only to the binary', async () => {
    const dir = makeTmpDir();
    const log = join(dir, 'argv.log');
    const stub = writeBlastStub(dir, {
      node: SYMBOLS_ADD,
      callers: CALLERS_ADD,
      impact: IMPACT_ADD,
      affected: AFFECTED,
      log,
    });
    await computeBlastRadius(dir, makeScope(PATCH_ADD), { bin: stub });
    const logged = readFileSync(log, 'utf8');
    expect(logged).toContain(`node -p ${dir} --file src/add.js --symbols-only`);
    expect(logged).toContain(`callers -p ${dir} add -j --limit 20`);
    expect(logged).toContain(`impact -p ${dir} add -j --depth 2`);
    expect(logged).toContain(`affected -p ${dir} src/add.js -j`);
  });

  it('returns disabled/index-unavailable without spawning', async () => {
    const dir = makeTmpDir();
    const missing = join(dir, 'does-not-exist');
    expect(
      await computeBlastRadius(dir, makeScope(PATCH_ADD), { bin: missing, enabled: false }),
    ).toEqual({
      available: false,
      reason: 'disabled',
      block: '',
      stats: { symbols: 0, callers: 0, tests: 0 },
    });
    expect(
      await computeBlastRadius(dir, makeScope(PATCH_ADD), { bin: missing, indexAvailable: false }),
    ).toEqual({
      available: false,
      reason: 'index-unavailable',
      block: '',
      stats: { symbols: 0, callers: 0, tests: 0 },
    });
  });

  it('maps a missing binary to query-failed', async () => {
    const dir = makeTmpDir();
    const result = await computeBlastRadius(dir, makeScope(PATCH_ADD), {
      bin: join(dir, 'does-not-exist'),
    });
    expect(result).toEqual({
      available: false,
      reason: 'query-failed',
      block: '',
      stats: { symbols: 0, callers: 0, tests: 0 },
    });
  });

  it('maps a hung binary to query-failed via per-call timeout', async () => {
    const dir = makeTmpDir();
    const stub = writeStub(dir, 'codegraph-hang', 'sleep 30');
    const result = await computeBlastRadius(dir, makeScope(PATCH_ADD), {
      bin: stub,
      timeoutMs: 200,
    });
    expect(result.reason).toBe('query-failed');
    expect(result.available).toBe(false);
  });

  it('maps total parse failure to parse-failed', async () => {
    const dir = makeTmpDir();
    const stub = writeBlastStub(dir, {
      node: 'garbage',
      callers: 'garbage',
      impact: 'garbage',
      affected: 'garbage',
    });
    const result = await computeBlastRadius(dir, makeScope(PATCH_ADD), { bin: stub });
    expect(result).toEqual({
      available: false,
      reason: 'parse-failed',
      block: '',
      stats: { symbols: 0, callers: 0, tests: 0 },
    });
  });

  it('degrades one malformed symbol map to file-level while others stay granular', async () => {
    const dir = makeTmpDir();
    const twoFilePatch = [
      'diff --git a/src/add.js b/src/add.js',
      '--- a/src/add.js',
      '+++ b/src/add.js',
      '@@ -1 +1 @@',
      ' x',
      'diff --git a/src/legacy.js b/src/legacy.js',
      '--- a/src/legacy.js',
      '+++ b/src/legacy.js',
      '@@ -1 +1 @@',
      ' y',
    ].join('\n');
    const stub = writeStub(
      dir,
      'codegraph-stub',
      [
        'case "$1" in',
        `  node) if [ "$5" = "src/add.js" ]; then printf '%s' '${SYMBOLS_ADD}'; else printf '%s' 'garbage'; fi ;;`,
        `  callers) printf '%s' '${CALLERS_ADD}' ;;`,
        `  impact) printf '%s' '${IMPACT_ADD}' ;;`,
        `  affected) printf '%s' '${AFFECTED}' ;;`,
        'esac',
      ].join('\n'),
    );
    const result = await computeBlastRadius(dir, makeScope(twoFilePatch), { bin: stub });
    expect(result.available).toBe(true);
    expect(result.block).toContain('- `add` (function) src/add.js:1');
    expect(result.block).toContain('File-level (symbol map unavailable) (1):');
    expect(result.block).toContain('- src/legacy.js');
  });

  it('names deleted files, unindexed files, and removed symbols', async () => {
    const dir = makeTmpDir();
    const patch = [
      'diff --git a/src/gone.js b/src/gone.js',
      'deleted file mode 100644',
      '--- a/src/gone.js',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
      'diff --git a/docs/notes.md b/docs/notes.md',
      '--- a/docs/notes.md',
      '+++ b/docs/notes.md',
      '@@ -1 +1 @@',
      ' x',
      'diff --git a/src/add.js b/src/add.js',
      '--- a/src/add.js',
      '+++ b/src/add.js',
      '@@ -1 +1 @@',
      ' y',
    ].join('\n');
    const stub = writeStub(
      dir,
      'codegraph-stub',
      [
        'case "$1" in',
        `  node) if [ "$5" = "src/add.js" ]; then printf '%s' '${SYMBOLS_ADD}'; else printf '%s' 'No indexed file matches "docs/notes.md".'; fi ;;`,
        `  callers) printf '%s' 'Symbol "add" not found' ;;`,
        `  impact) printf '%s' '{}' ;;`,
        `  affected) printf '%s' '${JSON.stringify({ changedFiles: [], affectedTests: [], totalDependentsTraversed: 0 })}' ;;`,
        'esac',
      ].join('\n'),
    );
    const result = await computeBlastRadius(dir, makeScope(patch), { bin: stub });
    expect(result.available).toBe(true);
    expect(result.block).toContain('- `add` (function) src/add.js:1 (removed symbol)');
    expect(result.block).toContain('- src/gone.js (deleted file)');
    expect(result.block).toContain('- docs/notes.md (not in index)');
    expect(result.block).toContain('references are not computable from this index');
  });

  it('keeps a partial block when affected is unparsable', async () => {
    const dir = makeTmpDir();
    const stub = writeBlastStub(dir, {
      node: SYMBOLS_ADD,
      callers: CALLERS_ADD,
      impact: IMPACT_ADD,
      affected: 'garbage',
    });
    const result = await computeBlastRadius(dir, makeScope(PATCH_ADD), { bin: stub });
    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.block).toContain('- `add` (function) src/add.js:1');
    expect(result.block).toContain('Affected tests: unavailable (unparsable output)');
  });

  it('keeps a partial block when one symbol query exits nonzero', async () => {
    const dir = makeTmpDir();
    const twoHunkPatch = [
      'diff --git a/src/add.js b/src/add.js',
      '--- a/src/add.js',
      '+++ b/src/add.js',
      '@@ -1 +1 @@',
      ' x',
      '@@ -5 +5 @@',
      ' y',
    ].join('\n');
    const stub = writeStub(
      dir,
      'codegraph-stub',
      [
        'case "$1" in',
        `  node) printf '%s' '${SYMBOLS_ADD}' ;;`,
        `  callers) if [ "$4" = "add" ]; then exit 1; else printf '%s' '${JSON.stringify({ symbol: 'mul', callers: [] })}'; fi ;;`,
        `  impact) printf '%s' '${JSON.stringify({ symbol: 'mul', affected: [] })}' ;;`,
        `  affected) printf '%s' '${AFFECTED}' ;;`,
        'esac',
      ].join('\n'),
    );
    const result = await computeBlastRadius(dir, makeScope(twoHunkPatch), { bin: stub });
    expect(result.available).toBe(true);
    expect(result.block).toContain('- `add` (function) src/add.js:1');
    expect(result.block).toContain('callers: unavailable (query failed)');
    expect(result.block).toContain('- `mul` (function) src/add.js:4');
    expect(result.stats).toEqual({ symbols: 2, callers: 0, tests: 1 });
  });

  it('returns an empty block with reason empty for an empty patch', async () => {
    const dir = makeTmpDir();
    const result = await computeBlastRadius(dir, makeScope(''), {
      bin: join(dir, 'does-not-exist'),
    });
    expect(result.available).toBe(true);
    expect(result.reason).toBe('empty');
    expect(result.block).toContain('No traceable symbols, dependents, or affected tests');
  });

  it('returns empty when nothing is traceable', async () => {
    const dir = makeTmpDir();
    const stub = writeBlastStub(dir, {
      node: [
        '**src/add.js** — 0 symbols, no other indexed file depends on it',
        '',
        '**Symbols**',
      ].join('\n'),
      callers: '{}',
      impact: '{}',
      affected: JSON.stringify({ changedFiles: ['src/add.js'], affectedTests: [] }),
    });
    const result = await computeBlastRadius(dir, makeScope(PATCH_ADD), { bin: stub });
    expect(result.available).toBe(true);
    expect(result.reason).toBe('empty');
  });

  it('caps traced symbols with an overflow note', async () => {
    const dir = makeTmpDir();
    const twoHunkPatch = [
      'diff --git a/src/add.js b/src/add.js',
      '--- a/src/add.js',
      '+++ b/src/add.js',
      '@@ -1 +1 @@',
      ' x',
      '@@ -5 +5 @@',
      ' y',
    ].join('\n');
    const stub = writeBlastStub(dir, {
      node: SYMBOLS_ADD,
      callers: CALLERS_ADD,
      impact: IMPACT_ADD,
      affected: AFFECTED,
    });
    const result = await computeBlastRadius(dir, makeScope(twoHunkPatch), {
      bin: stub,
      maxSymbols: 1,
    });
    expect(result.available).toBe(true);
    expect(result.block).toContain('Changed symbols (1 of 2; 1 omitted):');
    expect(result.block).toContain('- `add` (function) src/add.js:1');
    expect(result.block).not.toContain('`mul`');
  });

  it('skips impact for narrowly-referenced private symbols', async () => {
    const dir = makeTmpDir();
    const log = join(dir, 'argv.log');
    const methodSymbols = [
      '**s.js** — 1 symbol, no other indexed file depends on it',
      '',
      '**Symbols**',
      '- `help` (method) () — :1',
    ].join('\n');
    const patch = [
      'diff --git a/s.js b/s.js',
      '--- a/s.js',
      '+++ b/s.js',
      '@@ -1 +1 @@',
      ' x',
    ].join('\n');
    const stub = writeBlastStub(dir, {
      node: methodSymbols,
      callers: JSON.stringify({ symbol: 'help', callers: [] }),
      impact: JSON.stringify({ symbol: 'help', affected: [] }),
      affected: JSON.stringify({ changedFiles: ['s.js'], affectedTests: [] }),
      log,
    });
    const result = await computeBlastRadius(dir, makeScope(patch), { bin: stub });
    expect(result.available).toBe(true);
    expect(result.block).toContain('impact: not traced (below threshold)');
    expect(readFileSync(log, 'utf8')).not.toContain('impact -p');
  });

  it('validates options', async () => {
    const dir = makeTmpDir();
    await expect(computeBlastRadius('', makeScope(PATCH_ADD))).rejects.toThrow();
    await expect(computeBlastRadius(dir, makeScope(PATCH_ADD), { depth: 0 })).rejects.toThrow();
    await expect(
      computeBlastRadius(dir, makeScope(PATCH_ADD), { maxSymbols: 0 }),
    ).rejects.toThrow();
    await expect(
      computeBlastRadius(dir, makeScope(PATCH_ADD), { maxBlockChars: 0 }),
    ).rejects.toThrow();
  });
});
