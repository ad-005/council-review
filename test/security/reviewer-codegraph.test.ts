/**
 * Security tests for `council_codegraph`: the read-only subcommand allowlist, literal-argument
 * handling that makes command composition impossible, snapshot path containment for file
 * arguments, and graceful degradation when the per-run index is absent. Mirrors the shape of
 * `reviewer-git.test.ts`: `council_codegraph` builds a literal argv (never through a shell) and
 * always injects `-p <snapshotRoot>` server-side, so reviewer input can neither smuggle a flag
 * nor aim a query at any other tree.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CODEGRAPH_FALLBACK_MESSAGE,
  CODEGRAPH_SUBCOMMANDS,
  buildCodegraphArgv,
  getCodegraphBin,
  runCodegraph,
  type CodegraphParams,
} from '../../src/reviewer-tools.js';

let dirs: string[] = [];
let savedBin: string | undefined;

function track(path: string): string {
  dirs.push(path);
  return path;
}

function makeTempDir(): string {
  return track(mkdtempSync(join(tmpdir(), 'codegraph-test-')));
}

/** A snapshot-shaped root containing one real file; the caller decides whether it also carries
 *  a (fake) `.codegraph/codegraph.db` index marker. */
function makeSnapshot(withIndex: boolean): string {
  const root = makeTempDir();
  writeFileSync(join(root, 'real.txt'), 'export const x = 1;\n');
  if (withIndex) {
    mkdirSync(join(root, '.codegraph'), { recursive: true });
    writeFileSync(join(root, '.codegraph', 'codegraph.db'), 'fake-index');
  }
  return root;
}

function writeStub(body: string): string {
  const dir = makeTempDir();
  const path = join(dir, 'codegraph-stub.sh');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  savedBin = process.env.COUNCIL_CODEGRAPH_BIN;
});

