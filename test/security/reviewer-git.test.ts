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
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_TOOL_OUTPUT_CHARS,
  buildGitArgv,
  councilGitTool,
  runGitHistory,
  type GitParams,
} from '../../src/reviewer-tools.js';
import { createTestRepo, type TestRepo } from '../helpers/git-repo.js';

describe('buildGitArgv allowlist', () => {
  it('builds argv for each allowlisted subcommand', () => {
    const noDrivers = ['--no-color', '--no-ext-diff', '--no-textconv'];
    expect(buildGitArgv({ subcommand: 'log' })).toEqual(['log', ...noDrivers, '--max-count=50']);
    expect(buildGitArgv({ subcommand: 'show' })).toEqual(['show', ...noDrivers, 'HEAD']);
    expect(buildGitArgv({ subcommand: 'diff' })).toEqual(['diff', ...noDrivers]);
    expect(buildGitArgv({ subcommand: 'blame', path: 'src/foo.ts' })).toEqual([
      'blame',
      '--no-textconv',
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
      expect(argv).toEqual([
        'log',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--max-count=50',
        value,
      ]);
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

describe('council_git log is bounded by default', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
    repo.writeAndCommit('tracked.txt', 'hello\n', 'initial commit');
    for (let i = 0; i < 59; i++) {
      repo.git(['commit', '--allow-empty', '--no-gpg-sign', '-m', `empty ${i}`]);
    }
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('pushes --max-count=50 when maxCount is omitted, matching the schema description', () => {
    expect(buildGitArgv({ subcommand: 'log' })).toContain('--max-count=50');
  });

  it('returns at most 50 commits from a 60-commit history when maxCount is omitted', () => {
    const output = runGitHistory(repo.root, { subcommand: 'log' });
    expect(output.match(/^commit [0-9a-f]{40}/gm)).toHaveLength(50);
  });

  it('honours an explicit maxCount', () => {
    const output = runGitHistory(repo.root, { subcommand: 'log', maxCount: 3 });
    expect(output.match(/^commit [0-9a-f]{40}/gm)).toHaveLength(3);
  });
});

describe('revisions that reach the stash, reflogs or pseudo-refs are refused', () => {
  const refused = [
    'stash',
    'stash^3',
    'stash^3:.env',
    'refs/stash^3:.env',
    'stash~0',
    'stash^{tree}',
    'STASH^3:.env',
    'Refs/Stash^3:.env',
    'stash@{0}^3:.env',
    'refs/stash@{1}',
    'HEAD..stash',
    'main...refs/stash',
    '^stash',
    'HEAD@{1}',
    '@{u}',
    '@{-1}',
    ':/untracked files on',
    'HEAD..:/wip',
    'ORIG_HEAD',
    'orig_head:.env',
    'FETCH_HEAD',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'AUTO_MERGE',
    'MERGE_AUTOSTASH^3',
  ];
  for (const revision of refused) {
    it(`rejects revision "${revision}"`, () => {
      expect(() => buildGitArgv({ subcommand: 'show', revision })).toThrow(/revision/);
    });
  }

  const accepted = [
    'HEAD',
    '@',
    'HEAD~3',
    'HEAD^2',
    'abc1234',
    '0123456789abcdef0123456789abcdef01234567',
    'main',
    'v1.2.3',
    'origin/main',
    'refs/heads/stash',
    'heads/stash',
    'feature/stash-cleanup',
    'stashed-work',
    'HEAD~1..HEAD',
    'main...feature',
    'HEAD^{tree}',
    'HEAD^{/fix bug}',
    'HEAD:src/foo.ts',
    'HEAD^!',
  ];
  for (const revision of accepted) {
    it(`accepts legitimate revision "${revision}"`, () => {
      expect(buildGitArgv({ subcommand: 'show', revision })).toContain(revision);
    });
  }

  describe('against a real repository with `git stash --all`', () => {
    let repo: TestRepo;

    beforeEach(() => {
      repo = createTestRepo();
      repo.writeAndCommit('.gitignore', '.env\n', 'ignore env');
      repo.writeFile('.env', 'STASHED-SECRET=1\n');
      repo.git(['stash', 'push', '--all', '-m', 'wip']);
    });

    afterEach(() => {
      repo.cleanup();
    });

    it('the leak is real: plain git reads the stashed ignored file', () => {
      expect(repo.git(['show', 'stash^3:.env'])).toContain('STASHED-SECRET');
      expect(repo.git(['show', ':/untracked files on'])).toContain('STASHED-SECRET');
    });

    for (const revision of [
      'stash^3:.env',
      'refs/stash^3:.env',
      'stash@{0}^3:.env',
      ':/untracked files on',
    ]) {
      it(`council_git refuses "${revision}" and never reveals the stashed file`, () => {
        expect(() => runGitHistory(repo.root, { subcommand: 'show', revision })).toThrow(
          /revision/,
        );
      });
    }

    it('council_git log cannot enumerate stash commits either', () => {
      expect(() =>
        runGitHistory(repo.root, { subcommand: 'log', revision: 'HEAD..stash' }),
      ).toThrow(/revision/);
    });
  });
});

describe('user diff drivers never run', () => {
  let repo: TestRepo;
  let marker: string;

  beforeEach(() => {
    repo = createTestRepo();
    marker = join(repo.root, '.git', 'driver-ran-marker');
    const script = join(repo.root, '.git', 'driver.sh');
    writeFileSync(script, `#!/bin/sh\necho DRIVER-RAN\ntouch '${marker}'\n`);
    chmodSync(script, 0o755);
    repo.git(['config', 'diff.external', script]);
    repo.git(['config', 'diff.upper.textconv', script]);
    repo.writeAndCommit('.gitattributes', '*.txt diff=upper\n', 'attributes');
    repo.writeAndCommit('a.txt', 'one\n', 'first');
    repo.writeAndCommit('a.txt', 'two\n', 'second');
    repo.writeFile('a.txt', 'three\n');
  });

  afterEach(() => {
    rmSync(marker, { force: true });
    repo.cleanup();
  });

  it('the drivers are real: plain git runs them', () => {
    expect(repo.git(['diff', 'HEAD~1..HEAD'])).toContain('DRIVER-RAN');
    expect(existsSync(marker)).toBe(true);
  });

  it('adds --no-ext-diff --no-textconv to diff/show/log and --no-textconv to blame', () => {
    for (const subcommand of ['diff', 'show', 'log'] as const) {
      const argv = buildGitArgv({ subcommand });
      expect(argv).toContain('--no-ext-diff');
      expect(argv).toContain('--no-textconv');
    }
    expect(buildGitArgv({ subcommand: 'blame', path: 'a.txt' })).toContain('--no-textconv');
  });

  it('neither diff.external nor a textconv driver runs for diff, show, log or blame', () => {
    const outputs = [
      runGitHistory(repo.root, { subcommand: 'diff' }),
      runGitHistory(repo.root, { subcommand: 'diff', revision: 'HEAD~1..HEAD' }),
      runGitHistory(repo.root, { subcommand: 'show' }),
      runGitHistory(repo.root, { subcommand: 'log', maxCount: 2 }),
      runGitHistory(repo.root, { subcommand: 'blame', path: 'a.txt' }),
    ];
    for (const output of outputs) {
      expect(output).not.toContain('DRIVER-RAN');
    }
    expect(runGitHistory(repo.root, { subcommand: 'show' })).toContain('+two');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('council_git output and runtime are bounded', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('truncates output above the exec buffer with a marker instead of failing with ENOBUFS', () => {
    const line = `${'x'.repeat(99)}\n`;
    repo.writeAndCommit('big.txt', line.repeat(30_000), 'a 3MB file');
    const output = runGitHistory(repo.root, { subcommand: 'show' });
    expect(output.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 500);
    expect(output).toMatch(/\[output truncated: more than \d+ characters/);
  });

  it('truncates output above the tool limit with a marker', () => {
    const line = `${'y'.repeat(99)}\n`;
    repo.writeAndCommit('medium.txt', line.repeat(2_000), 'a 200KB file');
    const output = runGitHistory(repo.root, { subcommand: 'show' });
    expect(output.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 500);
    expect(output).toMatch(/\[output truncated: \d+ characters total/);
  });

  it('kills a hung git and reports a timeout', () => {
    // A repository-local fsmonitor hook runs on every working-tree diff; a hanging one stands in
    // for any git invocation that never finishes.
    repo.writeAndCommit('a.txt', 'one\n', 'first');
    const hook = join(repo.root, '.git', 'slow-fsmonitor.sh');
    writeFileSync(hook, '#!/bin/sh\nsleep 20\n');
    chmodSync(hook, 0o755);
    repo.git(['config', 'core.fsmonitor', hook]);
    const started = Date.now();
    expect(() => runGitHistory(repo.root, { subcommand: 'diff' }, { timeoutMs: 300 })).toThrow(
      /timed out/,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('council_git tool description', () => {
  it('states that revision-less blame/diff read the live working tree, not the snapshot', () => {
    expect(councilGitTool.description).toMatch(/working tree/);
    expect(councilGitTool.description).toMatch(/snapshot/);
  });
});
