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
import { styleText } from 'node:util';

import { Separator, checkbox, select } from '@inquirer/prompts';

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

function modelIdentity(m: CatalogModel): string {
  return `${m.provider}/${m.id}`;
}

function formatCostPair(m: CatalogModel): string {
  return `${formatCostRate(m.inputCostPerMTok)} in / ${formatCostRate(m.outputCostPerMTok)} out /Mtok`;
}

/**
 * Expanded detail for the highlighted row. `@inquirer/checkbox` renders only the active choice's
 * `description`, underneath the list — so the rows stay short enough to scan while the focused
 * model still shows its exact figures.
 */
function modelDetailLine(m: CatalogModel): string {
  const context = m.contextWindow === null ? '?' : `${m.contextWindow} tokens`;
  const maxOut = m.maxOutputTokens === null ? '?' : `${m.maxOutputTokens} tokens`;
  const thinking = m.reasoning ? 'supports thinking levels' : 'no thinking levels';
  return (
    `${modelIdentity(m)}  —  vendor ${m.vendor}, context ${context}, max output ${maxOut}, ` +
    `${formatCostPair(m)}, ${thinking}`
  );
}

// Identity/vendor column widths are capped so one very long `provider/id` cannot push every
// other row's specs off-screen; over-long entries simply overflow the column unaligned.
const MAX_IDENTITY_WIDTH = 48;
const MAX_VENDOR_WIDTH = 12;

export interface ModelChoice {
  value: string;
  name: string;
  description: string;
  short: string;
}

/**
 * Larger square checkbox glyphs (`☐`/`☑`) replacing the default small circles (`○`/`◉`) for
 * the picker's checkbox stages. The checked glyph keeps the default green via `node:util`'s
 * `styleText` — which, like the default theme, emits plain text when output is piped and color
 * only on a real terminal. Only `checked`/`unchecked` are overridden, so the cursor (`❯`) and
 * everything else stay on the inquirer defaults.
 */
export const pickerCheckboxTheme = {
  icon: {
    checked: styleText('green', '☑'),
    unchecked: '☐',
  },
};

export interface ModelGroup {
  provider: string;
  models: CatalogModel[];
}

/** Groups models by provider in first-appearance (catalog) order. */
export function groupModelsByProvider(models: readonly CatalogModel[]): ModelGroup[] {
  const groups = new Map<string, CatalogModel[]>();
  for (const m of models) {
    const group = groups.get(m.provider);
    if (group) {
      group.push(m);
    } else {
      groups.set(m.provider, [m]);
    }
  }
  return [...groups.entries()].map(([provider, groupModels]) => ({
    provider,
    models: groupModels,
  }));
}

/**
 * The model-stage prompt message doubles as the provider group header: inquirer renders the
 * message above the paginated list and never scrolls it, so the header stays pinned at the top
 * — visually distinct (prompt-message styling) and distanced (a blank spacer row follows it)
 * — no matter how far the rows scroll underneath.
 */
export function modelGroupMessage(provider: string, modelCount: number): string {
  const count = modelCount === 1 ? '1 model' : `${modelCount} models`;
  return `Select models for the panel — ${provider} (${count}):`;
}

/**
 * Builds one provider group's checkbox rows: one padded, single-line row per model, each
 * preceded by a blank `Separator` spacer (including the first, which distances the rows from
 * the header message). Padding lines up the identity and vendor columns so the rows stop
 * blurring into a wall of text. `short` stays the bare `provider/id` so the submitted answer
 * line reads cleanly. Widths are measured within the group since each group is its own prompt.
 *
 * Blank separators are skipped by checkbox navigation (up/down/space/number keys all ignore
 * them), so they are pure vertical air with no effect on selection.
 */
export function buildModelRows(models: readonly CatalogModel[]): Array<ModelChoice | Separator> {
  const identityWidth = Math.min(
    Math.max(0, ...models.map((m) => modelIdentity(m).length)),
    MAX_IDENTITY_WIDTH,
  );
  const vendorWidth = Math.min(
    Math.max(0, ...models.map((m) => m.vendor.length)),
    MAX_VENDOR_WIDTH,
  );

  const choices: Array<ModelChoice | Separator> = [];
  for (const m of models) {
    // A single space: renders as an empty line. (`new Separator('')` would fall back to
    // the default dashed line — the constructor ignores falsy values.)
    choices.push(new Separator(' '));
    const identity = modelIdentity(m);
    const specs =
      `${m.vendor.padEnd(vendorWidth)}  ·  ${formatTokenCount(m.contextWindow)} ctx  ·  ` +
      `${formatCostPair(m)}  ·  ${m.reasoning ? 'thinking' : 'no thinking'}`;
    choices.push({
      value: modelKey(m.provider, m.id),
      name: `${identity.padEnd(identityWidth)}  ${specs}`,
      description: modelDetailLine(m),
      short: identity,
    });
  }
  return choices;
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
 * Sentinel value for the thinking prompt's "back" choice. A plain string (rather than a
 * `Symbol`) so it flows through inquirer's generic `select<Value>` typing untouched; it can
 * never collide with a real pick because no `ThinkingLevel` equals it.
 */
export const THINKING_BACK_VALUE = '__council_thinking_back__' as const;

export type ThinkingPromptValue = ThinkingLevel | typeof THINKING_BACK_VALUE;

export interface ThinkingChoice {
  value: ThinkingPromptValue;
  name: string;
  short?: string;
}

