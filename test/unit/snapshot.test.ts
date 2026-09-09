import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSnapshot,
  sweepOrphans,
  writePatch,
  SNAPSHOT_PREFIX,
  type Snapshot,
} from '../../src/snapshot.js';
import { resolveScope, type ResolvedScope } from '../../src/scope.js';
import { createTestRepo } from '../helpers/git-repo.js';

/**
 * A fresh, isolated scratch base directory for one test's own `buildSnapshot`/`sweepOrphans`
 * calls -- `buildSnapshot`'s `scratchDir` option, and `sweepOrphans`'s second parameter, exist
 * specifically so tests that enumerate "everything under the scratch base" are not seeing (and
 * flaking on) whatever other, unrelated test files build concurrently in the real, process-wide
 * `os.tmpdir()`. Every test in this file that lists directory contents rather than just checking
 * its own `snapshot.root` uses one of these.
 */
function makeScratchDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'council-review-test-scratch-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Asserts every file and directory under `root` (root included) has no write bit set. */
function assertReadOnly(root: string): void {
  const st = statSync(root);
  expect(st.mode & 0o222).toBe(0);
  if (st.isDirectory()) {
    // Read-only in practice: attempting to create a new file under it fails.
    expect(() => writeFileSync(join(root, '__probe__'), 'x')).toThrow();
  } else {
    expect(() => writeFileSync(root, 'x')).toThrow();
  }
}

async function withSnapshot<T>(snapshot: Snapshot, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } finally {
    snapshot.cleanup();
  }
}

describe('buildSnapshot: worktree scope', () => {
  it('copies tracked files, untracked-not-ignored files, and excludes gitignored paths', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('tracked.txt', 'v1\n', 'initial');
      repo.writeFile('.gitignore', 'ignored.txt\nnode_modules/\n');
      repo.add(['.gitignore']);
      repo.commit('add gitignore');
      repo.writeFile('tracked.txt', 'v2 on disk\n'); // unstaged edit
      repo.writeFile('untracked.txt', 'brand new\n'); // untracked, not ignored
      repo.writeFile('ignored.txt', 'must not appear\n'); // untracked, ignored
      repo.writeFile('node_modules/dep/index.js', 'must not appear\n');

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope);

      await withSnapshot(snapshot, () => {
        expect(readFileSync(join(snapshot.root, 'tracked.txt'), 'utf8')).toBe('v2 on disk\n');
        expect(readFileSync(join(snapshot.root, 'untracked.txt'), 'utf8')).toBe('brand new\n');
        expect(existsSync(join(snapshot.root, 'ignored.txt'))).toBe(false);
        expect(existsSync(join(snapshot.root, 'node_modules'))).toBe(false);
        expect(snapshot.files).not.toContain('ignored.txt');
        expect(snapshot.files.some((f) => f.startsWith('node_modules'))).toBe(false);
      });
      expect(existsSync(snapshot.root)).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('folds committed, staged and unstaged changes and reflects them all on disk', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('a.txt', 'base\n', 'initial');
      repo.writeAndCommit('a.txt', 'committed change\n', 'second commit'); // ahead of base
      repo.writeFile('b.txt', 'staged\n');
      repo.add(['b.txt']); // staged
      repo.writeFile('a.txt', 'unstaged on top\n'); // unstaged edit of a tracked file

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope);

      await withSnapshot(snapshot, () => {
        expect(readFileSync(join(snapshot.root, 'a.txt'), 'utf8')).toBe('unstaged on top\n');
        expect(readFileSync(join(snapshot.root, 'b.txt'), 'utf8')).toBe('staged\n');
      });
    } finally {
      repo.cleanup();
    }
  });

  it('does not disturb the real repository: index and status are unchanged after the build', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('a.txt', 'base\n', 'initial');
      repo.writeFile('a.txt', 'edited\n');
      repo.writeFile('new.txt', 'new\n');

      const indexBefore = existsSync(repo.indexPath()) ? readFileSync(repo.indexPath()) : null;
      const statusBefore = repo.git(['status', '--porcelain']);

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope);
      snapshot.cleanup();

      const indexAfter = existsSync(repo.indexPath()) ? readFileSync(repo.indexPath()) : null;
      const statusAfter = repo.git(['status', '--porcelain']);

      expect(indexAfter?.equals(indexBefore as Buffer)).toBe(true);
      expect(statusAfter).toBe(statusBefore);
    } finally {
      repo.cleanup();
    }
  });
});

