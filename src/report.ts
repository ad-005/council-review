/**
 * Writes everything a run leaves behind: the run directory itself and the most-recent pointer,
 * the manifest, the per-reviewer raw artifacts, the merged findings document, the human report,
 * the handoff prompt, and the machine-readable stdout form of the findings document. Also reads
 * and prunes past runs (`listRuns`, `gcRuns`), which back the `show` and `gc` CLI commands.
 *
 * See `openspec/changes/add-council-review/specs/council-review/reporting/spec.md` for the
 * requirements this implements, and CONTRACT.md's "PINNED: run-directory layout and the
 * most-recent pointer" for the exact on-disk shape other sections (`resolve.ts`, `cli.ts`) read
 * against:
 *
 *   .council/reviews/
 *     <run-id>/
 *       manifest.json
 *       patch.diff              written by snapshot.ts's writePatch(), never by this module
 *       findings.json           JSON array of MergedFinding
 *       REPORT.md
 *       HANDOFF.md
 *       reviewers/<slug>.findings.json | .text.md | .trace.jsonl
 *     last -> <run-id>          SYMLINK to the most recent run directory
 *
 * This module never calls a model, never touches the network, and never calls `process.exit`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { MergedFinding } from './merge.js';
import type { ResolutionOutcome, ResolutionState } from './resolve.js';
import type { ReviewerResult, RunPanelOutcome } from './runner.js';
import type { ResolvedScope } from './scope.js';
import type { SnapshotIdentity } from './snapshot.js';
import type { ResolvedThinking } from './thinking.js';

// -------------------------------------------------------------------------------------------
// Run directory
// -------------------------------------------------------------------------------------------

export interface RunDir {
  id: string;
  path: string;
  reviewsDir: string;
}

/** `<projectRoot>/.council/reviews` — the container directory for every run. */
export function reviewsDirPath(projectRoot: string): string {
  return path.join(projectRoot, '.council', 'reviews');
}

/**
 * A timestamp id down to the millisecond, in a fixed-width, purely numeric-plus-`T`/`Z` form
 * (`20260904T153012123Z`). Fixed-width fields with no separators mean lexicographic string order
 * is exactly chronological order, and every character is filesystem-safe on POSIX (and Windows,
 * incidentally, since the usual offender — `:` — never appears).
 */
function timestampId(now: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}${pad(now.getUTCMilliseconds(), 3)}Z`
  );
}

function isEexistError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

/**
 * Creates a fresh, uniquely named run directory (plus its `reviewers/` subdirectory) under
 * `<projectRoot>/.council/reviews`. On the vanishingly unlikely event that two runs start in the
 * same millisecond, a numeric suffix is appended to the id until directory creation succeeds —
 * the suffixed id is still lexicographically greater than its unsuffixed base (a string that is a
 * strict prefix of another always sorts before it), so chronological ordering is preserved either
 * way.
 */
export function createRunDir(projectRoot: string): RunDir {
  const reviewsDir = reviewsDirPath(projectRoot);
  fs.mkdirSync(reviewsDir, { recursive: true });

  const base = timestampId(new Date());
  let id = base;
  let dir = path.join(reviewsDir, id);
  let suffix = 1;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (err) {
      if (!isEexistError(err)) throw err;
      suffix += 1;
      id = `${base}-${suffix}`;
      dir = path.join(reviewsDir, id);
    }
  }
  fs.mkdirSync(path.join(dir, 'reviewers'));
  return { id, path: dir, reviewsDir };
}

/**
 * Atomically creates or replaces the `last` symlink to point at `run`. Symlinking to the run's
 * own id (a relative target, not an absolute path) keeps the pointer valid even if the whole
 * `.council/reviews` directory is later moved or copied.
 *
 * `fs.renameSync` is used rather than removing then recreating `last`, because rename is atomic
 * on POSIX: there is no window in which `last` is absent or pointing at a half-written target.
 * The caller must be able to rely on this — it's what makes "the pointer is updated even by a
 * degraded run" true in the presence of a crash immediately after this call.
 */
export function updateLastPointer(run: RunDir): void {
  const lastPath = path.join(run.reviewsDir, 'last');
  const tmpPath = path.join(
    run.reviewsDir,
    `.last.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.symlinkSync(run.id, tmpPath, 'dir');
  try {
    fs.renameSync(tmpPath, lastPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup of the temp link; the rename error is what matters
    }
    throw err;
  }
}

