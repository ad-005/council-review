/**
 * Tests for `collectStatus` / `formatStatusText` (src/status.ts): the unconfigured / configured /
 * invalid-config / guard-failing-panel cases, suppression and run counting, gitignore detection,
 * and that the default (non-`--verify`) path never touches the model catalog. The one `--verify`
 * test drives a real `loadCatalog` call against a fake `pi` binary, exactly the way
 * `test/unit/providers.test.ts` and `test/unit/cli.test.ts` already do, rather than mocking
 * `loadCatalog` itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeConfig, type CouncilConfig } from '../../src/config.js';
import { reviewsDirPath } from '../../src/report.js';
import { collectStatus, formatStatusText } from '../../src/status.js';
import { createTestRepo, type TestRepo } from '../helpers/git-repo.js';

const CATALOG_FIXTURE = fileURLToPath(
  new URL('../fixtures/catalog/models-store.json', import.meta.url),
);

// Three real, distinct-vendor models from the shared catalog fixture (see cli.test.ts's own
// comment on the same triple): minimax/MiniMax-M2.7 -> "minimax", opencode-go/glm-5.2 ->
// "zhipu", opencode-go/kimi-k2.6 -> "moonshot".
const INDEPENDENT_PANEL = [
  { provider: 'minimax', model: 'MiniMax-M2.7' },
  { provider: 'opencode-go', model: 'glm-5.2' },
  { provider: 'opencode-go', model: 'kimi-k2.6' },
];

function baseConfig(overrides: Partial<CouncilConfig> = {}): Partial<CouncilConfig> {
  return {
    version: 1,
    baseBranch: 'main',
    panel: INDEPENDENT_PANEL,
    includeContextFiles: false,
    timeoutSeconds: 600,
    maxOutputTokens: null,
    mergeWindow: 10,
    claimSimilarity: 0.6,
    failOn: 'high',
    retain: 20,
    ...overrides,
  };
}

/** Writes a fake `pi` whose `auth check` always reports every provider ready. Sufficient for
 * `--verify`, which never spawns a reviewer -- only `loadCatalog`'s own readiness probe. */
