/**
 * Model discovery and vendor mapping.
 *
 * Reads the review agent host's model catalog (or, failing that, its model-listing command) to
 * learn which providers and models are available, without ever making a model call and without
 * ever opening the host's credential store. See `openspec/changes/add-council-review/specs/
 * council-review/model-discovery/spec.md` for the requirements this module satisfies.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { ThinkingLevel } from './levels.js';
import { isThinkingLevel } from './levels.js';

export interface CatalogModel {
  id: string; // host model id; may contain '/' and a leading prefix marker
  name: string;
  provider: string; // gateway id, e.g. 'openrouter'
  vendor: string; // derived; 'unknown' when underivable
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputCostPerMTok: number | null; // USD per 1M input tokens
  outputCostPerMTok: number | null;
  reasoning: boolean;
  thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>> | undefined;
}

export interface ProviderInfo {
  id: string;
  ready: boolean;
  authType: string | null;
  reason: string | null; // why not ready
  modelCount: number;
}

export interface Catalog {
  providers: ProviderInfo[];
  models: CatalogModel[]; // ready providers only are marked; see readyModels()
  skipped: number; // malformed entries omitted
  source: 'store' | 'listing';
}

export interface DiscoveryOptions {
  vendorOverrides?: Record<string, string>; // key: 'provider/modelId'
  homeDir?: string; // test seam; defaults to os.homedir()
  piBin?: string; // test seam; defaults to COUNCIL_PI_BIN ?? 'pi'
}

export class DiscoveryError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

// ---------------------------------------------------------------------------------------------
// Vendor derivation
// ---------------------------------------------------------------------------------------------

/**
 * Shipped, non-user-editable prefix table for flat-id gateways (a model id with no `/`). Built
 * from real vendor families observed across the catalog: several ids per vendor may match, so
 * this is a list of (prefix, vendor) pairs rather than a 1:1 map. Matching is longest-prefix-
 * first, case-insensitive, against the whole flat id (not a token match), because ids like
 * `qwen3.6-plus` and `glm-5.2` glue a version straight onto the family name with no separator.
 */
type VendorPrefixEntry = readonly [prefix: string, vendor: string];

const VENDOR_PREFIX_TABLE: readonly VendorPrefixEntry[] = (
  [
    ['anthropic', 'anthropic'],
    ['claude', 'anthropic'],
    ['openai', 'openai'],
    ['gpt', 'openai'],
    ['codex', 'openai'],
    ['o1', 'openai'],
    ['o3', 'openai'],
    ['google', 'google'],
    ['gemini', 'google'],
    ['meta', 'meta'],
    ['llama', 'meta'],
    ['mistral', 'mistral'],
    ['deepseek', 'deepseek'],
    ['qwen', 'qwen'],
    ['minimax', 'minimax'],
    ['moonshot', 'moonshot'],
    ['kimi', 'moonshot'],
    ['xai', 'xai'],
    ['grok', 'xai'],
    ['cohere', 'cohere'],
    ['amazon', 'amazon'],
    ['nova', 'amazon'],
    ['zhipu', 'zhipu'],
    ['glm', 'zhipu'],
  ] satisfies VendorPrefixEntry[]
)
  .slice()
  .sort((a, b) => b[0].length - a[0].length);

/** Strips a leading run of punctuation/sigil characters some gateways prepend to an id. */
function stripPrefixMarker(segment: string): string {
  return segment.replace(/^[^a-zA-Z0-9]+/, '');
}

function matchPrefixTable(modelId: string): string | null {
  const lower = modelId.toLowerCase();
  for (const [prefix, vendor] of VENDOR_PREFIX_TABLE) {
    if (lower.startsWith(prefix)) return vendor;
  }
  return null;
}

