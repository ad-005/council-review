/**
 * Regression test for the npm-installed-binary entry point: npm installs a `bin` as a symlink
 * (e.g. `/opt/homebrew/bin/council-review -> .../dist/bin.js`), and Node sets `import.meta.url`
 * to the module's resolved real path while leaving `process.argv[1]` as the symlink path used to
 * invoke it. An entry point that decides whether to run itself by comparing those two can never
 * match for an npm-installed bin, so it silently does nothing. This test builds the real `dist/`
 * output and invokes it through a symlink exactly the way npm's bin shim would, asserting on
 * actual stdout content (exit code 0 alone is worthless here — the bug this guards against also
 * exits 0).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = path.join(REPO_ROOT, 'dist', 'bin.js');

describe('bin entry point', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  }, 120000);

  it('runs when invoked through a symlink, as an npm-installed bin is', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-review-bin-'));
    try {
      const linkPath = path.join(tmpDir, 'council-review');
      fs.symlinkSync(ENTRY, linkPath);

      const stdout = execFileSync('node', [linkPath, '--help'], { encoding: 'utf8' });
      expect(stdout).toContain('council-review [flags]');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runs when invoked by its real path', () => {
    const stdout = execFileSync('node', [ENTRY, '--help'], { encoding: 'utf8' });
    expect(stdout).toContain('council-review [flags]');
  });
});