/**
 * Builds one thinking prompt's choices: the model's supported levels, plus — when `prevLabel`
 * names a previous reasoning model — a trailing, separator-spaced "back" choice that returns to
 * it. The first reasoning model gets `prevLabel: null` and therefore no back choice. The back
 * choice goes last so the levels keep their positions (and existing key sequences still land on
 * the same level), and it names the model it returns to so the destination is unambiguous.
 */
export function buildThinkingChoices(
  supported: readonly ThinkingLevel[],
  prevLabel: string | null,
): Array<ThinkingChoice | Separator> {
  const choices: Array<ThinkingChoice | Separator> = supported.map((level) => ({
    value: level,
    name: level,
  }));
  if (prevLabel !== null) {
    // A single space: renders as an empty line. (`new Separator('')` would fall back to
    // the default dashed line — the constructor ignores falsy values.)
    choices.push(new Separator(' '));
    choices.push({
      value: THINKING_BACK_VALUE,
      name: `← Back (re-pick ${prevLabel})`,
      short: '← Back',
    });
  }
  return choices;
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
 * thinking" and skip the prompt entirely). From the second reasoning model on, each thinking
 * prompt offers a trailing "back" choice that returns to the previous reasoning model, so a
 * mis-picked level can be corrected without restarting selection; a re-visited prompt re-opens
 * on its previous pick. Throws `PickerNonInteractive` (exit code 2) without a terminal, before
 * any prompt runs, and `PickerCancelled` (exit code 2) if the user cancels at any stage.
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
        theme: pickerCheckboxTheme,
      },
      promptContext(io),
    );

    const scopedModels = catalog.models.filter((m) => selectedProviderIds.includes(m.provider));
    const modelGroups = groupModelsByProvider(scopedModels);
    if (modelGroups.length === 0) {
      throw new Error('picker: no models available for the selected providers');
    }

    // One checkbox prompt per provider group, with the group header as the prompt message.
    // The message is rendered above the paginated list and never scrolls, so the header stays
    // pinned at the top while the rows move beneath it.
    let selectedModelKeys: string[] = [];
    let modelsConfirmed = false;
    while (!modelsConfirmed) {
      selectedModelKeys = [];
      for (const group of modelGroups) {
        const keys = await checkbox<string>(
          {
            message: modelGroupMessage(group.provider, group.models.length),
            required: false,
            choices: buildModelRows(group.models),
            theme: pickerCheckboxTheme,
            // The rows scroll in a circle within their group; the header message stays put.
            loop: true,
            // Spacer rows roughly double the list height versus the default page size of 7; a
            // larger page keeps a modest panel on one screen instead of forcing paging.
            pageSize: 12,
          },
          promptContext(io),
        );
        selectedModelKeys.push(...keys);
      }
      // `required` cannot be per-group (a group may legitimately contribute nothing), so the
      // at-least-one-model invariant is enforced across all groups by re-running the stage.
      // Cancelling (Ctrl+C) still throws `PickerCancelled` from whichever prompt is active.
      modelsConfirmed = selectedModelKeys.length > 0;
      if (!modelsConfirmed) {
        io.output.write('Select at least one model for the panel.\n');
      }
    }

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

    // Thinking stage: an index-driven loop (rather than a for-of) so "back" can move the
    // cursor to the previous *reasoning* model, skipping non-reasoning selections, which never
    // prompt. Picks live in a map so a re-visited prompt re-opens on its previous pick via
    // `default`, and "no thinking" announcements print once even when backtracking passes over a
    // non-reasoning selection again. Reviewers are built after the loop, in selection order.
    const thinkingPicks = new Map<number, ThinkingLevel>();
    const announcedNoThinking = new Set<number>();
    let index = 0;
    while (index < selectedModels.length) {
      const model = selectedModels[index]!;
      const supported = supportedLevels(model);
      const label = `${model.provider}/${model.id}`;

      if (supported.length === 0) {
        if (!announcedNoThinking.has(index)) {
          io.output.write(`${label}: no thinking (model does not support reasoning)\n`);
          announcedNoThinking.add(index);
        }
        index += 1;
        continue;
      }

      let prevIndex: number | null = null;
      for (let j = index - 1; j >= 0; j--) {
        if (supportedLevels(selectedModels[j]!).length > 0) {
          prevIndex = j;
          break;
        }
      }
      const prevLabel =
        prevIndex === null
          ? null
          : `${selectedModels[prevIndex]!.provider}/${selectedModels[prevIndex]!.id}`;
      const previousPick = thinkingPicks.get(index);

      const picked = await select<ThinkingPromptValue>(
        {
          message: `Thinking level for ${label}:`,
          choices: buildThinkingChoices(supported, prevLabel),
          ...(previousPick !== undefined ? { default: previousPick } : {}),
        },
        promptContext(io),
      );

      if (picked === THINKING_BACK_VALUE) {
        // `prevIndex` is non-null whenever the back choice was offered; the fallback keeps
        // the loop total rather than asserted.
        index = prevIndex ?? Math.max(0, index - 1);
        continue;
      }

      thinkingPicks.set(index, picked);
      index += 1;
    }

    const reviewers: Reviewer[] = selectedModels.map((model, i) => {
      const pin = thinkingPicks.get(i);
      return {
        provider: model.provider,
        model: model.id,
        vendor: model.vendor,
        catalog: model,
        thinking: resolveThinking(model, pin === undefined ? {} : { cliPin: pin }),
      };
    });

    return reviewers;
  } catch (err) {
    if (isCancellation(err)) {
      throw new PickerCancelled();
    }
    throw err;
  }
}
