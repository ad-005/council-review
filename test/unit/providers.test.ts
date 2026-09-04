import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadCatalog,
  readyModels,
  findModel,
  deriveVendor,
  collapsedVendorGroups,
  parseListModelsOutput,
  DiscoveryError,
  type CatalogModel,
} from '../../src/providers.js';

const FIXTURES_DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'fixtures',
  'catalog',
);
const STORE_FIXTURE = join(FIXTURES_DIR, 'models-store.json');
const MODELS_JSON_FIXTURE = join(FIXTURES_DIR, 'models.json');
const LIST_MODELS_CLEAN = join(FIXTURES_DIR, 'list-models-clean.txt');
const LIST_MODELS_CONTAMINATED = join(FIXTURES_DIR, 'list-models-contaminated.txt');

// A tiny fake `pi` binary (plain CommonJS so it runs regardless of this package's ESM "type"),
// driven entirely by environment variables so each test can shape its behaviour without
// touching the real host or the real `~/.pi` directory.
const FAKE_PI_SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

if (args[0] === 'auth' && args[1] === 'check') {
  const providerIdx = args.indexOf('--provider');
  const provider = providerIdx >= 0 ? args[providerIdx + 1] : null;
  let map = {};
  if (process.env.FAKE_AUTH_MAP) {
    try { map = JSON.parse(fs.readFileSync(process.env.FAKE_AUTH_MAP, 'utf8')); } catch {}
  }
  const entry = provider ? map[provider] : undefined;
  if (entry && entry.status === 'ready') {
    process.stdout.write(JSON.stringify({ status: 'ready', provider, authType: entry.authType || 'api_key' }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ status: 'not_ready', provider, reason: (entry && entry.reason) || 'not_configured' }));
  process.exit(1);
}