describe('buildSnapshot: staged scope', () => {
  it('materialises exactly the index, not the working tree', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('a.txt', 'base\n', 'initial');
      repo.writeFile('a.txt', 'staged content\n');
      repo.add(['a.txt']);
      repo.writeFile('a.txt', 'unstaged content on top -- must not appear\n');
      repo.writeFile('untracked.txt', 'must not appear either\n');

      const scope = await resolveScope(repo.root, { staged: true }, { baseBranch: 'main' });
      expect(scope.mode).toBe('staged');
      const snapshot = await buildSnapshot(repo.root, scope);

      await withSnapshot(snapshot, () => {
        expect(readFileSync(join(snapshot.root, 'a.txt'), 'utf8')).toBe('staged content\n');
        expect(existsSync(join(snapshot.root, 'untracked.txt'))).toBe(false);
      });
    } finally {
      repo.cleanup();
    }
  });
});

describe('buildSnapshot: range and revision scope', () => {
  it('materialises the tree at the range end revision, not the current worktree', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('a.txt', 'v1\n', 'c1');
      const c2 = repo.writeAndCommit('a.txt', 'v2\n', 'c2');
      repo.writeAndCommit('a.txt', 'v3 (after range end)\n', 'c3');

      const c1 = repo.git(['rev-parse', 'HEAD~2']);
      const scope = await resolveScope(
        repo.root,
        { range: `${c1}..${c2}` },
        { baseBranch: 'main' },
      );
      expect(scope.mode).toBe('range');
      expect(scope.endRevision).toBe(c2);

      const snapshot = await buildSnapshot(repo.root, scope);
      await withSnapshot(snapshot, () => {
        expect(readFileSync(join(snapshot.root, 'a.txt'), 'utf8')).toBe('v2\n');
      });
    } finally {
      repo.cleanup();
    }
  });

  it('materialises a single revision end state', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('a.txt', 'v1\n', 'c1');
      const c2 = repo.writeAndCommit('a.txt', 'v2\n', 'c2');
      repo.writeAndCommit('a.txt', 'v3\n', 'c3');

      const scope = await resolveScope(repo.root, { revision: c2 }, { baseBranch: 'main' });
      expect(scope.mode).toBe('revision');
      expect(scope.endRevision).toBe(c2);

      const snapshot = await buildSnapshot(repo.root, scope);
      await withSnapshot(snapshot, () => {
        expect(readFileSync(join(snapshot.root, 'a.txt'), 'utf8')).toBe('v2\n');
      });
    } finally {
      repo.cleanup();
    }
  });
});

describe('buildSnapshot: freeze', () => {
  it('makes every file and directory non-writable before returning', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('dir/nested.txt', 'content\n', 'initial');
      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope);

      await withSnapshot(snapshot, () => {
        assertReadOnly(snapshot.root);
        assertReadOnly(join(snapshot.root, 'dir'));
        assertReadOnly(join(snapshot.root, 'dir', 'nested.txt'));
        // Concurrent edits to the real worktree must not disturb the frozen copy.
        repo.writeFile('dir/nested.txt', 'changed after freeze\n');
        expect(readFileSync(join(snapshot.root, 'dir', 'nested.txt'), 'utf8')).toBe('content\n');
      });
    } finally {
      repo.cleanup();
    }
  });
});

