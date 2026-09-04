/**
 * Thinking-level support computation, precedence resolution and clamping.
 *
 * See `openspec/changes/add-council-review/specs/council-review/model-discovery/spec.md`'s
 * "Thinking-level support computation" requirement and `.../panel-selection/spec.md`'s
 * "Thinking-level precedence" and "Clamping an unsupported level" requirements for what this
 * module implements, and `design.md`'s "Thinking levels are clamped, not rejected" for why.
 *
 * This module never computes, stores or passes a numeric thinking-budget value: the host's
 * vocabulary is the closed seven-level string enum in `./levels.js`, and nothing here widens it.
 */
import { THINKING_LEVELS, type ThinkingLevel } from './levels.js';
import type { CatalogModel } from './providers.js';

/**
 * Levels the provider-default fallback marks unsupported when a `thinkingLevelMap` key is
 * absent — whether the whole map is absent, or only this one key is missing from an otherwise
 * partially specified map (see the "Level absent from a partially specified map" scenario).
 * `off` through `high` fall back to supported; only these two do not.
 */
const FALLBACK_UNSUPPORTED: ReadonlySet<ThinkingLevel> = new Set(['xhigh', 'max']);

/**
 * Whether `level` is supported by a model whose tristate map is `map`, applying the absent-key
 * fallback uniformly whether the whole map is `undefined` or just this key is missing from it.
 * This is the one place that fallback logic lives, so the Section 18 live check can amend it
 * cheaply if it turns out not to apply per-key inside a partial map (see design.md's "Open
 * Questions" / Risks entry on this).
 */
function isLevelSupported(level: ThinkingLevel, map: CatalogModel['thinkingLevelMap']): boolean {
  if (map !== undefined && Object.prototype.hasOwnProperty.call(map, level)) {
    // A string value means supported (its content is the host's own internal mapping and is
    // never our concern); an explicit `null` means unsupported.
    return map[level] !== null;
  }
  return !FALLBACK_UNSUPPORTED.has(level);
}

/**
 * The thinking levels `m` supports, in ascending order. Empty for a model whose `reasoning` flag
 * is falsy — such a model supports no thinking levels at all, not even `off`.
 */
export function supportedLevels(m: CatalogModel): ThinkingLevel[] {
  if (!m.reasoning) return [];
  return THINKING_LEVELS.filter((level) => isLevelSupported(level, m.thinkingLevelMap));
}

export interface ThinkingSources {
  cliPin?: ThinkingLevel; // per-model pin from --models entry
  cliPanelWide?: ThinkingLevel; // --thinking
  configPerModel?: ThinkingLevel; // config.modelThinkingLevels['provider/modelId']
  configDefault?: ThinkingLevel; // config.defaultThinkingLevel
}

export interface ResolvedThinking {
  applicable: boolean; // false for non-reasoning models
  requested: ThinkingLevel | null; // null === "no level at all" (distinct from any level)
  effective: ThinkingLevel | null; // null === send no thinking selection to the host
  clamped: boolean; // effective !== requested
}

/**
 * The five-step precedence chain: per-model CLI pin, then panel-wide CLI flag, then configured
 * per-model level, then configured default, then — distinctly from any of those — nothing at
 * all. `null` here is a real outcome, not an absence to paper over: it means the host's own
 * default thinking level governs because this tool sends no `--thinking` flag whatsoever.
 */
function resolveRequested(sources: ThinkingSources): ThinkingLevel | null {
  return (
    sources.cliPin ??
    sources.cliPanelWide ??
    sources.configPerModel ??
    sources.configDefault ??
    null
  );
}

/**
 * Clamps `level` to the nearest level in `supported`, measured by ordinal distance along
 * `THINKING_LEVELS`. Ties (a requested level equidistant from a supported level above and one
 * below) resolve to the lower level. Returns `null` only when `supported` is empty — callers
 * only reach that case for a non-reasoning model, which `resolveThinking` short-circuits before
 * calling this at all.
 */
export function clampLevel(
  level: ThinkingLevel,
  supported: readonly ThinkingLevel[],
): ThinkingLevel | null {
  if (supported.length === 0) return null;
  if (supported.includes(level)) return level;

  const targetIdx = THINKING_LEVELS.indexOf(level);
  let best: ThinkingLevel | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of supported) {
    const candidateIdx = THINKING_LEVELS.indexOf(candidate);
    const distance = Math.abs(candidateIdx - targetIdx);
    const closer = distance < bestDistance;
    // On a tie, prefer the lower ordinal — this comparison is against the current best rather
    // than depending on `supported`'s iteration order, so the tie-break holds regardless of how
    // callers order that array.
    const tieBreaksLower =
      distance === bestDistance && best !== null && candidateIdx < THINKING_LEVELS.indexOf(best);
    if (closer || tieBreaksLower) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * Resolves one reviewer's effective thinking level: precedence, then clamping, then the record
 * of both requested and effective needed to explain an unexpectedly shallow review after the
 * fact. Non-reasoning models ignore every source in `sources` — nothing is requested and nothing
 * is sent, per the "Non-reasoning model ignores every source" scenario.
 */
export function resolveThinking(model: CatalogModel, sources: ThinkingSources): ResolvedThinking {
  const supported = supportedLevels(model);

  if (supported.length === 0) {
    return { applicable: false, requested: null, effective: null, clamped: false };
  }

  const requested = resolveRequested(sources);
  if (requested === null) {
    return { applicable: true, requested: null, effective: null, clamped: false };
  }

  const effective = clampLevel(requested, supported);
  return { applicable: true, requested, effective, clamped: effective !== requested };
}

/**
 * Formats the run-time notice for a reviewer whose effective level diverges from what was
 * requested. Returns `null` when there is nothing to report, so callers can filter without
 * re-checking `thinking.clamped` themselves. Deliberately just a formatter — printing happens at
 * the call site (the runner's progress output and the manifest writer), never from in here.
 */
export function formatClampNotice(
  reviewerLabel: string,
  thinking: ResolvedThinking,
): string | null {
  if (!thinking.clamped) return null;
  return `${reviewerLabel}: requested thinking level "${thinking.requested}" is not supported; using "${thinking.effective}" instead`;
}
