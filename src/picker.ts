/**
 * Three-stage interactive panel selection: providers, then models scoped to those providers,
 * then a thinking level per selected reasoning model. See `openspec/changes/add-council-review/
 * specs/council-review/panel-selection/spec.md`'s "Staged interactive selection" requirement.
 *
 * This module never writes configuration itself — it only resolves a `Reviewer[]`. The caller
 * (`cli.ts`) is what persists a panel, which is what makes "cancelling writes nothing" true by
 * construction rather than by a save/rollback dance in here. It also never runs the
 * vendor-independence guard: that is `panel.ts`'s `enforceIndependence`, called by the CLI once
 * selection finishes and again immediately before launch.
 */
import { PassThrough } from 'node:stream';

import { checkbox, select } from '@inquirer/prompts';

import type { ThinkingLevel } from './levels.js';
import type { Reviewer } from './panel.js';
import type { Catalog, CatalogModel, ProviderInfo } from './providers.js';
import { resolveThinking, supportedLevels } from './thinking.js';

export interface PickerIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream & Partial<Pick<NodeJS.WriteStream, 'columns' | 'rows' | 'isTTY'>>;
  isTTY: boolean;
}

export class PickerCancelled extends Error {
  readonly exitCode = 2 as const;

  constructor(message = 'selection cancelled; no configuration was written') {
    super(message);
    this.name = 'PickerCancelled';
    Object.setPrototypeOf(this, PickerCancelled.prototype);
  }
}

export class PickerNonInteractive extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = 'PickerNonInteractive';
    Object.setPrototypeOf(this, PickerNonInteractive.prototype);
  }
}

/**
 * `@inquirer/prompts` rejects with `ExitPromptError` on Ctrl+C / SIGINT / a closed input stream,
 * and with `CancelPromptError` when a prompt's own `context.signal` (not used here) fires. Both
 * are checked by `.name` rather than `instanceof` against an imported class, because
 * `@inquirer/core` is a transitive dependency of `@inquirer/prompts` — this package depends only
 * on the latter, per the contract's "do not edit package.json" rule.
 */
function isCancellation(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === 'ExitPromptError' || err.name === 'CancelPromptError')
  );
}

function defaultIO(): PickerIO {
  return {
    input: process.stdin,
    output: process.stdout,
    isTTY: process.stdin.isTTY === true,
  };
}

