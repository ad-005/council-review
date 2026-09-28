/**
 * Path-containment security tests for the three snapshot-facing reviewer tools
 * (`council_read`, `council_grep`, `council_list`). See
 * `specs/council-review/reviewer-isolation/spec.md`'s "Every tool path is contained within the
 * snapshot" -- all four escape shapes (relative traversal, absolute-outside, escaping symlink,
 * escaping intermediate symlinked directory) must be rejected by every tool that accepts a path,
 * including as a search root (`council_grep`) or a listing target (`council_list`), and an
 * in-root path must succeed.
 *
 * Each escape shape is exercised twice: once against the internal pure function
 * (`readInRoot`/`grepInRoot`/`listInRoot`), and once through the actual registered
 * `ToolDefinition.execute()` a reviewer process would call -- so a mistake in the thin wiring
 * layer between `execute()` and the pure functions cannot hide behind unit tests of the pure
 * functions alone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_TOOL_OUTPUT_CHARS,
  councilGrepTool,
  councilListTool,
  councilReadTool,
  grepInRoot,
  listInRoot,
  readInRoot,
  resolveContained,
} from '../../src/reviewer-tools.js';

interface Fixture {
  snapshotRoot: string;
  outsideRoot: string;
  cleanup: () => void;
}

function buildFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'council-review-containment-'));
  const snapshotRoot = join(base, 'snapshot');
  const outsideRoot = join(base, 'outside');
  mkdirSync(snapshotRoot, { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });

  // In-root content.
  writeFileSync(join(snapshotRoot, 'inside.txt'), 'line one\nline two\nsecret-marker\n');
  mkdirSync(join(snapshotRoot, 'subdir'));
  writeFileSync(join(snapshotRoot, 'subdir', 'nested.txt'), 'nested content\n');

  // Outside content that must never be reachable.
  writeFileSync(join(outsideRoot, 'secret.txt'), 'OUTSIDE-SECRET-CONTENT\n');
  mkdirSync(join(outsideRoot, 'secret-dir'));
  writeFileSync(join(outsideRoot, 'secret-dir', 'file.txt'), 'OUTSIDE-DIR-SECRET\n');

  // Escape shape 3: a symlink whose final component escapes the root.
  symlinkSync(join(outsideRoot, 'secret.txt'), join(snapshotRoot, 'escaping-symlink.txt'));

  // Escape shape 4: an intermediate directory component that is a symlink escaping the root.
  symlinkSync(outsideRoot, join(snapshotRoot, 'escaping-dir'));

  return {
    snapshotRoot,
    outsideRoot,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Escape shapes shared across every tool under test. */
function escapeShapes(fx: Fixture): Array<{ label: string; path: string }> {
  return [
    { label: 'relative parent-directory traversal', path: '../outside/secret.txt' },
    { label: 'absolute path outside the root', path: join(fx.outsideRoot, 'secret.txt') },
    { label: 'escaping symlink (final component)', path: 'escaping-symlink.txt' },
    { label: 'escaping intermediate symlinked directory', path: 'escaping-dir/secret.txt' },
  ];
}

describe('resolveContained', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = buildFixture();
  });
  afterEach(() => fx.cleanup());

  for (const shape of [
    { label: 'relative traversal', path: '../outside/secret.txt' },
    { label: 'absolute outside', path: () => join(fx.outsideRoot, 'secret.txt') },
    { label: 'escaping symlink', path: 'escaping-symlink.txt' },
    { label: 'escaping intermediate symlinked directory', path: 'escaping-dir/secret.txt' },
  ]) {
    it(`rejects ${shape.label}`, () => {
      const p = typeof shape.path === 'function' ? shape.path() : shape.path;
      expect(() => resolveContained(fx.snapshotRoot, p)).toThrow();
    });
  }

  it('accepts an in-root relative path', () => {
    expect(resolveContained(fx.snapshotRoot, 'subdir/nested.txt')).toBe(
      resolveContained(fx.snapshotRoot, 'subdir/nested.txt'),
    );
    expect(() => resolveContained(fx.snapshotRoot, 'subdir/nested.txt')).not.toThrow();
  });

  it('accepts the root itself', () => {
    expect(() => resolveContained(fx.snapshotRoot, '.')).not.toThrow();
  });

  it('accepts an empty string as another spelling of the root', () => {
    expect(() => resolveContained(fx.snapshotRoot, '')).not.toThrow();
    expect(resolveContained(fx.snapshotRoot, '')).toBe(resolveContained(fx.snapshotRoot, '.'));
  });

  it('rejects a NUL byte in the path even though empty-string normalisation exists', () => {
    expect(() => resolveContained(fx.snapshotRoot, 'inside.txt\0')).toThrow();
  });
});

