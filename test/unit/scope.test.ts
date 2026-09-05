import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  checkScopeSelectors,
  findRepoRoot,
  resolveScope,
  ScopeError,
  type ScopeSelectors,
} from '../../src/scope.js';
import { reviewsDirPath } from '../../src/report.js';
import { createTestRepo, type TestRepo } from '../helpers/git-repo.js';

describe('scope', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  describe('findRepoRoot', () => {
    it('resolves the toplevel of a real repository', () => {
      expect(findRepoRoot(repo.root)).toBe(repo.git(['rev-parse', '--show-toplevel']));
    });

    it('throws a ScopeError with exitCode 2 outside a git repository', () => {
      // The OS temp directory itself is not a repo (mkdtemp creates a fresh dir each time).
      const outside = repo.root.slice(0, repo.root.lastIndexOf('/'));
      let thrown: unknown;
      try {
        findRepoRoot(outside);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ScopeError);
      expect((thrown as ScopeError).exitCode).toBe(2);
    });
  });

  describe('checkScopeSelectors', () => {
    it('accepts a single selector', () => {
      expect(() => checkScopeSelectors({ staged: true })).not.toThrow();
      expect(() => checkScopeSelectors({ range: 'a..b' })).not.toThrow();
      expect(() => checkScopeSelectors({ revision: 'abc' })).not.toThrow();
      expect(() => checkScopeSelectors({})).not.toThrow();
    });

    it('rejects staged combined with range', () => {
      let thrown: unknown;
      try {
        checkScopeSelectors({ staged: true, range: 'a..b' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ScopeError);
      expect((thrown as ScopeError).exitCode).toBe(2);
      expect((thrown as Error).message).toContain('--staged');
      expect((thrown as Error).message).toContain('--range');
    });

    it('rejects staged combined with revision', () => {
      expect(() => checkScopeSelectors({ staged: true, revision: 'abc' })).toThrow(ScopeError);
    });

    it('rejects range combined with revision', () => {
      expect(() => checkScopeSelectors({ range: 'a..b', revision: 'abc' })).toThrow(ScopeError);
    });

    it('is called by resolveScope before any git work, for a conflicting selector', async () => {
      await expect(
        resolveScope(repo.root, { staged: true, range: 'a..b' }, { baseBranch: 'main' }),
      ).rejects.toBeInstanceOf(ScopeError);
    });
  });

  describe('default (worktree) scope', () => {
    it('folds committed, staged, unstaged and untracked-not-ignored changes into one patch', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.git(['branch', 'main-base', 'HEAD']); // marks the pre-divergence point used as the base below

      // Committed ahead of base.
      repo.writeAndCommit('committed.txt', 'committed content\n', 'add committed file');

      // Staged edit.
      repo.writeFile('staged.txt', 'staged content\n');
      repo.add(['staged.txt']);

      // Unstaged edit to a tracked file.
      repo.writeFile('base.txt', 'base\nmodified unstaged\n');

      // Untracked, not ignored.
      repo.writeFile('untracked.txt', 'untracked content\n');

      // Untracked but ignored.
      repo.writeFile('.gitignore', 'ignored.txt\nnode_modules/\n');
      repo.add(['.gitignore']);
      repo.commit('add gitignore');
      repo.writeFile('ignored.txt', 'should never appear\n');
      repo.writeFile('node_modules/dep/index.js', 'module.exports = {};\n');

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main-base' });

      expect(scope.mode).toBe('worktree');
      expect(scope.empty).toBe(false);
      expect(scope.endRevision).toBeNull();
      expect(scope.files.sort()).toEqual(
        ['.gitignore', 'base.txt', 'committed.txt', 'staged.txt', 'untracked.txt'].sort(),
      );
      expect(scope.patch).toContain('committed content');
      expect(scope.patch).toContain('staged content');
      expect(scope.patch).toContain('modified unstaged');
      expect(scope.patch).toContain('untracked content');
      expect(scope.patch).not.toContain('should never appear');
      expect(scope.files).not.toContain('node_modules/dep/index.js');
    });

    it('excludes gitignored paths from both the patch and the file set', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.writeFile('.gitignore', 'env/\n*.secret\n');
      repo.add(['.gitignore']);
      repo.commit('add gitignore');

      repo.writeFile('env/config.js', 'secret = 1\n');
      repo.writeFile('token.secret', 'sk-abc123\n');
      repo.writeFile('kept.txt', 'kept\n');

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });

      expect(scope.files).toEqual(['kept.txt']);
      expect(scope.patch).not.toContain('secret');
      expect(scope.patch).not.toContain('sk-abc123');
    });

    it('resolves the base branch from configuration when no override is given', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.git(['checkout', '-b', 'feature']);
      repo.writeAndCommit('feature.txt', 'feature\n', 'feature commit');

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });

      expect(scope.baseBranch).toBe('main');
      expect(scope.mergeBase).toBe(repo.git(['rev-parse', 'main']));
      expect(scope.files).toEqual(['feature.txt']);
    });

    it('uses a base branch override from the selectors instead of the configured one', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.git(['checkout', '-b', 'other-base']);
      repo.writeAndCommit('other.txt', 'other\n', 'other-base commit');
      repo.git(['checkout', '-b', 'feature', 'main']);
      repo.writeAndCommit('feature.txt', 'feature\n', 'feature commit');

      const scope = await resolveScope(repo.root, { base: 'other-base' }, { baseBranch: 'main' });

      expect(scope.baseBranch).toBe('other-base');
      // Diverges from other-base, so feature.txt is present but other.txt (unique to
      // other-base, absent from feature) is not part of feature's own changes.
      expect(scope.files).toEqual(['feature.txt']);
    });

    it('exits with a ScopeError naming the branch when the base branch does not exist', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      let thrown: unknown;
      try {
        await resolveScope(repo.root, {}, { baseBranch: 'does-not-exist' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ScopeError);
      expect((thrown as ScopeError).exitCode).toBe(2);
      expect((thrown as Error).message).toContain('does-not-exist');
    });

    it('reports an empty scope when there is nothing to review', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      expect(scope.empty).toBe(true);
      expect(scope.files).toEqual([]);
      expect(scope.patch).toBe('');
    });

    it('leaves the real index and working tree untouched', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.writeFile('untracked.txt', 'untracked\n');
      repo.writeFile('base.txt', 'base\nedited\n');

      const indexBefore = readFileSync(repo.indexPath());
      const statusBefore = repo.git(['status', '--porcelain']);

      await resolveScope(repo.root, {}, { baseBranch: 'main' });

      const indexAfter = readFileSync(repo.indexPath());
      const statusAfter = repo.git(['status', '--porcelain']);

      expect(Buffer.compare(indexBefore, indexAfter)).toBe(0);
      expect(statusAfter).toBe(statusBefore);
    });
  });

  describe('staged scope', () => {
    it('describes exactly the staged changes, excluding unstaged and untracked changes', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');

      repo.writeFile('staged.txt', 'staged content\n');
      repo.add(['staged.txt']);

      repo.writeFile('base.txt', 'base\nunstaged edit\n');
      repo.writeFile('untracked.txt', 'untracked content\n');

      const scope = await resolveScope(repo.root, { staged: true }, { baseBranch: 'main' });

      expect(scope.mode).toBe('staged');
      expect(scope.endRevision).toBeNull();
      expect(scope.files).toEqual(['staged.txt']);
      expect(scope.patch).toContain('staged content');
      expect(scope.patch).not.toContain('unstaged edit');
      expect(scope.patch).not.toContain('untracked content');
    });

    it('leaves the real index and working tree untouched', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.writeFile('staged.txt', 'staged\n');
      repo.add(['staged.txt']);

      const indexBefore = readFileSync(repo.indexPath());
      const statusBefore = repo.git(['status', '--porcelain']);

      await resolveScope(repo.root, { staged: true }, { baseBranch: 'main' });

      expect(Buffer.compare(readFileSync(repo.indexPath()), indexBefore)).toBe(0);
      expect(repo.git(['status', '--porcelain'])).toBe(statusBefore);
    });
  });

  describe('range scope', () => {
    it('describes exactly the difference between the two endpoints', async () => {
      const a = repo.writeAndCommit('base.txt', 'base\n', 'commit A');
      repo.writeAndCommit('middle.txt', 'middle\n', 'commit B');
      const c = repo.writeAndCommit('end.txt', 'end\n', 'commit C');

      const scope = await resolveScope(repo.root, { range: `${a}..${c}` }, { baseBranch: 'main' });

      expect(scope.mode).toBe('range');
      expect(scope.endRevision).toBe(c);
      expect(scope.files.sort()).toEqual(['middle.txt', 'end.txt'].sort());
      expect(scope.patch).toContain('middle');
      expect(scope.patch).toContain('end');
    });

    it('supports the three-dot separator', async () => {
      const a = repo.writeAndCommit('base.txt', 'base\n', 'commit A');
      const b = repo.writeAndCommit('next.txt', 'next\n', 'commit B');

      const scope = await resolveScope(repo.root, { range: `${a}...${b}` }, { baseBranch: 'main' });
      expect(scope.files).toEqual(['next.txt']);
      expect(scope.endRevision).toBe(b);
    });

    it('exits with a ScopeError naming an unresolvable revision', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'commit A');
      let thrown: unknown;
      try {
        await resolveScope(repo.root, { range: 'HEAD..nope-not-a-thing' }, { baseBranch: 'main' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ScopeError);
      expect((thrown as ScopeError).exitCode).toBe(2);
      expect((thrown as Error).message).toContain('nope-not-a-thing');
    });
  });

  describe('revision scope', () => {
    it("describes exactly that revision's change", async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'commit A');
      const rev = repo.writeAndCommit('feature.txt', 'feature content\n', 'commit B');

      const scope = await resolveScope(repo.root, { revision: rev }, { baseBranch: 'main' });

      expect(scope.mode).toBe('revision');
      expect(scope.endRevision).toBe(rev);
      expect(scope.files).toEqual(['feature.txt']);
      expect(scope.patch).toContain('feature content');
    });

    it('handles a root commit by diffing against the empty tree', async () => {
      const root = repo.writeAndCommit('base.txt', 'root content\n', 'root commit');
      const scope = await resolveScope(repo.root, { revision: root }, { baseBranch: 'main' });
      expect(scope.files).toEqual(['base.txt']);
      expect(scope.patch).toContain('root content');
    });

    it('exits with a ScopeError naming an unresolvable revision', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'commit A');
      await expect(
        resolveScope(repo.root, { revision: 'totally-bogus-rev' }, { baseBranch: 'main' }),
      ).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringContaining('totally-bogus-rev'),
      });
    });
  });

  describe('path-glob narrowing', () => {
    async function repoWithMixedFiles(repo: TestRepo): Promise<void> {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.git(['branch', 'main-base', 'HEAD']); // marks the pre-divergence point used as the base below
      repo.writeAndCommit('src/a.ts', 'a\n', 'add a.ts');
      repo.writeAndCommit('src/b.ts', 'b\n', 'add b.ts');
      repo.writeAndCommit('README.md', 'docs\n', 'add readme');
    }

    it('restricts the patch and file set to matching globs, for any scope', async () => {
      await repoWithMixedFiles(repo);
      const selectors: ScopeSelectors = { paths: ['src/**/*.ts'] };
      const scope = await resolveScope(repo.root, selectors, { baseBranch: 'main-base' });

      expect(scope.files.sort()).toEqual(['src/a.ts', 'src/b.ts'].sort());
      expect(scope.patch).not.toContain('docs');
    });

    it('reports an empty scope when the globs match nothing', async () => {
      await repoWithMixedFiles(repo);
      const scope = await resolveScope(
        repo.root,
        { paths: ['*.nonexistent-extension'] },
        { baseBranch: 'main-base' },
      );
      expect(scope.empty).toBe(true);
      expect(scope.files).toEqual([]);
      expect(scope.patch).toBe('');
    });

    it('narrows a staged scope', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.writeFile('src/a.ts', 'a\n');
      repo.writeFile('README.md', 'docs\n');
      repo.add(['src/a.ts', 'README.md']);

      const scope = await resolveScope(
        repo.root,
        { staged: true, paths: ['src/**'] },
        { baseBranch: 'main' },
      );
      expect(scope.files).toEqual(['src/a.ts']);
    });
  });

  describe('own run-artifact exclusion', () => {
    // reviewsDirPath is report.ts's single source of truth for where a run's own manifest,
    // findings, report, handoff and per-reviewer traces land. These tests derive the relative
    // path from it rather than hardcoding '.council/reviews' a second time, so they keep
    // matching scope.ts's exclusion even if that directory ever moved.
    function reviewsRelFile(repo: TestRepo, ...segments: string[]): string {
      const abs = reviewsDirPath(repo.root);
      const rel = abs.slice(repo.root.length + 1); // strip "<root>/"
      return [rel, ...segments].join('/');
    }

    it('excludes untracked-not-ignored run artifacts from the default worktree scope', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');

      // Simulates a prior run's leftovers sitting in the tree, exactly as council-review itself
      // would leave them -- untracked, and with no .gitignore involved at all (the whole point
      // being that this must be excluded whether or not `init` ever ran).
      repo.writeFile(reviewsRelFile(repo, '20260101T000000000Z', 'manifest.json'), '{"scope":{}}\n');
      repo.writeFile(
        reviewsRelFile(repo, '20260101T000000000Z', 'reviewers', 'nova.trace.jsonl'),
        '{"line":1}\n',
      );
      repo.writeFile('kept.txt', 'kept content\n');

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });

      expect(scope.files).toEqual(['kept.txt']);
      expect(scope.patch).not.toContain('manifest');
      expect(scope.patch).not.toContain('nova.trace');
    });

    it('excludes committed run artifacts from every scope mode', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.git(['branch', 'main-base', 'HEAD']);
      const artifactPath = reviewsRelFile(repo, '20260101T000000000Z', 'manifest.json');
      const rev = repo.writeAndCommit(artifactPath, '{"scope":{}}\n', 'accidentally committed a run');
      repo.writeAndCommit('feature.txt', 'feature\n', 'real change');

      const worktree = await resolveScope(repo.root, {}, { baseBranch: 'main-base' });
      expect(worktree.files).toEqual(['feature.txt']);

      const revision = await resolveScope(repo.root, { revision: rev }, { baseBranch: 'main-base' });
      expect(revision.files).toEqual([]);
      expect(revision.empty).toBe(true);

      const range = await resolveScope(
        repo.root,
        { range: `main-base..${rev}` },
        { baseBranch: 'main-base' },
      );
      expect(range.files).toEqual([]);
      expect(range.empty).toBe(true);
    });

    it('excludes staged run artifacts from the staged scope', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      const artifactPath = reviewsRelFile(repo, '20260101T000000000Z', 'findings.json');
      repo.writeFile(artifactPath, '[]\n');
      repo.writeFile('staged.txt', 'staged content\n');
      repo.add([artifactPath, 'staged.txt']);

      const scope = await resolveScope(repo.root, { staged: true }, { baseBranch: 'main' });

      expect(scope.files).toEqual(['staged.txt']);
    });

    it('cannot be smuggled back in by an explicit --paths glob targeting it', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.writeFile(reviewsRelFile(repo, '20260101T000000000Z', 'manifest.json'), '{}\n');
      repo.writeFile('kept.txt', 'kept\n');

      const scope = await resolveScope(
        repo.root,
        { paths: ['.council/reviews/**', 'kept.txt'] },
        { baseBranch: 'main' },
      );

      expect(scope.files).toEqual(['kept.txt']);
    });

    it('still reviews changes to .council/config.json and .council/ignore.json', async () => {
      // Only the run-artifact directory is excluded -- config.json and ignore.json are meant to
      // be committed, and a reviewer should still see a change to them like any other file.
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.writeFile('.council/config.json', '{"models":[]}\n');
      repo.writeFile('.council/ignore.json', '{"suppressions":[]}\n');

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });

      expect(scope.files.sort()).toEqual(['.council/config.json', '.council/ignore.json'].sort());
    });
  });
});