// -------------------------------------------------------------------------------------------
// Filename slugification (task 15.2)
// -------------------------------------------------------------------------------------------

function sanitizeSegment(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'x';
}

/**
 * Deterministic, collision-free filename slug for a `provider/model` pair. A pure
 * lowercase-and-replace scheme is not collision-free on its own — `openrouter/a/b` and
 * `openrouter/a-b` would both sanitize to the same text — so the slug always carries an 8-hex-char
 * SHA-256 prefix of the exact, untouched `"provider/model"` string. Two different models collide
 * on a filename only if they collide on that hash, which is what "collision-free" is grounded in
 * here rather than in the sanitization itself.
 */
export function slugifyModel(provider: string, model: string): string {
  const key = `${provider}/${model}`;
  const hash = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8);
  return `${hash}-${sanitizeSegment(provider)}__${sanitizeSegment(model)}`;
}

// -------------------------------------------------------------------------------------------
// Per-reviewer raw artifacts (task 15.3)
// -------------------------------------------------------------------------------------------

/**
 * Writes the three raw artifacts for one reviewer, regardless of its outcome — including a
 * reviewer that failed validation on both attempts. `findings` is written as `null` (valid JSON)
 * when the reviewer never produced a schema-valid block, which is itself informative: the file's
 * presence, not its content, is what the spec requires for every reviewer.
 */
export function writeReviewerArtifacts(run: RunDir, r: ReviewerResult): void {
  const slug = slugifyModel(r.reviewer.provider, r.reviewer.model);
  const dir = path.join(run.path, 'reviewers');
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    path.join(dir, `${slug}.findings.json`),
    `${JSON.stringify(r.findings, null, 2)}\n`,
    'utf8',
  );

  const heading = `${r.reviewer.provider}/${r.reviewer.model}`;
  const textParts: string[] = [`# ${heading} — attempt 1\n\n${r.finalText}`];
  if (r.repairText !== null) {
    textParts.push(`\n\n---\n\n# ${heading} — repair attempt\n\n${r.repairText}`);
  }
  fs.writeFileSync(path.join(dir, `${slug}.text.md`), `${textParts.join('')}\n`, 'utf8');

  const trace = r.rawTrace.length > 0 ? `${r.rawTrace.join('\n')}\n` : '';
  fs.writeFileSync(path.join(dir, `${slug}.trace.jsonl`), trace, 'utf8');
}

// -------------------------------------------------------------------------------------------
// Merged findings document
// -------------------------------------------------------------------------------------------

/** The exact text written to `findings.json` and emitted in machine-readable mode — kept as one
 * function so the two can never drift apart. */
export function serializeFindings(findings: readonly MergedFinding[]): string {
  return `${JSON.stringify(findings, null, 2)}\n`;
}

export function writeFindings(run: RunDir, findings: readonly MergedFinding[]): string {
  const dest = path.join(run.path, 'findings.json');
  fs.writeFileSync(dest, serializeFindings(findings), 'utf8');
  return dest;
}

/**
 * Machine-readable output mode (task 15.8): writes ONLY the merged findings document to `stream`
 * (defaulting to `process.stdout`, overridable for tests). This function touches no other stream
 * and prints nothing else, which is what keeps stdout parseable in that mode — the caller (the
 * CLI) is responsible for routing progress and diagnostics to stderr instead of calling
 * `console.log`/`process.stdout.write` itself while this mode is active.
 */
export function emitMachineReadableFindings(
  findings: readonly MergedFinding[],
  stream: NodeJS.WritableStream = process.stdout,
): void {
  stream.write(serializeFindings(findings));
}

// -------------------------------------------------------------------------------------------
// Manifest (task 15.4)
// -------------------------------------------------------------------------------------------

export interface ManifestInput {
  run: RunDir;
  identity: SnapshotIdentity;
  scope: ResolvedScope;
  outcome: RunPanelOutcome;
  suppressed: number;
  overrides: { allowCorrelated: boolean; includeContextFiles: boolean; noSuppress: boolean };
  hostVersion: string | null;
}

/**
 * Writes the manifest: everything needed to explain and reproduce a run, per the reporting
 * spec's "Manifest contract" requirement. Deliberately omits `scope.patch` (the diff text) —
 * that content already exists verbatim as `patch.diff`, and there is no reason for a document
 * whose scenarios are about reproducibility metadata to carry a second copy of it.
 *
 * Nothing here ever reads `process.env`, a credential store, or reviewer stdout beyond the
 * already-structured `ReviewerResult` fields (`usage`, `cost`, `depth`, `state`, `error`) — see
 * the "Manifest carries no credentials" test in `test/unit/report.test.ts`.
 */
