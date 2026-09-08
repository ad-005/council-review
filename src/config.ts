/**
 * Loads, validates and writes `.council/config.json` and `.council/ignore.json`.
 *
 * Validation failures are reported as `ConfigError` (exit code 2) carrying the offending key
 * path and the reason, per the CLI spec's "Configuration file contract". This module never
 * calls `process.exit` itself — the CLI layer maps `ConfigError` to an exit code.
 */
import fs from 'node:fs';
import path from 'node:path';

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { isThinkingLevel, type ThinkingLevel } from './levels.js';

export interface PanelEntry {
  provider: string;
  model: string;
  thinking?: ThinkingLevel;
}

export interface CouncilConfig {
  version: number;
  baseBranch: string;
  panel: PanelEntry[];
  defaultThinkingLevel?: ThinkingLevel;
  modelThinkingLevels?: Record<string, ThinkingLevel>;
  includeContextFiles: boolean;
  timeoutSeconds: number;
  /** Per-reviewer output-token ceiling. `null` means no ceiling at all -- reviewers are then
   *  bounded only by `timeoutSeconds`. */
  maxOutputTokens: number | null;
  mergeWindow: number;
  claimSimilarity: number;
  failOn: 'critical' | 'high' | 'medium' | 'low' | 'none';
  snapshot?: { include?: string[] };
  vendorOverrides?: Record<string, string>;
  retain?: number;
}

export interface IgnoreEntry {
  fingerprint: string;
  reason?: string;
  addedAt?: string;
}

export interface IgnoreFile {
  version: number;
  entries: IgnoreEntry[];
}

/** Thrown for every config/ignore-file problem. Never thrown for something the CLI can retry. */
export class ConfigError extends Error {
  readonly exitCode = 2 as const;
  readonly keyPath?: string;