describe('buildSnapshot: narrowing', () => {
  it('the configured include list narrows the copy, but never omits a patch file', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('src/a.ts', 'base\n', 'initial');
      repo.writeAndCommit('docs/readme.md', 'base\n', 'docs');
      // Tracked but never touched by the patch: a candidate the narrowing filter should be free
      // to drop, since forcing it back in would defeat the point of narrowing.
      repo.writeAndCommit('vendor/lib.js', 'noise\n', 'vendor');
      repo.writeFile('src/a.ts', 'changed\n'); // this is what the patch touches

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      expect(scope.files).toContain('src/a.ts');
      expect(scope.files).not.toContain('vendor/lib.js');

      const snapshot = await buildSnapshot(repo.root, scope, { include: ['docs/**'] });
      await withSnapshot(snapshot, () => {
        // docs/ matched the include list.
        expect(snapshot.files).toContain('docs/readme.md');
        // src/a.ts did NOT match the include list, but it is a patch file, so it must survive.
        expect(snapshot.files).toContain('src/a.ts');
        expect(existsSync(join(snapshot.root, 'src', 'a.ts'))).toBe(true);
        // vendor/lib.js matched neither the include list nor the patch: narrowed away.
        expect(snapshot.files).not.toContain('vendor/lib.js');
      });
    } finally {
      repo.cleanup();
    }
  });

  it('scope path globs also narrow the snapshot copy', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('src/a.ts', 'base\n', 'initial');
      repo.writeAndCommit('other/b.ts', 'base\n', 'other');
      repo.writeFile('src/a.ts', 'changed\n');
      repo.writeFile('other/b.ts', 'also changed\n');

      const scope = await resolveScope(repo.root, { paths: ['src/**'] }, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope);
      await withSnapshot(snapshot, () => {
        expect(snapshot.files).toContain('src/a.ts');
        expect(snapshot.files).not.toContain('other/b.ts');
      });
    } finally {
      repo.cleanup();
    }
  });
});

describe('buildSnapshot: patch is a run artifact, never snapshot content', () => {
  it('writePatch writes only to the given destination directory, never into the snapshot', async () => {
    const repo = createTestRepo();
    const runDir = mkdtempSync(join(tmpdir(), 'council-review-test-rundir-'));
    try {
      repo.writeAndCommit('a.txt', 'base\n', 'initial');
      repo.writeFile('a.txt', 'changed\n');

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope);

      await withSnapshot(snapshot, () => {
        const patchPath = writePatch(runDir, scope);
        expect(patchPath).toBe(join(runDir, 'patch.diff'));
        expect(readFileSync(patchPath, 'utf8')).toBe(scope.patch);

        // The snapshot contains only reviewed source content: no patch, prompt or manifest.
        expect(existsSync(join(snapshot.root, 'patch.diff'))).toBe(false);
        expect(snapshot.files.some((f) => f.endsWith('.diff'))).toBe(false);
      });
    } finally {
      repo.cleanup();
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

describe('buildSnapshot: identity', () => {
  it('records HEAD and the dirty flag from the resolved scope', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('a.txt', 'base\n', 'initial');
      repo.writeFile('a.txt', 'dirty\n');

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope);
      await withSnapshot(snapshot, () => {
        expect(snapshot.identity.head).toBe(scope.head);
        expect(snapshot.identity.dirty).toBe(scope.dirty);
        expect(scope.dirty).toBe(true);
      });
    } finally {
      repo.cleanup();
    }
  });

  it('hashes identically for byte-identical reviewed file sets', async () => {
    const repoA = createTestRepo();
    const repoB = createTestRepo();
    try {
      repoA.writeAndCommit('a.txt', 'same content\n', 'initial');
      repoB.writeAndCommit('a.txt', 'same content\n', 'initial');

      const scopeA = await resolveScope(repoA.root, {}, { baseBranch: 'main' });
      const scopeB = await resolveScope(repoB.root, {}, { baseBranch: 'main' });

      // Force both scopes into an equivalent "one file present" shape independent of history
      // shas, by reviewing a single revision each -- endRevision differs, but the tree hash must
      // not, since it is a function of reviewed path/content only.
      const revScopeA = await resolveScope(
        repoA.root,
        { revision: scopeA.head },
        { baseBranch: 'main' },
      );
      const revScopeB = await resolveScope(
        repoB.root,
        { revision: scopeB.head },
        { baseBranch: 'main' },
      );

      const snapA = await buildSnapshot(repoA.root, revScopeA);
      const snapB = await buildSnapshot(repoB.root, revScopeB);
      try {
        expect(snapA.identity.treeHash).toBe(snapB.identity.treeHash);
      } finally {
        snapA.cleanup();
        snapB.cleanup();
      }
    } finally {
      repoA.cleanup();
      repoB.cleanup();
    }
  });

  it('changes the hash when any reviewed file differs', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('a.txt', 'content\n', 'initial');
      const scope1 = await resolveScope(
        repo.root,
        { revision: repo.git(['rev-parse', 'HEAD']) },
        { baseBranch: 'main' },
      );
      const snap1 = await buildSnapshot(repo.root, scope1);
      const hash1 = snap1.identity.treeHash;
      snap1.cleanup();

      const c2 = repo.writeAndCommit('a.txt', 'different content\n', 'second');
      const scope2 = await resolveScope(repo.root, { revision: c2 }, { baseBranch: 'main' });
      const snap2 = await buildSnapshot(repo.root, scope2);
      const hash2 = snap2.identity.treeHash;
      snap2.cleanup();

      expect(hash1).not.toBe(hash2);
    } finally {
      repo.cleanup();
    }
  });
});

