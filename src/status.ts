/**
 * `council-review status`: a fast, side-effect-free snapshot of whether this project is
 * configured, plus enough surrounding state (panel, independence guard, settings, suppressions,
 * stored runs, `.gitignore`, herdr) that a coding agent can decide what to do next without
 * spawning a review or reading half a dozen files itself.
 *
 * The default path is deliberately cheap: it reads only what is already on disk and the one
 * `git rev-parse` inside `findRepoRoot` -- no host process, no catalog discovery, no network.
 * `--verify` is the one path that talks to the catalog (`loadCatalog`), and is opt-in for
 * exactly that reason. See the cli spec's "status" requirement for the scenarios this covers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ThinkingLevel } from './levels.js';
import {
  ConfigError,
  CONFIG_DEFAULTS,
  configPath,
  ignorePath,
  loadConfig,
  loadIgnore,
  type CouncilConfig,
  type PanelEntry,
} from './config.js';
import { checkIndependence } from './panel.js';
import { deriveVendor, findModel, loadCatalog } from './providers.js';
import { listRuns, reviewsDirPath } from './report.js';
import { findRepoRoot, ScopeError } from './scope.js';
import { isHerdrEnv } from './herdr.js';
import { resolveThinking } from './thinking.js';

// -------------------------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------------------------

export interface StatusPanelEntry {
  provider: string;
  model: string;
  vendor: string;
  /** Configured level, resolved from config only -- no catalog lookup, so this is available on
   *  the default (non-`--verify`) path. */
  thinking: ThinkingLevel | null;
  /** `--verify` only; `null` otherwise (including when the model turned out to be absent from
   *  the catalog -- there is nothing to clamp against). */
  effectiveThinking: ThinkingLevel | null;
  /** `--verify` only; `null` otherwise. */
  clamped: boolean | null;
  /** `--verify` only; `null` otherwise. */
  ready: boolean | null;
  /** `--verify` only, and only set when `ready` is false. */
  readyReason: string | null;
}

export interface StatusReport {
  version: string;
  /** True iff a repo root was found AND a config file is present AND it validated. */
  configured: boolean;
  repoRoot: string | null;
  config: {
    path: string | null;
    present: boolean;
    valid: boolean;
    version: number | null;
    error: string | null;
    errorKeyPath: string | null;
  };
  panel: StatusPanelEntry[];
  independence: {
    ok: boolean;
    modelCount: number;
    vendorCount: number;
    vendors: Record<string, string[]>;
    reason: string | null;
  } | null;
  settings: {
    baseBranch: string;
    failOn: CouncilConfig['failOn'];
    timeoutSeconds: number;
    maxOutputTokens: number | null;
    mergeWindow: number;
    claimSimilarity: number;
    includeContextFiles: boolean;
    retain: number;
  } | null;
  suppressions: { path: string | null; present: boolean; count: number };
  runs: {
    count: number;
    last: { id: string; path: string; reportPath: string; findingsPath: string } | null;
  };
  gitignore: { excludesReviews: boolean };
  herdr: { detected: boolean };
  /** Whether `--verify` actually ran. False when not given, and also false when given against an
   *  unconfigured project -- there is no panel to verify, so it is a no-op rather than an error. */
  verified: boolean;
}

// -------------------------------------------------------------------------------------------
// Small helpers, duplicated deliberately rather than exported from their real owners
// -------------------------------------------------------------------------------------------

/** Mirrors `cli.ts`'s own `readPackageVersion` -- not shared, since neither file is the other's
 * dependency and this is three lines of no real complexity to keep in sync. */
function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Mirrors `report.ts`'s own (unexported) `resolveLastRunId`. */
function resolveLastRunId(reviewsDir: string): string | null {
  try {
    return path.basename(fs.realpathSync(path.join(reviewsDir, 'last')));
  } catch {
    return null;
  }
}

const GITIGNORE_REVIEWS_ENTRIES = ['.council/reviews/', '.council/reviews'];

/**
 * Whether `<repoRoot>/.gitignore` already excludes `.council/reviews/`, matched exactly the way
 * `cli.ts`'s `ensureGitignoreEntry` decides whether to append it -- that function now calls this
 * one, so the read check (`status`) and the write check (`init`) can never drift apart.
 */
