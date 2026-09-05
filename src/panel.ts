/**
 * Assembles the set of reviewers for a run — from a saved config panel or from a command-line
 * spec — and the vendor-independence guard that refuses a panel whose members would fail in
 * correlated ways. See `openspec/changes/add-council-review/specs/council-review/panel-
 * selection/spec.md` for the requirements this implements.
 *
 * This module never spawns anything and never prompts; `picker.ts` (interactive selection) and
 * `cli.ts` (dispatch and exit-code mapping) sit on top of it.
 */
import picomatch from 'picomatch';

import type { CouncilConfig, PanelEntry } from './config.js';
import { isThinkingLevel, type ThinkingLevel } from './levels.js';
import { findModel, type Catalog, type CatalogModel } from './providers.js';
import { resolveThinking, type ResolvedThinking, type ThinkingSources } from './thinking.js';

export interface Reviewer {
  provider: string;
  model: string; // catalog model id
  vendor: string;
  catalog: CatalogModel;
  thinking: ResolvedThinking;
}

export class PanelError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = 'PanelError';
    Object.setPrototypeOf(this, PanelError.prototype);
  }
}

export class GuardRefusal extends Error {
  readonly exitCode = 4 as const;
  readonly vendors: Map<string, string[]>;

  constructor(message: string, vendors: Map<string, string[]>) {
    super(message);
    this.name = 'GuardRefusal';
    this.vendors = vendors;
    Object.setPrototypeOf(this, GuardRefusal.prototype);
  }
}

// -------------------------------------------------------------------------------------------
// Entry parsing
// -------------------------------------------------------------------------------------------

type ParsedEntry = { provider: string; model: string; pin?: ThinkingLevel };

/**
 * Splits a trailing `:level` pin off `raw` on the LAST colon. A colon that is present but whose
 * suffix is not a recognised thinking level is a parse error (rather than being silently
 * ignored), because the last-colon rule is unconditional: any entry with a colon is asserting a
 * pin. `label` is what the thrown error names — the original, untrimmed entry text.
 */
function splitTrailingPin(raw: string, label: string): { rest: string; pin?: ThinkingLevel } {
  const lastColon = raw.lastIndexOf(':');
  if (lastColon === -1) return { rest: raw };

  const candidate = raw.slice(lastColon + 1);
  if (!isThinkingLevel(candidate)) {
    throw new PanelError(`could not parse panel entry: ${JSON.stringify(label)}`);
  }
  return { rest: raw.slice(0, lastColon), pin: candidate };
}

/**
 * Parses one `provider/modelId[:level]` entry. The pin is split on the last colon (see
 * `splitTrailingPin`); everything before it is `provider/modelId`, split on the FIRST slash —
 * this is what tolerates a model id that itself contains slashes (the entire remainder becomes
 * the model id) and one that carries a leading prefix marker (carried through unmodified; vendor
 * derivation in `providers.ts` is what strips it, not this parser).
 */
export function parsePanelEntry(entry: string): ParsedEntry {
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    throw new PanelError(`could not parse panel entry: ${JSON.stringify(entry)}`);
  }

  const { rest, pin } = splitTrailingPin(trimmed, entry);

  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0 || slashIdx === rest.length - 1) {
    throw new PanelError(`could not parse panel entry: ${JSON.stringify(entry)}`);
  }

  const provider = rest.slice(0, slashIdx);
  const model = rest.slice(slashIdx + 1);
  return pin === undefined ? { provider, model } : { provider, model, pin };
}

// -------------------------------------------------------------------------------------------
// Glob expansion
// -------------------------------------------------------------------------------------------

/** Characters that mark an entry's `provider/modelId` portion as a glob pattern rather than a
 * literal id. Plain ids never contain these (host ids are alphanumerics plus `.`, `-`, `_`, `/`,
 * `~`), so their presence is an unambiguous signal to expand rather than look up directly. */
const GLOB_CHAR_RE = /[*?[\]{}]/;

/**
 * Expands one comma-separated `--models` spec against the catalog. A literal (non-glob) entry is
 * looked up directly and must name a real catalog model, or it errors naming the offending
 * entry. A glob entry is matched against every catalog model's `provider/id`, must match at
 * least one, and every match inherits the pattern's own pin.
 */
