/**
 * The `council-review` binary: argument parsing, subcommand dispatch, and exit-code mapping.
 * See `openspec/changes/add-council-review/specs/council-review/cli/spec.md` for the requirements
 * this implements, and `design.md`'s "Exit code 3 outranks exit code 1" for the taxonomy's one
 * ordering rule.
 *
 * This is the only module in the package that calls `process.exit`-equivalents
 * (`process.exitCode`) on purpose and the only one that owns stdio routing for `--json` mode.
 * Every other module throws a typed, `exitCode`-carrying error; this file is where those are
 * mapped to a process exit code.
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isThinkingLevel, type ThinkingLevel } from './levels.js';
import {
  ConfigError,
  CONFIG_DEFAULTS,
  configPath,
  ignorePath,
  loadConfig,
  writeConfig,
  loadIgnore,
  appendIgnore,
  type CouncilConfig,
  type IgnoreFile,
} from './config.js';
import { loadCatalog, readyModels } from './providers.js';
import { supportedLevels, formatClampNotice } from './thinking.js';
import {
  resolveConfiguredPanel,
  resolveSpecPanel,
  enforceIndependence,
  type Reviewer,
} from './panel.js';
import { pickPanel, type PickerIO } from './picker.js';
import { findRepoRoot, resolveScope, checkScopeSelectors, type ScopeSelectors } from './scope.js';
import { buildSnapshot, writePatch, sweepOrphans, type Snapshot } from './snapshot.js';
import { runPanel, type RunPanelOutcome } from './runner.js';
import type { Severity } from './schema.js';
import { mergeFindings, type ReviewerFindings, type MergedFinding } from './merge.js';
import { loadPreviousFindings, diffAgainstBaseline, type ResolutionOutcome } from './resolve.js';
import {
  createRunDir,
  updateLastPointer,
  reviewsDirPath,
  listRuns,
  gcRuns,
  writeManifest,
  writeReviewerArtifacts,
  writeFindings,
  writeReport,
  writeHandoff,
  emitMachineReadableFindings,
  type ManifestInput,
} from './report.js';
import { splitPaneAndRun, setPaneTitle, notifyComplete, handoffToAgent } from './herdr.js';

// -------------------------------------------------------------------------------------------
// CLI-level errors
// -------------------------------------------------------------------------------------------

/** A usage problem this file itself detects (not raised by any other module). Exit code 2. */
class UsageError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
    Object.setPrototypeOf(this, UsageError.prototype);
  }
}

/** Specifically an unrecognised flag/subcommand, or any other `parseArgs` failure — the CLI
 * spec's "Unknown flag or subcommand" scenario requires printing usage on top of the message,
 * which plain `UsageError` does not (a conflicting-selector or missing-config error should not
 * dump the whole flag surface). `subcommand` is which help text to print alongside it. */
class FlagParseError extends UsageError {
  readonly subcommand: string | null;

  constructor(message: string, subcommand: string | null) {
    super(message);
    this.name = 'FlagParseError';
    this.subcommand = subcommand;
    Object.setPrototypeOf(this, FlagParseError.prototype);
  }
}

function callParseArgs<T>(subcommand: string | null, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new FlagParseError(err instanceof Error ? err.message : String(err), subcommand);
  }
}

function hasExitCode(err: unknown): err is Error & { exitCode: number } {
  return err instanceof Error && typeof (err as { exitCode?: unknown }).exitCode === 'number';
}

// -------------------------------------------------------------------------------------------
// Help text
// -------------------------------------------------------------------------------------------