export function gitignoreExcludesReviews(repoRoot: string): boolean {
  let content = '';
  try {
    content = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  } catch {
    return false;
  }
  const lines = content.split('\n').map((l) => l.trim());
  return GITIGNORE_REVIEWS_ENTRIES.some((entry) => lines.includes(entry));
}

// -------------------------------------------------------------------------------------------
// Panel entries
// -------------------------------------------------------------------------------------------

/**
 * Builds one panel entry from config alone: vendor derivation is pure (`deriveVendor` opens no
 * catalog), and the configured thinking level follows the same "per-model map, then the entry's
 * own saved pin, then the panel-wide default" precedence `resolveConfiguredPanel` uses for its
 * `configPerModel` source -- just without a catalog to resolve against yet.
 */
function buildBasePanelEntry(entry: PanelEntry, cfg: CouncilConfig): StatusPanelEntry {
  const vendor = deriveVendor(entry.provider, entry.model, cfg.vendorOverrides ?? {});
  const key = `${entry.provider}/${entry.model}`;
  const thinking =
    cfg.modelThinkingLevels?.[key] ?? entry.thinking ?? cfg.defaultThinkingLevel ?? null;
  return {
    provider: entry.provider,
    model: entry.model,
    vendor,
    thinking,
    effectiveThinking: null,
    clamped: null,
    ready: null,
    readyReason: null,
  };
}

/**
 * Fills in the `--verify`-only fields against a freshly discovered catalog. Deliberately never
 * throws for a stale entry -- unlike `resolveConfiguredPanel` (used at review time, where a
 * missing model is a hard `PanelError`), `status --verify` must survive a saved panel that no
 * longer matches the catalog and just report that plainly.
 */
async function verifyPanelEntries(
  base: readonly StatusPanelEntry[],
  cfg: CouncilConfig,
): Promise<StatusPanelEntry[]> {
  const catalog = await loadCatalog({ vendorOverrides: cfg.vendorOverrides ?? {} });

  return base.map((entry) => {
    const model = findModel(catalog, entry.provider, entry.model);
    if (!model) {
      return { ...entry, ready: false, readyReason: 'model absent from the catalog' };
    }

    const providerInfo = catalog.providers.find((p) => p.id === entry.provider);
    const ready = providerInfo?.ready ?? false;
    const readyReason = ready ? null : (providerInfo?.reason ?? 'provider not ready');

    // `entry.thinking` already folds config's own precedence chain down to one value (see
    // `buildBasePanelEntry`), so it is fed in at the `configPerModel` tier here -- the only
    // source that matters, since status has no CLI-flag-level override of its own.
    const resolved = resolveThinking(model, { configPerModel: entry.thinking ?? undefined });

    return {
      ...entry,
      ready,
      readyReason,
      effectiveThinking: resolved.effective,
      clamped: resolved.clamped,
    };
  });
}

// -------------------------------------------------------------------------------------------
// collectStatus
// -------------------------------------------------------------------------------------------