afterEach(() => {
  if (savedBin === undefined) {
    delete process.env.COUNCIL_CODEGRAPH_BIN;
  } else {
    process.env.COUNCIL_CODEGRAPH_BIN = savedBin;
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe('getCodegraphBin', () => {
  it('defaults to codegraph on PATH', () => {
    expect(getCodegraphBin({})).toBe('codegraph');
  });

  it('honours COUNCIL_CODEGRAPH_BIN when set', () => {
    expect(getCodegraphBin({ COUNCIL_CODEGRAPH_BIN: '/opt/bin/codegraph' })).toBe(
      '/opt/bin/codegraph',
    );
  });
});

describe('buildCodegraphArgv allowlist', () => {
  const allowed: Array<[string, CodegraphParams]> = [
    ['explore', { subcommand: 'explore', query: 'auth flow' }],
    ['query', { subcommand: 'query', query: 'foo' }],
    ['node', { subcommand: 'node', symbol: 'foo' }],
    ['callers', { subcommand: 'callers', symbol: 'foo' }],
    ['callees', { subcommand: 'callees', symbol: 'foo' }],
    ['impact', { subcommand: 'impact', symbol: 'foo' }],
    ['affected', { subcommand: 'affected' }],
  ];

  it('exposes exactly the seven read-only subcommands', () => {
    expect([...CODEGRAPH_SUBCOMMANDS]).toEqual([
      'explore',
      'query',
      'node',
      'callers',
      'callees',
      'impact',
      'affected',
    ]);
  });

  for (const [subcommand, params] of allowed) {
    it(`builds argv for allowlisted subcommand "${subcommand}" with server-side -p root`, () => {
      const root = makeSnapshot(false);
      const argv = buildCodegraphArgv(root, params);
      expect(argv[0]).toBe(subcommand);
      // The project flag always names the caller's snapshot root, never reviewer input.
      expect(argv[1]).toBe('-p');
      expect(argv[2]).toBe(root);
    });
  }

  for (const bad of [
    'init',
    'index',
    'sync',
    'uninit',
    'upgrade',
    'install',
    'uninstall',
    'daemon',
    'telemetry',
    'unlock',
    'files',
    'status',
    '',
    'Explore',
    'CALLERS',
  ]) {
    it(`rejects the non-allowlisted subcommand "${bad}"`, () => {
      const root = makeSnapshot(false);
      expect(() => buildCodegraphArgv(root, { subcommand: bad })).toThrow(
        /unsupported codegraph subcommand/,
      );
    });
  }

  it('rejects a subcommand supplied as a non-string', () => {
    const root = makeSnapshot(false);
    expect(() => buildCodegraphArgv(root, { subcommand: { toString: () => 'query' } })).toThrow(
      /unsupported codegraph subcommand/,
    );
  });

  it('rejects a missing subcommand', () => {
    const root = makeSnapshot(false);
    expect(() => buildCodegraphArgv(root, {})).toThrow(/unsupported codegraph subcommand/);
  });
});

describe('command composition is impossible', () => {
  const injectionValues = [
    '; rm -rf /',
    '$(rm -rf /)',
    '`rm -rf /`',
    '&& echo pwned',
    '| cat /etc/passwd',
  ];

  for (const value of injectionValues) {
    it(`treats query value "${value}" as a single literal argv entry`, () => {
      const root = makeSnapshot(false);
      const argv = buildCodegraphArgv(root, { subcommand: 'explore', query: value });
      // The entire string is exactly one argv element -- nothing about it was interpreted or
      // split, because argv is passed straight to execFileSync with no shell involved.
      expect(argv).toEqual(['explore', '-p', root, value]);
    });

    it(`treats symbol value "${value}" as a single literal argv entry`, () => {
      const root = makeSnapshot(false);
      const argv = buildCodegraphArgv(root, { subcommand: 'callers', symbol: value });
      expect(argv).toEqual(['callers', '-p', root, value]);
    });
  }

  for (const optionLike of ['-limit', '--limit=1', '-x']) {
    it(`rejects option-like query value "${optionLike}"`, () => {
      const root = makeSnapshot(false);
      expect(() => buildCodegraphArgv(root, { subcommand: 'query', query: optionLike })).toThrow();
    });

    it(`rejects option-like symbol value "${optionLike}"`, () => {
      const root = makeSnapshot(false);
      expect(() =>
        buildCodegraphArgv(root, { subcommand: 'impact', symbol: optionLike }),
      ).toThrow();
    });

    it(`rejects option-like kind value "${optionLike}"`, () => {
      const root = makeSnapshot(false);
      expect(() =>
        buildCodegraphArgv(root, { subcommand: 'query', query: 'foo', kind: optionLike }),
      ).toThrow();
    });
  }

  it('rejects empty and NUL-containing query/symbol/kind', () => {
    const root = makeSnapshot(false);
    expect(() => buildCodegraphArgv(root, { subcommand: 'query', query: '' })).toThrow();
    expect(() => buildCodegraphArgv(root, { subcommand: 'query', query: 'a\0b' })).toThrow();
    expect(() => buildCodegraphArgv(root, { subcommand: 'callers', symbol: '' })).toThrow();
    expect(() => buildCodegraphArgv(root, { subcommand: 'callers', symbol: 'a\0b' })).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'query', query: 'foo', kind: '' }),
    ).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'query', query: 'foo', kind: 'a\0b' }),
    ).toThrow();
  });

  it('rejects a non-string kind', () => {
    const root = makeSnapshot(false);
    expect(() => buildCodegraphArgv(root, { subcommand: 'query', query: 'foo', kind: 42 })).toThrow(
      /kind must be a string/,
    );
  });
});

