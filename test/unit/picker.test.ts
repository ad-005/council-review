import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { Catalog, CatalogModel, ProviderInfo } from '../../src/providers.js';
import type { ThinkingLevel } from '../../src/levels.js';
import {
  PickerCancelled,
  PickerNonInteractive,
  THINKING_BACK_VALUE,
  buildModelRows,
  buildThinkingChoices,
  groupModelsByProvider,
  modelGroupMessage,
  pickPanel,
  pickerCheckboxTheme,
  type ModelChoice,
} from '../../src/picker.js';
import { Separator } from '@inquirer/prompts';

// ---------------------------------------------------------------------------------------------
// A scripted terminal: a real (non-TTY) duplex pair driving @inquirer/prompts exactly as the
// contract requires ("it accepts custom input/output streams, which is how 6.6 must drive it").
// `readline.createInterface` is created with `terminal: true` unconditionally inside
// @inquirer/core, so a plain PassThrough works as `input` regardless of `isTTY`; the picker's
// own `PickerIO.isTTY` field is this module's own interactivity gate, not passed to inquirer.
// ---------------------------------------------------------------------------------------------

const UP = '\x1B[A';
const DOWN = '\x1B[B';
const SPACE = ' ';
const ENTER = '\r';
const CTRL_C = '\x03';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ScriptedTerminal {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  buffer = '';

  constructor(options: { columns?: number } = {}) {
    this.output.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
    });
    if (options.columns !== undefined) {
      Object.defineProperty(this.output, 'columns', {
        value: options.columns,
        configurable: true,
      });
    }
  }

  send(keys: string): void {
    this.input.write(keys);
  }

  /** Polls the accumulated rendered output for `needle`, so each scripted keystroke is sent
   * only once the prompt it targets has actually rendered — far less flaky than a fixed delay. */
  async waitFor(needle: string, timeoutMs = 4000): Promise<void> {
    const start = Date.now();
    while (!this.buffer.includes(needle)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timed out waiting for rendered output to contain ${JSON.stringify(needle)}; got:\n${this.buffer}`,
        );
      }
      await delay(10);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Fixture catalog
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

function provider(id: string, modelCount: number): ProviderInfo {
  return { id, ready: true, authType: 'api_key', reason: null, modelCount };
}

const MINIMAX = model({
  id: 'MiniMax-M2.7',
  provider: 'minimax',
  vendor: 'minimax',
  reasoning: true,
});
const KIMI = model({
  id: 'kimi-k2.6',
  provider: 'opencode-go',
  vendor: 'moonshot',
  reasoning: false,
});
const GLM = model({ id: 'glm-5.2', provider: 'opencode-go', vendor: 'zhipu', reasoning: true });

// Same-provider reasoning pair (plus a non-reasoning stablemate) for the back-navigation
// tests: one provider checkbox and one model group keep the scripted key sequences short.
const REASON_A = model({
  id: 'model-a',
  provider: 'test-gw',
  vendor: 'vendor-a',
  reasoning: true,
});
const REASON_B = model({
  id: 'model-b',
  provider: 'test-gw',
  vendor: 'vendor-b',
  reasoning: true,
});
const PLAIN = model({
  id: 'model-plain',
  provider: 'test-gw',
  vendor: 'vendor-p',
  reasoning: false,
});

// `provider/id` alone is ~99 characters here — over the inquirer fallback width of 80 columns,
// but under the 120-column terminal the test below drives the picker at.
const WIDE_ID = 'a'.repeat(90);
const WIDE = model({ id: WIDE_ID, provider: 'opencode', vendor: 'opencode', reasoning: false });

function catalogOf(models: CatalogModel[]): Catalog {
  const providerIds = Array.from(new Set(models.map((m) => m.provider)));
  return {
    providers: providerIds.map((id) =>
      provider(id, models.filter((m) => m.provider === id).length),
    ),
    models,
    skipped: 0,
    source: 'store',
  };
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe('pickPanel — non-interactive refusal', () => {
  it('exits without a terminal, before any prompt, exit code 2', async () => {
    const catalog = catalogOf([MINIMAX]);
    const term = new ScriptedTerminal();

    const result = pickPanel(catalog, { input: term.input, output: term.output, isTTY: false });
    await expect(result).rejects.toBeInstanceOf(PickerNonInteractive);
    await expect(
      pickPanel(catalog, { input: term.input, output: term.output, isTTY: false }),
    ).rejects.toMatchObject({ exitCode: 2 });
    // Nothing was ever rendered — the refusal happens before any prompt runs.
    expect(term.buffer).toBe('');
  });
});

describe('pickPanel — full staged selection', () => {
  it('drives provider -> model -> thinking stages over a scripted input stream', async () => {
    const catalog = catalogOf([MINIMAX]);
    const term = new ScriptedTerminal();

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    term.send(SPACE + ENTER); // select the only provider

    await term.waitFor('Select models');
    term.send(SPACE + ENTER); // select the only model

    await term.waitFor('Thinking level for minimax/MiniMax-M2.7');
    term.send(DOWN + DOWN + ENTER); // off -> minimal -> low

    const reviewers = await resultPromise;

    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]).toMatchObject({
      provider: 'minimax',
      model: 'MiniMax-M2.7',
      vendor: 'minimax',
    });
    expect(reviewers[0]?.thinking).toMatchObject({
      applicable: true,
      requested: 'low',
      effective: 'low',
      clamped: false,
    });
  }, 10_000);

  it('shows a non-reasoning selection as "no thinking" and skips its prompt entirely', async () => {
    const catalog = catalogOf([KIMI, GLM]);
    const term = new ScriptedTerminal();

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    term.send(SPACE + ENTER); // one provider, opencode-go

    await term.waitFor('Select models');
    term.send(SPACE + DOWN + SPACE + ENTER); // select both KIMI and GLM

    // KIMI is non-reasoning, so the very next prompt to render is GLM's thinking stage — no
    // prompt for KIMI ever appears.
    await term.waitFor('Thinking level for opencode-go/glm-5.2');
    expect(term.buffer).not.toContain('Thinking level for opencode-go/kimi-k2.6');
    term.send(ENTER); // accept the default (first / lowest supported) level

    const reviewers = await resultPromise;

    expect(reviewers).toHaveLength(2);
    const kimi = reviewers.find((r) => r.model === 'kimi-k2.6');
    const glm = reviewers.find((r) => r.model === 'glm-5.2');

    expect(kimi?.thinking).toMatchObject({ applicable: false, requested: null, effective: null });
    expect(glm?.thinking.applicable).toBe(true);
    expect(glm?.thinking.requested).not.toBeNull();

    expect(term.buffer).toContain('opencode-go/kimi-k2.6: no thinking');
  }, 10_000);

  it('scopes the model stage to only the chosen providers', async () => {
    const catalog = catalogOf([MINIMAX, KIMI, GLM]);
    const term = new ScriptedTerminal();

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    // Providers render in catalog order: minimax, opencode-go. Select only minimax.
    term.send(SPACE + ENTER);

    await term.waitFor('Select models');
    expect(term.buffer).toContain('MiniMax-M2.7');
    expect(term.buffer).not.toContain('kimi-k2.6');
    expect(term.buffer).not.toContain('glm-5.2');

    term.send(SPACE + ENTER);
    await term.waitFor('Thinking level for minimax/MiniMax-M2.7');
    term.send(ENTER);

    const reviewers = await resultPromise;
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]?.provider).toBe('minimax');
  }, 10_000);
});

describe('pickPanel — terminal width', () => {
  it('does not hard-wrap a long model id when the relay reports the real terminal width', async () => {
    const catalog = catalogOf([WIDE]);
    const term = new ScriptedTerminal({ columns: 120 });

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    term.send(SPACE + ENTER); // select the only provider

    await term.waitFor('Select models');
    // At the buggy 80-column fallback, inquirer hard-wraps mid-token and this id is split across
    // two rendered lines; at the real 120-column width it stays on one line, contiguous.
    expect(term.buffer).toContain(WIDE_ID);

    term.send(SPACE + ENTER); // select the only model; non-reasoning, so no thinking stage follows

    await resultPromise;
  }, 10_000);
});

describe('groupModelsByProvider — provider groups', () => {
  it('groups models by provider in first-appearance order', () => {
    const groups = groupModelsByProvider([MINIMAX, KIMI, GLM]);

    expect(groups.map((g) => g.provider)).toEqual(['minimax', 'opencode-go']);
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['MiniMax-M2.7']);
    expect(groups[1]?.models.map((m) => m.id)).toEqual(['kimi-k2.6', 'glm-5.2']);
  });

  it('returns no groups for an empty model scope', () => {
    expect(groupModelsByProvider([])).toEqual([]);
  });
});

describe('modelGroupMessage — pinned group header', () => {
  it('names the provider with a singular model count', () => {
    expect(modelGroupMessage('minimax', 1)).toBe(
      'Select models for the panel — minimax (1 model):',
    );
  });

  it('names the provider with a plural model count', () => {
    expect(modelGroupMessage('opencode-go', 25)).toBe(
      'Select models for the panel — opencode-go (25 models):',
    );
  });
});

describe('buildModelRows — readable model rows', () => {
  function rows(choices: Array<ModelChoice | Separator>): ModelChoice[] {
    return choices.filter((c): c is ModelChoice => !Separator.isSeparator(c));
  }

  /** 'R' = model row, '.' = blank spacer. */
  function shape(choices: Array<ModelChoice | Separator>): string {
    return choices.map((c) => (Separator.isSeparator(c) ? '.' : 'R')).join('');
  }

  it('keeps the identity intact and shows vendor, context, costs, and thinking support', () => {
    const [row] = rows(buildModelRows([MINIMAX]));
    expect(row?.short).toBe('minimax/MiniMax-M2.7');
    expect(row?.name).toContain('minimax/MiniMax-M2.7');
    expect(row?.name).toContain('minimax');
    expect(row?.name).toContain('100.0K ctx');
    expect(row?.name).toContain('$1 in / $2 out /Mtok');
    expect(row?.name).toContain('thinking');
    expect(row?.description).toContain('vendor minimax');
    expect(row?.description).toContain('supports thinking levels');
  });

  it('marks non-reasoning models so the skipped thinking prompt is no surprise', () => {
    const [row] = rows(buildModelRows([KIMI]));
    expect(row?.name).toContain('no thinking');
    expect(row?.description).toContain('no thinking levels');
  });

  it('renders unknown figures as ? rather than dropping the column', () => {
    const mystery = model({
      id: 'mystery-1',
      provider: 'p',
      vendor: 'unknown',
      contextWindow: null,
      maxOutputTokens: null,
      inputCostPerMTok: null,
      outputCostPerMTok: null,
    });
    const [row] = rows(buildModelRows([mystery]));
    expect(row?.name).toContain('? ctx');
    expect(row?.name).toContain('? in / ? out /Mtok');
  });

  it('aligns the specs columns across rows of different identity lengths', () => {
    const choices = buildModelRows([MINIMAX, GLM]);
    const names = rows(choices).map((r) => r.name);
    expect(names).toHaveLength(2);
    // Both specs columns start at the same offset: the shorter identity is space-padded.
    const specsAt = names.map((n) => n.indexOf('·'));
    expect(specsAt[0]).toBe(specsAt[1]);
    expect(specsAt[0]).toBeGreaterThan(0);
  });

  it('caps the identity column so one very long id cannot push the rest off-screen', () => {
    const choices = buildModelRows([WIDE, MINIMAX]);
    const names = rows(choices).map((r) => r.name);
    // The short row stays padded to the 48-column cap, not to the 90+ character id.
    expect(names[1]?.indexOf('·')).toBeLessThanOrEqual(60);
    expect(names[0]).toContain(WIDE_ID);
  });

  it('returns no choices for an empty group', () => {
    expect(buildModelRows([])).toEqual([]);
  });

  it('precedes every row with a blank spacer, distancing the first row from the header', () => {
    expect(shape(buildModelRows([KIMI, GLM]))).toBe('.R.R');
    expect(shape(buildModelRows([MINIMAX]))).toBe('.R');
  });

  it('uses larger square checkbox glyphs instead of the default small circles', () => {
    expect(pickerCheckboxTheme.icon.unchecked).toBe('☐');
    expect(pickerCheckboxTheme.icon.checked).toContain('☑');
  });
});

describe('pickPanel — model stage rendering', () => {
  it('renders square checkboxes and a blank line between model rows', async () => {
    const catalog = catalogOf([KIMI, GLM]);
    const term = new ScriptedTerminal();

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    term.send(SPACE + ENTER); // one provider, opencode-go

    // The group header is the prompt message itself, so it can never scroll away with the rows.
    await term.waitFor('Select models for the panel — opencode-go (2 models):');
    expect(term.buffer).toContain('☐');
    expect(term.buffer).not.toContain('◯');

    term.send(SPACE); // check the highlighted row
    await term.waitFor('☑');

    term.send(DOWN + SPACE + ENTER); // DOWN skips the blank spacer onto GLM; select both
    await term.waitFor('Thinking level for opencode-go/glm-5.2');
    term.send(ENTER);

    const reviewers = await resultPromise;
    expect(reviewers.map((r) => r.model).sort()).toEqual(['glm-5.2', 'kimi-k2.6']);
  }, 10_000);

  it('walks one pinned-header prompt per provider group and accumulates selections', async () => {
    const catalog = catalogOf([MINIMAX, KIMI]);
    const term = new ScriptedTerminal();

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    // Providers render in catalog order: minimax, opencode-go. Select both.
    term.send(SPACE + DOWN + SPACE + ENTER);

    await term.waitFor('Select models for the panel — minimax (1 model):');
    term.send(SPACE + ENTER); // take MiniMax-M2.7; minimax group done

    await term.waitFor('Select models for the panel — opencode-go (1 model):');
    term.send(SPACE + ENTER); // take kimi-k2.6; KIMI skips thinking, MINIMAX prompts next

    await term.waitFor('Thinking level for minimax/MiniMax-M2.7');
    term.send(ENTER);

    const reviewers = await resultPromise;
    expect(reviewers.map((r) => `${r.provider}/${r.model}`).sort()).toEqual([
      'minimax/MiniMax-M2.7',
      'opencode-go/kimi-k2.6',
    ]);
  }, 10_000);

  it('re-runs the model stage when nothing was selected anywhere', async () => {
    const catalog = catalogOf([MINIMAX]);
    const term = new ScriptedTerminal();

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    term.send(SPACE + ENTER);

    await term.waitFor('Select models for the panel — minimax (1 model):');
    term.send(ENTER); // confirm with nothing selected

    await term.waitFor('Select at least one model for the panel.');
    term.send(SPACE + ENTER); // select the model on the second pass

    await term.waitFor('Thinking level for minimax/MiniMax-M2.7');
    term.send(ENTER);

    const reviewers = await resultPromise;
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]?.model).toBe('MiniMax-M2.7');
  }, 10_000);

  it('loops the rows in a circle within the group', async () => {
    const kimi2 = model({ id: 'kimi-k2.7', provider: 'opencode-go', vendor: 'moonshot' });
    const kimi3 = model({ id: 'kimi-k2.8', provider: 'opencode-go', vendor: 'moonshot' });
    const catalog = catalogOf([KIMI, kimi2, kimi3]);
    const term = new ScriptedTerminal();

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    term.send(SPACE + ENTER); // one provider, opencode-go

    await term.waitFor('Select models for the panel — opencode-go (3 models):');
    // Four downs from the first row wraps past the end back onto the second row.
    term.send(DOWN + DOWN + DOWN + DOWN + SPACE + ENTER);

    const reviewers = await resultPromise;
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]?.model).toBe('kimi-k2.7');
  }, 10_000);
});

describe('pickPanel — cancellation', () => {
  it('cancelling at the provider stage throws PickerCancelled(exitCode 2) and resolves nothing', async () => {
    const catalog = catalogOf([MINIMAX]);
    const term = new ScriptedTerminal();

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    term.send(CTRL_C);

    await expect(resultPromise).rejects.toBeInstanceOf(PickerCancelled);
  }, 10_000);

  it('cancelling at the model stage throws PickerCancelled(exitCode 2)', async () => {
    const catalog = catalogOf([MINIMAX]);
    const term = new ScriptedTerminal();

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    term.send(SPACE + ENTER);

    await term.waitFor('Select models');
    term.send(CTRL_C);

    try {
      await resultPromise;
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PickerCancelled);
      expect((err as PickerCancelled).exitCode).toBe(2);
    }
  }, 10_000);

  it('cancelling at the thinking stage throws PickerCancelled(exitCode 2)', async () => {
    const catalog = catalogOf([MINIMAX]);
    const term = new ScriptedTerminal();

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    term.send(SPACE + ENTER);
    await term.waitFor('Select models');
    term.send(SPACE + ENTER);
    await term.waitFor('Thinking level for minimax/MiniMax-M2.7');
    term.send(CTRL_C);

    await expect(resultPromise).rejects.toBeInstanceOf(PickerCancelled);
  }, 10_000);
});

describe('buildThinkingChoices — back choice', () => {
  const levels: ThinkingLevel[] = ['off', 'minimal', 'low'];

  it('offers only levels when there is no previous reasoning model', () => {
    const choices = buildThinkingChoices(levels, null);
    expect(choices).toHaveLength(3);
    expect(choices.every((c) => !Separator.isSeparator(c))).toBe(true);
    expect(choices).toMatchObject([
      { value: 'off', name: 'off' },
      { value: 'minimal', name: 'minimal' },
      { value: 'low', name: 'low' },
    ]);
  });

  it('appends a separator-spaced back choice naming the previous model otherwise', () => {
    const choices = buildThinkingChoices(levels, 'test-gw/model-a');
    expect(choices).toHaveLength(5);
    // Levels keep their positions; the back choice is trailing.
    expect(choices.slice(0, 3)).toMatchObject([
      { value: 'off' },
      { value: 'minimal' },
      { value: 'low' },
    ]);
    expect(Separator.isSeparator(choices[3])).toBe(true);
    const back = choices[4];
    expect(Separator.isSeparator(back)).toBe(false);
    expect(back).toMatchObject({ value: THINKING_BACK_VALUE });
    if (!Separator.isSeparator(back)) {
      expect(back.name).toContain('Back');
      expect(back.name).toContain('test-gw/model-a');
    }
  });
});

describe('pickPanel — thinking back navigation', () => {
  it('the first reasoning model offers no back choice', async () => {
    const catalog = catalogOf([REASON_A]);
    const term = new ScriptedTerminal();

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    term.send(SPACE + ENTER);

    await term.waitFor('Select models');
    term.send(SPACE + ENTER);

    await term.waitFor('Thinking level for test-gw/model-a');
    expect(term.buffer).not.toContain('Back');
    term.send(ENTER);

    const reviewers = await resultPromise;
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]?.thinking).toMatchObject({ requested: 'off', effective: 'off' });
  }, 10_000);

  it('going back re-opens the previous model on its previous pick for correction', async () => {
    const catalog = catalogOf([REASON_A, REASON_B]);
    const term = new ScriptedTerminal();

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    term.send(SPACE + ENTER);

    await term.waitFor('Select models');
    term.send(SPACE + DOWN + SPACE + ENTER); // select both models

    await term.waitFor('Thinking level for test-gw/model-a');
    term.send(DOWN + DOWN + ENTER); // model-a: off -> minimal -> low

    await term.waitFor('Thinking level for test-gw/model-b');
    expect(term.buffer).toContain('Back');
    // The re-prompted message is identical to the already-rendered one, so the buffer is
    // cleared before each transition and the wait below only matches the fresh render.
    term.buffer = '';
    term.send(UP + ENTER); // UP wraps past the top onto the trailing back choice

    await term.waitFor('Thinking level for test-gw/model-a');
    term.buffer = '';
    term.send(DOWN + ENTER); // re-opened on low (the previous pick); move to medium

    await term.waitFor('Thinking level for test-gw/model-b');
    term.send(DOWN + DOWN + DOWN + DOWN + ENTER); // model-b: high

    const reviewers = await resultPromise;
    expect(reviewers).toHaveLength(2);
    // If the re-visited prompt had re-opened on off instead of low, DOWN would have landed on
    // minimal rather than medium.
    expect(reviewers[0]).toMatchObject({ model: 'model-a' });
    expect(reviewers[0]?.thinking).toMatchObject({ requested: 'medium', effective: 'medium' });
    expect(reviewers[1]).toMatchObject({ model: 'model-b' });
    expect(reviewers[1]?.thinking).toMatchObject({ requested: 'high', effective: 'high' });
  }, 10_000);

  it('going back lands on the previous reasoning model and announces "no thinking" once', async () => {
    const catalog = catalogOf([REASON_A, PLAIN, REASON_B]);
    const term = new ScriptedTerminal();

    const resultPromise = pickPanel(catalog, {
      input: term.input,
      output: term.output,
      isTTY: true,
    });

    await term.waitFor('Select providers');
    term.send(SPACE + ENTER);

    await term.waitFor('Select models');
    term.send(SPACE + DOWN + SPACE + DOWN + SPACE + ENTER); // select all three

    await term.waitFor('Thinking level for test-gw/model-a');
    term.send(ENTER); // model-a: off

    await term.waitFor('Thinking level for test-gw/model-b');
    // The non-reasoning selection in between was skipped with its announcement.
    const announcement = 'test-gw/model-plain: no thinking';
    expect(term.buffer).toContain(announcement);
    expect(term.buffer.split(announcement)).toHaveLength(2);

    term.buffer = '';
    term.send(UP + ENTER); // back: must land on model-a, skipping model-plain

    await term.waitFor('Thinking level for test-gw/model-a');
    term.buffer = '';
    term.send(ENTER); // keep off (re-opened on the previous pick)

    await term.waitFor('Thinking level for test-gw/model-b');
    term.send(ENTER); // model-b: off

    const reviewers = await resultPromise;
    expect(reviewers.map((r) => r.model)).toEqual(['model-a', 'model-plain', 'model-b']);
    expect(reviewers[1]?.thinking).toMatchObject({
      applicable: false,
      requested: null,
      effective: null,
    });
    // Backtracking passed over model-plain a second time without re-announcing it.
    expect(term.buffer).not.toContain(announcement);
  }, 10_000);
});