const REVIEW_HELP = `council-review [flags]

Runs a review of local git state using the configured (or given) panel. This is what runs when
no subcommand is given.

Subcommands:
  init [--pick]              Bootstrap this repository's configuration
  models                     List discovered, ready models
  show [run-id]               Render a stored run's report
  ignore <finding-id>         Suppress a finding
  gc [--keep <n>]             Prune stored runs
Run "council-review <subcommand> --help" for a subcommand's own flags.

Scope flags:
  --staged                    Review the staged index only
  --range <A..B>               Review a commit range
  --revision <rev>             Review a single revision's own change
  --paths <glob>[,<glob>...]   Narrow to matching paths (repeatable)
  --base <branch>              Override the configured base branch

Panel flags:
  --models <spec>              One-off panel: comma-separated provider/modelId[:level] entries or globs
  --pick                       Re-open interactive selection; replaces the saved panel
  --thinking <level>           Panel-wide thinking level
  --allow-correlated           Waive the vendor-independence guard

Run flags:
  --timeout <seconds>          Per-reviewer wall-clock timeout
  --max-tokens <n>              Per-reviewer output-token ceiling
  --since <last|run-id>         Diff findings against a previous run
  --fail-on <level|none>        Severity threshold for exit code 1
  --no-suppress                 Ignore .council/ignore.json for this run
  --json                        Emit merged findings on stdout; everything else goes to stderr

Environment flags:
  --pane                        Run the review in a new herdr pane
  --direction <horizontal|vertical>   Direction for --pane (default: horizontal)
  --no-pane                     Do not delegate to a new pane even if --pane is set
  --handoff <agent>              Deliver the handoff prompt to a herdr-managed agent
  --no-notify                    Suppress the herdr completion notification

Exit codes: 0 clean, 1 findings at/above --fail-on, 2 config/usage error, 3 degraded panel
(outranks 1), 4 vendor-independence guard refusal.
`;

const SUBCOMMAND_HELP: Record<string, string> = {
  init: `council-review init [--pick]

Runs panel selection, then writes .council/config.json and .council/ignore.json and ensures
.gitignore excludes .council/reviews/. Safe to re-run: existing suppressions in ignore.json are
preserved, and only the panel-related configuration is rewritten. Must be run inside a git
repository. --pick is accepted for symmetry with the review-time flag of the same name; init
always re-opens selection.
`,
  models: `council-review models

Lists discovered, ready models: provider, model id, derived vendor, context window, input/output
cost rates and supported thinking levels. Makes no model call and never prompts, even without a
terminal attached.
`,
  show: `council-review show [run-id]

Renders a stored run's REPORT.md. Defaults to the most recent run when no run-id is given. Makes
no model call and incurs no cost.
`,
  ignore: `council-review ignore <finding-id> [--reason <text>] [--run <run-id>]

Resolves <finding-id> against the referenced run's merged findings (default: the most recent
run), and appends its fingerprint to .council/ignore.json, with an optional reason. Idempotent:
suppressing an already-suppressed finding leaves exactly one entry. An unknown finding id exits 2
and leaves the ignore file unchanged.
`,
  gc: `council-review gc [--keep <n>]

Prunes stored runs under .council/reviews/, retaining the <n> most recent (default: the
configured "retain" value, or 20). Never removes the run the most-recent pointer resolves to.
Also sweeps snapshot directories orphaned by a run that could not clean up after itself.
`,
};

function printHelp(
  subcommand: string | null,
  stream: NodeJS.WritableStream = process.stdout,
): void {
  const text =
    subcommand !== null && subcommand in SUBCOMMAND_HELP
      ? SUBCOMMAND_HELP[subcommand]!
      : REVIEW_HELP;
  stream.write(text);
}

// -------------------------------------------------------------------------------------------
// Small shared helpers
// -------------------------------------------------------------------------------------------

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

function resolveExtensionPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'reviewer-tools.js');
}

/** Writes to stderr in `--json` mode (to keep stdout parseable), stdout otherwise. */
function out(json: boolean, msg: string): void {
  (json ? process.stderr : process.stdout).write(msg);
}