describe('snapshot path containment', () => {
  it('rejects a parent-directory traversal for node file', () => {
    const root = makeSnapshot(false);
    // The escape target exists, so this pins the containment check itself rather than a
    // missing-file error.
    const escapee = join(root, '..', 'cg-escape-target.txt');
    writeFileSync(escapee, 'outside\n');
    track(escapee);
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'node', file: '../cg-escape-target.txt' }),
    ).toThrow(/escapes the allowed root/);
  });

  it('rejects an absolute path outside the snapshot', () => {
    const root = makeSnapshot(false);
    const outside = makeTempDir();
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'node', file: join(outside, 'secret.txt') }),
    ).toThrow(/escapes the allowed root/);
  });

  it('rejects a symlink escaping the snapshot', () => {
    const root = makeSnapshot(false);
    const outside = makeTempDir();
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'evil-link'));
    expect(() => buildCodegraphArgv(root, { subcommand: 'node', file: 'evil-link' })).toThrow(
      /escapes the allowed root/,
    );
  });

  it('rejects a path through an escaping intermediate directory symlink', () => {
    const root = makeSnapshot(false);
    const outside = makeTempDir();
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(outside, join(root, 'evil-dir'));
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'node', file: 'evil-dir/secret.txt' }),
    ).toThrow(/escapes the allowed root/);
  });

  it('rejects escaping entries in the affected files list', () => {
    const root = makeSnapshot(false);
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'affected', files: ['real.txt', '../../etc/passwd'] }),
    ).toThrow();
  });

  it('rejects a non-array files value and non-string entries', () => {
    const root = makeSnapshot(false);
    expect(() => buildCodegraphArgv(root, { subcommand: 'affected', files: 'real.txt' })).toThrow(
      /files must be an array of strings/,
    );
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'affected', files: ['real.txt', 42] }),
    ).toThrow(/files must be an array of strings/);
  });

  it('passes a contained node file as a resolved absolute path', () => {
    const root = makeSnapshot(false);
    const argv = buildCodegraphArgv(root, { subcommand: 'node', file: 'real.txt' });
    const flagIndex = argv.indexOf('--file');
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    const passed = argv[flagIndex + 1] as string;
    expect(isAbsolute(passed)).toBe(true);
    expect(passed).toMatch(/real\.txt$/);
    expect(passed).not.toContain('..');
  });

  it('passes contained affected files as resolved absolute paths', () => {
    const root = makeSnapshot(false);
    const argv = buildCodegraphArgv(root, { subcommand: 'affected', files: ['real.txt'] });
    expect(argv.slice(0, 3)).toEqual(['affected', '-p', root]);
    expect(argv[3]).toMatch(/real\.txt$/);
    expect(isAbsolute(argv[3] as string)).toBe(true);
  });
});

describe('numeric clamps and required fields', () => {
  it('clamps in-range numerics into the argv', () => {
    const root = makeSnapshot(false);
    expect(buildCodegraphArgv(root, { subcommand: 'explore', query: 'q', maxFiles: 10 })).toEqual([
      'explore',
      '-p',
      root,
      'q',
      '--max-files',
      '10',
    ]);
    expect(buildCodegraphArgv(root, { subcommand: 'query', query: 'q', limit: 5 })).toEqual([
      'query',
      '-p',
      root,
      'q',
      '--limit',
      '5',
    ]);
    expect(buildCodegraphArgv(root, { subcommand: 'impact', symbol: 's', depth: 3 })).toEqual([
      'impact',
      '-p',
      root,
      's',
      '--depth',
      '3',
    ]);
  });

  it('rejects out-of-range and non-integer limit/depth/maxFiles/offset', () => {
    const root = makeSnapshot(false);
    expect(() => buildCodegraphArgv(root, { subcommand: 'query', query: 'q', limit: 0 })).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'query', query: 'q', limit: 101 }),
    ).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'query', query: 'q', limit: 1.5 }),
    ).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'explore', query: 'q', maxFiles: 0 }),
    ).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'explore', query: 'q', maxFiles: 51 }),
    ).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'explore', query: 'q', maxFiles: 2.5 }),
    ).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'impact', symbol: 's', depth: 0 }),
    ).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'impact', symbol: 's', depth: 11 }),
    ).toThrow();
    expect(() => buildCodegraphArgv(root, { subcommand: 'affected', depth: 11 })).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'node', file: 'real.txt', offset: 0 }),
    ).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'node', file: 'real.txt', offset: 1_000_001 }),
    ).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'node', file: 'real.txt', offset: 1.5 }),
    ).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'node', file: 'real.txt', limit: 1001 }),
    ).toThrow();
    expect(() =>
      buildCodegraphArgv(root, { subcommand: 'callers', symbol: 's', limit: 101 }),
    ).toThrow();
  });

  it('rejects node offset/limit without file', () => {
    const root = makeSnapshot(false);
    expect(() => buildCodegraphArgv(root, { subcommand: 'node', symbol: 's', offset: 10 })).toThrow(
      /only supported with file/,
    );
    expect(() => buildCodegraphArgv(root, { subcommand: 'node', symbol: 's', limit: 10 })).toThrow(
      /only supported with file/,
    );
  });

  it('accepts node offset/limit with file', () => {
    const root = makeSnapshot(false);
    const argv = buildCodegraphArgv(root, {
      subcommand: 'node',
      file: 'real.txt',
      offset: 2,
      limit: 50,
    });
    expect(argv).toContain('--offset');
    expect(argv).toContain('--limit');
  });

  it('rejects missing required query/symbol', () => {
    const root = makeSnapshot(false);
    expect(() => buildCodegraphArgv(root, { subcommand: 'explore' })).toThrow();
    expect(() => buildCodegraphArgv(root, { subcommand: 'query' })).toThrow();
    expect(() => buildCodegraphArgv(root, { subcommand: 'node' })).toThrow(
      /requires symbol and\/or file/,
    );
    expect(() => buildCodegraphArgv(root, { subcommand: 'callers' })).toThrow();
    expect(() => buildCodegraphArgv(root, { subcommand: 'callees' })).toThrow();
    expect(() => buildCodegraphArgv(root, { subcommand: 'impact' })).toThrow();
  });

  it('accepts node with only a file and affected with no files', () => {
    const root = makeSnapshot(false);
    expect(() => buildCodegraphArgv(root, { subcommand: 'node', file: 'real.txt' })).not.toThrow();
    expect(() => buildCodegraphArgv(root, { subcommand: 'affected' })).not.toThrow();
  });
});