export function deriveVendor(
  provider: string,
  modelId: string,
  overrides: Record<string, string>,
): string {
  const overrideKey = `${provider}/${modelId}`;
  if (Object.prototype.hasOwnProperty.call(overrides, overrideKey)) {
    return overrides[overrideKey] as string;
  }

  const slashIdx = modelId.indexOf('/');
  if (slashIdx > 0) {
    const leading = stripPrefixMarker(modelId.slice(0, slashIdx));
    if (leading.length > 0) return leading;
  }

  const flatVendor = matchPrefixTable(modelId);
  if (flatVendor) return flatVendor;

  return 'unknown';
}

/** vendor -> ['provider/modelId', ...]; only groups with >1 member matter to callers, but return all. */
export function collapsedVendorGroups(models: readonly CatalogModel[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const model of models) {
    const key = `${model.provider}/${model.id}`;
    const existing = groups.get(model.vendor);
    if (existing) {
      existing.push(key);
    } else {
      groups.set(model.vendor, [key]);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------
// Catalog store parsing (primary source)
// ---------------------------------------------------------------------------------------------

interface RawStoreModel {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: unknown;
  cost?: { input?: unknown; output?: unknown } | unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
}

interface RawStoreFile {
  [provider: string]: { models?: unknown } | unknown;
}

function toNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Like `toNumberOrNull`, but additionally rejects a negative value. A per-token rate cannot
 * legitimately be negative — some gateways (observed: OpenRouter's `auto`/`auto-beta` routing
 * models) store a large negative number (e.g. `-1000000`) as a sentinel for "dynamic pricing,
 * no fixed rate exists", rather than omitting `cost` outright. Passing that through as a real
 * rate would compute a negative run cost and make a "cheapest first" ranking pick it every
 * time, so it is treated exactly like an absent rate: unknown, mapped to `null`.
 */
function toCostRateOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function toThinkingLevelMap(v: unknown): Partial<Record<ThinkingLevel, string | null>> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: Partial<Record<ThinkingLevel, string | null>> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (!isThinkingLevel(key)) continue;
    if (value === null) {
      out[key] = null;
    } else if (typeof value === 'string') {
      out[key] = value;
    }
    // Any other shape for this key is ignored rather than propagated as garbage.
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// `models.json` — layered over the store before it is turned into CatalogModels
// ---------------------------------------------------------------------------------------------
//
// The host does not run purely off `models-store.json`: `~/.pi/agent/models.json` is applied on
// top of it before the host ever presents a model list. Two independent shapes were verified
// directly against the host's own merge code (`applyModelsJson` / `applyModelOverride` in the
// installed `pi` bundle), and are replicated here exactly:
//
//  1. `providers[p].models[]` — each entry is a full model *definition*. If its `id` already
//     exists among that provider's models, it REPLACES the existing entry outright (built fresh
//     from the definition, defaulting `reasoning` to `false`, `cost` to zeros, `contextWindow`
//     to 128000 and `maxTokens` to 16384 when the definition omits them — it does NOT inherit
//     those fields from the entry it replaces). If the id is new, it is appended. Order matters:
//     this step runs BEFORE `modelOverrides` below, so an override can still target a model this
//     step just added or replaced.
//  2. `providers[p].modelOverrides[id]` — a partial patch applied to whichever model (store- or
//     `models[]`-derived) already carries that exact id. It is a no-op for an id that matches
//     nothing. `thinkingLevelMap` is shallow-merged onto the existing map (`{...existing,
//     ...override}`); every other field is `override.field ?? existing.field`.
//
// A missing or malformed `models.json` is non-fatal — the store is then used unmodified, the
// same way a corrupt `models-store.json` itself falls back to the listing command.

interface RawModelOverride {
  name?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: unknown;
  cost?: { input?: unknown; output?: unknown } | unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
}

interface RawModelDefinition {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: unknown;
  cost?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
}

interface RawProviderModelsConfig {
  modelOverrides?: Record<string, unknown>;
  models?: unknown;
}

interface RawModelsJsonFile {
  providers?: Record<string, unknown>;
}

/** `override.field ?? existing.field` merge, mirroring the host's `applyModelOverride`. */
function applyRawModelOverride(model: RawStoreModel, overrideUnknown: unknown): RawStoreModel {
  const override = overrideUnknown as RawModelOverride;

  const existingCost =
    typeof model.cost === 'object' && model.cost !== null
      ? (model.cost as { input?: unknown; output?: unknown })
      : undefined;
  const overrideCost =
    typeof override.cost === 'object' && override.cost !== null
      ? (override.cost as { input?: unknown; output?: unknown })
      : undefined;

  const existingMap =
    typeof model.thinkingLevelMap === 'object' && model.thinkingLevelMap !== null
      ? (model.thinkingLevelMap as Record<string, unknown>)
      : undefined;
  const overrideMap =
    typeof override.thinkingLevelMap === 'object' && override.thinkingLevelMap !== null
      ? (override.thinkingLevelMap as Record<string, unknown>)
      : undefined;

  return {
    ...model,
    name:
      typeof override.name === 'string' && override.name.length > 0 ? override.name : model.name,
    reasoning: override.reasoning ?? model.reasoning,
    thinkingLevelMap: overrideMap ? { ...existingMap, ...overrideMap } : model.thinkingLevelMap,
    cost: overrideCost
      ? {
          input: overrideCost.input ?? existingCost?.input,
          output: overrideCost.output ?? existingCost?.output,
        }
      : model.cost,
    contextWindow: override.contextWindow ?? model.contextWindow,
    maxTokens: override.maxTokens ?? model.maxTokens,
  };
}

/** Builds a fresh raw model entry from a `models[]` definition, mirroring `modelFromJson`. */
function rawModelFromDefinition(
  providerId: string,
  definitionUnknown: unknown,
): RawStoreModel | null {
  const definition = definitionUnknown as RawModelDefinition;
  if (typeof definition.id !== 'string' || definition.id.length === 0) return null;

  return {
    id: definition.id,
    name:
      typeof definition.name === 'string' && definition.name.length > 0
        ? definition.name
        : definition.id,
    provider: providerId,
    reasoning: definition.reasoning ?? false,
    thinkingLevelMap: definition.thinkingLevelMap,
    cost: (definition.cost as RawStoreModel['cost']) ?? { input: 0, output: 0 },
    contextWindow: definition.contextWindow ?? 128_000,
    maxTokens: definition.maxTokens ?? 16_384,
  };
}

/** Applies one provider's `models.json` config over that provider's raw store models. */
function mergeProviderModelsJson(
  providerId: string,
  baseModelsUnknown: readonly unknown[],
  configUnknown: unknown,
): RawStoreModel[] {
  let models: RawStoreModel[] = baseModelsUnknown.map((m) => ({ ...(m as RawStoreModel) }));
  const config = configUnknown as RawProviderModelsConfig;

  const definitions = Array.isArray(config.models) ? config.models : [];
  for (const rawDefinition of definitions) {
    const built = rawModelFromDefinition(providerId, rawDefinition);
    if (built === null) continue; // malformed models.json definition (no id) — dropped
    const existingIndex = models.findIndex((m) => m.id === built.id);
    if (existingIndex >= 0) {
      models[existingIndex] = built;
    } else {
      models.push(built);
    }
  }

  const overrides = config.modelOverrides;
  if (overrides && typeof overrides === 'object') {
    models = models.map((m) => {
      if (typeof m.id !== 'string') return m;
      const override = (overrides as Record<string, unknown>)[m.id];
      return override !== undefined ? applyRawModelOverride(m, override) : m;
    });
  }

  return models;
}

/**
 * Layers a parsed `models.json` document over a parsed `models-store.json` document, producing
 * a store-shaped document that `catalogFromStore` can consume unchanged. `modelsJson === null`
 * (missing or malformed) returns `store` untouched.
 */
function mergeModelsJson(store: RawStoreFile, modelsJson: RawModelsJsonFile | null): RawStoreFile {
  const providerConfigs = modelsJson?.providers;
  if (!providerConfigs || typeof providerConfigs !== 'object') return store;

  const merged: RawStoreFile = { ...store };
  const providerIds = new Set<string>([...Object.keys(store), ...Object.keys(providerConfigs)]);

  for (const providerId of providerIds) {
    const config = providerConfigs[providerId];
    if (config === undefined) continue; // no models.json entry for this provider — store stands as-is

    const storeBlock = store[providerId] as { models?: unknown } | undefined;
    const baseModels = Array.isArray(storeBlock?.models) ? storeBlock.models : [];
    merged[providerId] = { models: mergeProviderModelsJson(providerId, baseModels, config) };
  }

  return merged;
}

async function loadModelsJson(homeDir: string): Promise<RawModelsJsonFile | null> {
  const modelsJsonPath = join(homeDir, '.pi', 'agent', 'models.json');
  let text: string;
  try {
    text = await readFile(modelsJsonPath, 'utf8');
  } catch {
    return null; // missing (or unreadable) — the store is used unmodified
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as RawModelsJsonFile;
  } catch {
    return null; // corrupt models.json — treated the same as "absent"
  }
}

/**
 * Builds catalog models from an already-parsed `models-store.json` document, skipping malformed
 * entries individually. Returns the usable models plus how many entries were skipped.
 */
function catalogFromStore(
  store: RawStoreFile,
  overrides: Record<string, string>,
): { models: CatalogModel[]; skipped: number } {
  const models: CatalogModel[] = [];
  let skipped = 0;

  for (const providerBlock of Object.values(store)) {
    if (typeof providerBlock !== 'object' || providerBlock === null) continue;
    const rawModels = (providerBlock as { models?: unknown }).models;
    if (!Array.isArray(rawModels)) continue;

    for (const entryUnknown of rawModels) {
      const entry = entryUnknown as RawStoreModel;
      const id = entry.id;
      const name = entry.name;
      const provider = entry.provider;

      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        typeof name !== 'string' ||
        name.length === 0 ||
        typeof provider !== 'string' ||
        provider.length === 0
      ) {
        skipped += 1;
        continue;
      }

      const cost =
        typeof entry.cost === 'object' && entry.cost !== null
          ? (entry.cost as { input?: unknown; output?: unknown })
          : undefined;

      models.push({
        id,
        name,
        provider,
        vendor: deriveVendor(provider, id, overrides),
        contextWindow: toNumberOrNull(entry.contextWindow),
        maxOutputTokens: toNumberOrNull(entry.maxTokens),
        inputCostPerMTok: toCostRateOrNull(cost?.input),
        outputCostPerMTok: toCostRateOrNull(cost?.output),
        reasoning: Boolean(entry.reasoning),
        thinkingLevelMap: toThinkingLevelMap(entry.thinkingLevelMap),
      });
    }
  }

  return { models, skipped };
}

// ---------------------------------------------------------------------------------------------
// Fallback: `--list-models` output parsing
// ---------------------------------------------------------------------------------------------

interface ListedModel {
  provider: string;
  id: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  reasoning: boolean;
}

/**
 * Parses a size column like `204.8K`, `1.0M` or a bare integer into a token count. The host
 * renders these already rounded, so the result is approximate — this is the fallback path, used
 * only when the catalog store is unavailable.
 */
function parseSizeToken(token: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)([KM])?$/i.exec(token);
  if (!match) return null;
  const value = Number.parseFloat(match[1] as string);
  const suffix = match[2]?.toUpperCase();
  if (suffix === 'K') return Math.round(value * 1_000);
  if (suffix === 'M') return Math.round(value * 1_000_000);
  return Math.round(value);
}

/**
 * Parses the plain-text table printed by `pi --list-models`. Only lines matching the exact
 * six-column data shape (provider, model, context, max-out, thinking, images) after the header
 * are treated as models; everything else — the header itself, blank lines, and extension banner
 * lines printed at startup (which happen to also tokenize into a handful of words) — is dropped
 * silently, because banner lines never carry a `yes`/`no` thinking column.
 */
export function parseListModelsOutput(text: string): ListedModel[] {
  const out: ListedModel[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const tokens = line.split(/\s+/);
    if (tokens.length !== 6) continue;

    const [provider, id, contextTok, maxOutTok, thinkingTok] = tokens as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    if (provider.toLowerCase() === 'provider') continue; // header row
    if (/[[\]]/.test(provider) || /[[\]]/.test(id)) continue; // e.g. "[Playwright" banner tokens

    const thinkingLower = thinkingTok.toLowerCase();
    if (thinkingLower !== 'yes' && thinkingLower !== 'no') continue;

    out.push({
      provider,
      id,
      contextWindow: parseSizeToken(contextTok),
      maxOutputTokens: parseSizeToken(maxOutTok),
      reasoning: thinkingLower === 'yes',
    });
  }

  return out;
}

function listedModelsToCatalogModels(
  listed: readonly ListedModel[],
  overrides: Record<string, string>,
): CatalogModel[] {
  return listed.map((m) => ({
    id: m.id,
    name: m.id, // no separate display name is available from the listing command
    provider: m.provider,
    vendor: deriveVendor(m.provider, m.id, overrides),
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    inputCostPerMTok: null, // not exposed by the listing command
    outputCostPerMTok: null,
    reasoning: m.reasoning,
    thinkingLevelMap: undefined, // per-level support is not exposed by the listing command
  }));
}

// ---------------------------------------------------------------------------------------------
// Host process helpers
// ---------------------------------------------------------------------------------------------

const COMMAND_TIMEOUT_MS = 15_000;

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Runs a host command to completion and always resolves with whatever it printed, regardless of
 * exit code — `pi auth check` exits non-zero for a not-ready provider while still printing a
 * valid JSON status object on stdout, and callers need that body. Only rejects when the process
 * itself could not be spawned or run, or when it hangs past the timeout.
 */
function runCommand(bin: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error(`command timed out after ${COMMAND_TIMEOUT_MS}ms: ${bin} ${args.join(' ')}`),
      );
    }, COMMAND_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolvePiBin(opts: DiscoveryOptions | undefined): string {
  return opts?.piBin ?? process.env.COUNCIL_PI_BIN ?? 'pi';
}

