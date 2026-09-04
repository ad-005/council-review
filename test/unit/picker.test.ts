import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { Catalog, CatalogModel, ProviderInfo } from '../../src/providers.js';
import { PickerCancelled, PickerNonInteractive, pickPanel } from '../../src/picker.js';

// ---------------------------------------------------------------------------------------------
// A scripted terminal: a real (non-TTY) duplex pair driving @inquirer/prompts exactly as the
// contract requires ("it accepts custom input/output streams, which is how 6.6 must drive it").
// `readline.createInterface` is created with `terminal: true` unconditionally inside
// @inquirer/core, so a plain PassThrough works as `input` regardless of `isTTY`; the picker's
// own `PickerIO.isTTY` field is this module's own interactivity gate, not passed to inquirer.
// ---------------------------------------------------------------------------------------------

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

  constructor() {
    this.output.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
    });
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