function tryLoadConfig(repoRoot: string): CouncilConfig | null {
  try {
    return loadConfig(repoRoot);
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}

function resolveLastRunId(reviewsDir: string): string | null {
  try {
    return path.basename(fs.realpathSync(path.join(reviewsDir, 'last')));
  } catch {
    return null;
  }
}

function panelEntriesFrom(reviewers: readonly Reviewer[]): {
  panel: { provider: string; model: string }[];
  modelThinkingLevels: Record<string, ThinkingLevel>;
} {
  const panel = reviewers.map((r) => ({ provider: r.provider, model: r.model }));
  const modelThinkingLevels: Record<string, ThinkingLevel> = {};
  for (const r of reviewers) {
    if (r.thinking.requested !== null) {
      modelThinkingLevels[`${r.provider}/${r.model}`] = r.thinking.requested;
    }
  }
  return { panel, modelThinkingLevels };
}

/**
 * Persists a panel produced by the picker into `.council/config.json`. Used by `init`, and by a
 * review-time `--pick` (which "replaces the saved panel" per the panel-selection spec). Never
 * used for `--models`, which defines the panel for one run only.
 */
function persistPanel(repoRoot: string, reviewers: readonly Reviewer[]): void {
  const { panel, modelThinkingLevels } = panelEntriesFrom(reviewers);
  writeConfig(repoRoot, { version: CONFIG_DEFAULTS.version!, panel, modelThinkingLevels });
}

function ensureIgnoreFile(repoRoot: string): void {
  const file = ignorePath(repoRoot);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const empty: IgnoreFile = { version: 1, entries: [] };
  fs.writeFileSync(file, `${JSON.stringify(empty, null, 2)}\n`, 'utf8');
}

const GITIGNORE_ENTRY = '.council/reviews/';

function ensureGitignoreEntry(repoRoot: string): void {
  const file = path.join(repoRoot, '.gitignore');
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    // No .gitignore yet; created fresh below.
  }
  const lines = content.split('\n').map((l) => l.trim());
  if (lines.includes(GITIGNORE_ENTRY) || lines.includes('.council/reviews')) return;
  const needsNewline = content.length > 0 && !content.endsWith('\n');
  fs.writeFileSync(file, `${content}${needsNewline ? '\n' : ''}${GITIGNORE_ENTRY}\n`, 'utf8');
}

function parsePositiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`${flag} must be a positive integer, got "${raw}"`);
  }
  return n;
}

const FAIL_ON_LEVELS = ['critical', 'high', 'medium', 'low', 'none'] as const;

function validateFailOn(raw: string): CouncilConfig['failOn'] {
  if (!(FAIL_ON_LEVELS as readonly string[]).includes(raw)) {
    throw new UsageError(
      `invalid --fail-on value: "${raw}" (expected one of ${FAIL_ON_LEVELS.join(', ')})`,
    );
  }
  return raw as CouncilConfig['failOn'];
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function breachesThreshold(
  findings: readonly MergedFinding[],
  failOn: CouncilConfig['failOn'],
): boolean {
  if (failOn === 'none') return false;
  const min = SEVERITY_RANK[failOn];
  return findings.some((f) => SEVERITY_RANK[f.severity] >= min);
}

/**
 * Redirects `process.stdout.write` to `process.stderr.write` for the duration of `fn`, so that
 * `runner.ts`'s own progress output (which writes directly to `process.stdout` and takes no
 * stream parameter) does not contaminate stdout while `--json` mode is active. Restored in a
 * `finally`, and a no-op (calls `fn` directly) when `active` is false.
 */
async function withStdoutRedirectedToStderr<T>(active: boolean, fn: () => Promise<T>): Promise<T> {
  if (!active) return fn();
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((...args: Parameters<typeof process.stdout.write>): boolean =>
    process.stderr.write(...args)) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = original;
  }
}

const TASK_PROMPT = `You are one independent reviewer in a multi-model code review panel. You are
given a unified diff patch and read-only access to a frozen snapshot of the repository at the
tree the patch ends at, via your council_read, council_grep, council_list and council_git tools.

Review the patch for correctness bugs, security issues, and other defects a careful senior
engineer would flag before merging: logic errors, unhandled edge cases, resource leaks, race
conditions, broken error handling, security vulnerabilities, and violations of the codebase's own
established conventions. Do not comment on style preferences and do not report merely cosmetic
issues.

You do not know which other models, if any, are also reviewing this patch, and you will never see
their output or the fact that they exist. Form your own independent judgment using only what you
can read yourself.`;