// ---------------------------------------------------------------------------------------------
// Provider readiness
// ---------------------------------------------------------------------------------------------

interface ReadinessResult {
  ready: boolean;
  authType: string | null;
  reason: string | null;
}

/**
 * Determines whether one provider is ready via the host's own auth-status interface. Parses
 * ONLY the `status`/`authType`/`reason` fields of its JSON output. This is the one place this
 * module talks to `pi auth`, and it invokes nothing beyond the `check` subcommand shown below —
 * no flag or subcommand that would cause the host to print or copy a live token.
 */
async function checkProviderReady(piBin: string, provider: string): Promise<ReadinessResult> {
  try {
    const { stdout } = await runCommand(piBin, ['auth', 'check', '--provider', provider, '--json']);
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      return { ready: false, authType: null, reason: 'auth check produced no output' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ready: false, authType: null, reason: 'auth check produced unparseable output' };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return { ready: false, authType: null, reason: 'auth check produced an unexpected shape' };
    }

    const status = (parsed as { status?: unknown }).status;
    const authTypeRaw = (parsed as { authType?: unknown }).authType;
    const reasonRaw = (parsed as { reason?: unknown }).reason;

    if (status === 'ready') {
      return {
        ready: true,
        authType: typeof authTypeRaw === 'string' ? authTypeRaw : null,
        reason: null,
      };
    }

    return {
      ready: false,
      authType: null,
      reason:
        typeof reasonRaw === 'string'
          ? reasonRaw
          : typeof status === 'string'
            ? status
            : 'not ready',
    };
  } catch (err) {
    return { ready: false, authType: null, reason: `auth check failed: ${errorMessage(err)}` };
  }
}

