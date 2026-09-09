/**
 * Deterministic unit tests for `src/codegraph.ts`. Every subprocess is a tiny
 * `#!/bin/sh` stub written to a fresh tmp dir (same style precedent as
 * `test/helpers/fake-host.ts`'s wrapper generation): no real `codegraph` binary, no
 * network, no model calls. Tmp dirs are removed after each test.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSnapshotIndex, resolveCodegraphBin } from '../../src/codegraph.js';

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'council-codegraph-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** Writes an executable `#!/bin/sh` stub and returns its path. */
function writeStub(dir: string, name: string, body: string): string {
  const stubPath = join(dir, name);
  writeFileSync(stubPath, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(stubPath, 0o755);
  return stubPath;
}

describe('resolveCodegraphBin', () => {
  it('honors an explicit COUNCIL_CODEGRAPH_BIN value', () => {
    expect(resolveCodegraphBin({ COUNCIL_CODEGRAPH_BIN: '/opt/bin/codegraph' })).toBe(
      '/opt/bin/codegraph',
    );
  });

  it("defaults to 'codegraph' when the variable is unset", () => {
    expect(resolveCodegraphBin({})).toBe('codegraph');
  });
});

describe('ensureSnapshotIndex', () => {
  it('returns available on exit 0 and passes argv `init <root>`', async () => {
    const dir = makeTmpDir();
    const argsFile = join(dir, 'args');
    const stub = writeStub(
      dir,
      'codegraph-ok',
      `mkdir -p "$2/.codegraph" && touch "$2/.codegraph/codegraph.db" && echo "$@" > ${argsFile}`,
    );
    const root = join(dir, 'snapshot-root');

    const status = await ensureSnapshotIndex(root, { bin: stub });

    expect(status).toEqual({ available: true });
    expect(readFileSync(argsFile, 'utf8').trim()).toBe(`init ${root}`);
  });

  it('maps exit 0 without the index artifact to index-failed', async () => {
    const dir = makeTmpDir();
    // Exits 0 but produces nothing: without the artifact check this would be recorded as a
    // good index while every reviewer call fell back.
    const stub = writeStub(dir, 'codegraph-hollow', 'exit 0');

    const status = await ensureSnapshotIndex(join(dir, 'snapshot-root'), { bin: stub });

    expect(status).toEqual({ available: false, reason: 'index-failed' });
  });

  it('maps a missing binary to binary-missing', async () => {
    const dir = makeTmpDir();
    const status = await ensureSnapshotIndex(join(dir, 'snapshot-root'), {
      bin: join(dir, 'does-not-exist'),
    });

    expect(status).toEqual({ available: false, reason: 'binary-missing' });
  });

  it('maps a nonzero exit to index-failed', async () => {
    const dir = makeTmpDir();
    const stub = writeStub(dir, 'codegraph-fail', 'exit 1');

    const status = await ensureSnapshotIndex(join(dir, 'snapshot-root'), { bin: stub });

    expect(status).toEqual({ available: false, reason: 'index-failed' });
  });

  it('maps a slow stub to index-timeout', async () => {
    const dir = makeTmpDir();
    const stub = writeStub(dir, 'codegraph-slow', 'sleep 5');

    const started = Date.now();
    const status = await ensureSnapshotIndex(join(dir, 'snapshot-root'), {
      bin: stub,
      timeoutSeconds: 1,
    });

    expect(status).toEqual({ available: false, reason: 'index-timeout' });
    expect(Date.now() - started).toBeLessThan(20000);
  });

  it('returns disabled without spawning when enabled is false', async () => {
    const dir = makeTmpDir();
    const status = await ensureSnapshotIndex(join(dir, 'snapshot-root'), {
      bin: join(dir, 'does-not-exist'),
      enabled: false,
    });

    expect(status).toEqual({ available: false, reason: 'disabled' });
  });
});