export function expandPanelSpec(spec: string, catalog: Catalog): ParsedEntry[] {
  const results: ParsedEntry[] = [];

  for (const rawEntry of spec.split(',')) {
    const entry = rawEntry.trim();
    if (entry.length === 0) continue;

    const { rest, pin } = splitTrailingPin(entry, entry);

    if (!GLOB_CHAR_RE.test(rest)) {
      const parsed = parsePanelEntry(entry);
      const found = findModel(catalog, parsed.provider, parsed.model);
      if (!found) {
        throw new PanelError(
          `panel entry names an unknown provider or model: ${JSON.stringify(entry)}`,
        );
      }
      results.push(parsed);
      continue;
    }

    const isMatch = picomatch(rest, { dot: true });
    const matches = catalog.models.filter((m) => isMatch(`${m.provider}/${m.id}`));
    if (matches.length === 0) {
      throw new PanelError(`glob pattern matched no catalog model: ${JSON.stringify(rest)}`);
    }
    for (const m of matches) {
      results.push(
        pin === undefined
          ? { provider: m.provider, model: m.id }
          : { provider: m.provider, model: m.id, pin },
      );
    }
  }

  return results;
}

// -------------------------------------------------------------------------------------------
// Duplicate collapsing
// -------------------------------------------------------------------------------------------

/**
 * Collapses `entries` that name the same `provider/model` down to one, at the position of their
 * FIRST occurrence but carrying the value of their LAST occurrence. A duplicated panel entry is
 * always a mistake, never a deliberate choice — reviewing the same model twice adds no
 * independence, but it does spawn the host twice (paying twice for one model's worth of signal),
 * and because a reviewer's on-disk artifacts are named from a hash of `provider/model`, the
 * second spawn silently overwrites the first's `.text.md`/`.findings.json`/`.trace.jsonl` while
 * the manifest still claims both ran. The most common way to hit this isn't a literal repeated
 * entry — it's a glob (`opencode-go/qwen3.8-*`) that happens to also match a model named
 * explicitly elsewhere in the same spec, so this must run on the fully-expanded entry list, not
 * just reject literal repeats.
 *
 * "Last occurrence wins" for the entry's own value mirrors `resolveThinking`'s own precedence
 * rule elsewhere in this file: when a model is named more than once with conflicting per-entry
 * pins (`foo/bar:low,foo/bar:high`), the later one is treated as a correction of the earlier one
 * — the user's final word — not as a note to silently discard. `Map#set` gives us exactly this
 * for free: re-setting an already-present key overwrites its value but leaves its original
 * iteration position untouched, so the loop below is the entire implementation.
 *
 * This must run BEFORE the independence guard (`enforceIndependence`) sees the result — both
 * `resolveSpecPanel` and `resolveConfiguredPanel` call this ahead of `buildReviewer` for exactly
 * that reason, so `--models 'a,a,a'` is correctly refused as one model, not admitted as three.
 */
function collapseDuplicates<T>(entries: readonly T[], keyOf: (entry: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const entry of entries) {
    byKey.set(keyOf(entry), entry);
  }
  return Array.from(byKey.values());
}

// -------------------------------------------------------------------------------------------
// Reviewer assembly
// -------------------------------------------------------------------------------------------

function buildReviewer(model: CatalogModel, sources: ThinkingSources): Reviewer {
  return {
    provider: model.provider,
    model: model.id,
    vendor: model.vendor,
    catalog: model,
    thinking: resolveThinking(model, sources),
  };
}

/**
 * Resolves a saved config panel into reviewers. Every entry's model must still be present in the
 * catalog and its provider must still be ready — either failure is a `PanelError` naming the
 * entry, per the "A saved panel entry no longer exists" and "A configured model belongs to an
 * unready provider" scenarios. Each entry's own saved `thinking` and the general
 * `modelThinkingLevels` map both occupy the "configured per-model" precedence tier; the general
 * map wins when both name the same model, since it is the more deliberate, hand-editable source.
 */
export function resolveConfiguredPanel(
  panel: readonly PanelEntry[],
  catalog: Catalog,
  cfg: CouncilConfig,
  cliPanelWide?: ThinkingLevel,
): Reviewer[] {
  const deduped = collapseDuplicates(panel, (entry) => `${entry.provider}/${entry.model}`);
  return deduped.map((entry) => {
    const model = findModel(catalog, entry.provider, entry.model);
    if (!model) {
      throw new PanelError(
        `configured panel entry names a model absent from the catalog: ${entry.provider}/${entry.model}. ` +
          'Re-run selection to update the saved panel.',
      );
    }

    const providerInfo = catalog.providers.find((p) => p.id === entry.provider);
    if (!providerInfo || !providerInfo.ready) {
      const reason = providerInfo?.reason ? ` (${providerInfo.reason})` : '';
      throw new PanelError(
        `configured panel entry's provider "${entry.provider}" is not ready${reason}: ` +
          `${entry.provider}/${entry.model}`,
      );
    }

    const key = `${entry.provider}/${entry.model}`;
    return buildReviewer(model, {
      cliPanelWide,
      configPerModel: cfg.modelThinkingLevels?.[key] ?? entry.thinking,
      configDefault: cfg.defaultThinkingLevel,
    });
  });
}