// ---------------------------------------------------------------------------------------------
// Catalog assembly
// ---------------------------------------------------------------------------------------------

async function buildProviderInfos(
  piBin: string,
  models: readonly CatalogModel[],
): Promise<ProviderInfo[]> {
  const providerIds = Array.from(new Set(models.map((m) => m.provider))).sort();
  const readiness = await Promise.all(providerIds.map((id) => checkProviderReady(piBin, id)));

  return providerIds.map((id, i) => {
    const r = readiness[i] as ReadinessResult;
    return {
      id,
      ready: r.ready,
      authType: r.authType,
      reason: r.reason,
      modelCount: models.filter((m) => m.provider === id).length,
    };
  });
}

async function loadFromStore(homeDir: string): Promise<RawStoreFile | null> {
  const storePath = join(homeDir, '.pi', 'agent', 'models-store.json');
  let text: string;
  try {
    text = await readFile(storePath, 'utf8');
  } catch {
    return null; // missing (or unreadable) — caller falls back to the listing command
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as RawStoreFile;
  } catch {
    return null; // corrupt store file — treated the same as "unavailable"
  }
}

async function loadFromListing(
  piBin: string,
  overrides: Record<string, string>,
): Promise<CatalogModel[] | null> {
  let result: CommandResult;
  try {
    result = await runCommand(piBin, ['--list-models', '-ne']);
  } catch {
    return null;
  }
  if (result.code !== 0) return null;

  const listed = parseListModelsOutput(result.stdout);
  if (listed.length === 0) return null;

  return listedModelsToCatalogModels(listed, overrides);
}

