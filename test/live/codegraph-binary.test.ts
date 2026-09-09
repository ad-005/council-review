/**
 * Opt-in live test for the `council_codegraph` contract against the REAL `codegraph` binary.
 *
 * Unlike `smoke.test.ts` in this directory, this file spends nothing: no `pi` host, no model
 * calls — it only shells out to a local `codegraph` binary on throwaway git repositories. It
 * still lives behind the same `COUNCIL_LIVE=1` gate (see `vitest.config.ts`), because it
 * depends on an external binary being installed, and it skips cleanly when that binary is
 * absent rather than failing.
 *
 * Purpose: every deterministic test in `test/unit` and `test/security` stubs the binary, so
 * only this file pins the two things stubs cannot — that a real `codegraph init` produces the
 * `<root>/.codegraph/codegraph.db` artifact the availability gate probes, and that file
 * arguments reach the binary in the project-relative form the index is keyed by (an absolute
 * `--file` answers 'No indexed file matches ...' even for indexed files — verified by probe,
 * and the reason `buildCodegraphArgv` relativises).
 *
 * Run deliberately (never as a side effect of `npm test`):
 *   COUNCIL_LIVE=1 npx vitest run --project live test/live/codegraph-binary.test.ts
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { ensureSnapshotIndex, codegraphDbPath } from '../../src/codegraph.js';
import { runCodegraph } from '../../src/reviewer-tools.js';
import { createTestRepo, type TestRepo } from '../helpers/git-repo.js';

const LIVE = process.env.COUNCIL_LIVE === '1';

function binaryPresent(): boolean {
  try {
    execFileSync('codegraph', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!LIVE)('live codegraph: real binary contract', () => {
  it('init produces codegraph.db and relative file queries resolve', async (ctx) => {
    if (!binaryPresent()) {
      console.error('[live codegraph] skipping: no `codegraph` binary on PATH');
      ctx.skip();
    }
    const repo: TestRepo = createTestRepo();
    try {
      repo.writeAndCommit(
        'src/add.js',
        'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n',
        'initial commit',
      );
      repo.writeAndCommit(
        'test/add.test.js',
        "const { add } = require('../src/add.js');\ntest('adds', () => expect(add(1, 2)).toBe(3));\n",
        'add test',
      );

      // A real `init` must satisfy the artifact check `ensureSnapshotIndex` reports on.
      const prevBin = process.env.COUNCIL_CODEGRAPH_BIN;
      delete process.env.COUNCIL_CODEGRAPH_BIN; // resolve the real binary via PATH
      try {
        const status = await ensureSnapshotIndex(repo.root, { timeoutSeconds: 120 });
        expect(status).toEqual({ available: true });
      } finally {
        if (prevBin !== undefined) process.env.COUNCIL_CODEGRAPH_BIN = prevBin;
      }
      expect(existsSync(codegraphDbPath(repo.root))).toBe(true);

      // `node --file` with the project-relative form `buildCodegraphArgv` passes must
      // resolve to the indexed file's contents, not the no-match message.
      const nodeOut = runCodegraph(repo.root, { subcommand: 'node', file: 'src/add.js' });
      expect(nodeOut).toContain('src/add.js');
      expect(nodeOut).not.toContain('No indexed file matches');

      // `affected` over a changed source file must find the test that requires it.
      const affectedOut = runCodegraph(repo.root, {
        subcommand: 'affected',
        files: ['src/add.js'],
      });
      expect(affectedOut).toContain('test/add.test.js');
    } finally {
      repo.cleanup();
    }
  }, 120000);
});