export async function collectStatus(cwd: string, opts: { verify: boolean }): Promise<StatusReport> {
  const version = readPackageVersion();

  let repoRoot: string | null;
  try {
    repoRoot = findRepoRoot(cwd);
  } catch (err) {
    if (!(err instanceof ScopeError)) throw err;
    repoRoot = null;
  }

  // --- config ---------------------------------------------------------------------------
  const cfgPath = repoRoot !== null ? configPath(repoRoot) : null;
  let configPresent = false;
  let configValid = false;
  let configVersion: number | null = null;
  let configError: string | null = null;
  let configErrorKeyPath: string | null = null;
  let cfg: CouncilConfig | null = null;

  if (repoRoot !== null && cfgPath !== null) {
    configPresent = fs.existsSync(cfgPath);
    if (configPresent) {
      try {
        cfg = loadConfig(repoRoot);
        configValid = true;
        configVersion = cfg.version;
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        configValid = false;
        configError = err.message;
        configErrorKeyPath = err.keyPath ?? null;
      }
    }
  }

  const configured = repoRoot !== null && configPresent && configValid && cfg !== null;

  // --- panel, independence, settings (config-derived; null when not configured) ---------
  let panel: StatusPanelEntry[] = [];
  let independence: StatusReport['independence'] = null;
  let settings: StatusReport['settings'] = null;

  if (configured && cfg !== null) {
    const activeCfg = cfg;
    panel = activeCfg.panel.map((entry) => buildBasePanelEntry(entry, activeCfg));

    const guard = checkIndependence(
      panel.map((p) => ({ provider: p.provider, model: p.model, vendor: p.vendor })),
    );
    const vendors: Record<string, string[]> = {};
    for (const [vendor, members] of guard.vendors) vendors[vendor] = members;
    independence = {
      ok: guard.ok,
      modelCount: panel.length,
      vendorCount: guard.vendors.size,
      vendors,
      reason: guard.reason ?? null,
    };

    settings = {
      baseBranch: activeCfg.baseBranch ?? CONFIG_DEFAULTS.baseBranch!,
      failOn: activeCfg.failOn ?? CONFIG_DEFAULTS.failOn!,
      timeoutSeconds: activeCfg.timeoutSeconds ?? CONFIG_DEFAULTS.timeoutSeconds!,
      maxOutputTokens: activeCfg.maxOutputTokens ?? CONFIG_DEFAULTS.maxOutputTokens!,
      mergeWindow: activeCfg.mergeWindow ?? CONFIG_DEFAULTS.mergeWindow!,
      claimSimilarity: activeCfg.claimSimilarity ?? CONFIG_DEFAULTS.claimSimilarity!,
      includeContextFiles: activeCfg.includeContextFiles ?? CONFIG_DEFAULTS.includeContextFiles!,
      retain: activeCfg.retain ?? CONFIG_DEFAULTS.retain!,
    };
  }

  // --- suppressions -----------------------------------------------------------------------
  let suppressions: StatusReport['suppressions'];
  if (repoRoot === null) {
    suppressions = { path: null, present: false, count: 0 };
  } else {
    const iPath = ignorePath(repoRoot);
    const present = fs.existsSync(iPath);
    let count = 0;
    if (present) {
      try {
        count = loadIgnore(repoRoot).entries.length;
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        // Corrupt ignore file: the file exists (that's what `present` reports), there is just
        // nothing countable in it -- this must not throw out of a status read.
      }
    }
    suppressions = { path: iPath, present, count };
  }

  // --- runs ---------------------------------------------------------------------------------
  let runs: StatusReport['runs'];
  if (repoRoot === null) {
    runs = { count: 0, last: null };
  } else {
    const allRuns = listRuns(repoRoot); // newest first
    const reviewsDir = reviewsDirPath(repoRoot);
    const lastId = resolveLastRunId(reviewsDir) ?? allRuns[0]?.id ?? null;
    const last =
      lastId === null
        ? null
        : {
            id: lastId,
            path: path.join(reviewsDir, lastId),
            reportPath: path.join(reviewsDir, lastId, 'REPORT.md'),
            findingsPath: path.join(reviewsDir, lastId, 'findings.json'),
          };
    runs = { count: allRuns.length, last };
  }

  const gitignore = { excludesReviews: repoRoot !== null && gitignoreExcludesReviews(repoRoot) };
  const herdr = { detected: isHerdrEnv() };

  // --- --verify: the one path that opens the catalog --------------------------------------
  let verified = false;
  if (configured && cfg !== null && opts.verify) {
    panel = await verifyPanelEntries(panel, cfg);
    verified = true;
  }

  return {
    version,
    configured,
    repoRoot,
    config: {
      path: cfgPath,
      present: configPresent,
      valid: configValid,
      version: configVersion,
      error: configError,
      errorKeyPath: configErrorKeyPath,
    },
    panel,
    independence,
    settings,
    suppressions,
    runs,
    gitignore,
    herdr,
    verified,
  };
}

// -------------------------------------------------------------------------------------------
// formatStatusText
// -------------------------------------------------------------------------------------------

/** Every top-level line is `<label>` padded to this width, then its value -- what lines up the
 * `configured:`/`repo:`/`config:`/`panel (...)`/`independence:`/`settings:`/... column below. */