function warnSkipped(count: number): void {
  if (count <= 0) return;
  const noun = count === 1 ? 'entry' : 'entries';
  process.stderr.write(`council-review: skipped ${count} malformed catalog ${noun}\n`);
}

export async function loadCatalog(opts?: DiscoveryOptions): Promise<Catalog> {
  const overrides = opts?.vendorOverrides ?? {};
  const homeDir = opts?.homeDir ?? homedir();
  const piBin = resolvePiBin(opts);

  const store = await loadFromStore(homeDir);

  if (store !== null) {
    // The host's effective catalog layers `models.json` (overrides + additions) on top of the
    // store; when we spawn the host itself (the listing fallback below) it has already done
    // this merge before printing, but reading the store file directly bypasses that, so it must
    // be replicated here.
    const modelsJson = await loadModelsJson(homeDir);
    const mergedStore = mergeModelsJson(store, modelsJson);
    const { models, skipped } = catalogFromStore(mergedStore, overrides);
    warnSkipped(skipped);
    const providers = await buildProviderInfos(piBin, models);
    return { providers, models, skipped, source: 'store' };
  }

  const listingModels = await loadFromListing(piBin, overrides);
  if (listingModels === null) {
    throw new DiscoveryError(
      'No models could be discovered: the model catalog is missing and the host listing command failed or is unavailable.',
    );
  }

  const providers = await buildProviderInfos(piBin, listingModels);
  return { providers, models: listingModels, skipped: 0, source: 'listing' };
}

export function readyModels(c: Catalog): CatalogModel[] {
  const readyProviderIds = new Set(c.providers.filter((p) => p.ready).map((p) => p.id));
  return c.models.filter((m) => readyProviderIds.has(m.provider));
}

export function findModel(c: Catalog, provider: string, modelId: string): CatalogModel | undefined {
  return c.models.find((m) => m.provider === provider && m.id === modelId);
}