describe('buildSnapshot: cleanup', () => {
  it('cleanup restores write bits and removes the directory, and is idempotent', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('a.txt', 'content\n', 'initial');
      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope);

      const root = snapshot.root;
      expect(existsSync(root)).toBe(true);
      snapshot.cleanup();
      expect(existsSync(root)).toBe(false);
      expect(() => snapshot.cleanup()).not.toThrow();
    } finally {
      repo.cleanup();
    }
  });

  it('removes the partial snapshot when the build fails, before launch', async () => {
    const repo = createTestRepo();
    const scratch = makeScratchDir();
    try {
      repo.writeAndCommit('a.txt', 'content\n', 'initial');
      const goodScope = await resolveScope(repo.root, {}, { baseBranch: 'main' });

      // A scope shaped like a valid 'revision' scope but naming a revision that does not exist:
      // buildSnapshot must abort and remove whatever scratch directory it had already created.
      const brokenScope: ResolvedScope = {
        ...goodScope,
        mode: 'revision',
        endRevision: '0000000000000000000000000000000000dead',
      };

      await expect(
        buildSnapshot(repo.root, brokenScope, { scratchDir: scratch.dir }),
      ).rejects.toMatchObject({ exitCode: 2 });
      // No orphaned snapshot directory survives the failed build, in this test's own isolated
      // scratch base -- not the process-wide OS temp dir, which a concurrently-running unrelated
      // test file may also be populating with its own, entirely unrelated snapshots right now.
      expect(readdirSync(scratch.dir).filter((e) => e.startsWith(SNAPSHOT_PREFIX))).toEqual([]);
    } finally {
      repo.cleanup();
      scratch.cleanup();
    }
  });
});

describe('buildSnapshot: no git worktree is created', () => {
  it("leaves the repository's registered worktree set unchanged across a full run", async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('a.txt', 'base\n', 'initial');
      repo.writeFile('a.txt', 'changed\n');
      repo.writeFile('new.txt', 'new\n');

      const before = repo.git(['worktree', 'list']);

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope);
      snapshot.cleanup();

      const stagedScope = await resolveScope(repo.root, { staged: true }, { baseBranch: 'main' });
      const stagedSnapshot = await buildSnapshot(repo.root, stagedScope);
      stagedSnapshot.cleanup();

      const revScope = await resolveScope(
        repo.root,
        { revision: scope.head },
        { baseBranch: 'main' },
      );
      const revSnapshot = await buildSnapshot(repo.root, revScope);
      revSnapshot.cleanup();

      const after = repo.git(['worktree', 'list']);
      expect(after).toBe(before);
    } finally {
      repo.cleanup();
    }
  });
});

