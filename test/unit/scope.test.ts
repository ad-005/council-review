import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  checkScopeSelectors,
  findRepoRoot,
  resolveScope,
  ScopeError,
  type ScopeSelectors,
} from '../../src/scope.js';
import { reviewsDirPath } from '../../src/report.js';
import { createTestRepo, type TestRepo } from '../helpers/git-repo.js';

/** Every file under the repository's object store, repo-relative and sorted. */
function listObjectFiles(repo: TestRepo): string[] {
  const objects = join(repo.root, '.git', 'objects');
  return readdirSync(objects, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(objects, join(e.parentPath, e.name)))
    .sort();
}

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

    it('leaves an untracked embedded repository out, even one with no commit checked out', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.writeFile('base.txt', 'changed\n');
      repo.writeFile('nested/inner.txt', 'belongs to another repository\n');
      repo.git(['-C', join(repo.root, 'nested'), 'init', '--quiet']);

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });

      expect(scope.files).toEqual(['base.txt']);
      expect(scope.patch).not.toContain('nested');
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

  describe('unusual file names', () => {
    it('folds an untracked non-ASCII file name into the patch', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.writeFile('é.txt', 'accented content\n');

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });

      expect(scope.files).toEqual(['é.txt']);
      expect(scope.patch).toContain('diff --git a/é.txt b/é.txt');
      expect(scope.patch).toContain('accented content');
    });

    it('includes a modified tracked non-ASCII file in the patch, not just the file set', async () => {
      repo.writeAndCommit('é.txt', 'before\n', 'base commit');
      repo.writeFile('é.txt', 'before\nafter\n');

      for (const selectors of [{}, { revision: 'HEAD' }] as ScopeSelectors[]) {
        if (selectors.revision !== undefined) {
          repo.add(['é.txt']);
          repo.commit('edit');
        }
        const scope = await resolveScope(repo.root, selectors, { baseBranch: 'main' });
        expect(scope.files).toEqual(['é.txt']);
        expect(scope.patch).toContain('+after');
      }
    });

    it('keeps leading and trailing spaces in file names', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.writeFile(' lead.txt', 'lead content\n');
      repo.writeFile('trail.txt ', 'trail content\n');

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });

      expect(scope.files).toEqual([' lead.txt', 'trail.txt ']);
      expect(scope.patch).toContain('lead content');
      expect(scope.patch).toContain('trail content');
    });

    it('treats file names as literal paths, never pathspec magic or globs', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.writeFile(':colon.txt', 'colon content\n');
      repo.writeFile('*.ts', 'star content\n');
      repo.writeFile('a.ts', 'plain ts content\n');

      const colon = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      expect(colon.files).toEqual(['*.ts', ':colon.txt', 'a.ts']);
      expect(colon.patch).toContain('colon content');

      // Only the file literally named `*.ts` is selected; its name must not glob-match a.ts.
      const star = await resolveScope(repo.root, { paths: ['\\*.ts'] }, { baseBranch: 'main' });
      expect(star.files).toEqual(['*.ts']);
      expect(star.patch).toContain('star content');
      expect(star.patch).not.toContain('plain ts content');
    });

    it('handles more untracked files than fit in one argv', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      // ~2.4MB of path names: past Linux's default ARG_MAX (2MB) if passed as arguments.
      const dir = 'd'.repeat(200);
      const count = 11000;
      for (let i = 0; i < count; i++) repo.writeFile(`${dir}/f${i}`, `${i}\n`);

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });

      expect(scope.files).toHaveLength(count);
      expect(scope.patch.match(/^diff --git /gm)).toHaveLength(count);
    });
  });

  describe('renames', () => {
    function expectBothSides(scope: { files: string[]; patch: string }): void {
      expect(scope.files).toEqual(['new-name.txt', 'old-name.txt']);
      expect(scope.patch).toContain('rename from old-name.txt');
      expect(scope.patch).toContain('rename to new-name.txt');
    }

    it('lists both sides of a rename and keeps the deletion of the old path, in every mode', async () => {
      repo.writeAndCommit('old-name.txt', 'line one\nline two\nline three\n', 'base commit');
      repo.git(['branch', 'main-base', 'HEAD']);
      repo.git(['mv', 'old-name.txt', 'new-name.txt']);

      expectBothSides(await resolveScope(repo.root, {}, { baseBranch: 'main-base' }));
      expectBothSides(await resolveScope(repo.root, { staged: true }, { baseBranch: 'main' }));

      const rev = repo.commit('rename');
      expectBothSides(await resolveScope(repo.root, { revision: rev }, { baseBranch: 'main' }));
      expectBothSides(
        await resolveScope(repo.root, { range: `main-base..${rev}` }, { baseBranch: 'main' }),
      );
    });

    it('narrows each side of a rename independently by --paths', async () => {
      repo.writeFile('src/other.txt', 'other\n');
      repo.writeAndCommit('lib/x.txt', 'line one\nline two\nline three\n', 'base commit');
      repo.git(['mv', 'lib/x.txt', 'src/x.txt']);

      const scope = await resolveScope(
        repo.root,
        { staged: true, paths: ['src/**'] },
        { baseBranch: 'main' },
      );

      expect(scope.files).toEqual(['src/x.txt']);
      expect(scope.patch).toContain('new file mode');
    });
  });

  describe('isolation from the caller repository and user git config', () => {
    it('does not refresh (rewrite) the real index when its stat data is stale', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      // Same content, new mtime: `git status` would otherwise refresh and rewrite the index.
      const future = new Date(Date.now() + 60_000);
      utimesSync(join(repo.root, 'base.txt'), future, future);
      const indexBefore = readFileSync(repo.indexPath());

      for (const selectors of [{}, { staged: true }] as ScopeSelectors[]) {
        await resolveScope(repo.root, selectors, { baseBranch: 'main' });
      }

      expect(Buffer.compare(readFileSync(repo.indexPath()), indexBefore)).toBe(0);
    });

    it('writes no objects into the repository when folding untracked files', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.writeFile('empty.txt', '');
      repo.writeFile('untracked.txt', 'untracked\n');
      const objectsBefore = listObjectFiles(repo);

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });

      expect(scope.files).toEqual(['empty.txt', 'untracked.txt']);
      expect(listObjectFiles(repo)).toEqual(objectsBefore);
    });

    it('produces a plain a/ b/ patch regardless of color, prefix and external-diff config', async () => {
      repo.writeFile('.gitattributes', '*.txt diff=shout\n');
      repo.add(['.gitattributes']);
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      // Inside .git/: never listed, never reviewed, removed with the repo.
      const marker = join(repo.root, '.git', 'ext-diff-ran');
      const script = join(repo.root, '.git', 'ext-diff.sh');
      writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      repo.git(['config', 'color.ui', 'always']);
      repo.git(['config', 'diff.noprefix', 'true']);
      repo.git(['config', 'diff.mnemonicPrefix', 'true']);
      repo.git(['config', 'diff.external', script]);
      repo.git(['config', 'diff.shout.textconv', 'tr a-z A-Z']);
      repo.writeFile('base.txt', 'base\nedited\n');

      const worktree = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      repo.add(['base.txt']);
      const rev = repo.commit('edit');
      const revision = await resolveScope(repo.root, { revision: rev }, { baseBranch: 'main' });

      for (const scope of [worktree, revision]) {
        expect(scope.files).toEqual(['base.txt']);
        expect(scope.patch).not.toContain('\x1b[');
        expect(scope.patch).not.toContain('EDITED');
        expect(scope.patch).toContain('diff --git a/base.txt b/base.txt\n');
        expect(scope.patch).toContain('\n--- a/base.txt\n+++ b/base.txt\n');
        expect(scope.patch).toContain('\n+edited\n');
      }
      expect(existsSync(marker)).toBe(false);
    });
  });

  describe('descriptive errors', () => {
    it('explains a repository with no commits yet', async () => {
      repo.writeFile('staged.txt', 'staged\n');
      repo.add(['staged.txt']);

      await expect(
        resolveScope(repo.root, { staged: true }, { baseBranch: 'main' }),
      ).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringContaining('no commits yet'),
      });
    });

    it('explains unrelated histories with no merge base', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.git(['checkout', '--orphan', 'unrelated']);
      repo.writeAndCommit('other.txt', 'other\n', 'unrelated root');

      await expect(resolveScope(repo.root, {}, { baseBranch: 'main' })).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringMatching(/no common ancestor.*"main".*--base.*--range/),
      });
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
      repo.writeFile(
        reviewsRelFile(repo, '20260101T000000000Z', 'manifest.json'),
        '{"scope":{}}\n',
      );
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
      const rev = repo.writeAndCommit(
        artifactPath,
        '{"scope":{}}\n',
        'accidentally committed a run',
      );
      repo.writeAndCommit('feature.txt', 'feature\n', 'real change');

      const worktree = await resolveScope(repo.root, {}, { baseBranch: 'main-base' });
      expect(worktree.files).toEqual(['feature.txt']);

      const revision = await resolveScope(
        repo.root,
        { revision: rev },
        { baseBranch: 'main-base' },
      );
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

    it('does not count its own untracked run artifacts as a dirty worktree', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.writeFile(reviewsRelFile(repo, '20260101T000000000Z', 'manifest.json'), '{}\n');

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });

      expect(scope.dirty).toBe(false);

      // Anything else untracked next to it still counts.
      repo.writeFile('.council/config.json', '{}\n');
      const dirtyScope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      expect(dirtyScope.dirty).toBe(true);
    });

    it('ignores pathspec-mode variables in the environment', async () => {
      repo.writeAndCommit('base.txt', 'base\n', 'base commit');
      repo.writeFile('base.txt', 'changed\n');

      for (const name of ['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']) {
        process.env[name] = '1';
        try {
          const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
          expect(scope.dirty).toBe(true);
          expect(scope.files).toEqual(['base.txt']);
        } finally {
          delete process.env[name];
        }
      }
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