// -------------------------------------------------------------------------------------------
// init
// -------------------------------------------------------------------------------------------

async function cmdInit(args: readonly string[], pickerIO: PickerIO | undefined): Promise<number> {
  callParseArgs('init', () =>
    parseArgs({
      args: args as string[],
      options: { pick: { type: 'boolean' } },
      allowPositionals: false,
      strict: true,
    }),
  );
  // `--pick` is accepted but does not change behaviour: `init` always re-opens selection, per
  // the "Fresh initialization" and "Re-running the picker later" scenarios both describing the
  // same effect.

  const repoRoot = findRepoRoot(process.cwd());
  const existing = tryLoadConfig(repoRoot);

  process.stderr.write('council-review: discovering models...\n');
  const catalog = await loadCatalog({ vendorOverrides: existing?.vendorOverrides ?? {} });
  const reviewers = await pickPanel(catalog, pickerIO);
  enforceIndependence(reviewers, false);

  persistPanel(repoRoot, reviewers);
  ensureIgnoreFile(repoRoot);
  ensureGitignoreEntry(repoRoot);

  process.stdout.write(`council-review: initialized with ${reviewers.length} reviewer(s):\n`);
  for (const r of reviewers) {
    process.stdout.write(`  ${r.provider}/${r.model} (${r.vendor})\n`);
  }
  process.stdout.write(`Wrote ${configPath(repoRoot)}\n`);
  return 0;
}

// -------------------------------------------------------------------------------------------
// models
// -------------------------------------------------------------------------------------------

async function cmdModels(args: readonly string[]): Promise<number> {
  callParseArgs('models', () =>
    parseArgs({ args: args as string[], options: {}, allowPositionals: false, strict: true }),
  );

  let overrides: Record<string, string> = {};
  try {
    const repoRoot = findRepoRoot(process.cwd());
    overrides = tryLoadConfig(repoRoot)?.vendorOverrides ?? {};
  } catch {
    // `models` is useful outside a repository too; fall back to no overrides.
  }

  const catalog = await loadCatalog({ vendorOverrides: overrides });
  const models = readyModels(catalog);

  if (models.length === 0) {
    process.stdout.write('No ready models found.\n');
    return 0;
  }

  for (const m of models) {
    const levels = supportedLevels(m);
    const context = m.contextWindow === null ? '?' : String(m.contextWindow);
    const inCost = m.inputCostPerMTok === null ? '?' : `$${m.inputCostPerMTok}`;
    const outCost = m.outputCostPerMTok === null ? '?' : `$${m.outputCostPerMTok}`;
    process.stdout.write(
      `${m.provider}/${m.id}\tvendor=${m.vendor}\tcontext=${context}\tin=${inCost}/Mtok\t` +
        `out=${outCost}/Mtok\tthinking=${levels.length > 0 ? levels.join(',') : 'none'}\n`,
    );
  }
  return 0;
}

// -------------------------------------------------------------------------------------------
// show
// -------------------------------------------------------------------------------------------

async function cmdShow(args: readonly string[]): Promise<number> {
  const { positionals } = callParseArgs('show', () =>
    parseArgs({ args: args as string[], options: {}, allowPositionals: true, strict: true }),
  );
  if (positionals.length > 1) {
    throw new UsageError(`show: unexpected extra argument "${positionals[1]}"`);
  }

  const repoRoot = findRepoRoot(process.cwd());
  const reviewsDir = reviewsDirPath(repoRoot);

  let runId: string;
  if (positionals.length === 1) {
    runId = positionals[0]!;
    if (!listRuns(repoRoot).some((r) => r.id === runId)) {
      throw new UsageError(`show: unknown run "${runId}"`);
    }
  } else {
    const lastId = resolveLastRunId(reviewsDir);
    if (lastId === null) {
      throw new UsageError('show: no runs found; run a review first');
    }
    runId = lastId;
  }

  const reportFile = path.join(reviewsDir, runId, 'REPORT.md');
  let content: string;
  try {
    content = fs.readFileSync(reportFile, 'utf8');
  } catch {
    throw new UsageError(`show: could not read the report for run "${runId}"`);
  }
  process.stdout.write(content);
  return 0;
}