if (args[0] === '--list-models') {
  const filePath = process.env.FAKE_LIST_MODELS_FILE;
  if (!filePath) { process.exit(1); }
  try {
    process.stdout.write(fs.readFileSync(filePath, 'utf8'));
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

process.exit(1);
`;

const FAKE_PI_UNAVAILABLE_SCRIPT = `#!/usr/bin/env node
process.exit(1);
`;

let workDir: string;
let piBinPath: string;
let unavailablePiBinPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'council-providers-test-'));
  piBinPath = join(workDir, 'fake-pi.cjs');
  writeFileSync(piBinPath, FAKE_PI_SCRIPT);
  chmodSync(piBinPath, 0o755);
  unavailablePiBinPath = join(workDir, 'fake-pi-unavailable.cjs');
  writeFileSync(unavailablePiBinPath, FAKE_PI_UNAVAILABLE_SCRIPT);
  chmodSync(unavailablePiBinPath, 0o755);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.FAKE_AUTH_MAP;
  delete process.env.FAKE_LIST_MODELS_FILE;
  vi.restoreAllMocks();
});

function writeAuthMap(
  map: Record<string, { status: string; authType?: string; reason?: string }>,
): void {
  const p = join(workDir, 'auth-map.json');
  writeFileSync(p, JSON.stringify(map));
  process.env.FAKE_AUTH_MAP = p;
}

function installStoreFixture(homeDir: string): void {
  const dir = join(homeDir, '.pi', 'agent');
  mkdirSync(dir, { recursive: true });
  copyFileSync(STORE_FIXTURE, join(dir, 'models-store.json'));
}

function installModelsJsonFixture(homeDir: string): void {
  const dir = join(homeDir, '.pi', 'agent');
  mkdirSync(dir, { recursive: true });
  copyFileSync(MODELS_JSON_FIXTURE, join(dir, 'models.json'));
}

const ALL_PROVIDERS_READY = {
  minimax: { status: 'ready', authType: 'api_key' },
  'opencode-go': { status: 'ready', authType: 'api_key' },
  'openai-codex': { status: 'ready', authType: 'oauth' },
  openrouter: { status: 'ready', authType: 'api_key' },
};

describe('loadCatalog — catalog store (primary source)', () => {
  it('enumerates every well-formed entry, annotated with provider/vendor/cost/context', async () => {
    installStoreFixture(workDir);
    writeAuthMap(ALL_PROVIDERS_READY);

    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });

    expect(catalog.source).toBe('store');
    // 18 raw entries across the fixture, 3 deliberately malformed.
    expect(catalog.skipped).toBe(3);
    expect(catalog.models).toHaveLength(15);

    const minimaxModel = findModel(catalog, 'minimax', 'MiniMax-M2.7');
    expect(minimaxModel).toBeDefined();
    expect(minimaxModel).toMatchObject({
      name: 'MiniMax-M2.7',
      provider: 'minimax',
      vendor: 'minimax',
      contextWindow: 204800,
      maxOutputTokens: 131072,
      inputCostPerMTok: 0.3,
      outputCostPerMTok: 1.2,
      reasoning: true,
    });
  });

  it('makes no model call — the fake host records only auth-check and list-models invocations', async () => {
    installStoreFixture(workDir);
    writeAuthMap(ALL_PROVIDERS_READY);
    // The fake host only understands `auth check` and `--list-models`; anything else exits 1.
    // Successfully loading a full catalog through it demonstrates no other invocation shape
    // (i.e. no inference call) was made.
    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });
    expect(catalog.models.length).toBeGreaterThan(0);
  });

  it('skips malformed entries individually, keeping the rest usable, and warns with the count', async () => {
    installStoreFixture(workDir);
    writeAuthMap(ALL_PROVIDERS_READY);
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });

    expect(catalog.skipped).toBe(3);
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('skipped 3 malformed catalog entries'),
    );
    // The malformed opencode-go entries must not appear at all.
    expect(catalog.models.find((m) => m.name === 'Missing Id')).toBeUndefined();
    expect(findModel(catalog, 'opencode-go', 'missing-name')).toBeUndefined();
  });

  it('maps absent contextWindow/cost to null, not 0, for a model that has neither', async () => {
    installStoreFixture(workDir);
    writeAuthMap(ALL_PROVIDERS_READY);
    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });

    const noCost = findModel(catalog, 'opencode-go', 'experimental-no-cost');
    expect(noCost).toBeDefined();
    expect(noCost?.inputCostPerMTok).toBeNull();
    expect(noCost?.outputCostPerMTok).toBeNull();
    expect(noCost?.contextWindow).toBe(131072);
    expect(noCost?.maxOutputTokens).toBe(32768);
  });

  it('treats a negative cost rate as unknown (null), not as a real (and sortable) rate', async () => {
    // OpenRouter's `auto`/`auto-beta` routing models store -1000000 as a sentinel for "dynamic
    // pricing, no fixed rate exists" rather than omitting `cost` — this is the real
    // `openrouter/auto-beta` entry from this machine's catalog. Passed through unchanged, cost
    // would compute negative and a "cheapest first" ranking would pick it over every real model.
    installStoreFixture(workDir);
    writeAuthMap(ALL_PROVIDERS_READY);
    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });

    const autoBeta = findModel(catalog, 'openrouter', 'openrouter/auto-beta');
    expect(autoBeta).toBeDefined();
    expect(autoBeta?.inputCostPerMTok).toBeNull();
    expect(autoBeta?.outputCostPerMTok).toBeNull();
    // Untouched, legitimate fields on the same entry are unaffected by the cost check.
    expect(autoBeta?.contextWindow).toBe(2_000_000);
    expect(autoBeta?.reasoning).toBe(true);
  });

  it('passes a partially-specified thinkingLevelMap through as a tristate map', async () => {
    installStoreFixture(workDir);
    writeAuthMap(ALL_PROVIDERS_READY);
    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });

    const glm = findModel(catalog, 'opencode-go', 'glm-5.2');
    expect(glm?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    });
  });

  it('never opens the real ~/.pi directory when homeDir is overridden', async () => {
    // No store fixture installed under workDir at all: the store is genuinely absent there.
    writeAuthMap(ALL_PROVIDERS_READY);
    process.env.FAKE_LIST_MODELS_FILE = LIST_MODELS_CLEAN;
    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });
    // Falls back to listing rather than silently reading the real machine's store.
    expect(catalog.source).toBe('listing');
  });
});

describe('loadCatalog — models.json layered over the store', () => {
  // The host itself does not run purely off models-store.json: ~/.pi/agent/models.json patches
  // and adds entries before the host presents any model. These fixtures are the real file from
  // this machine, verified against the host's own merge code — see the comment above
  // mergeModelsJson in src/providers.ts.

  it('patches thinkingLevelMap via modelOverrides, shallow-merged onto the store map', async () => {
    installStoreFixture(workDir);
    installModelsJsonFixture(workDir);
    writeAuthMap(ALL_PROVIDERS_READY);

    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });
    const glm = findModel(catalog, 'opencode-go', 'glm-5.2');

    // Store map: {off:null, minimal:null, low:null, medium:null, high:"high", xhigh:null, max:"max"}
    // Override:  {minimal:null, low:"high", medium:"high", high:"high", xhigh:"max"}
    // Merge is {...store, ...override}: off/max survive untouched from the store, the rest come
    // from the override.
    expect(glm?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: 'high',
      medium: 'high',
      high: 'high',
      xhigh: 'max',
      max: 'max',
    });
  });

  it('patches contextWindow via modelOverrides without touching other fields', async () => {
    installStoreFixture(workDir);
    installModelsJsonFixture(workDir);
    writeAuthMap(ALL_PROVIDERS_READY);

    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });
    const sol = findModel(catalog, 'openai-codex', 'gpt-5.6-sol');

    expect(sol?.contextWindow).toBe(1_050_000); // store had 272000; models.json overrides it
    expect(sol?.maxOutputTokens).toBe(128_000); // untouched — override only names contextWindow
    expect(sol?.reasoning).toBe(true);
  });

  it('a modelOverrides entry naming an id absent from the merged models is a no-op', async () => {
    installStoreFixture(workDir);
    installModelsJsonFixture(workDir); // also carries an override for opencode-go/glm-5.1, not in our store fixture
    writeAuthMap(ALL_PROVIDERS_READY);

    // Must not throw, and must not fabricate a glm-5.1 entry out of the override alone.
    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });
    expect(findModel(catalog, 'opencode-go', 'glm-5.1')).toBeUndefined();
  });

  it('adds a models[] entry absent from the store as a brand-new model', async () => {
    installStoreFixture(workDir);
    installModelsJsonFixture(workDir);
    writeAuthMap(ALL_PROVIDERS_READY);

    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });
    const muse = findModel(catalog, 'openrouter', 'meta/muse-spark-1.2');

    expect(muse).toBeDefined();
    expect(muse).toMatchObject({
      name: 'Meta: Muse Spark 1.2',
      provider: 'openrouter',
      vendor: 'meta', // vendor/model-shaped id, no marker
      contextWindow: 1_048_576,
      maxOutputTokens: 4096,
      inputCostPerMTok: 1.25,
      outputCostPerMTok: 4.25,
      reasoning: true,
    });
  });

  it('a saved panel entry naming the models[]-added model would resolve, not 404', async () => {
    // Guards against the exact regression named in review: an entry that only exists via
    // models.json must be as findable as one native to the store.
    installStoreFixture(workDir);
    installModelsJsonFixture(workDir);
    writeAuthMap(ALL_PROVIDERS_READY);

    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });
    expect(
      readyModels(catalog).some(
        (m) => m.provider === 'openrouter' && m.id === 'meta/muse-spark-1.2',
      ),
    ).toBe(true);
  });

  it('a missing models.json leaves the store unmodified', async () => {
    installStoreFixture(workDir);
    // No models.json installed at all.
    writeAuthMap(ALL_PROVIDERS_READY);

    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });
    const sol = findModel(catalog, 'openai-codex', 'gpt-5.6-sol');
    expect(sol?.contextWindow).toBe(272_000); // the store's own value, unoverridden
  });

  it('a malformed models.json is non-fatal and the store is used unmodified', async () => {
    installStoreFixture(workDir);
    const dir = join(workDir, '.pi', 'agent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'models.json'), '{ this is not valid JSON');
    writeAuthMap(ALL_PROVIDERS_READY);

    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });
    expect(catalog.source).toBe('store');
    const sol = findModel(catalog, 'openai-codex', 'gpt-5.6-sol');
    expect(sol?.contextWindow).toBe(272_000);
  });
});

describe('loadCatalog — provider readiness', () => {
  it('offers ready providers, annotated with authType and model count', async () => {
    installStoreFixture(workDir);
    writeAuthMap(ALL_PROVIDERS_READY);
    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });

    const minimax = catalog.providers.find((p) => p.id === 'minimax');
    expect(minimax).toMatchObject({
      ready: true,
      authType: 'api_key',
      reason: null,
      modelCount: 1,
    });
  });

  it('excludes an unready provider from readyModels and records why in diagnostics', async () => {
    installStoreFixture(workDir);
    writeAuthMap({
      ...ALL_PROVIDERS_READY,
      'openai-codex': { status: 'not_ready', reason: 'oauth_expired' },
    });

    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });
    const codexInfo = catalog.providers.find((p) => p.id === 'openai-codex');
    expect(codexInfo).toMatchObject({ ready: false, authType: null, reason: 'oauth_expired' });

    const ready = readyModels(catalog);
    expect(ready.find((m) => m.provider === 'openai-codex')).toBeUndefined();
    // Other providers remain selectable.
    expect(ready.find((m) => m.provider === 'minimax')).toBeDefined();
  });
});

describe('loadCatalog — fallback listing path', () => {
  it('enumerates models from `--list-models -ne` output when the store is missing', async () => {
    writeAuthMap(ALL_PROVIDERS_READY);
    process.env.FAKE_LIST_MODELS_FILE = LIST_MODELS_CLEAN;

    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });

    expect(catalog.source).toBe('listing');
    expect(catalog.skipped).toBe(0);
    const minimaxModel = findModel(catalog, 'minimax', 'MiniMax-M2.7');
    expect(minimaxModel).toBeDefined();
    expect(minimaxModel?.reasoning).toBe(true);
    expect(minimaxModel?.inputCostPerMTok).toBeNull();
    expect(minimaxModel?.outputCostPerMTok).toBeNull();
    // "204.8K" -> 204800, rounded from the host's own rendering.
    expect(minimaxModel?.contextWindow).toBe(204800);

    const nova = findModel(catalog, 'openrouter', 'amazon/nova-lite-v1');
    expect(nova?.reasoning).toBe(false);
  });

  it('ignores extension banner output entirely rather than parsing it as a model', async () => {
    writeAuthMap(ALL_PROVIDERS_READY);
    process.env.FAKE_LIST_MODELS_FILE = LIST_MODELS_CONTAMINATED;

    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });

    expect(catalog.source).toBe('listing');
    expect(catalog.models.every((m) => !m.provider.includes('[') && !m.id.includes('['))).toBe(
      true,
    );
    expect(catalog.models.find((m) => m.provider === '[Playwright')).toBeUndefined();
    // The fixture's 9 genuine data rows, none of the banner lines.
    expect(catalog.models).toHaveLength(9);
  });

  it('throws DiscoveryError(exitCode 2) when both the store and the listing command are unavailable', async () => {
    // workDir has no .pi/agent/models-store.json, and the fake host here always fails.
    await expect(
      loadCatalog({ homeDir: workDir, piBin: unavailablePiBinPath }),
    ).rejects.toMatchObject({ exitCode: 2 });
    await expect(
      loadCatalog({ homeDir: workDir, piBin: unavailablePiBinPath }),
    ).rejects.toBeInstanceOf(DiscoveryError);
  });
});

describe('parseListModelsOutput', () => {
  it('parses every genuine data row from the clean fixture', () => {
    const text = readFileSync(LIST_MODELS_CLEAN, 'utf8');
    const rows = parseListModelsOutput(text);
    expect(rows).toHaveLength(14);
    expect(rows[0]).toMatchObject({ provider: 'minimax', id: 'MiniMax-M2.7', reasoning: true });
  });

  it('drops the header line and every banner line from the contaminated fixture', () => {
    const text = readFileSync(LIST_MODELS_CONTAMINATED, 'utf8');
    const rows = parseListModelsOutput(text);
    expect(rows).toHaveLength(9);
    expect(rows.some((r) => r.provider.startsWith('['))).toBe(false);
  });

  it('parses K/M-suffixed size columns into approximate token counts', () => {
    const rows = parseListModelsOutput(
      'provider  model  context  max-out  thinking  images\n' +
        'prov      mid    1.0M     512K     yes       no\n',
    );
    expect(rows).toEqual([
      {
        provider: 'prov',
        id: 'mid',
        contextWindow: 1_000_000,
        maxOutputTokens: 512_000,
        reasoning: true,
      },
    ]);
  });
});

describe('deriveVendor', () => {
  it('prefers an exact provider/model override over every other rule', () => {
    expect(deriveVendor('openrouter', 'auto', { 'openrouter/auto': 'openai' })).toBe('openai');
  });

  it('takes the leading segment of a vendor/model gateway id', () => {
    expect(deriveVendor('openrouter', 'anthropic/claude-3-haiku', {})).toBe('anthropic');
    expect(deriveVendor('openrouter', 'aion-labs/aion-2.0', {})).toBe('aion-labs');
  });

  it('strips a leading prefix marker before matching the vendor/model leading segment', () => {
    expect(deriveVendor('openrouter', '~anthropic/claude-fable-latest', {})).toBe('anthropic');
  });

  it('matches a flat id against the shipped vendor prefix table', () => {
    expect(deriveVendor('opencode-go', 'grok-4.6', {})).toBe('xai');
    expect(deriveVendor('opencode-go', 'glm-5.2', {})).toBe('zhipu');
    expect(deriveVendor('opencode-go', 'kimi-k2.6', {})).toBe('moonshot');
    expect(deriveVendor('opencode-go', 'qwen3.6-plus', {})).toBe('qwen');
    expect(deriveVendor('opencode-go', 'deepseek-v4-flash', {})).toBe('deepseek');
    expect(deriveVendor('minimax', 'MiniMax-M2.7', {})).toBe('minimax');
    expect(deriveVendor('openai-codex', 'gpt-5.4', {})).toBe('openai');
  });

  it('falls back to unknown for an unrecognised flat id', () => {
    expect(deriveVendor('opencode-go', 'longcat-2.0', {})).toBe('unknown');
    expect(deriveVendor('opencode-go', 'hy3', {})).toBe('unknown');
    expect(deriveVendor('openrouter', 'auto', {})).toBe('unknown');
  });
});

describe('collapsedVendorGroups', () => {
  it('groups models by derived vendor, including singleton groups', () => {
    const models: CatalogModel[] = [
      makeModel({ provider: 'openrouter', id: 'anthropic/claude-3-haiku', vendor: 'anthropic' }),
      makeModel({ provider: 'openai-codex', id: 'gpt-5.4', vendor: 'openai' }),
      makeModel({ provider: 'opencode-go', id: 'kimi-k2.6', vendor: 'moonshot' }),
    ];
    const groups = collapsedVendorGroups(models);
    expect(groups.get('anthropic')).toEqual(['openrouter/anthropic/claude-3-haiku']);
    expect(groups.get('openai')).toEqual(['openai-codex/gpt-5.4']);
    expect(groups.size).toBe(3);
  });

  it('collapses several selections that share a vendor into one group', () => {
    const models: CatalogModel[] = [
      makeModel({ provider: 'openrouter', id: 'anthropic/claude-3-haiku', vendor: 'anthropic' }),
      makeModel({
        provider: 'openrouter',
        id: '~anthropic/claude-fable-latest',
        vendor: 'anthropic',
      }),
    ];
    const groups = collapsedVendorGroups(models);
    expect(groups.get('anthropic')).toEqual([
      'openrouter/anthropic/claude-3-haiku',
      'openrouter/~anthropic/claude-fable-latest',
    ]);
  });
});

function makeModel(
  partial: Partial<CatalogModel> & { provider: string; id: string; vendor: string },
): CatalogModel {
  return {
    name: partial.id,
    contextWindow: null,
    maxOutputTokens: null,
    inputCostPerMTok: null,
    outputCostPerMTok: null,
    reasoning: false,
    thinkingLevelMap: undefined,
    ...partial,
  };
}
