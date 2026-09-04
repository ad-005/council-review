import { describe, expect, it } from 'vitest';

import type { CouncilConfig, PanelEntry } from '../../src/config.js';
import type { Catalog, CatalogModel, ProviderInfo } from '../../src/providers.js';
import {
  GuardRefusal,
  PanelError,
  checkIndependence,
  enforceIndependence,
  expandPanelSpec,
  formatVendorGrouping,
  parsePanelEntry,
  resolveConfiguredPanel,
  resolveSpecPanel,
  type Reviewer,
} from '../../src/panel.js';

// ---------------------------------------------------------------------------------------------
// Fixture catalog — a small, hand-built stand-in for test/fixtures/catalog/models-store.json's
// real shapes (panel.ts never touches the host process, so there is no need to route this
// through loadCatalog / a fake `pi` binary at all).
// ---------------------------------------------------------------------------------------------

function model(
  partial: Partial<CatalogModel> & { id: string; provider: string; vendor: string },
): CatalogModel {
  return {
    name: partial.id,
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    inputCostPerMTok: 1,
    outputCostPerMTok: 2,
    reasoning: false,
    thinkingLevelMap: undefined,
    ...partial,
  };
}

const MINIMAX = model({
  id: 'MiniMax-M2.7',
  provider: 'minimax',
  vendor: 'minimax',
  reasoning: true,
  thinkingLevelMap: undefined, // whole map absent -> off..high supported
});

const GLM = model({
  id: 'glm-5.2',
  provider: 'opencode-go',
  vendor: 'zhipu',
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
    max: 'max',
  },
});

const KIMI = model({
  id: 'kimi-k2.6',
  provider: 'opencode-go',
  vendor: 'moonshot',
  reasoning: true,
});

const GPT = model({
  id: 'gpt-5.4',
  provider: 'openai-codex',
  vendor: 'openai',
  reasoning: true,
});

const CLAUDE_HAIKU = model({
  id: 'anthropic/claude-3-haiku',
  provider: 'openrouter',
  vendor: 'anthropic',
  reasoning: false,
});

const CLAUDE_FABLE = model({
  id: '~anthropic/claude-fable-latest',
  provider: 'openrouter',
  vendor: 'anthropic',
  reasoning: true,
});

const NOVA = model({
  id: 'amazon/nova-lite-v1',
  provider: 'openrouter',
  vendor: 'amazon',
  reasoning: false,
});

const AUTO_UNKNOWN_1 = model({
  id: 'auto',
  provider: 'openrouter',
  vendor: 'unknown',
  reasoning: true,
});

const MYSTERY_UNKNOWN_2 = model({
  id: 'mystery-model',
  provider: 'openrouter',
  vendor: 'unknown',
  reasoning: false,
});

const ALL_MODELS = [
  MINIMAX,
  GLM,
  KIMI,
  GPT,
  CLAUDE_HAIKU,
  CLAUDE_FABLE,
  NOVA,
  AUTO_UNKNOWN_1,
  MYSTERY_UNKNOWN_2,
];

function providerInfo(id: string, ready: boolean, reason: string | null = null): ProviderInfo {
  return {
    id,
    ready,
    authType: ready ? 'api_key' : null,
    reason: ready ? null : reason,
    modelCount: ALL_MODELS.filter((m) => m.provider === id).length,
  };
}

function makeCatalog(opts?: { unreadyProvider?: string; models?: CatalogModel[] }): Catalog {
  const models = opts?.models ?? ALL_MODELS;
  const providerIds = Array.from(new Set(models.map((m) => m.provider)));
  return {
    providers: providerIds.map((id) =>
      providerInfo(id, id !== opts?.unreadyProvider, 'oauth_expired'),
    ),
    models,
    skipped: 0,
    source: 'store',
  };
}

const CATALOG = makeCatalog();

const BASE_CONFIG: CouncilConfig = {
  version: 1,
  baseBranch: 'main',
  panel: [],
  includeContextFiles: false,
  timeoutSeconds: 600,
  maxOutputTokens: 32000,
  mergeWindow: 10,
  claimSimilarity: 0.6,
  failOn: 'high',
};

// ---------------------------------------------------------------------------------------------
// parsePanelEntry
// ---------------------------------------------------------------------------------------------