  constructor(message: string, keyPath?: string) {
    super(message);
    this.name = 'ConfigError';
    this.keyPath = keyPath;
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

export const SUPPORTED_CONFIG_VERSIONS: readonly number[] = [1];

/** The current version stamped onto a newly written config, alongside the documented defaults
 * for every optional key. `panel` has no default: it is meaningless without a real selection.
 * `maxOutputTokens` defaults to no ceiling (`null`): an omitted key is deliberately unbounded,
 * not a forgotten number. */
export const CONFIG_DEFAULTS: Readonly<Partial<CouncilConfig>> = Object.freeze({
  version: 1,
  baseBranch: 'main',
  includeContextFiles: false,
  timeoutSeconds: 86400,
  maxOutputTokens: null,
  mergeWindow: 10,
  claimSimilarity: 0.6,
  failOn: 'high',
  retain: 20,
});

export function configPath(projectRoot: string): string {
  return path.join(projectRoot, '.council', 'config.json');
}

export function ignorePath(projectRoot: string): string {
  return path.join(projectRoot, '.council', 'ignore.json');
}

// ---------------------------------------------------------------------------------------------
// Schema
//
// Thinking-level fields are typed `Type.String()` here — their *shape* is checked by TypeBox,
// their *vocabulary* is checked afterwards with `isThinkingLevel`, per the task brief, so an
// unknown level is reported with its own clear reason rather than folded into a generic
// "expected one of [...]" union-literal message.
// ---------------------------------------------------------------------------------------------

const PanelEntrySchema = Type.Object({
  provider: Type.String(),
  model: Type.String(),
  thinking: Type.Optional(Type.String()),
});

const ConfigSchema = Type.Object({
  version: Type.Number(),
  baseBranch: Type.Optional(Type.String()),
  panel: Type.Array(PanelEntrySchema),
  defaultThinkingLevel: Type.Optional(Type.String()),
  modelThinkingLevels: Type.Optional(Type.Record(Type.String(), Type.String())),
  includeContextFiles: Type.Optional(Type.Boolean()),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
  maxOutputTokens: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  mergeWindow: Type.Optional(Type.Integer({ minimum: 0 })),
  claimSimilarity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  failOn: Type.Optional(
    Type.Union([
      Type.Literal('critical'),
      Type.Literal('high'),
      Type.Literal('medium'),
      Type.Literal('low'),
      Type.Literal('none'),
    ]),
  ),
  snapshot: Type.Optional(
    Type.Object({
      include: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  vendorOverrides: Type.Optional(Type.Record(Type.String(), Type.String())),
  retain: Type.Optional(Type.Integer({ minimum: 0 })),
});

type RawConfig = Static<typeof ConfigSchema>;

const IgnoreEntrySchema = Type.Object({
  fingerprint: Type.String(),
  reason: Type.Optional(Type.String()),
  addedAt: Type.Optional(Type.String()),
});

const IgnoreFileSchema = Type.Object({
  version: Type.Number(),
  entries: Type.Array(IgnoreEntrySchema),
});

const IGNORE_FILE_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Config: read
// ---------------------------------------------------------------------------------------------

const NOT_FOUND = Symbol('config-file-not-found');

/** Reads and parses `file`, returning the `NOT_FOUND` sentinel when it does not exist. */
function tryReadJsonFile(file: string): unknown | typeof NOT_FOUND {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NOT_FOUND;
    }
    throw new ConfigError(`Unable to read ${file}: ${(err as Error).message}`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
}

/**
 * Hard-errors on an unrecognised `version` before anything else in the document is interpreted
 * — an unsupported version is never best-effort parsed. This runs ahead of the general schema
 * check so a version mismatch is reported as a version problem, not a generic type error.
 */
function checkVersion(raw: Record<string, unknown>, file: string): void {
  const version = raw.version;
  if (typeof version !== 'number' || !SUPPORTED_CONFIG_VERSIONS.includes(version)) {
    throw new ConfigError(
      `Unsupported config version ${JSON.stringify(version)} in ${file}; ` +
        `supported versions: ${SUPPORTED_CONFIG_VERSIONS.join(', ')}.`,
      '/version',
    );
  }
}

function checkThinkingLevels(raw: RawConfig): void {
  if (raw.defaultThinkingLevel !== undefined && !isThinkingLevel(raw.defaultThinkingLevel)) {
    throw new ConfigError(
      `Invalid config at "/defaultThinkingLevel": unknown thinking level ` +
        `${JSON.stringify(raw.defaultThinkingLevel)}`,
      '/defaultThinkingLevel',
    );
  }

  if (raw.modelThinkingLevels) {
    for (const [key, value] of Object.entries(raw.modelThinkingLevels)) {
      if (!isThinkingLevel(value)) {
        throw new ConfigError(
          `Invalid config at "/modelThinkingLevels/${key}": unknown thinking level ` +
            `${JSON.stringify(value)}`,
          `/modelThinkingLevels/${key}`,
        );
      }
    }
  }

  raw.panel.forEach((entry, i) => {
    if (entry.thinking !== undefined && !isThinkingLevel(entry.thinking)) {
      throw new ConfigError(
        `Invalid config at "/panel/${i}/thinking": unknown thinking level ` +
          `${JSON.stringify(entry.thinking)}`,
        `/panel/${i}/thinking`,
      );
    }
  });
}

function applyDefaults(raw: RawConfig): CouncilConfig {
  return {
    version: raw.version,
    baseBranch: raw.baseBranch ?? CONFIG_DEFAULTS.baseBranch!,
    panel: raw.panel as PanelEntry[],
    defaultThinkingLevel: raw.defaultThinkingLevel as ThinkingLevel | undefined,
    modelThinkingLevels: raw.modelThinkingLevels as Record<string, ThinkingLevel> | undefined,
    includeContextFiles: raw.includeContextFiles ?? CONFIG_DEFAULTS.includeContextFiles!,
    timeoutSeconds: raw.timeoutSeconds ?? CONFIG_DEFAULTS.timeoutSeconds!,
    maxOutputTokens: raw.maxOutputTokens ?? CONFIG_DEFAULTS.maxOutputTokens!,
    mergeWindow: raw.mergeWindow ?? CONFIG_DEFAULTS.mergeWindow!,
    claimSimilarity: raw.claimSimilarity ?? CONFIG_DEFAULTS.claimSimilarity!,
    failOn: raw.failOn ?? CONFIG_DEFAULTS.failOn!,
    snapshot: raw.snapshot,
    vendorOverrides: raw.vendorOverrides,
    retain: raw.retain ?? CONFIG_DEFAULTS.retain!,
  };
}

export function loadConfig(projectRoot: string): CouncilConfig {
  const file = configPath(projectRoot);
  const raw = tryReadJsonFile(file);

  if (raw === NOT_FOUND) {
    throw new ConfigError(
      `No configuration found at ${file}. Run "council-review init" to create one.`,
    );
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`Invalid config in ${file}: expected a JSON object at the top level`);
  }

  const rawRecord = raw as Record<string, unknown>;
  checkVersion(rawRecord, file);

  const error = Value.Errors(ConfigSchema, raw).First();
  if (error) {
    throw new ConfigError(
      `Invalid config at "${error.path}": ${error.message} (got ${JSON.stringify(error.value)})`,
      error.path,
    );
  }

  const validated = raw as RawConfig;
  checkThinkingLevels(validated);

  return applyDefaults(validated);
}

// ---------------------------------------------------------------------------------------------
// Config: write
// ---------------------------------------------------------------------------------------------

/**
 * Merges `patch` over the document currently on disk (or over `{}` when none exists yet) and
 * writes the result back. The merge is a shallow object spread over the *raw* JSON, not the
 * typed `CouncilConfig` — so a key the current schema does not know about survives untouched,
 * and any key present in `patch` replaces its previous value wholesale.
 */
export function writeConfig(projectRoot: string, patch: Partial<CouncilConfig>): void {
  const file = configPath(projectRoot);
  const raw = tryReadJsonFile(file);

  let existing: Record<string, unknown> = {};
  if (raw !== NOT_FOUND) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigError(`Invalid config in ${file}: expected a JSON object at the top level`);
    }
    existing = raw as Record<string, unknown>;
  }

  const merged = { ...existing, ...patch };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Ignore file
// ---------------------------------------------------------------------------------------------

export function loadIgnore(projectRoot: string): IgnoreFile {
  const file = ignorePath(projectRoot);
  const raw = tryReadJsonFile(file);

  if (raw === NOT_FOUND) {
    return { version: IGNORE_FILE_VERSION, entries: [] };
  }

  const error = Value.Errors(IgnoreFileSchema, raw).First();
  if (error) {
    throw new ConfigError(
      `Invalid ignore file at "${error.path}": ${error.message} (got ${JSON.stringify(error.value)})`,
      error.path,
    );
  }

  return raw as IgnoreFile;
}

/** Appends `entry` unless its fingerprint is already present, in which case this is a no-op. */
export function appendIgnore(projectRoot: string, entry: IgnoreEntry): void {
  const file = ignorePath(projectRoot);
  const current = loadIgnore(projectRoot);

  const alreadyPresent = current.entries.some((e) => e.fingerprint === entry.fingerprint);
  const entries = alreadyPresent
    ? current.entries
    : [...current.entries, { addedAt: new Date().toISOString(), ...entry }];

  const next: IgnoreFile = { version: current.version || IGNORE_FILE_VERSION, entries };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
}
