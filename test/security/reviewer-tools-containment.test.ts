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

  it('never follows a symlinked subdirectory during a recursive listing', () => {
    const outcome = listInRoot(fx.snapshotRoot, { recursive: true });
    const names = outcome.entries.map((e) => e.path);
    // The symlink itself is listed by name (harmless -- it reveals nothing but its own
    // presence), but nothing beneath it is descended into.
    expect(names).toContain('escaping-dir');
    expect(names.some((n) => n.startsWith('escaping-dir/'))).toBe(false);
  });
});
