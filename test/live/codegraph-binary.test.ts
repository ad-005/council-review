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
 * It also pins the `-j/--json` shapes `src/blast-radius.ts` consumes (`callers`, `impact`,
 * `affected`) plus the unknown-symbol message, by running that module's own argv builders
 * against the real binary and feeding the output through its parsers — so a `codegraph`
 * upgrade that drifts those shapes breaks loudly here instead of silently degrading runs
 * to `parse-failed`.
 *
 * Run deliberately (never as a side effect of `npm test`):
 *   COUNCIL_LIVE=1 npx vitest run --project live test/live/codegraph-binary.test.ts
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { ensureSnapshotIndex, codegraphDbPath } from '../../src/codegraph.js';
import {
  buildAffectedArgv,
  buildCallersArgv,
  buildImpactArgv,
  parseAffectedJson,
  parseCallersJson,
  parseImpactJson,
} from '../../src/blast-radius.js';
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

/** Runs the local `codegraph` binary with CLI-side argv (never a shell string). */
function runBlastArgv(repoRoot: string, argv: readonly string[]): string {
  return execFileSync('codegraph', argv as string[], { cwd: repoRoot, encoding: 'utf8' });
}

/**
 * Asserts the `{ name, kind, filePath, startLine }` ref shape `parseCallersJson` and
 * `parseImpactJson` consume, entry by entry, so a drifted field breaks loudly here.
 */
function expectCodeRefArray(value: unknown): void {
  expect(Array.isArray(value)).toBe(true);
  for (const entry of value as unknown[]) {
    expect(typeof entry).toBe('object');
    expect(entry).not.toBeNull();
    const rec = entry as Record<string, unknown>;
    expect(typeof rec.name).toBe('string');
    expect((rec.name as string).length).toBeGreaterThan(0);
    expect(typeof rec.kind).toBe('string');
    expect((rec.kind as string).length).toBeGreaterThan(0);
    expect(typeof rec.filePath).toBe('string');
    expect((rec.filePath as string).length).toBeGreaterThan(0);
    expect(Number.isInteger(rec.startLine)).toBe(true);
    expect(rec.startLine as number).toBeGreaterThanOrEqual(1);
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

  it('pins the blast-radius -j shapes the parsers consume', async (ctx) => {
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
        'src/use.js',
        "const { add } = require('./add.js');\nfunction usesAdd(x) {\n  return add(x, 1);\n}\nmodule.exports = { usesAdd };\n",
        'add caller',
      );
      repo.writeAndCommit(
        'test/add.test.js',
        "const { add } = require('../src/add.js');\ntest('adds', () => expect(add(1, 2)).toBe(3));\n",
        'add test',
      );

      const prevBin = process.env.COUNCIL_CODEGRAPH_BIN;
      delete process.env.COUNCIL_CODEGRAPH_BIN; // resolve the real binary via PATH
      try {
        const status = await ensureSnapshotIndex(repo.root, { timeoutSeconds: 120 });
        expect(status).toEqual({ available: true });
      } finally {
        if (prevBin !== undefined) process.env.COUNCIL_CODEGRAPH_BIN = prevBin;
      }

      // `callers -j`: `{ symbol, callers: [{ name, kind, filePath, startLine }] }`.
      const callersOut = runBlastArgv(repo.root, buildCallersArgv(repo.root, 'add'));
      const callersRaw = JSON.parse(callersOut) as { symbol: unknown; callers: unknown };
      expect(callersRaw.symbol).toBe('add');
      expectCodeRefArray(callersRaw.callers);
      const callersParsed = parseCallersJson(callersOut);
      expect(callersParsed.status).toBe('ok');
      if (callersParsed.status === 'ok') {
        expect(callersParsed.refs).toContainEqual({
          name: 'usesAdd',
          kind: 'function',
          filePath: 'src/use.js',
          startLine: 2,
        });
      }

      // `impact -j`: `{ symbol, depth, ..., affected: [<same ref shape>] }`.
      const impactOut = runBlastArgv(repo.root, buildImpactArgv(repo.root, 'add', 2));
      const impactRaw = JSON.parse(impactOut) as {
        symbol: unknown;
        depth: unknown;
        affected: unknown;
      };
      expect(impactRaw.symbol).toBe('add');
      expect(impactRaw.depth).toBe(2);
      expectCodeRefArray(impactRaw.affected);
      const impactParsed = parseImpactJson(impactOut);
      expect(impactParsed.status).toBe('ok');
      if (impactParsed.status === 'ok') {
        expect(impactParsed.refs).toContainEqual({
          name: 'add',
          kind: 'function',
          filePath: 'src/add.js',
          startLine: 1,
        });
        expect(impactParsed.refs).toContainEqual({
          name: 'usesAdd',
          kind: 'function',
          filePath: 'src/use.js',
          startLine: 2,
        });
      }

      // `affected -j`: `{ changedFiles: string[], affectedTests: string[], ... }`.
      const affectedJsonOut = runBlastArgv(repo.root, buildAffectedArgv(repo.root, ['src/add.js']));
      const affectedRaw = JSON.parse(affectedJsonOut) as {
        changedFiles: unknown;
        affectedTests: unknown;
      };
      expect(affectedRaw.changedFiles).toEqual(['src/add.js']);
      expect(Array.isArray(affectedRaw.affectedTests)).toBe(true);
      for (const entry of affectedRaw.affectedTests as unknown[]) {
        expect(typeof entry).toBe('string');
      }
      expect(parseAffectedJson(affectedJsonOut)).toEqual({
        status: 'ok',
        changedFiles: ['src/add.js'],
        affectedTests: ['test/add.test.js'],
      });

      // Unknown symbols answer on stdout with exit 0 (never JSON, never an error); both
      // parsers map that message to `not-found`, not `malformed`.
      const missingCallers = runBlastArgv(repo.root, buildCallersArgv(repo.root, 'missingXyz'));
      expect(missingCallers).toMatch(/Symbol ".+" not found/);
      expect(parseCallersJson(missingCallers)).toEqual({ status: 'not-found' });
      const missingImpact = runBlastArgv(repo.root, buildImpactArgv(repo.root, 'missingXyz', 2));
      expect(missingImpact).toMatch(/Symbol ".+" not found/);
      expect(parseImpactJson(missingImpact)).toEqual({ status: 'not-found' });
    } finally {
      repo.cleanup();
    }
  }, 120000);
});