describe('absent index returns the fallback without spawning', () => {
  it('returns the fallback message when .codegraph/codegraph.db is missing', () => {
    const root = makeSnapshot(false);
    // A binary path that would throw ENOENT if ever spawned proves nothing is executed.
    process.env.COUNCIL_CODEGRAPH_BIN = join(makeTempDir(), 'no-such-binary');
    expect(runCodegraph(root, { subcommand: 'query', query: 'foo' })).toBe(
      CODEGRAPH_FALLBACK_MESSAGE,
    );
  });

  it('returns the fallback message when only the directory exists without the db file', () => {
    const root = makeSnapshot(false);
    mkdirSync(join(root, '.codegraph'), { recursive: true });
    process.env.COUNCIL_CODEGRAPH_BIN = join(makeTempDir(), 'no-such-binary');
    expect(runCodegraph(root, { subcommand: 'callers', symbol: 'foo' })).toBe(
      CODEGRAPH_FALLBACK_MESSAGE,
    );
  });

  it('fallback message directs the reviewer to grep and read', () => {
    expect(CODEGRAPH_FALLBACK_MESSAGE).toContain('council_grep');
    expect(CODEGRAPH_FALLBACK_MESSAGE).toContain('council_read');
  });
});

describe('runCodegraph against stub binaries', () => {
  it('passes reviewer input as literal argv with server-side -p root', () => {
    const root = makeSnapshot(true);
    process.env.COUNCIL_CODEGRAPH_BIN = writeStub('printf \'%s\\n\' "$@"');
    const output = runCodegraph(root, { subcommand: 'callers', symbol: '; rm -rf /' });
    const lines = output.trim().split('\n');
    expect(lines[0]).toBe('callers');
    expect(lines[1]).toBe('-p');
    expect(lines[2]).toBe(root);
    expect(lines[3]).toBe('; rm -rf /');
    // No reviewer input became a flag: the only flag-like entries are the injected ones.
    expect(lines.filter((line) => line.startsWith('-'))).toEqual(['-p']);
  });

  it('truncates output beyond the cap with an explicit marker', () => {
    const root = makeSnapshot(true);
    process.env.COUNCIL_CODEGRAPH_BIN = writeStub("head -c 150000 /dev/zero | tr '\\0' 'A'");
    const output = runCodegraph(root, { subcommand: 'query', query: 'foo' });
    expect(output.length).toBeLessThan(150000);
    expect(output).toContain('150000');
    expect(output).toMatch(/truncat/i);
    expect(output).toMatch(/narrow the query/i);
  });

  it('wraps a failing binary with the stderr-first message', () => {
    const root = makeSnapshot(true);
    process.env.COUNCIL_CODEGRAPH_BIN = writeStub('echo some-codegraph-failure >&2; exit 1');
    expect(() => runCodegraph(root, { subcommand: 'query', query: 'foo' })).toThrow(
      /codegraph query failed: some-codegraph-failure/,
    );
  });

  it('turns a hung binary into a narrow-the-query timeout error', () => {
    const root = makeSnapshot(true);
    process.env.COUNCIL_CODEGRAPH_BIN = writeStub('sleep 5');
    expect(() =>
      runCodegraph(root, { subcommand: 'query', query: 'foo' }, { timeoutMs: 200 }),
    ).toThrow(/narrow the query/);
  });
});