describe('sweepOrphans', () => {
  it('removes orphaned snapshot directories but leaves an active run intact', async () => {
    const scratch = makeScratchDir();
    const orphan = await mkdtemp(join(scratch.dir, SNAPSHOT_PREFIX));
    const active = await mkdtemp(join(scratch.dir, SNAPSHOT_PREFIX));
    try {
      const result = sweepOrphans([active], scratch.dir);
      expect(result.removed).toBe(1);
      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(active)).toBe(true);
    } finally {
      scratch.cleanup();
    }
  });

  it('reports zero when there is nothing to sweep', () => {
    const scratch = makeScratchDir();
    try {
      const result = sweepOrphans([], scratch.dir);
      expect(result.removed).toBe(0);
    } finally {
      scratch.cleanup();
    }
  });

  // "Sweep does not touch a live run" (review-target spec): a snapshot from a *different*
  // process is invisible to `activeRoots` (that only ever names snapshots the calling process
  // itself is holding), so the only way to protect it is the liveness marker `buildSnapshot`
  // writes before freezing the tree.
  it('does not remove a directory whose liveness marker names a live PID, even when not in activeRoots', async () => {
    const scratch = makeScratchDir();
    const live = await mkdtemp(join(scratch.dir, SNAPSHOT_PREFIX));
    try {
      writeFileSync(join(live, '.council-run.pid'), String(process.pid), 'utf8');
      const result = sweepOrphans([], scratch.dir); // deliberately not passed as an active root
      expect(existsSync(live)).toBe(true);
      expect(result.removed).toBe(0);
    } finally {
      scratch.cleanup();
    }
  });

  it('removes a directory whose liveness marker names a PID that is no longer running', async () => {
    const scratch = makeScratchDir();
    const dead = await mkdtemp(join(scratch.dir, SNAPSHOT_PREFIX));
    try {
      // A PID essentially guaranteed not to be alive: spawn a short-lived child and wait for it
      // to exit, rather than guessing a number, so this can't flake against a real live process.
      const deadPid = await spawnAndWaitForExit();
      writeFileSync(join(dead, '.council-run.pid'), String(deadPid), 'utf8');
      const result = sweepOrphans([], scratch.dir);
      expect(existsSync(dead)).toBe(false);
      expect(result.removed).toBe(1);
    } finally {
      scratch.cleanup();
    }
  });

  it('removes a directory with no liveness marker at all, as before', async () => {
    const scratch = makeScratchDir();
    const noMarker = await mkdtemp(join(scratch.dir, SNAPSHOT_PREFIX));
    try {
      const result = sweepOrphans([], scratch.dir);
      expect(existsSync(noMarker)).toBe(false);
      expect(result.removed).toBe(1);
    } finally {
      scratch.cleanup();
    }
  });
});

describe('buildSnapshot: liveness marker', () => {
  it('writes a liveness marker naming its own process, cleaned up as part of the snapshot', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('a.txt', 'content\n', 'initial');
      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope);

      const markerPath = join(snapshot.root, '.council-run.pid');
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, 'utf8').trim()).toBe(String(process.pid));
      // The marker is bookkeeping, not a reviewed file: it must not appear in `files`.
      expect(snapshot.files).not.toContain('.council-run.pid');

      snapshot.cleanup();
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('accepts handleSignals: false without changing what is built', async () => {
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('a.txt', 'content\n', 'initial');
      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope, { handleSignals: false });

      expect(existsSync(join(snapshot.root, 'a.txt'))).toBe(true);
      expect(readFileSync(join(snapshot.root, 'a.txt'), 'utf8')).toBe('content\n');
      snapshot.cleanup();
      expect(existsSync(snapshot.root)).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
});