/** Resolves a `--models` command-line spec into reviewers. Each entry's own `:level` pin, if
 * any, is that model's CLI pin — the most specific source in the precedence chain. */
export function resolveSpecPanel(
  spec: string,
  catalog: Catalog,
  cfg: CouncilConfig,
  cliPanelWide?: ThinkingLevel,
): Reviewer[] {
  const expanded = expandPanelSpec(spec, catalog);
  const deduped = collapseDuplicates(expanded, (entry) => `${entry.provider}/${entry.model}`);
  return deduped.map((entry) => {
    const model = findModel(catalog, entry.provider, entry.model);
    if (!model) {
      // expandPanelSpec already validated existence for every entry it returns; this only
      // guards against a future caller feeding pre-expanded entries in directly.
      throw new PanelError(
        `panel entry names an unknown provider or model: ${entry.provider}/${entry.model}`,
      );
    }

    const key = `${entry.provider}/${entry.model}`;
    return buildReviewer(model, {
      cliPin: entry.pin,
      cliPanelWide,
      configPerModel: cfg.modelThinkingLevels?.[key],
      configDefault: cfg.defaultThinkingLevel,
    });
  });
}

// -------------------------------------------------------------------------------------------
// Vendor-independence guard
// -------------------------------------------------------------------------------------------

const MIN_MODELS = 3;
const MIN_VENDORS = 3;

export interface GuardResult {
  ok: boolean;
  vendors: Map<string, string[]>;
  reason?: string;
}

/**
 * Groups `reviewers` by derived vendor and checks the independence minimums: at least three
 * models across at least three distinct vendors. `unknown` is one legitimate vendor bucket like
 * any other — several unrecognised models collapse into it exactly as several recognised models
 * from the same real vendor would, per design.md's "`unknown` is not treated as benign" (the
 * point there is that `unknown` is admitted rather than rejected, not that it is exempt from
 * collapsing). The model-count check runs first so its message doesn't get crowded out by a
 * vendor-count message that would be equally true of a too-small panel.
 */
export function checkIndependence(reviewers: readonly Reviewer[]): GuardResult {
  const vendors = new Map<string, string[]>();
  for (const r of reviewers) {
    const key = `${r.provider}/${r.model}`;
    const existing = vendors.get(r.vendor);
    if (existing) {
      existing.push(key);
    } else {
      vendors.set(r.vendor, [key]);
    }
  }

  if (reviewers.length < MIN_MODELS) {
    return {
      ok: false,
      vendors,
      reason: `panel holds ${reviewers.length} model(s); at least ${MIN_MODELS} are required`,
    };
  }

  if (vendors.size < MIN_VENDORS) {
    return {
      ok: false,
      vendors,
      reason:
        `panel resolves to ${vendors.size} distinct vendor(s) (${MIN_VENDORS} required): ` +
        formatVendorGrouping(vendors),
    };
  }

  return { ok: true, vendors };
}

/** Formats a vendor grouping as `vendor: member, member (n)` lines, for printing on refusal or
 * before launch. Singleton groups are included too, so the full picture is visible at a glance. */
export function formatVendorGrouping(vendors: ReadonlyMap<string, string[]>): string {
  return Array.from(vendors.entries())
    .map(([vendor, members]) => `${vendor}: ${members.join(', ')}`)
    .join('\n');
}

/**
 * Enforces the independence guard. Throws `GuardRefusal` (exit code 4) when the panel fails the
 * guard and `allowCorrelated` is false. Stateless and cheap to call twice — at the end of
 * selection and again immediately before launch — which is how a panel that reached
 * configuration by hand-editing (never passing through the picker) still gets checked.
 */
export function enforceIndependence(
  reviewers: readonly Reviewer[],
  allowCorrelated: boolean,
): void {
  const result = checkIndependence(reviewers);
  if (!result.ok && !allowCorrelated) {
    throw new GuardRefusal(result.reason ?? 'panel failed the independence guard', result.vendors);
  }
}
