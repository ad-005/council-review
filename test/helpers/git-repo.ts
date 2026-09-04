/**
 * Test-only helper for building throwaway git repositories, so scope and snapshot logic can be
 * exercised against real git behaviour rather than mocks. Every repo lives under its own fresh
 * `mkdtemp` directory, is created with an explicit initial branch name (never relying on the
 * host's `init.defaultBranch`), and has `user.name`/`user.email`/`commit.gpgsign` set locally —
 * never globally — so tests never depend on, or mutate, the developer machine's git config.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TestRepoOptions {
  /** Name of the initial branch. Defaults to 'main'. */
  initialBranch?: string;
}

export class TestRepo {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Runs a git command in this repo, returning trimmed stdout. Argument array only, never a shell string. */
  git(args: readonly string[]): string {
    return execFileSync('git', args as string[], { cwd: this.root, encoding: 'utf8' }).trim();
  }

  /** Writes a file relative to the repo root, creating parent directories as needed. Does not stage it. */
  writeFile(relPath: string, content: string): void {
    const full = join(this.root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  /** Stages the given paths, or everything under the root if none are given. */
  add(paths?: readonly string[]): void {
    this.git(['add', '--', ...(paths && paths.length > 0 ? paths : ['.'])]);
  }

  /** Commits currently staged content and returns the new commit's sha. */
  commit(message: string): string {
    this.git(['commit', '-m', message, '--no-gpg-sign']);
    return this.git(['rev-parse', 'HEAD']);
  }

  /** Writes a file, stages it and commits it in one step -- a convenience for building history. */
  writeAndCommit(relPath: string, content: string, message: string): string {
    this.writeFile(relPath, content);
    this.add([relPath]);
    return this.commit(message);
  }

  /** Path to this repo's real index file, resolved via `git rev-parse --git-dir`. Test seam for
   *  asserting the real index is untouched by code under test. */
  indexPath(): string {
    const gitDir = this.git(['rev-parse', '--git-dir']);
    const absolute = gitDir.startsWith('/') ? gitDir : join(this.root, gitDir);
    return join(absolute, 'index');
  }

  /** Removes the temporary directory. Safe to call more than once. */
  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Creates a fresh throwaway git repository with a local (never global) identity configured. */
export function createTestRepo(opts: TestRepoOptions = {}): TestRepo {
  const branch = opts.initialBranch ?? 'main';
  const root = mkdtempSync(join(tmpdir(), 'council-review-test-repo-'));
  const repo = new TestRepo(root);
  repo.git(['init', '--quiet', '-b', branch]);
  repo.git(['config', 'user.name', 'Council Review Test']);
  repo.git(['config', 'user.email', 'council-review-test@example.invalid']);
  // A developer machine's global commit.gpgsign must never leak into a throwaway test fixture.
  repo.git(['config', 'commit.gpgsign', 'false']);
  return repo;
}