describe('council_read containment', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = buildFixture();
    process.env.COUNCIL_SNAPSHOT_ROOT = fx.snapshotRoot;
  });
  afterEach(() => {
    delete process.env.COUNCIL_SNAPSHOT_ROOT;
    fx.cleanup();
  });

  for (const shape of [
    { label: 'relative parent-directory traversal', path: '../outside/secret.txt' },
    { label: 'escaping symlink (final component)', path: 'escaping-symlink.txt' },
    { label: 'escaping intermediate symlinked directory', path: 'escaping-dir/secret.txt' },
  ]) {
    it(`readInRoot rejects ${shape.label}`, () => {
      expect(() => readInRoot(fx.snapshotRoot, { path: shape.path })).toThrow();
    });
  }

  it('readInRoot rejects an absolute path outside the root', () => {
    expect(() =>
      readInRoot(fx.snapshotRoot, { path: join(fx.outsideRoot, 'secret.txt') }),
    ).toThrow();
  });

  it('readInRoot succeeds for an in-root path and returns no outside content', () => {
    const outcome = readInRoot(fx.snapshotRoot, { path: 'inside.txt' });
    expect(outcome.content).toContain('secret-marker');
    expect(outcome.content).not.toContain('OUTSIDE');
  });

  it('the registered council_read tool rejects every escape shape via execute()', async () => {
    for (const shape of escapeShapes(fx)) {
      await expect(
        councilReadTool.execute('id', { path: shape.path }, undefined, undefined, {}),
      ).rejects.toThrow();
    }
  });

  it('the registered council_read tool succeeds for an in-root path via execute()', async () => {
    const result = await councilReadTool.execute(
      'id',
      { path: 'inside.txt' },
      undefined,
      undefined,
      {},
    );
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('secret-marker');
    expect(text).not.toContain('OUTSIDE');
  });

  it('readInRoot on an empty path (the root) gives the informative "is a directory" error, not a path-validation error', () => {
    expect(() => readInRoot(fx.snapshotRoot, { path: '' })).toThrow(/is a directory/);
  });

  it('readInRoot on "." (the root) gives the same informative "is a directory" error', () => {
    expect(() => readInRoot(fx.snapshotRoot, { path: '.' })).toThrow(/is a directory/);
  });
});

describe('council_grep containment', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = buildFixture();
    process.env.COUNCIL_SNAPSHOT_ROOT = fx.snapshotRoot;
  });
  afterEach(() => {
    delete process.env.COUNCIL_SNAPSHOT_ROOT;
    fx.cleanup();
  });

  it('grepInRoot rejects every escape shape as a search root', () => {
    for (const shape of escapeShapes(fx)) {
      expect(() => grepInRoot(fx.snapshotRoot, { pattern: '.', path: shape.path })).toThrow();
    }
  });

  it('grepInRoot never returns a match from outside the root even when it matches', () => {
    // A pattern that would match the outside secret content if it were ever reached.
    for (const shape of escapeShapes(fx)) {
      expect(() => grepInRoot(fx.snapshotRoot, { pattern: 'OUTSIDE', path: shape.path })).toThrow();
    }
  });

  it('grepInRoot succeeds for an in-root search root and finds the in-root match', () => {
    const outcome = grepInRoot(fx.snapshotRoot, { pattern: 'secret-marker' });
    expect(outcome.matches).toHaveLength(1);
    expect(outcome.matches[0]?.path).toBe('inside.txt');
  });

  it('the registered council_grep tool rejects every escape shape via execute()', async () => {
    for (const shape of escapeShapes(fx)) {
      await expect(
        councilGrepTool.execute('id', { pattern: '.', path: shape.path }, undefined, undefined, {}),
      ).rejects.toThrow();
    }
  });

  it('the registered council_grep tool succeeds in-root via execute()', async () => {
    const result = await councilGrepTool.execute(
      'id',
      { pattern: 'secret-marker' },
      undefined,
      undefined,
      {},
    );
    expect(result.content[0]?.text).toContain('inside.txt:3');
  });

  it('grepInRoot succeeds with an empty string as the search root, same as the default', () => {
    const outcome = grepInRoot(fx.snapshotRoot, { pattern: 'secret-marker', path: '' });
    expect(outcome.matches).toHaveLength(1);
    expect(outcome.matches[0]?.path).toBe('inside.txt');
  });
});