describe('buildSnapshot: codegraph indexing', () => {
  let prevBin: string | undefined;
  let stubDir = '';

  beforeEach(() => {
    prevBin = process.env.COUNCIL_CODEGRAPH_BIN;
    stubDir = mkdtempSync(join(tmpdir(), 'council-codegraph-stub-'));
  });

  afterEach(() => {
    if (prevBin === undefined) delete process.env.COUNCIL_CODEGRAPH_BIN;
    else process.env.COUNCIL_CODEGRAPH_BIN = prevBin;
    rmSync(stubDir, { recursive: true, force: true });
  });

  /** Writes an executable `codegraph` stand-in; the stub sees `init <root>` as $1/$2. */
  function writeStub(body: string): string {
    const binPath = join(stubDir, 'codegraph');
    writeFileSync(binPath, `#!/bin/sh\n${body}\n`, 'utf8');
    chmodSync(binPath, 0o755);
    return binPath;
  }

  it('is disabled by default and reports that without needing the binary', async () => {
    process.env.COUNCIL_CODEGRAPH_BIN = join(stubDir, 'does-not-exist');
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('a.txt', 'content\n', 'initial');
      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope);

      await withSnapshot(snapshot, () => {
        // A nonexistent binary path with no codegraph opts: nothing was spawned, and the
        // snapshot still built and froze exactly as before.
        expect(snapshot.codegraph).toEqual({ available: false, reason: 'disabled' });
        expect(existsSync(join(snapshot.root, '.codegraph'))).toBe(false);
        assertReadOnly(join(snapshot.root, 'a.txt'));
      });
    } finally {
      repo.cleanup();
    }
  });

  it('indexes after materialisation, so the indexer sees the narrowed files', async () => {
    // Exit nonzero unless the narrowed file is already materialised at the passed root.
    process.env.COUNCIL_CODEGRAPH_BIN = writeStub('test -f "$2/src/a.ts"');
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('src/a.ts', 'content\n', 'initial');
      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope, {
        codegraph: { enabled: true, indexTimeoutSeconds: 60 },
      });

      await withSnapshot(snapshot, () => {
        expect(snapshot.codegraph).toEqual({ available: true });
      });
    } finally {
      repo.cleanup();
    }
  });

  it('leaves sources frozen while the index directory stays writable', async () => {
    process.env.COUNCIL_CODEGRAPH_BIN = writeStub(
      'mkdir -p "$2/.codegraph" && touch "$2/.codegraph/codegraph.db"',
    );
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('src/a.ts', 'content\n', 'initial');
      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope, {
        codegraph: { enabled: true, indexTimeoutSeconds: 60 },
      });

      await withSnapshot(snapshot, () => {
        expect(snapshot.codegraph).toEqual({ available: true });
        // Reviewed sources are frozen...
        assertReadOnly(join(snapshot.root, 'src', 'a.ts'));
        assertReadOnly(snapshot.root);
        // ...while the index directory and its files are writable in practice, not just by
        // mode bits: the SQLite index needs real write access even for reads.
        const indexDir = join(snapshot.root, '.codegraph');
        expect(statSync(indexDir).mode & 0o200).not.toBe(0);
        expect(statSync(join(indexDir, 'codegraph.db')).mode & 0o200).not.toBe(0);
        expect(() => writeFileSync(join(indexDir, '__probe__'), 'x')).not.toThrow();
      });
      expect(existsSync(snapshot.root)).toBe(false); // cleanup still removes everything
    } finally {
      repo.cleanup();
    }
  });

  it('keeps index files out of the file list and tree hash', async () => {
    process.env.COUNCIL_CODEGRAPH_BIN = writeStub(
      'mkdir -p "$2/.codegraph" && echo junk > "$2/.codegraph/codegraph.db"',
    );
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('src/a.ts', 'content\n', 'initial');
      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });

      const indexed = await buildSnapshot(repo.root, scope, {
        codegraph: { enabled: true, indexTimeoutSeconds: 60 },
      });
      const plain = await buildSnapshot(repo.root, scope);
      try {
        expect(indexed.files).toEqual(plain.files);
        expect(indexed.files.every((f) => !f.startsWith('.codegraph'))).toBe(true);
        expect(indexed.identity.treeHash).toBe(plain.identity.treeHash);
      } finally {
        indexed.cleanup();
        plain.cleanup();
      }
    } finally {
      repo.cleanup();
    }
  });

  it('a failing index build still freezes and reports its reason', async () => {
    process.env.COUNCIL_CODEGRAPH_BIN = writeStub('exit 1');
    const repo = createTestRepo();
    try {
      repo.writeAndCommit('a.txt', 'content\n', 'initial');
      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      const snapshot = await buildSnapshot(repo.root, scope, {
        codegraph: { enabled: true, indexTimeoutSeconds: 60 },
      });

      await withSnapshot(snapshot, () => {
        expect(snapshot.codegraph).toEqual({ available: false, reason: 'index-failed' });
        expect(snapshot.files).toContain('a.txt');
        assertReadOnly(join(snapshot.root, 'a.txt'));
      });
    } finally {
      repo.cleanup();
    }
  });
});

/** Spawns a trivial child process, waits for it to exit, and returns its now-dead PID. */
async function spawnAndWaitForExit(): Promise<number> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['-e', '""'], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', () => {
      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error('spawnAndWaitForExit: child has no pid'));
        return;
      }
      resolvePromise(pid);
    });
  });
}