function writeFakePiAlwaysReady(dir: string): string {
  const p = path.join(dir, 'fake-pi.cjs');
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'check') {
  const i = args.indexOf('--provider');
  const provider = i >= 0 ? args[i + 1] : null;
  process.stdout.write(JSON.stringify({ status: 'ready', provider, authType: 'api_key' }));
  process.exit(0);
}
process.exit(1);
`;
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
}

let repo: TestRepo;
let prevCwd: string;
let prevEnv: Record<string, string | undefined>;
let scratchDirs: string[];

beforeEach(() => {
  prevCwd = process.cwd();
  prevEnv = {
    COUNCIL_PI_BIN: process.env.COUNCIL_PI_BIN,
    HOME: process.env.HOME,
  };
  repo = createTestRepo();
  repo.writeAndCommit('README.md', '# test repo\n', 'init');
  process.chdir(repo.root);
  scratchDirs = [];
});

afterEach(() => {
  process.chdir(prevCwd);
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  repo.cleanup();
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkScratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

// -------------------------------------------------------------------------------------------
// Unconfigured
// -------------------------------------------------------------------------------------------

describe('collectStatus: unconfigured repository', () => {
  it('reports configured=false with a repo root but no config', async () => {
    const report = await collectStatus(repo.root, { verify: false });
    expect(report.configured).toBe(false);
    // `findRepoRoot` shells out to `git rev-parse --show-toplevel`, which resolves symlinks in
    // the path (notably macOS's /tmp -> /private/tmp) -- compare against the resolved form.
    expect(report.repoRoot).toBe(fs.realpathSync(repo.root));
    expect(report.config.present).toBe(false);
    expect(report.config.valid).toBe(false);
    expect(report.config.error).toBeNull();
    expect(report.panel).toEqual([]);
    expect(report.independence).toBeNull();
    expect(report.settings).toBeNull();
    expect(report.verified).toBe(false);
  });

  it('formats as not configured, directing to init', async () => {
    const report = await collectStatus(repo.root, { verify: false });
    const text = formatStatusText(report);
    expect(text).toContain('configured:   no');
    expect(text).toContain('config:       (missing)');
    expect(text).toContain('Run "council-review init" to configure this repository.');
  });
});

// -------------------------------------------------------------------------------------------
// Outside a git repository
// -------------------------------------------------------------------------------------------

describe('collectStatus: outside a git repository', () => {
  it('reports repoRoot=null without throwing', async () => {
    const outside = mkScratchDir('council-status-test-outside-');
    const report = await collectStatus(outside, { verify: false });
    expect(report.repoRoot).toBeNull();
    expect(report.configured).toBe(false);
    expect(report.config.path).toBeNull();
    expect(report.suppressions).toEqual({ path: null, present: false, count: 0 });
    expect(report.runs).toEqual({ count: 0, last: null });
    expect(report.gitignore.excludesReviews).toBe(false);
  });

  it('formats with a "(not a git repository)" repo line', async () => {
    const outside = mkScratchDir('council-status-test-outside-');
    const report = await collectStatus(outside, { verify: false });
    expect(formatStatusText(report)).toContain('repo:         (not a git repository)');
  });
});

// -------------------------------------------------------------------------------------------
// Configured, independent panel
// -------------------------------------------------------------------------------------------

describe('collectStatus: configured repository with an independent panel', () => {
  it('resolves the panel from config alone and passes the independence guard', async () => {
    writeConfig(repo.root, baseConfig());
    const report = await collectStatus(repo.root, { verify: false });

    expect(report.configured).toBe(true);
    expect(report.config.present).toBe(true);
    expect(report.config.valid).toBe(true);
    expect(report.config.version).toBe(1);

    expect(report.panel).toHaveLength(3);
    const vendors = report.panel.map((p) => p.vendor).sort();
    expect(vendors).toEqual(['minimax', 'moonshot', 'zhipu']);
    // The default path never opens the catalog, so every verify-only field stays null.
    for (const p of report.panel) {
      expect(p.effectiveThinking).toBeNull();
      expect(p.clamped).toBeNull();
      expect(p.ready).toBeNull();
      expect(p.readyReason).toBeNull();
    }

    expect(report.independence).toEqual({
      ok: true,
      modelCount: 3,
      vendorCount: 3,
      vendors: {
        minimax: ['minimax/MiniMax-M2.7'],
        zhipu: ['opencode-go/glm-5.2'],
        moonshot: ['opencode-go/kimi-k2.6'],
      },
      reason: null,
    });

    expect(report.settings).toEqual({
      baseBranch: 'main',
      failOn: 'high',
      timeoutSeconds: 600,
      maxOutputTokens: null,
      mergeWindow: 10,
      claimSimilarity: 0.6,
      includeContextFiles: false,
      retain: 20,
    });

    expect(report.verified).toBe(false);
  });

  it('resolves the configured thinking level without opening the catalog', async () => {
    writeConfig(repo.root, baseConfig({ modelThinkingLevels: { 'minimax/MiniMax-M2.7': 'high' } }));
    const report = await collectStatus(repo.root, { verify: false });
    const entry = report.panel.find((p) => p.model === 'MiniMax-M2.7');
    expect(entry?.thinking).toBe('high');
  });

  it('the default path never invokes catalog discovery, even when it would fail loudly', async () => {
    writeConfig(repo.root, baseConfig());
    // A nonexistent piBin and a HOME with no models-store.json: loadCatalog would throw
    // DiscoveryError if it were ever called on this path.
    process.env.COUNCIL_PI_BIN = path.join(repo.root, 'no-such-pi-binary');
    process.env.HOME = mkScratchDir('council-status-test-home-empty-');

    const report = await collectStatus(repo.root, { verify: false });
    expect(report.configured).toBe(true);
    expect(report.verified).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// Invalid config
// -------------------------------------------------------------------------------------------

describe('collectStatus: invalid config', () => {
  it('reports present but invalid, with the ConfigError message and key path, and configured=false', async () => {
    fs.mkdirSync(path.join(repo.root, '.council'), { recursive: true });
    fs.writeFileSync(
      path.join(repo.root, '.council', 'config.json'),
      `${JSON.stringify({ version: 999, panel: [] })}\n`,
      'utf8',
    );

    const report = await collectStatus(repo.root, { verify: false });
    expect(report.configured).toBe(false);
    expect(report.config.present).toBe(true);
    expect(report.config.valid).toBe(false);
    expect(report.config.error).toContain('999');
    expect(report.config.errorKeyPath).toBe('/version');
    expect(report.panel).toEqual([]);
    expect(report.independence).toBeNull();
    expect(report.settings).toBeNull();
  });

  it('formats the invalid-config line with the error message', async () => {
    fs.mkdirSync(path.join(repo.root, '.council'), { recursive: true });
    fs.writeFileSync(
      path.join(repo.root, '.council', 'config.json'),
      `${JSON.stringify({ version: 999, panel: [] })}\n`,
      'utf8',
    );
    const report = await collectStatus(repo.root, { verify: false });
    expect(formatStatusText(report)).toContain('config:       (invalid:');
  });
});

// -------------------------------------------------------------------------------------------
// Guard-failing panel
// -------------------------------------------------------------------------------------------

describe('collectStatus: a panel that fails the independence guard', () => {
  it('reports independence.ok=false with a reason when two of three models share a vendor', async () => {
    writeConfig(
      repo.root,
      baseConfig({
        panel: [
          { provider: 'minimax', model: 'MiniMax-M2.7' }, // vendor: minimax
          { provider: 'openai-codex', model: 'gpt-5.4' }, // vendor: openai
          { provider: 'openai-codex', model: 'gpt-5.6-sol' }, // vendor: openai (collides)
        ],
      }),
    );

    const report = await collectStatus(repo.root, { verify: false });
    // Still "configured" -- the guard failing is a fact to report, not an invalid configuration.
    expect(report.configured).toBe(true);
    expect(report.independence?.ok).toBe(false);
    expect(report.independence?.vendorCount).toBe(2);
    expect(report.independence?.reason).toContain('2 distinct vendor');
    expect(report.independence?.vendors.openai).toEqual([
      'openai-codex/gpt-5.4',
      'openai-codex/gpt-5.6-sol',
    ]);
  });

  it('formats the failure with FAILED and the vendor grouping', async () => {
    writeConfig(
      repo.root,
      baseConfig({
        panel: [
          { provider: 'minimax', model: 'MiniMax-M2.7' },
          { provider: 'openai-codex', model: 'gpt-5.4' },
          { provider: 'openai-codex', model: 'gpt-5.6-sol' },
        ],
      }),
    );
    const report = await collectStatus(repo.root, { verify: false });
    const text = formatStatusText(report);
    expect(text).toContain('independence: FAILED —');
    expect(text).toContain('openai: openai-codex/gpt-5.4, openai-codex/gpt-5.6-sol');
  });
});

// -------------------------------------------------------------------------------------------
// Suppressions
// -------------------------------------------------------------------------------------------

describe('collectStatus: suppressions', () => {
  it('counts entries in .council/ignore.json', async () => {
    writeConfig(repo.root, baseConfig());
    fs.mkdirSync(path.join(repo.root, '.council'), { recursive: true });
    fs.writeFileSync(
      path.join(repo.root, '.council', 'ignore.json'),
      `${JSON.stringify({
        version: 1,
        entries: [{ fingerprint: 'a' }, { fingerprint: 'b' }, { fingerprint: 'c' }],
      })}\n`,
      'utf8',
    );

    const report = await collectStatus(repo.root, { verify: false });
    expect(report.suppressions.present).toBe(true);
    expect(report.suppressions.count).toBe(3);
  });

  it('reports present=false, count=0 when no ignore file exists yet', async () => {
    writeConfig(repo.root, baseConfig());
    const report = await collectStatus(repo.root, { verify: false });
    expect(report.suppressions.present).toBe(false);
    expect(report.suppressions.count).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// Stored runs
// -------------------------------------------------------------------------------------------

describe('collectStatus: stored runs', () => {
  it('lists run count and resolves "last" from the symlink, with reportPath/findingsPath', async () => {
    const reviewsDir = reviewsDirPath(fs.realpathSync(repo.root));
    fs.mkdirSync(path.join(reviewsDir, '20260101T000000000Z'), { recursive: true });
    fs.writeFileSync(path.join(reviewsDir, '20260101T000000000Z', 'REPORT.md'), '# r1\n');
    fs.writeFileSync(path.join(reviewsDir, '20260101T000000000Z', 'findings.json'), '[]\n');
    fs.mkdirSync(path.join(reviewsDir, '20260102T000000000Z'), { recursive: true });
    fs.writeFileSync(path.join(reviewsDir, '20260102T000000000Z', 'REPORT.md'), '# r2\n');
    fs.writeFileSync(path.join(reviewsDir, '20260102T000000000Z', 'findings.json'), '[]\n');
    fs.symlinkSync('20260102T000000000Z', path.join(reviewsDir, 'last'), 'dir');

    const report = await collectStatus(repo.root, { verify: false });
    expect(report.runs.count).toBe(2);
    expect(report.runs.last?.id).toBe('20260102T000000000Z');
    expect(report.runs.last?.path).toBe(path.join(reviewsDir, '20260102T000000000Z'));
    expect(report.runs.last?.reportPath).toBe(
      path.join(reviewsDir, '20260102T000000000Z', 'REPORT.md'),
    );
    expect(report.runs.last?.findingsPath).toBe(
      path.join(reviewsDir, '20260102T000000000Z', 'findings.json'),
    );
  });

  it('reports count=0 and last=null when no run has ever been stored', async () => {
    const report = await collectStatus(repo.root, { verify: false });
    expect(report.runs).toEqual({ count: 0, last: null });
  });

  it('falls back to the newest run when the "last" symlink is absent', async () => {
    const reviewsDir = reviewsDirPath(repo.root);
    fs.mkdirSync(path.join(reviewsDir, '20260101T000000000Z'), { recursive: true });
    fs.mkdirSync(path.join(reviewsDir, '20260103T000000000Z'), { recursive: true });

    const report = await collectStatus(repo.root, { verify: false });
    expect(report.runs.count).toBe(2);
    expect(report.runs.last?.id).toBe('20260103T000000000Z');
  });
});

// -------------------------------------------------------------------------------------------
// Gitignore detection
// -------------------------------------------------------------------------------------------

describe('collectStatus: gitignore detection', () => {
  it('reports excludesReviews=true when .gitignore already has the entry', async () => {
    fs.writeFileSync(path.join(repo.root, '.gitignore'), '.council/reviews/\n');
    const report = await collectStatus(repo.root, { verify: false });
    expect(report.gitignore.excludesReviews).toBe(true);
  });

  it('reports excludesReviews=false when .gitignore lacks the entry', async () => {
    fs.writeFileSync(path.join(repo.root, '.gitignore'), 'node_modules/\n');
    const report = await collectStatus(repo.root, { verify: false });
    expect(report.gitignore.excludesReviews).toBe(false);
  });

  it('reports excludesReviews=false when there is no .gitignore at all', async () => {
    const report = await collectStatus(repo.root, { verify: false });
    expect(report.gitignore.excludesReviews).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// --verify
// -------------------------------------------------------------------------------------------

describe('collectStatus: --verify', () => {
  it('reports readiness and clamping from the catalog, and a stale entry as not-ready rather than throwing', async () => {
    const homeDir = mkScratchDir('council-status-test-home-');
    fs.mkdirSync(path.join(homeDir, '.pi', 'agent'), { recursive: true });
    fs.copyFileSync(CATALOG_FIXTURE, path.join(homeDir, '.pi', 'agent', 'models-store.json'));
    const toolDir = mkScratchDir('council-status-test-bin-');

    process.env.HOME = homeDir;
    process.env.COUNCIL_PI_BIN = writeFakePiAlwaysReady(toolDir);

    writeConfig(
      repo.root,
      baseConfig({
        panel: [
          { provider: 'minimax', model: 'MiniMax-M2.7' },
          { provider: 'opencode-go', model: 'glm-5.2' },
          { provider: 'nonexistent-provider', model: 'no-such-model' },
        ],
        modelThinkingLevels: { 'minimax/MiniMax-M2.7': 'xhigh' }, // unsupported -> clamps to 'high'
      }),
    );

    const report = await collectStatus(repo.root, { verify: true });
    expect(report.verified).toBe(true);

    const minimax = report.panel.find((p) => p.model === 'MiniMax-M2.7');
    expect(minimax?.ready).toBe(true);
    expect(minimax?.thinking).toBe('xhigh');
    expect(minimax?.effectiveThinking).toBe('high');
    expect(minimax?.clamped).toBe(true);

    const glm = report.panel.find((p) => p.model === 'glm-5.2');
    expect(glm?.ready).toBe(true);
    expect(glm?.clamped).toBe(false);

    const missing = report.panel.find((p) => p.model === 'no-such-model');
    expect(missing?.ready).toBe(false);
    expect(missing?.readyReason).toContain('absent from the catalog');
  });

  it('is a no-op (verified=false) against an unconfigured project', async () => {
    const report = await collectStatus(repo.root, { verify: true });
    expect(report.configured).toBe(false);
    expect(report.verified).toBe(false);
  });
});