describe('council_list containment', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = buildFixture();
    process.env.COUNCIL_SNAPSHOT_ROOT = fx.snapshotRoot;
  });
  afterEach(() => {
    delete process.env.COUNCIL_SNAPSHOT_ROOT;
    fx.cleanup();
  });

  it('listInRoot rejects every escape shape as a listing target', () => {
    for (const shape of escapeShapes(fx)) {
      expect(() => listInRoot(fx.snapshotRoot, { path: shape.path })).toThrow();
    }
  });

  it('listInRoot succeeds for the root and does not reveal outside entries', () => {
    const outcome = listInRoot(fx.snapshotRoot, {});
    const names = outcome.entries.map((e) => e.path);
    expect(names).toContain('inside.txt');
    expect(names).toContain('subdir');
    expect(names.some((n) => n.includes('secret'))).toBe(false);
  });

  it('the registered council_list tool rejects every escape shape via execute()', async () => {
    for (const shape of escapeShapes(fx)) {
      await expect(
        councilListTool.execute('id', { path: shape.path }, undefined, undefined, {}),
      ).rejects.toThrow();
    }
  });

  it('the registered council_list tool succeeds for the root via execute()', async () => {
    const result = await councilListTool.execute('id', {}, undefined, undefined, {});
    expect(result.content[0]?.text).toContain('inside.txt');
  });

  it('listInRoot succeeds for an empty string path, same as the root', () => {
    const outcome = listInRoot(fx.snapshotRoot, { path: '' });
    const names = outcome.entries.map((e) => e.path);
    expect(names).toContain('inside.txt');
    expect(names).toContain('subdir');
    expect(names.some((n) => n.includes('secret'))).toBe(false);
  });

  it('the registered council_list tool succeeds for path "" via execute()', async () => {
    const result = await councilListTool.execute('id', { path: '' }, undefined, undefined, {});
    expect(result.content[0]?.text).toContain('inside.txt');
  });

  it('the registered council_list tool succeeds for path "." via execute()', async () => {
    const result = await councilListTool.execute('id', { path: '.' }, undefined, undefined, {});
    expect(result.content[0]?.text).toContain('inside.txt');
  });

  it('reports truncated only when an entry was actually left out', () => {
    // The root holds exactly four entries: inside.txt, subdir, escaping-symlink.txt and
    // escaping-dir.
    const all = listInRoot(fx.snapshotRoot, {});
    expect(all.entries).toHaveLength(4);
    expect(listInRoot(fx.snapshotRoot, { maxEntries: 4 }).truncated).toBe(false);
    expect(listInRoot(fx.snapshotRoot, { maxEntries: 3 }).truncated).toBe(true);

    // Recursive: the four root entries plus subdir/nested.txt.
    expect(listInRoot(fx.snapshotRoot, { recursive: true }).entries).toHaveLength(5);
    expect(listInRoot(fx.snapshotRoot, { recursive: true, maxEntries: 5 }).truncated).toBe(false);
    const cut = listInRoot(fx.snapshotRoot, { recursive: true, maxEntries: 4 });
    expect(cut.entries).toHaveLength(4);
    expect(cut.truncated).toBe(true);
  });

  it('never follows a symlinked subdirectory during a recursive listing', () => {
    const outcome = listInRoot(fx.snapshotRoot, { recursive: true });
    const names = outcome.entries.map((e) => e.path);
    // The symlink itself is listed by name (harmless -- it reveals nothing but its own
    // presence), but nothing beneath it is descended into.
    expect(names).toContain('escaping-dir');
    expect(names.some((n) => n.startsWith('escaping-dir/'))).toBe(false);
  });
});