describe('parsePanelEntry', () => {
  it('parses a plain provider/modelId entry with no pin', () => {
    expect(parsePanelEntry('minimax/MiniMax-M2.7')).toEqual({
      provider: 'minimax',
      model: 'MiniMax-M2.7',
    });
  });

  it('parses a trailing :level pin, splitting on the last colon', () => {
    expect(parsePanelEntry('minimax/MiniMax-M2.7:high')).toEqual({
      provider: 'minimax',
      model: 'MiniMax-M2.7',
      pin: 'high',
    });
  });

  it('treats the whole remainder after the provider as the model id when it contains slashes', () => {
    expect(parsePanelEntry('openrouter/anthropic/claude-3-haiku:medium')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-3-haiku',
      pin: 'medium',
    });
  });

  it('carries a leading prefix marker on the model id through unchanged', () => {
    expect(parsePanelEntry('openrouter/~anthropic/claude-fable-latest:xhigh')).toEqual({
      provider: 'openrouter',
      model: '~anthropic/claude-fable-latest',
      pin: 'xhigh',
    });
  });

  it('errors naming the offending entry when there is no slash at all', () => {
    expect(() => parsePanelEntry('not-a-valid-entry')).toThrow(PanelError);
    try {
      parsePanelEntry('not-a-valid-entry');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PanelError);
      expect((err as PanelError).exitCode).toBe(2);
      expect((err as Error).message).toContain('not-a-valid-entry');
    }
  });

  it('errors when the trailing colon suffix is not a recognised thinking level', () => {
    expect(() => parsePanelEntry('minimax/MiniMax-M2.7:not-a-level')).toThrow(PanelError);
  });

  it('errors on an empty entry', () => {
    expect(() => parsePanelEntry('   ')).toThrow(PanelError);
  });

  it('errors when the provider segment is empty', () => {
    expect(() => parsePanelEntry('/MiniMax-M2.7')).toThrow(PanelError);
  });

  it('errors when the model segment is empty', () => {
    expect(() => parsePanelEntry('minimax/')).toThrow(PanelError);
  });
});

// ---------------------------------------------------------------------------------------------
// expandPanelSpec
// ---------------------------------------------------------------------------------------------

