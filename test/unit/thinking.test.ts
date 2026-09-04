import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ThinkingLevel } from '../../src/levels.js';
import { THINKING_LEVELS } from '../../src/levels.js';
import type { CatalogModel } from '../../src/providers.js';
import {
  clampLevel,
  formatClampNotice,
  resolveThinking,
  supportedLevels,
  type ThinkingSources,
} from '../../src/thinking.js';

function makeModel(partial: Partial<CatalogModel> & { reasoning: boolean }): CatalogModel {
  return {
    id: 'model',
    name: 'Model',
    provider: 'provider',
    vendor: 'vendor',
    contextWindow: null,
    maxOutputTokens: null,
    inputCostPerMTok: null,
    outputCostPerMTok: null,
    thinkingLevelMap: undefined,
    ...partial,
  };
}

describe('supportedLevels', () => {
  it('reports no levels at all for a model whose reasoning flag is falsy', () => {
    const model = makeModel({ reasoning: false });
    expect(supportedLevels(model)).toEqual([]);
  });

  it('reports no levels at all for a falsy reasoning flag even with a thinking-level map present', () => {
    // A falsy reasoning flag wins outright — the map is not consulted at all.
    const model = makeModel({ reasoning: false, thinkingLevelMap: { high: 'high' } });
    expect(supportedLevels(model)).toEqual([]);
  });

  it('reports off through high as supported and xhigh/max as unsupported when the whole map is absent', () => {
    const model = makeModel({ reasoning: true, thinkingLevelMap: undefined });
    expect(supportedLevels(model)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
  });

  it('reports an explicit string value as supported', () => {
    const model = makeModel({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
    });
    expect(supportedLevels(model)).toEqual(['low']);
  });

  it('reports an explicit null as unsupported', () => {
    const model = makeModel({ reasoning: true, thinkingLevelMap: { high: null } });
    expect(supportedLevels(model)).not.toContain('high');
  });

  it('resolves an omitted key inside a partially specified map by the same fallback as a wholly absent map', () => {
    // Only `low` is specified; every other key is omitted and must fall back: off..high
    // supported, xhigh/max not.
    const model = makeModel({ reasoning: true, thinkingLevelMap: { low: 'low' } });
    expect(supportedLevels(model)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
  });

  it('reports off as unsupported when the map marks it explicit null, even though it would fall back to supported', () => {
    const model = makeModel({ reasoning: true, thinkingLevelMap: { off: null } });
    const levels = supportedLevels(model);
    expect(levels).not.toContain('off');
    expect(levels).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  it('matches the real opencode-go/glm-5.2 fixture shape: only high and max supported', () => {
    const model = makeModel({
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
    expect(supportedLevels(model)).toEqual(['high', 'max']);
  });
});

describe('resolveThinking — precedence', () => {
  const reasoningModel = makeModel({ reasoning: true, thinkingLevelMap: undefined });

  it('a per-model CLI pin beats a panel-wide CLI flag', () => {
    const sources: ThinkingSources = {
      cliPin: 'high',
      cliPanelWide: 'low',
      configDefault: 'medium',
    };
    expect(resolveThinking(reasoningModel, sources).requested).toBe('high');
  });

  it('a panel-wide CLI flag beats configured per-model and default levels', () => {
    const sources: ThinkingSources = {
      cliPanelWide: 'medium',
      configPerModel: 'low',
      configDefault: 'minimal',
    };
    expect(resolveThinking(reasoningModel, sources).requested).toBe('medium');
  });

  it('a configured per-model level beats the configured default', () => {
    const sources: ThinkingSources = { configPerModel: 'low', configDefault: 'high' };
    expect(resolveThinking(reasoningModel, sources).requested).toBe('low');
  });

  it('the configured default applies when nothing more specific is given', () => {
    const sources: ThinkingSources = { configDefault: 'medium' };
    expect(resolveThinking(reasoningModel, sources).requested).toBe('medium');
  });

  it('resolves to "nothing at all" — null, not any level — when no source supplies one', () => {
    const result = resolveThinking(reasoningModel, {});
    expect(result.requested).toBeNull();
    expect(result.effective).toBeNull();
    expect(result.clamped).toBe(false);
    expect(result.applicable).toBe(true);
  });

  it('a non-reasoning model ignores every source: not applicable, nothing requested, nothing sent', () => {
    const model = makeModel({ reasoning: false });
    const sources: ThinkingSources = {
      cliPin: 'high',
      cliPanelWide: 'high',
      configDefault: 'high',
    };
    const result = resolveThinking(model, sources);
    expect(result.applicable).toBe(false);
    expect(result.requested).toBeNull();
    expect(result.effective).toBeNull();
    expect(result.clamped).toBe(false);
  });
});

describe('resolveThinking / clampLevel — clamping', () => {
  it('clamps a requested level above the model ceiling down to the ceiling', () => {
    const model = makeModel({
      reasoning: true,
      thinkingLevelMap: { high: 'high', xhigh: null, max: null },
    });
    const result = resolveThinking(model, { cliPanelWide: 'max' });
    expect(result.requested).toBe('max');
    expect(result.effective).toBe('high');
    expect(result.clamped).toBe(true);
  });

  it('clamps "off" to the nearest supported level when the model cannot disable thinking, recording both values', () => {
    const model = makeModel({
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: 'minimal' },
    });
    const result = resolveThinking(model, { cliPanelWide: 'off' });
    expect(result.requested).toBe('off');
    expect(result.effective).toBe('minimal');
    expect(result.clamped).toBe(true);
  });

  it('does not clamp when the requested level is itself supported', () => {
    const model = makeModel({ reasoning: true, thinkingLevelMap: { medium: 'medium' } });
    const result = resolveThinking(model, { cliPanelWide: 'medium' });
    expect(result.effective).toBe('medium');
    expect(result.clamped).toBe(false);
  });

  it('breaks a tie between an equidistant supported level above and below by choosing the lower one', () => {
    // 'medium' is requested; 'low' and 'high' are each one step away — the tie must resolve down.
    const supported: ThinkingLevel[] = ['low', 'high'];
    expect(clampLevel('medium', supported)).toBe('low');
  });

  it('breaks a tie regardless of the supported array iteration order', () => {
    expect(clampLevel('medium', ['high', 'low'])).toBe('low');
  });

  it('picks the single nearest level when distances are unequal', () => {
    // 'off' is requested; nearest supported is 'low' (distance 2) over 'high' (distance 4).
    expect(clampLevel('off', ['low', 'high'])).toBe('low');
  });

  it('returns the level unchanged via clampLevel when it is already supported', () => {
    expect(clampLevel('high', THINKING_LEVELS)).toBe('high');
  });
});

describe('formatClampNotice', () => {
  it('returns null when nothing was clamped', () => {
    const model = makeModel({ reasoning: true, thinkingLevelMap: { medium: 'medium' } });
    const result = resolveThinking(model, { cliPanelWide: 'medium' });
    expect(formatClampNotice('openrouter/model', result)).toBeNull();
  });

  it('names both the requested and effective level when clamped', () => {
    const model = makeModel({
      reasoning: true,
      thinkingLevelMap: { high: 'high', xhigh: null, max: null },
    });
    const result = resolveThinking(model, { cliPanelWide: 'max' });
    const notice = formatClampNotice('openrouter/model', result);
    expect(notice).toContain('openrouter/model');
    expect(notice).toContain('max');
    expect(notice).toContain('high');
  });
});

describe('no thinking-budget value ever originates from this tool', () => {
  it('src/ contains no numeric thinking-budget token, field or literal', () => {
    const srcDir = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'src');
    const budgetPattern = /thinkingbudget|budgettokens|thinking_budget|maxthinkingtokens/i;

    const offenders: string[] = [];
    for (const file of fs.readdirSync(srcDir)) {
      if (!file.endsWith('.ts')) continue;
      const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
      if (budgetPattern.test(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it('ResolvedThinking never carries a numeric level — requested and effective are always the closed string enum or null', () => {
    const model = makeModel({ reasoning: true, thinkingLevelMap: undefined });
    const result = resolveThinking(model, { cliPanelWide: 'high' });
    for (const value of [result.requested, result.effective]) {
      expect(value === null || THINKING_LEVELS.includes(value)).toBe(true);
    }
  });
});