function formatTokenCount(n: number | null): string {
  if (n === null) return '?';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCostRate(n: number | null): string {
  return n === null ? '?' : `$${n}`;
}

function providerChoiceLabel(p: ProviderInfo): string {
  const auth = p.authType ?? 'unknown auth';
  const models = p.modelCount === 1 ? '1 model' : `${p.modelCount} models`;
  return `${p.id}  (${auth}, ${models})`;
}

function modelChoiceLabel(m: CatalogModel): string {
  return (
    `${m.provider}/${m.id}  —  vendor: ${m.vendor}, context: ${formatTokenCount(m.contextWindow)}, ` +
    `in: ${formatCostRate(m.inputCostPerMTok)}/Mtok, out: ${formatCostRate(m.outputCostPerMTok)}/Mtok`
  );
}

// JSON-encoded rather than joined with a separator character, because a host model id may
// itself contain '/' (or, in principle, anything else) — encoding sidesteps needing a separator
// character that is provably absent from every id.
function modelKey(provider: string, id: string): string {
  return JSON.stringify([provider, id]);
}

function splitModelKey(key: string): { provider: string; id: string } {
  const [provider, id] = JSON.parse(key) as [string, string];
  return { provider, id };
}

/**
 * Builds a fresh `{ input, output }` context for one prompt call. Each `@inquirer/prompts` call
 * ends its own internal stream wrapped around whatever `output` it is given as part of normal
 * cleanup, which — unlike `process.stdout`, which silently tolerates `.end()` — would close a
 * caller-supplied stream for good after the very first of this picker's three stages. Relaying
 * through a disposable `PassThrough` with `{ end: false }` on the downstream pipe means only the
 * disposable relay ever gets closed; `io.output` stays open for every later stage.
 *
 * The relay also needs to mirror `io.output`'s `columns`/`rows`/`isTTY`, because that is how
 * inquirer measures the terminal: `@inquirer/core`'s `readlineWidth()` goes through `cli-width`,
 * and node's own `readline.Interface#columns`, both of which end up reading `.columns` off
 * whatever stream inquirer was handed — here, the relay, not the real terminal. A relay that
 * reports no width silently falls back to 80 columns, which hard-wraps long model labels mid-word
 * and makes `ScreenManager` erase the wrong number of lines on every re-render (arrow keys leave
 * stale copies of the list on screen). Defined as getters rather than copied once, so a mid-prompt
 * terminal resize is still reflected on the next render, exactly as it would be against real
 * stdout.
 */
function promptContext(io: PickerIO): {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
} {
  const relay = new PassThrough();
  Object.defineProperties(relay, {
    columns: { get: () => io.output.columns, configurable: true },
    rows: { get: () => io.output.rows, configurable: true },
    isTTY: { get: () => io.output.isTTY === true, configurable: true },
  });
  relay.pipe(io.output, { end: false });
  return { input: io.input, output: relay };
}

/**
 * Runs the three-stage picker: providers, then models scoped to those providers, then a
 * thinking level per selected reasoning model (non-reasoning selections are shown as "no
 * thinking" and skip the prompt entirely). Throws `PickerNonInteractive` (exit code 2) without a
 * terminal, before any prompt runs, and `PickerCancelled` (exit code 2) if the user cancels at
 * any stage.
 */
export async function pickPanel(catalog: Catalog, io: PickerIO = defaultIO()): Promise<Reviewer[]> {
  if (!io.isTTY) {
    throw new PickerNonInteractive(
      'interactive selection requires a terminal; supply a panel via "council-review init" ' +
        'configuration or the --models flag in a non-interactive environment.',
    );
  }

  try {
    const readyProviders = catalog.providers.filter((p) => p.ready);

    const selectedProviderIds = await checkbox<string>(
      {
        message: 'Select providers to draw reviewers from:',
        required: true,
        choices: readyProviders.map((p) => ({ value: p.id, name: providerChoiceLabel(p) })),
      },
      promptContext(io),
    );

    const scopedModels = catalog.models.filter((m) => selectedProviderIds.includes(m.provider));

    const selectedModelKeys = await checkbox<string>(
      {
        message: 'Select models for the panel:',
        required: true,
        choices: scopedModels.map((m) => ({
          value: modelKey(m.provider, m.id),
          name: modelChoiceLabel(m),
        })),
      },
      promptContext(io),
    );

    const selectedModels = selectedModelKeys.map((key) => {
      const { provider, id } = splitModelKey(key);
      const found = scopedModels.find((m) => m.provider === provider && m.id === id);
      if (!found) {
        // Unreachable in practice — every choice value is built from `scopedModels` above — but
        // guarded rather than asserted away, since a thrown internal error is safer than a
        // reviewer silently resolving to `undefined`.
        throw new Error(`picker: selected model not found in scope: ${provider}/${id}`);
      }
      return found;
    });

    const reviewers: Reviewer[] = [];
    for (const model of selectedModels) {
      const supported = supportedLevels(model);
      const label = `${model.provider}/${model.id}`;

      if (supported.length === 0) {
        io.output.write(`${label}: no thinking (model does not support reasoning)\n`);
        reviewers.push({
          provider: model.provider,
          model: model.id,
          vendor: model.vendor,
          catalog: model,
          thinking: resolveThinking(model, {}),
        });
        continue;
      }

      const picked = await select<ThinkingLevel>(
        {
          message: `Thinking level for ${label}:`,
          choices: supported.map((level) => ({ value: level, name: level })),
        },
        promptContext(io),
      );

      reviewers.push({
        provider: model.provider,
        model: model.id,
        vendor: model.vendor,
        catalog: model,
        thinking: resolveThinking(model, { cliPin: picked }),
      });
    }

    return reviewers;
  } catch (err) {
    if (isCancellation(err)) {
      throw new PickerCancelled();
    }
    throw err;
  }
}