export function writeManifest(i: ManifestInput): string {
  const manifest = {
    runId: i.run.id,
    createdAt: new Date().toISOString(),
    hostVersion: i.hostVersion,
    reviewed: {
      commit: i.identity.head,
      dirty: i.identity.dirty,
      treeHash: i.identity.treeHash,
    },
    scope: {
      mode: i.scope.mode,
      selectors: i.scope.selectors,
      baseBranch: i.scope.baseBranch,
      mergeBase: i.scope.mergeBase,
      endRevision: i.scope.endRevision,
      head: i.scope.head,
      dirty: i.scope.dirty,
      empty: i.scope.empty,
      files: i.scope.files,
    },
    panel: i.outcome.results.map((r) => ({
      provider: r.reviewer.provider,
      model: r.reviewer.model,
      vendor: r.reviewer.vendor,
      thinking: {
        requested: r.reviewer.thinking.requested,
        effective: r.reviewer.thinking.effective,
        applicable: r.reviewer.thinking.applicable,
        clamped: r.reviewer.thinking.clamped,
      },
    })),
    reviewers: i.outcome.results.map((r) => ({
      provider: r.reviewer.provider,
      model: r.reviewer.model,
      state: r.state,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      durationMs: r.endedAt - r.startedAt,
      usage: r.usage,
      cost: r.cost,
      depth: {
        filesOpenedCount: r.depth.filesOpened.length,
        filesOpened: r.depth.filesOpened,
        searches: r.depth.searches,
      },
      ...(r.error !== undefined ? { error: r.error } : {}),
    })),
    counts: {
      launched: i.outcome.launched,
      reporting: i.outcome.reporting,
      suppressed: i.suppressed,
    },
    cost: {
      total: i.outcome.totalCost, // null === unknown, never coerced to 0
      incomplete: i.outcome.costIncomplete,
    },
    degraded: i.outcome.degraded,
    overrides: {
      allowCorrelated: i.overrides.allowCorrelated,
      includeContextFiles: i.overrides.includeContextFiles,
      noSuppress: i.overrides.noSuppress,
    },
  };

  const dest = path.join(i.run.path, 'manifest.json');
  fs.writeFileSync(dest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return dest;
}

// -------------------------------------------------------------------------------------------
// REPORT.md (task 15.6)
// -------------------------------------------------------------------------------------------

function formatThinking(t: ResolvedThinking): string {
  if (!t.applicable) return 'n/a';
  if (t.effective === null) return 'none';
  return t.clamped ? `${t.effective} (clamped from ${t.requested})` : t.effective;
}

function formatCost(cost: number | null): string {
  return cost === null ? 'unknown' : `$${cost.toFixed(4)}`;
}

function formatDepth(d: { filesOpened: string[]; searches: number }): string {
  const files = d.filesOpened.length;
  return `${files} file${files === 1 ? '' : 's'} opened, ${d.searches} search${d.searches === 1 ? '' : 'es'}`;
}

function renderResolutionSection(resolution: ResolutionOutcome): string[] {
  if (resolution.baselineRunId === null) {
    return [
      '## Resolution',
      '',
      'No baseline run was available for comparison, so findings below carry no resolution ' +
        'marking. This is the first run to be diffed, not a run with zero new findings.',
      '',
    ];
  }

  const { resolved, stillPresent, new: newCount } = resolution.counts;
  const lines = [
    '## Resolution',
    '',
    `Compared against run \`${resolution.baselineRunId}\`: ${resolved} resolved, ` +
      `${stillPresent} still present, ${newCount} new.`,
    '',
  ];
  if (resolution.resolved.length > 0) {
    lines.push('Resolved since the baseline run:', '');
    for (const f of resolution.resolved) {
      lines.push(`- \`${f.file}:${f.line}\` — ${f.claim}`);
    }
    lines.push('');
  }
  return lines;
}

function renderFinding(
  f: MergedFinding,
  resolutionByFingerprint: Map<string, ResolutionState | null> | null,
): string[] {
  const marker = resolutionByFingerprint?.get(f.fingerprint) ?? null;
  const markerText = marker ? ` [${marker}]` : '';
  const location = f.endLine !== null ? `${f.file}:${f.line}-${f.endLine}` : `${f.file}:${f.line}`;

  const lines = [
    `### ${f.id} — ${f.severity.toUpperCase()} · ${f.category}${markerText}`,
    '',
    `**Location:** \`${location}\``,
    `**Agreement:** ${f.agreement.raisers}/${f.agreement.reporting} reviewers (${f.raisedBy.join(', ')})`,
    `**Claim:** ${f.claim}`,
    `**Impact:** ${f.impact}`,
  ];
  if (f.unverifiable) {
    lines.push(
      '',
      '_This finding references a path absent from the reviewed snapshot; it could not be verified._',
    );
  }
  if (f.evidence.length > 0) {
    lines.push('', '**Evidence:**');
    for (const e of f.evidence) lines.push(`- ${e}`);
  }
  if (f.suggestions.length > 0) {
    lines.push('', '**Suggestions:**');
    for (const s of f.suggestions) lines.push(`- ${s}`);
  }
  lines.push('');
  return lines;
}

/**
 * Writes the human report. Ordering is fixed by the spec and is exactly the order this function
 * builds it in: the resolution summary (when resolution diffing was requested — i.e. `resolution
 * !== null` — whether or not a baseline turned out to be available), then the panel, then
 * findings in merged (agreement) order, then the footer's suppressed/degraded/cost summary.
 *
 * A run with no findings still produces a complete, valid report: the panel section is unaffected
 * and the findings section states plainly that none were raised, per the "Report for a run with
 * no findings" scenario.
 */
export function writeReport(
  run: RunDir,
  i: ManifestInput,
  findings: readonly MergedFinding[],
  resolution: ResolutionOutcome | null,
): string {
  const lines: string[] = [`# Council Review — ${run.id}`, ''];

  if (resolution !== null) {
    lines.push(...renderResolutionSection(resolution));
  }

  lines.push(
    '## Panel',
    '',
    '| Reviewer | Vendor | Thinking | Cost | Depth |',
    '|---|---|---|---|---|',
  );
  for (const r of i.outcome.results) {
    lines.push(
      `| ${r.reviewer.provider}/${r.reviewer.model} | ${r.reviewer.vendor} | ` +
        `${formatThinking(r.reviewer.thinking)} | ${formatCost(r.cost)} | ${formatDepth(r.depth)} |`,
    );
  }
  lines.push('');

  lines.push('## Findings', '');
  if (findings.length === 0) {
    lines.push('No findings were raised.', '');
  } else {
    const resolutionByFingerprint =
      resolution !== null
        ? new Map(resolution.current.map((f) => [f.fingerprint, f.resolution]))
        : null;
    for (const f of findings) {
      lines.push(...renderFinding(f, resolutionByFingerprint));
    }
  }

  lines.push('## Summary', '');
  lines.push(`- Launched: ${i.outcome.launched}, reporting: ${i.outcome.reporting}`);
  lines.push(`- Suppressed: ${i.suppressed}`);

  const degradedReviewers = i.outcome.results.filter((r) => r.state !== 'ok');
  if (degradedReviewers.length > 0) {
    const detail = degradedReviewers
      .map(
        (r) =>
          `${r.reviewer.provider}/${r.reviewer.model} (${r.state}${r.error ? `: ${r.error}` : ''})`,
      )
      .join('; ');
    lines.push(`- Degraded (${degradedReviewers.length}): ${detail}`);
  } else {
    lines.push('- Degraded: none');
  }

  const costSuffix = i.outcome.costIncomplete
    ? ' (incomplete — one or more reviewers had no cost data)'
    : '';
  lines.push(
    `- Total cost: ${i.outcome.totalCost === null ? 'unknown' : `$${i.outcome.totalCost.toFixed(4)}`}${costSuffix}`,
  );
  lines.push('');

  const dest = path.join(run.path, 'REPORT.md');
  fs.writeFileSync(dest, lines.join('\n'), 'utf8');
  return dest;
}

// -------------------------------------------------------------------------------------------
// HANDOFF.md (task 15.7)
// -------------------------------------------------------------------------------------------

/**
 * Writes the handoff prompt — addressed to a coding agent, not to a person — naming the run
 * directory and the merged findings file, requiring reproduction before any fix, directing
 * ambiguity to the raw per-reviewer artifacts, and framing a low-agreement finding as a
 * hypothesis to test rather than an established defect.
 */
export function writeHandoff(run: RunDir, findingsPath: string): string {
  const reviewersDir = path.join(run.path, 'reviewers');
  const text = [
    '# Council review handoff',
    '',
    'You are a coding agent picking up the output of an automated, multi-model code review panel.',
    'Treat this document as your instructions for what to do next, not as a report to read.',
    '',
    `Run directory: \`${run.path}\``,
    `Merged findings: \`${findingsPath}\``,
    '',
    '## Before you change any code',
    '',
    'Every entry in the merged findings file is a claim made by one or more independent reviewer ' +
      'models reading a frozen snapshot of the changed code, not a confirmed defect. For each ' +
      'finding you intend to act on: reproduce it first — read the referenced file and line range ' +
      'yourself and confirm the claimed behavior actually occurs — before you change anything. Do ' +
      'not edit code to address a finding you have not reproduced.',
    '',
    '## When a finding is ambiguous',
    '',
    "If a merged finding's claim, location or severity is unclear, do not guess at what the " +
      `reviewer meant. Consult that reviewer's raw output under \`${reviewersDir}\`: the ` +
      '`<slug>.text.md` file holds its verbatim response (both attempts, if it needed a repair), ' +
      'and the `<slug>.trace.jsonl` file holds every tool call and stream event it produced. The ' +
      'merged claim is a summary; the raw artifact is the source of truth for what a reviewer ' +
      'actually said.',
    '',
    '## Low-agreement findings are hypotheses, not defects',
    '',
    "Each finding records how many of the panel's reviewers raised it out of how many reported " +
      '(its `agreement` field). A finding raised by only one or two reviewers out of a larger ' +
      'panel is a hypothesis worth testing, not an established defect: treat it exactly as you ' +
      "would treat a colleague's unconfirmed suspicion — worth investigating, not worth acting on " +
      'without confirmation. A finding every reporting reviewer agreed on still requires the same ' +
      'reproduction step above, but a low-agreement one additionally requires you to explain, in ' +
      'your own investigation, why the disagreeing reviewers did not see it before treating it as ' +
      'real.',
    '',
  ].join('\n');

  const dest = path.join(run.path, 'HANDOFF.md');
  fs.writeFileSync(dest, text, 'utf8');
  return dest;
}

// -------------------------------------------------------------------------------------------
// Reading and pruning past runs (tasks feeding the `show` and `gc` CLI commands)
// -------------------------------------------------------------------------------------------

/** Every run directory under `<projectRoot>/.council/reviews`, newest first. Lexicographic sort
 * is chronological sort, per `createRunDir`'s id format. Returns `[]` when no run has ever been
 * written (the reviews directory does not exist yet), rather than throwing. */
export function listRuns(projectRoot: string): RunDir[] {
  const reviewsDir = reviewsDirPath(projectRoot);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(reviewsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const ids = entries
    .filter((e) => e.name !== 'last' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => {
      try {
        return fs.statSync(path.join(reviewsDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();

  return ids.map((id) => ({ id, path: path.join(reviewsDir, id), reviewsDir }));
}

/** Resolves the `last` symlink to the run id it points at, or `null` if it is absent, dangling, or
 * not a symlink at all. Mirrors `resolve.ts`'s own reading of this pointer. */
function resolveLastRunId(reviewsDir: string): string | null {
  try {
    return path.basename(fs.realpathSync(path.join(reviewsDir, 'last')));
  } catch {
    return null;
  }
}

/**
 * Prunes stored runs, retaining the `keep` most recent ones, and never removing the run `last`
 * resolves to even if it would otherwise fall outside that count (it never does in practice,
 * since `last` always points at the newest run, but the protection is explicit rather than
 * incidental). Returns the ids removed; an empty array when there was nothing to prune.
 */
export function gcRuns(projectRoot: string, keep: number): { removed: string[] } {
  const reviewsDir = reviewsDirPath(projectRoot);
  const runs = listRuns(projectRoot); // newest first
  const protectedId = resolveLastRunId(reviewsDir);

  const keepCount = Math.max(0, keep);
  const toKeep = new Set(runs.slice(0, keepCount).map((r) => r.id));
  if (protectedId !== null) toKeep.add(protectedId);

  const removed: string[] = [];
  for (const run of runs) {
    if (toKeep.has(run.id)) continue;
    fs.rmSync(run.path, { recursive: true, force: true });
    removed.push(run.id);
  }
  return { removed };
}