describe('expandPanelSpec', () => {
  it('resolves plain entries, each with the precedence-resolvable pin carried through', () => {
    const expanded = expandPanelSpec('minimax/MiniMax-M2.7,openai-codex/gpt-5.4:low', CATALOG);
    expect(expanded).toEqual([
      { provider: 'minimax', model: 'MiniMax-M2.7' },
      { provider: 'openai-codex', model: 'gpt-5.4', pin: 'low' },
    ]);
  });

  it('errors naming the offending entry for a literal entry with no catalog match', () => {
    expect(() => expandPanelSpec('minimax/does-not-exist', CATALOG)).toThrow(PanelError);
    try {
      expandPanelSpec('minimax/does-not-exist', CATALOG);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('does-not-exist');
    }
  });

  it('expands a glob pattern to every matching catalog model, propagating the pattern pin', () => {
    const expanded = expandPanelSpec('opencode-go/*:high', CATALOG);
    expect(expanded).toEqual(
      expect.arrayContaining([
        { provider: 'opencode-go', model: 'glm-5.2', pin: 'high' },
        { provider: 'opencode-go', model: 'kimi-k2.6', pin: 'high' },
      ]),
    );
    expect(expanded).toHaveLength(2);
  });

  it('expands a glob across providers', () => {
    const expanded = expandPanelSpec('*/gpt-5.4', CATALOG);
    expect(expanded).toEqual([{ provider: 'openai-codex', model: 'gpt-5.4' }]);
  });

  it('errors naming the pattern when a glob matches nothing', () => {
    expect(() => expandPanelSpec('nowhere/*', CATALOG)).toThrow(PanelError);
    try {
      expandPanelSpec('nowhere/*', CATALOG);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('nowhere/*');
    }
  });

  it('handles a mix of literal and glob entries in one spec', () => {
    const expanded = expandPanelSpec('minimax/MiniMax-M2.7:high,opencode-go/kimi-*', CATALOG);
    expect(expanded).toEqual([
      { provider: 'minimax', model: 'MiniMax-M2.7', pin: 'high' },
      { provider: 'opencode-go', model: 'kimi-k2.6' },
    ]);
  });

  it('ignores blank entries produced by stray commas', () => {
    const expanded = expandPanelSpec('minimax/MiniMax-M2.7,,openai-codex/gpt-5.4', CATALOG);
    expect(expanded).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// resolveConfiguredPanel / resolveSpecPanel
// ---------------------------------------------------------------------------------------------

describe('resolveConfiguredPanel', () => {
  it('resolves every entry to a Reviewer carrying its catalog model and thinking', () => {
    const panel: PanelEntry[] = [
      { provider: 'minimax', model: 'MiniMax-M2.7', thinking: 'high' },
      { provider: 'openai-codex', model: 'gpt-5.4' },
    ];
    const reviewers = resolveConfiguredPanel(panel, CATALOG, BASE_CONFIG);
    expect(reviewers).toHaveLength(2);
    expect(reviewers[0]).toMatchObject({
      provider: 'minimax',
      model: 'MiniMax-M2.7',
      vendor: 'minimax',
    });
    expect(reviewers[0]?.thinking).toMatchObject({
      applicable: true,
      requested: 'high',
      effective: 'high',
    });
  });

  it('prefers config.modelThinkingLevels over the saved entry thinking for the same model', () => {
    const panel: PanelEntry[] = [{ provider: 'minimax', model: 'MiniMax-M2.7', thinking: 'low' }];
    const cfg: CouncilConfig = {
      ...BASE_CONFIG,
      modelThinkingLevels: { 'minimax/MiniMax-M2.7': 'high' },
    };
    const [reviewer] = resolveConfiguredPanel(panel, CATALOG, cfg);
    expect(reviewer?.thinking.requested).toBe('high');
  });

  it('falls back to the saved entry thinking when modelThinkingLevels does not name the model', () => {
    const panel: PanelEntry[] = [
      { provider: 'minimax', model: 'MiniMax-M2.7', thinking: 'medium' },
    ];
    const [reviewer] = resolveConfiguredPanel(panel, CATALOG, BASE_CONFIG);
    expect(reviewer?.thinking.requested).toBe('medium');
  });

  it('a panel-wide CLI level overrides both configured sources', () => {
    const panel: PanelEntry[] = [{ provider: 'minimax', model: 'MiniMax-M2.7', thinking: 'low' }];
    const cfg: CouncilConfig = {
      ...BASE_CONFIG,
      modelThinkingLevels: { 'minimax/MiniMax-M2.7': 'medium' },
    };
    const [reviewer] = resolveConfiguredPanel(panel, CATALOG, cfg, 'high');
    expect(reviewer?.thinking.requested).toBe('high');
  });

  it('errors with exit code 2 naming the entry when its model is absent from the catalog', () => {
    const panel: PanelEntry[] = [{ provider: 'minimax', model: 'no-such-model' }];
    try {
      resolveConfiguredPanel(panel, CATALOG, BASE_CONFIG);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PanelError);
      expect((err as PanelError).exitCode).toBe(2);
      expect((err as Error).message).toContain('minimax/no-such-model');
    }
  });

  it('errors with exit code 2 naming the entry when its provider is no longer ready', () => {
    const catalog = makeCatalog({ unreadyProvider: 'minimax' });
    const panel: PanelEntry[] = [{ provider: 'minimax', model: 'MiniMax-M2.7' }];
    try {
      resolveConfiguredPanel(panel, catalog, BASE_CONFIG);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PanelError);
      expect((err as PanelError).exitCode).toBe(2);
      expect((err as Error).message).toContain('minimax');
    }
  });
});

describe('resolveSpecPanel', () => {
  it('resolves an expanded spec to reviewers, treating each pin as that model’s CLI pin', () => {
    const reviewers = resolveSpecPanel(
      'minimax/MiniMax-M2.7:low,openai-codex/gpt-5.4',
      CATALOG,
      BASE_CONFIG,
      'high',
    );
    // The per-model pin (low) beats the panel-wide flag (high); the unpinned entry takes it.
    expect(reviewers.find((r) => r.model === 'MiniMax-M2.7')?.thinking.requested).toBe('low');
    expect(reviewers.find((r) => r.model === 'gpt-5.4')?.thinking.requested).toBe('high');
  });

  it('propagates a glob expansion error as a PanelError', () => {
    expect(() => resolveSpecPanel('nowhere/*', CATALOG, BASE_CONFIG)).toThrow(PanelError);
  });
});

// ---------------------------------------------------------------------------------------------
// Independence guard
// ---------------------------------------------------------------------------------------------

function reviewerFrom(m: CatalogModel): Reviewer {
  return {
    provider: m.provider,
    model: m.id,
    vendor: m.vendor,
    catalog: m,
    thinking: { applicable: false, requested: null, effective: null, clamped: false },
  };
}

describe('checkIndependence', () => {
  it('admits a panel with three models across three distinct vendors', () => {
    const reviewers = [MINIMAX, GLM, GPT].map(reviewerFrom);
    const result = checkIndependence(reviewers);
    expect(result.ok).toBe(true);
    expect(result.vendors.size).toBe(3);
  });

  it('refuses a panel with too few vendors, even with enough models', () => {
    const reviewers = [CLAUDE_HAIKU, CLAUDE_FABLE, GPT].map(reviewerFrom); // 2 anthropic + 1 openai = 2 vendors
    const result = checkIndependence(reviewers);
    expect(result.ok).toBe(false);
    expect(result.vendors.size).toBe(2);
    expect(result.reason).toBeDefined();
  });

  it('refuses a panel with fewer than three models', () => {
    const reviewers = [MINIMAX, GLM].map(reviewerFrom);
    const result = checkIndependence(reviewers);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('2');
  });

  it('groups every unrecognised-vendor model into one shared "unknown" bucket, counted once', () => {
    const reviewers = [AUTO_UNKNOWN_1, MYSTERY_UNKNOWN_2, MINIMAX].map(reviewerFrom);
    const result = checkIndependence(reviewers);
    expect(result.vendors.get('unknown')).toEqual(['openrouter/auto', 'openrouter/mystery-model']);
    // Only 2 distinct vendors here (unknown + minimax) — still refused despite 3 models.
    expect(result.ok).toBe(false);
    expect(result.vendors.size).toBe(2);
  });

  it('admits a panel where "unknown" is one of three distinct vendor buckets', () => {
    const reviewers = [AUTO_UNKNOWN_1, MINIMAX, GPT].map(reviewerFrom);
    const result = checkIndependence(reviewers);
    expect(result.ok).toBe(true);
    expect(result.vendors.size).toBe(3);
  });
});

describe('enforceIndependence', () => {
  it('does not throw for a panel that passes the guard', () => {
    const reviewers = [MINIMAX, GLM, GPT].map(reviewerFrom);
    expect(() => enforceIndependence(reviewers, false)).not.toThrow();
  });

  it('throws GuardRefusal(exitCode 4) for too few vendors when not overridden', () => {
    const reviewers = [CLAUDE_HAIKU, CLAUDE_FABLE, GPT].map(reviewerFrom);
    try {
      enforceIndependence(reviewers, false);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GuardRefusal);
      expect((err as GuardRefusal).exitCode).toBe(4);
      expect((err as GuardRefusal).vendors.size).toBe(2);
    }
  });

  it('throws GuardRefusal(exitCode 4) for too few models when not overridden', () => {
    const reviewers = [MINIMAX, GLM].map(reviewerFrom);
    expect(() => enforceIndependence(reviewers, false)).toThrow(GuardRefusal);
  });

  it('the correlated-panel override waives both the vendor-count and the model-count minimum', () => {
    const tooFewModels = [MINIMAX, GLM].map(reviewerFrom);
    expect(() => enforceIndependence(tooFewModels, true)).not.toThrow();

    const tooFewVendors = [CLAUDE_HAIKU, CLAUDE_FABLE, GPT].map(reviewerFrom);
    expect(() => enforceIndependence(tooFewVendors, true)).not.toThrow();
  });

  it('is safe to call twice — end of selection and again before launch — with identical results', () => {
    const reviewers = [MINIMAX, GLM, GPT].map(reviewerFrom);
    expect(() => enforceIndependence(reviewers, false)).not.toThrow();
    expect(() => enforceIndependence(reviewers, false)).not.toThrow();
  });
});

describe('formatVendorGrouping', () => {
  it('names every vendor and its members, including singleton groups', () => {
    const result = checkIndependence([MINIMAX, GLM, GPT].map(reviewerFrom));
    const text = formatVendorGrouping(result.vendors);
    expect(text).toContain('minimax: minimax/MiniMax-M2.7');
    expect(text).toContain('zhipu: opencode-go/glm-5.2');
    expect(text).toContain('openai: openai-codex/gpt-5.4');
  });
});
