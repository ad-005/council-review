/**
 * Security tests for `council_git`: the read-only subcommand allowlist, literal-argument
 * handling that makes command composition impossible, and the invariant that no history call
 * ever mutates the real repository. See "Repository history is reachable only through an
 * allowlist" in `specs/council-review/reviewer-isolation/spec.md`.
 *
 * `council_git`'s `path` field is a git *pathspec filter* (always passed after a literal `--`),
 * never a raw filesystem path to read -- see `buildGitArgv`. That means the filesystem-symlink
 * escape shapes tested for the three snapshot tools don't apply the same way here: git's own
 * object model does not let a pathspec or a colon-syntax revision walk outside the repository
 * (verified empirically below: `git show "HEAD:../../etc/passwd"` fails with "is outside
 * repository", and `git show HEAD:<tracked-symlink>` returns only the symlink's *target string*,
 * never the referenced file's content). What this file asserts instead is what the spec actually
 * requires for history: the subcommand allowlist, literal-argument handling, and an unchanged
 * repository after every call.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildGitArgv, runGitHistory, type GitParams } from '../../src/reviewer-tools.js';
import { createTestRepo, type TestRepo } from '../helpers/git-repo.js';

describe('buildGitArgv allowlist', () => {
  it('builds argv for each allowlisted subcommand', () => {
    expect(buildGitArgv({ subcommand: 'log' })).toEqual(['log', '--no-color']);
    expect(buildGitArgv({ subcommand: 'show' })).toEqual(['show', '--no-color', 'HEAD']);
    expect(buildGitArgv({ subcommand: 'diff' })).toEqual(['diff', '--no-color']);
    expect(buildGitArgv({ subcommand: 'blame', path: 'src/foo.ts' })).toEqual([
      'blame',
      '--',
      'src/foo.ts',
    ]);
  });

  for (const bad of [
    'push',
    'checkout',
    'reset',
    'config',
    'commit',
    'fetch',
    'pull',
    'clone',
    '',
    'LOG',
  ]) {
    it(`rejects the non-allowlisted subcommand "${bad}"`, () => {
      expect(() => buildGitArgv({ subcommand: bad })).toThrow();
    });
  }

  it('rejects a subcommand supplied as a non-string', () => {
    expect(() => buildGitArgv({ subcommand: { toString: () => 'log' } })).toThrow();
  });

  it('requires path for blame', () => {
    expect(() => buildGitArgv({ subcommand: 'blame' })).toThrow(/blame requires path/);
  });

  it('rejects maxCount on a subcommand other than log', () => {
    expect(() => buildGitArgv({ subcommand: 'show', maxCount: 5 })).toThrow(
      /only supported for log/,
    );
  });

  it('clamps and rejects out-of-range maxCount for log', () => {
    expect(buildGitArgv({ subcommand: 'log', maxCount: 10 })).toContain('--max-count=10');
    expect(() => buildGitArgv({ subcommand: 'log', maxCount: 0 })).toThrow();
    expect(() => buildGitArgv({ subcommand: 'log', maxCount: 501 })).toThrow();
    expect(() => buildGitArgv({ subcommand: 'log', maxCount: 1.5 })).toThrow();
  });
});

describe('command composition is impossible', () => {
  const injectionValues = [
    '; rm -rf /',
    '$(rm -rf /)',
    '`rm -rf /`',
    '&& echo pwned',
    '| cat /etc/passwd',
    'HEAD; log',
    'log',
  ];

  for (const value of injectionValues) {
    it(`treats revision value "${value}" as a single literal argv entry`, () => {
      const argv = buildGitArgv({ subcommand: 'log', revision: value });
      // The entire string is exactly one argv element -- nothing about it was interpreted or
      // split, because argv is passed straight to execFileSync with no shell involved.
      expect(argv).toContain(value);
      expect(argv).toEqual(['log', '--no-color', value]);
    });

    it(`treats path value "${value}" as a single literal argv entry after '--'`, () => {
      const argv = buildGitArgv({ subcommand: 'log', path: value });
      const sepIndex = argv.indexOf('--');
      expect(sepIndex).toBeGreaterThanOrEqual(0);
      expect(argv[sepIndex + 1]).toBe(value);
    });
  }

  for (const optionLike of ['-original', '--upload-pack=/bin/sh', '-x']) {
    it(`rejects option-like revision value "${optionLike}"`, () => {
      expect(() => buildGitArgv({ subcommand: 'log', revision: optionLike })).toThrow();
    });

    it(`rejects option-like path value "${optionLike}"`, () => {
      expect(() => buildGitArgv({ subcommand: 'log', path: optionLike })).toThrow();
    });
  }

  it('rejects a path attempting relative traversal out of the repository', () => {
    expect(() => buildGitArgv({ subcommand: 'log', path: '../outside.txt' })).toThrow();
    expect(() => buildGitArgv({ subcommand: 'log', path: '../../etc/passwd' })).toThrow();
  });

  it('rejects an absolute path', () => {
    expect(() => buildGitArgv({ subcommand: 'log', path: '/etc/passwd' })).toThrow();
  });
});

describe('runGitHistory against a real repository', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
    repo.writeAndCommit('tracked.txt', 'hello world\n', 'initial commit');
    repo.writeAndCommit('src/foo.ts', 'export const x = 1;\n', 'add foo');
  });

  afterEach(() => {
    repo.cleanup();
  });

  function statusAndHead(): { status: string; head: string } {
    return { status: repo.git(['status', '--porcelain']), head: repo.git(['rev-parse', 'HEAD']) };
  }

  it('returns real output for each allowlisted subcommand', () => {
    expect(runGitHistory(repo.root, { subcommand: 'log' })).toContain('initial commit');
    expect(runGitHistory(repo.root, { subcommand: 'show' })).toContain('add foo');
    expect(runGitHistory(repo.root, { subcommand: 'blame', path: 'tracked.txt' })).toContain(
      'hello world',
    );
    expect(runGitHistory(repo.root, { subcommand: 'diff', revision: 'HEAD~1..HEAD' })).toContain(
      'foo.ts',
    );
  });

  it('refuses a non-allowlisted subcommand and executes nothing', () => {
    const before = statusAndHead();
    expect(() =>
      runGitHistory(repo.root, { subcommand: 'push' } as unknown as GitParams),
    ).toThrow();
    expect(statusAndHead()).toEqual(before);
  });

  it('leaves the repository unchanged across every allowlisted call', () => {
    const before = statusAndHead();
    runGitHistory(repo.root, { subcommand: 'log' });
    runGitHistory(repo.root, { subcommand: 'show' });
    runGitHistory(repo.root, { subcommand: 'blame', path: 'tracked.txt' });
    runGitHistory(repo.root, { subcommand: 'diff' });
    expect(statusAndHead()).toEqual(before);
  });

  it('a revision containing shell metacharacters is passed literally and fails as an unknown revision, without invoking a shell', () => {
    const before = statusAndHead();
    expect(() => runGitHistory(repo.root, { subcommand: 'log', revision: '; rm -rf /' })).toThrow();
    expect(statusAndHead()).toEqual(before);
  });

  it('rejects a git colon-syntax attempt to read outside the repository (verified against real git)', () => {
    // Not reachable through buildGitArgv's structured fields (revision and path are always
    // separate literal argv entries, never concatenated into "rev:path" syntax) -- this test
    // pins the underlying git behaviour this design decision relies on.
    expect(() => repo.git(['show', 'HEAD:../../etc/passwd'])).toThrow();
  });
});