describe('snapshot tools: line numbering, bounded work and bounded output', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'council-review-bounds-'));
    process.env.COUNCIL_SNAPSHOT_ROOT = root;
  });
  afterEach(() => {
    delete process.env.COUNCIL_SNAPSHOT_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  it('a trailing newline does not add a phantom last line', () => {
    writeFileSync(join(root, 'two.txt'), 'a\nb\n');
    const outcome = readInRoot(root, { path: 'two.txt' });
    expect(outcome.totalLines).toBe(2);
    expect(outcome.content).toBe('a\nb');
    writeFileSync(join(root, 'crlf.txt'), 'a\r\nb\r\n');
    expect(readInRoot(root, { path: 'crlf.txt' }).totalLines).toBe(2);
    writeFileSync(join(root, 'unterminated.txt'), 'a\nb');
    expect(readInRoot(root, { path: 'unterminated.txt' }).totalLines).toBe(2);
  });

  it('a lone carriage return is not a line break, matching git', () => {
    writeFileSync(join(root, 'cr.txt'), 'one\rstill one\ntarget\n');
    expect(readInRoot(root, { path: 'cr.txt' }).totalLines).toBe(2);
    const outcome = grepInRoot(root, { pattern: 'target' });
    expect(outcome.matches).toEqual([{ path: 'cr.txt', line: 2, text: 'target' }]);
  });

  it('stops a catastrophically backtracking pattern at the deadline instead of hanging', () => {
    writeFileSync(join(root, 'redos.txt'), `${'a'.repeat(35)}!\n`);
    const started = Date.now();
    expect(() => grepInRoot(root, { pattern: '^(a+)+$' }, { timeoutMs: 200 })).toThrow(
      /too expensive/,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    // The host process is still usable afterwards.
    expect(grepInRoot(root, { pattern: 'a!' }).matches).toHaveLength(1);
  });

  it('returns the matches found before the deadline, marked partial', () => {
    writeFileSync(join(root, 'a-first.txt'), 'needle\n');
    writeFileSync(join(root, 'b-redos.txt'), `${'a'.repeat(35)}!\n`);
    const outcome = grepInRoot(root, { pattern: 'needle|^(a+)+$' }, { timeoutMs: 200 });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.matches).toEqual([{ path: 'a-first.txt', line: 1, text: 'needle' }]);
  });

  it('marks a search that hit the file limit instead of silently reporting no matches', async () => {
    mkdirSync(join(root, 'many'));
    for (let i = 0; i < 5001; i++) {
      writeFileSync(join(root, 'many', `f${String(i).padStart(5, '0')}.txt`), 'nothing\n');
    }
    // Sorts after every file under many/, so it is beyond the file limit.
    writeFileSync(join(root, 'zzz-needle.txt'), 'needle\n');
    const outcome = grepInRoot(root, { pattern: 'needle' });
    expect(outcome.matches).toHaveLength(0);
    expect(outcome.filesScanned).toBe(5000);
    expect(outcome.fileLimitReached).toBe(true);
    const result = await councilGrepTool.execute(
      'id',
      { pattern: 'needle' },
      undefined,
      undefined,
      {},
    );
    expect(result.content[0]?.text).toMatch(/file limit reached/);
    expect(result.content[0]?.text).toMatch(/narrow path/);

    const narrowed = grepInRoot(root, { pattern: 'needle', path: 'zzz-needle.txt' });
    expect(narrowed.fileLimitReached).toBe(false);
    expect(narrowed.matches).toHaveLength(1);
  });

  it('does not mark the file limit when the tree fits within it', () => {
    writeFileSync(join(root, 'one.txt'), 'needle\n');
    expect(grepInRoot(root, { pattern: 'needle' }).fileLimitReached).toBe(false);
  });

  it('clips a long matching line (e.g. a minified bundle) to a short excerpt', () => {
    writeFileSync(join(root, 'bundle.min.js'), `needle${'x'.repeat(1_000_000)}\n`);
    const outcome = grepInRoot(root, { pattern: 'needle' });
    expect(outcome.matches).toHaveLength(1);
    const text = outcome.matches[0]?.text ?? '';
    expect(text.length).toBeLessThan(400);
    expect(text.startsWith('needle')).toBe(true);
    expect(text).toMatch(/1000006 characters/);
  });

  it('bounds council_grep output with a truncation marker', async () => {
    const line = `needle ${'z'.repeat(290)}\n`;
    writeFileSync(join(root, 'wide.txt'), line.repeat(1000));
    const result = await councilGrepTool.execute(
      'id',
      { pattern: 'needle', maxResults: 1000 },
      undefined,
      undefined,
      {},
    );
    const text = result.content[0]?.text ?? '';
    expect(text.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 500);
    expect(text).toMatch(/\[output truncated: \d+ characters total/);
  });

  it('bounds council_read output and says where to continue', async () => {
    const line = `${'r'.repeat(99)}\n`;
    writeFileSync(join(root, 'long.txt'), line.repeat(3000));
    const outcome = readInRoot(root, { path: 'long.txt' });
    expect(outcome.truncated).toBe(true);
    expect(outcome.content.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    const result = await councilReadTool.execute(
      'id',
      { path: 'long.txt' },
      undefined,
      undefined,
      {},
    );
    const text = result.content[0]?.text ?? '';
    expect(text.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 500);
    expect(text).toContain(`lines 1-${outcome.endLine} of 3000`);
    expect(text).toContain(`startLine=${outcome.endLine + 1}`);

    const rest = readInRoot(root, { path: 'long.txt', startLine: outcome.endLine + 1 });
    expect(rest.startLine).toBe(outcome.endLine + 1);
  });

  it('bounds council_read output even for a single enormous line', async () => {
    writeFileSync(join(root, 'one-line.min.js'), 'q'.repeat(1_000_000));
    const result = await councilReadTool.execute(
      'id',
      { path: 'one-line.min.js' },
      undefined,
      undefined,
      {},
    );
    const text = result.content[0]?.text ?? '';
    expect(text.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 500);
    expect(text).toMatch(/truncated/);
  });

  it('a read that fits is not marked truncated', () => {
    writeFileSync(join(root, 'small.txt'), 'x\ny\n');
    expect(readInRoot(root, { path: 'small.txt' }).truncated).toBe(false);
  });
});