const LABEL_WIDTH = 14;

function labelled(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

function formatPanelLine(
  p: StatusPanelEntry,
  verify: boolean,
  nameWidth: number,
  vendorWidth: number,
): string {
  const name = `${p.provider}/${p.model}`.padEnd(nameWidth);
  const vendorField = `vendor=${p.vendor}`.padEnd(vendorWidth);

  const requestedStr = p.thinking ?? '-';
  const thinkingStr =
    verify && p.clamped
      ? `thinking=${requestedStr}->${p.effectiveThinking} (clamped)`
      : `thinking=${requestedStr}`;

  let line = `  ${name}   ${vendorField}  ${thinkingStr}`;
  if (verify && p.ready === false) {
    line += `  NOT READY${p.readyReason ? ` (${p.readyReason})` : ''}`;
  }
  return line;
}

/**
 * Renders `StatusReport` as the human-readable form (the default output mode; `--json` bypasses
 * this entirely). Sections that don't apply to an unconfigured project are omitted outright
 * rather than printed empty, per the cli spec's "status" requirement.
 */
export function formatStatusText(r: StatusReport): string {
  const lines: string[] = [];

  lines.push(`council-review ${r.version}`);
  lines.push(labelled('configured:', r.configured ? 'yes' : 'no'));
  lines.push(labelled('repo:', r.repoRoot ?? '(not a git repository)'));

  if (r.config.present && r.config.valid) {
    lines.push(labelled('config:', `.council/config.json (version ${r.config.version})`));
  } else if (r.config.present && !r.config.valid) {
    lines.push(labelled('config:', `(invalid: ${r.config.error})`));
  } else {
    lines.push(labelled('config:', '(missing)'));
  }

  if (!r.configured) {
    lines.push('');
    lines.push('Run "council-review init" to configure this repository.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('');
  lines.push(`panel (${r.panel.length} reviewer${r.panel.length === 1 ? '' : 's'}):`);
  const nameWidth =
    r.panel.length > 0 ? Math.max(...r.panel.map((p) => `${p.provider}/${p.model}`.length)) : 0;
  const vendorWidth =
    r.panel.length > 0 ? Math.max(...r.panel.map((p) => `vendor=${p.vendor}`.length)) : 0;
  for (const p of r.panel) {
    lines.push(formatPanelLine(p, r.verified, nameWidth, vendorWidth));
  }

  if (r.independence) {
    if (r.independence.ok) {
      lines.push(
        `independence: ok (${r.independence.modelCount} models, ${r.independence.vendorCount} vendors)`,
      );
    } else {
      lines.push(`independence: FAILED — ${r.independence.reason}`);
      for (const [vendor, members] of Object.entries(r.independence.vendors)) {
        lines.push(`  ${vendor}: ${members.join(', ')}`);
      }
    }
  }

  if (r.settings) {
    const s = r.settings;
    lines.push('');
    lines.push(
      labelled(
        'settings:',
        `baseBranch=${s.baseBranch} failOn=${s.failOn} timeout=${s.timeoutSeconds}s ` +
          `maxOutputTokens=${s.maxOutputTokens ?? 'none'}`,
      ),
    );
    lines.push(
      labelled(
        '',
        `mergeWindow=${s.mergeWindow} claimSimilarity=${s.claimSimilarity} ` +
          `includeContextFiles=${s.includeContextFiles ? 'yes' : 'no'} retain=${s.retain}`,
      ),
    );
  }

  const suppressionNoun = r.suppressions.count === 1 ? 'entry' : 'entries';
  lines.push(labelled('suppressions:', `${r.suppressions.count} ${suppressionNoun}`));
  lines.push(labelled('runs:', `${r.runs.count} stored, last=${r.runs.last?.id ?? 'none'}`));
  lines.push(
    labelled(
      'gitignore:',
      `.council/reviews/ ${r.gitignore.excludesReviews ? 'excluded' : 'NOT excluded'}`,
    ),
  );
  lines.push(labelled('herdr:', r.herdr.detected ? 'detected' : 'not detected'));

  return `${lines.join('\n')}\n`;
}