// -------------------------------------------------------------------------------------------
// ignore
// -------------------------------------------------------------------------------------------

async function cmdIgnore(args: readonly string[]): Promise<number> {
  const { values, positionals } = callParseArgs('ignore', () =>
    parseArgs({
      args: args as string[],
      options: { reason: { type: 'string' }, run: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    }),
  );
  if (positionals.length !== 1) {
    throw new UsageError('ignore: expected exactly one finding id');
  }
  const findingId = positionals[0]!;

  const repoRoot = findRepoRoot(process.cwd());
  const reviewsDir = reviewsDirPath(repoRoot);

  let runId: string;
  if (values.run !== undefined) {
    runId = values.run;
    if (!listRuns(repoRoot).some((r) => r.id === runId)) {
      throw new UsageError(`ignore: unknown run "${runId}"`);
    }
  } else {
    const lastId = resolveLastRunId(reviewsDir);
    if (lastId === null) {
      throw new UsageError('ignore: no runs found; run a review first');
    }
    runId = lastId;
  }

  const findingsFile = path.join(reviewsDir, runId, 'findings.json');
  let findings: MergedFinding[];
  try {
    findings = JSON.parse(fs.readFileSync(findingsFile, 'utf8')) as MergedFinding[];
  } catch {
    throw new UsageError(`ignore: could not read the merged findings for run "${runId}"`);
  }

  const finding = findings.find((f) => f.id === findingId);
  if (!finding) {
    throw new UsageError(`ignore: unknown finding id "${findingId}" in run "${runId}"`);
  }

  appendIgnore(repoRoot, {
    fingerprint: finding.fingerprint,
    ...(values.reason !== undefined ? { reason: values.reason } : {}),
  });
  process.stdout.write(
    `council-review: suppressed ${findingId} (fingerprint ${finding.fingerprint})\n`,
  );
  return 0;
}

// -------------------------------------------------------------------------------------------
// gc
// -------------------------------------------------------------------------------------------

async function cmdGc(args: readonly string[]): Promise<number> {
  const { values } = callParseArgs('gc', () =>
    parseArgs({
      args: args as string[],
      options: { keep: { type: 'string' } },
      allowPositionals: false,
      strict: true,
    }),
  );

  const repoRoot = findRepoRoot(process.cwd());
  const cfg = tryLoadConfig(repoRoot);
  let keep = cfg?.retain ?? CONFIG_DEFAULTS.retain!;
  if (values.keep !== undefined) {
    const n = Number(values.keep);
    if (!Number.isInteger(n) || n < 0) {
      throw new UsageError(`gc: --keep must be a non-negative integer, got "${values.keep}"`);
    }
    keep = n;
  }

  const { removed } = gcRuns(repoRoot, keep);
  // `gc` never itself holds an active snapshot (it builds none), so it passes no roots of its
  // own to exempt -- protection for a snapshot a *different* process is still using comes from
  // `sweepOrphans` reading each candidate's own liveness marker (its owning process's PID),
  // written by `buildSnapshot` before freezing the tree.
  const sweep = sweepOrphans([]);

  if (removed.length === 0) {
    process.stdout.write('council-review: nothing to prune\n');
  } else {
    process.stdout.write(
      `council-review: removed ${removed.length} run(s): ${removed.join(', ')}\n`,
    );
  }
  if (sweep.removed > 0) {
    process.stdout.write(`council-review: swept ${sweep.removed} orphaned snapshot(s)\n`);
  }
  return 0;
}

// -------------------------------------------------------------------------------------------
// review (bare invocation)
// -------------------------------------------------------------------------------------------

async function cmdReview(args: readonly string[], pickerIO: PickerIO | undefined): Promise<number> {
  const { values } = callParseArgs('review', () =>
    parseArgs({
      args: args as string[],
      options: {
        staged: { type: 'boolean' },
        range: { type: 'string' },
        revision: { type: 'string' },
        paths: { type: 'string', multiple: true },
        base: { type: 'string' },
        models: { type: 'string' },
        pick: { type: 'boolean' },
        thinking: { type: 'string' },
        'allow-correlated': { type: 'boolean' },
        timeout: { type: 'string' },
        'max-tokens': { type: 'string' },
        since: { type: 'string' },
        'fail-on': { type: 'string' },
        'no-suppress': { type: 'boolean' },
        json: { type: 'boolean' },
        pane: { type: 'boolean' },
        'no-pane': { type: 'boolean' },
        direction: { type: 'string' },
        handoff: { type: 'string' },
        'no-notify': { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    }),
  );

  if (values.models !== undefined && values.pick) {
    throw new UsageError('conflicting panel flags: --models and --pick may not be combined');
  }

  const selectors: ScopeSelectors = {
    staged: values.staged,
    range: values.range,
    revision: values.revision,
    paths: values.paths?.flatMap((p) =>
      p
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
    base: values.base,
  };
  checkScopeSelectors(selectors);

  let thinkingFlag: ThinkingLevel | undefined;
  if (values.thinking !== undefined) {
    if (!isThinkingLevel(values.thinking)) {
      throw new UsageError(`invalid --thinking level: "${values.thinking}"`);
    }
    thinkingFlag = values.thinking;
  }

  const allowCorrelated = Boolean(values['allow-correlated']);
  const jsonMode = Boolean(values.json);
  const noSuppress = Boolean(values['no-suppress']);

  const repoRoot = findRepoRoot(process.cwd());

  const havePanelOverride = values.models !== undefined || Boolean(values.pick);
  const configExists = fs.existsSync(configPath(repoRoot));

  let cfg: CouncilConfig;
  if (!configExists && havePanelOverride) {
    cfg = {
      version: CONFIG_DEFAULTS.version!,
      baseBranch: CONFIG_DEFAULTS.baseBranch!,
      panel: [],
      includeContextFiles: CONFIG_DEFAULTS.includeContextFiles!,
      timeoutSeconds: CONFIG_DEFAULTS.timeoutSeconds!,
      maxOutputTokens: CONFIG_DEFAULTS.maxOutputTokens!,
      mergeWindow: CONFIG_DEFAULTS.mergeWindow!,
      claimSimilarity: CONFIG_DEFAULTS.claimSimilarity!,
      failOn: CONFIG_DEFAULTS.failOn!,
      retain: CONFIG_DEFAULTS.retain!,
    };
  } else {
    // Missing config with no override throws here, its message already directing to `init`
    // (config.ts's own wording satisfies the "Review without configuration" scenario verbatim).
    cfg = loadConfig(repoRoot);
  }

  const catalog = await loadCatalog({ vendorOverrides: cfg.vendorOverrides ?? {} });

  let reviewers: Reviewer[];
  let persistNewPanel = false;
  if (values.models !== undefined) {
    reviewers = resolveSpecPanel(values.models, catalog, cfg, thinkingFlag);
  } else if (values.pick) {
    reviewers = await pickPanel(catalog, pickerIO);
    persistNewPanel = true;
  } else {
    if (cfg.panel.length === 0) {
      throw new UsageError(
        'no panel configured; run "council-review init" or pass --models/--pick.',
      );
    }
    reviewers = resolveConfiguredPanel(cfg.panel, catalog, cfg, thinkingFlag);
  }

  // Guard #1: end of selection.
  enforceIndependence(reviewers, allowCorrelated);

  if (persistNewPanel) {
    persistPanel(repoRoot, reviewers);
  }

  setPaneTitle(`council-review: ${reviewers.length} models`);

  const scope = await resolveScope(repoRoot, selectors, { baseBranch: cfg.baseBranch });

  if (scope.empty) {
    out(jsonMode, 'council-review: nothing to review; the resolved scope is empty.\n');
    return 0;
  }

  if (values.pane && !values['no-pane']) {
    const direction = values.direction === 'vertical' ? 'vertical' : 'horizontal';
    const delegateArgv = [process.argv[0]!, process.argv[1]!, ...args];
    const { attempted } = splitPaneAndRun(delegateArgv, direction);
    if (attempted) {
      out(jsonMode, 'council-review: review delegated to a new pane.\n');
      return 0;
    }
    // Not attempted (outside herdr, or already running inside a delegated pane): fall through
    // and run the review in this process.
  }

  // Guard #2: immediately before launch, so a hand-edited config panel is checked too.
  enforceIndependence(reviewers, allowCorrelated);

  const run = createRunDir(repoRoot);
  const patchPath = writePatch(run.path, scope);

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let snapshot: Snapshot | undefined;
  try {
    // `handleSignals: false`: this process manages SIGINT/SIGTERM itself (above) to report the
    // interruption and apply its own exit code before exiting. snapshot.ts's own signal handling
    // calls `process.exit()` synchronously and would otherwise race that reporting and win,
    // since Node invokes every listener for one signal synchronously and none are awaited.
    // `snapshot.cleanup()` in the `finally` block below remains the sole cleanup path here, and
    // stays idempotent, so it composes safely with `runPanel`'s own call to it on the AbortError
    // path.
    snapshot = await buildSnapshot(repoRoot, scope, {
      include: cfg.snapshot?.include,
      handleSignals: false,
    });

    const timeoutSeconds =
      values.timeout !== undefined
        ? parsePositiveInt('--timeout', values.timeout)
        : cfg.timeoutSeconds;
    const maxOutputTokens =
      values['max-tokens'] !== undefined
        ? parsePositiveInt('--max-tokens', values['max-tokens'])
        : cfg.maxOutputTokens;

    const activeSnapshot = snapshot;
    let outcome: RunPanelOutcome;
    try {
      outcome = await withStdoutRedirectedToStderr(jsonMode, () =>
        runPanel({
          reviewers,
          snapshot: activeSnapshot,
          repoRoot,
          patchPath,
          prompt: TASK_PROMPT,
          extensionPath: resolveExtensionPath(),
          includeContextFiles: cfg.includeContextFiles,
          timeoutSeconds,
          maxOutputTokens,
          signal: controller.signal,
        }),
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        out(jsonMode, 'council-review: run interrupted.\n');
        return 130;
      }
      throw err;
    }

    for (const r of outcome.results) {
      const notice = formatClampNotice(
        `${r.reviewer.provider}/${r.reviewer.model}`,
        r.reviewer.thinking,
      );
      if (notice) out(jsonMode, `council-review: ${notice}\n`);
    }

    const reviewerFindings: ReviewerFindings[] = outcome.results.map((r) => ({
      reviewerId: `${r.reviewer.provider}/${r.reviewer.model}`,
      findings: r.findings,
    }));
    const ignoreFile = loadIgnore(repoRoot);
    const mergeOutcome = mergeFindings(reviewerFindings, {
      mergeWindow: cfg.mergeWindow,
      claimSimilarity: cfg.claimSimilarity,
      ignore: ignoreFile,
      suppress: !noSuppress,
    });

    let resolution: ResolutionOutcome | null = null;
    if (values.since !== undefined) {
      const baseline = loadPreviousFindings(run.reviewsDir, values.since);
      resolution = diffAgainstBaseline(mergeOutcome.findings, baseline);
    }

    for (const r of outcome.results) writeReviewerArtifacts(run, r);
    const findingsPath = writeFindings(run, mergeOutcome.findings);

    const manifestInput: ManifestInput = {
      run,
      identity: activeSnapshot.identity,
      scope,
      outcome,
      suppressed: mergeOutcome.suppressed,
      overrides: { allowCorrelated, includeContextFiles: cfg.includeContextFiles, noSuppress },
      hostVersion: null,
    };
    writeManifest(manifestInput);
    const reportPath = writeReport(run, manifestInput, mergeOutcome.findings, resolution);
    const handoffPath = writeHandoff(run, findingsPath);
    updateLastPointer(run);

    const summary =
      `${mergeOutcome.findings.length} finding(s), ${outcome.reporting}/${outcome.launched} ` +
      `reviewer(s) reported${outcome.degraded ? ' (degraded)' : ''}`;
    notifyComplete(summary, Boolean(values['no-notify']));
    if (values.handoff !== undefined) {
      handoffToAgent(values.handoff, handoffPath);
    }

    if (jsonMode) {
      emitMachineReadableFindings(mergeOutcome.findings);
    } else {
      process.stdout.write(`council-review: report written to ${reportPath}\n`);
    }

    const failOn = values['fail-on'] !== undefined ? validateFailOn(values['fail-on']) : cfg.failOn;
    const breached = breachesThreshold(mergeOutcome.findings, failOn);

    // Exit-code taxonomy (cli spec's "Exit-code taxonomy" requirement): a degraded panel outranks
    // a threshold breach, so a CI job never mistakes a partial panel for a clean measurement.
    if (outcome.degraded) return 3;
    if (breached) return 1;
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    // Idempotent; always called regardless of which path above returned or threw, including the
    // AbortError path (where runPanel has already called it itself).
    snapshot?.cleanup();
  }
}

// -------------------------------------------------------------------------------------------
// Dispatch
// -------------------------------------------------------------------------------------------

const KNOWN_SUBCOMMANDS = ['init', 'models', 'show', 'ignore', 'gc'] as const;
type Subcommand = (typeof KNOWN_SUBCOMMANDS)[number];

function isKnownSubcommand(s: string): s is Subcommand {
  return (KNOWN_SUBCOMMANDS as readonly string[]).includes(s);
}

async function dispatch(argv: readonly string[], pickerIO: PickerIO | undefined): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    process.stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }

  if (argv.length === 0 || argv[0]!.startsWith('-')) {
    return cmdReview(argv, pickerIO);
  }

  const sub = argv[0]!;
  const rest = argv.slice(1);

  if (!isKnownSubcommand(sub)) {
    process.stderr.write(`council-review: unrecognised subcommand "${sub}"\n\n`);
    printHelp(null, process.stderr);
    return 2;
  }

  switch (sub) {
    case 'init':
      return cmdInit(rest, pickerIO);
    case 'models':
      return cmdModels(rest);
    case 'show':
      return cmdShow(rest);
    case 'ignore':
      return cmdIgnore(rest);
    case 'gc':
      return cmdGc(rest);
  }
}

function handleTopLevelError(err: unknown): number {
  if (err instanceof Error && err.name === 'AbortError') {
    process.stderr.write('council-review: interrupted\n');
    return 130;
  }
  if (err instanceof FlagParseError) {
    process.stderr.write(`council-review: ${err.message}\n\n`);
    printHelp(err.subcommand, process.stderr);
    return err.exitCode;
  }
  if (hasExitCode(err)) {
    process.stderr.write(`council-review: ${err.message}\n`);
    return err.exitCode;
  }
  process.stderr.write(
    `council-review: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  return 70;
}

/** Dependencies `runCli` accepts beyond argv. `pickerIO` threads through to every call this
 * invocation makes to `pickPanel` (`init`, `init --pick`, and a review run's own `--pick`);
 * omitting it (the production path) leaves `pickPanel` on its own default, real-stdio behaviour
 * unchanged. This exists purely as a test seam -- there is no CLI flag for it, and it is not
 * part of the library's public surface. */
export interface CliDeps {
  pickerIO?: PickerIO;
}

/** Exported for `test/unit/cli.test.ts`, which drives the CLI in-process rather than by spawning
 * a subprocess for every scenario. Not part of the library's public surface (not re-exported from
 * `src/index.ts`). */
export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    const subToken = argv.find((a) => !a.startsWith('-'));
    printHelp(subToken && isKnownSubcommand(subToken) ? subToken : null);
    return 0;
  }
  try {
    return await dispatch(argv, deps.pickerIO);
  } catch (err) {
    return handleTopLevelError(err);
  }
}
