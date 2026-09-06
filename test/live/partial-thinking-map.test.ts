/**
 * Task 18.2 — live check settling the per-key thinking-level fallback question for a model with
 * a PARTIALLY specified, MERGED `thinkingLevelMap`.
 *
 * Background (design.md, "Risks / Trade-offs"): `src/thinking.ts`'s `isLevelSupported` applies
 * the same absent-key fallback ("off" through "high" supported, "xhigh"/"max" unsupported)
 * whether the whole `thinkingLevelMap` is missing or just one key is missing from an otherwise
 * partially specified map. The host's own documentation states that fallback for the
 * wholly-absent-map case; whether it also applies *per key* inside a partial map is the open
 * question this test settles empirically.
 *
 * CORRECTION #1 (2026-09-04): this file originally targeted `opencode-go/glm-5.2`, on the
 * strength of a `SCRATCH/CONTRACT.md` note recording its map as omitting `off` and `max`. That
 * note was wrong — not because the catalog drifted, but because it described an *override
 * fragment* from `~/.pi/agent/models.json` in isolation and mislabelled it as the model's
 * effective map. pi's own `applyModelOverride` deep-merges an override's `thinkingLevelMap` onto
 * the store's (`{...model.thinkingLevelMap, ...override.thinkingLevelMap}`), so `off`/`max`
 * (already specified in the store) survive into the merged map. Fixed by selecting a partial-map
 * model DYNAMICALLY at run time instead of hardcoding one — see `findPartialMapCandidates` below.
 *
 * CORRECTION #2 (2026-09-04) — the important one: an earlier version of this file, after
 * correction #1, ran once and reported "CONFIRMED." That verdict was retracted after a deeper
 * trace of pi's own bundle showed the signal it relied on — the `thinking_level_changed` session
 * event — cannot fire at all for a CLI-startup `--thinking` flag, regardless of the true clamping
 * outcome. Full trace, recorded durably in `HOST-VERSION.md`'s "Live end-to-end verification"
 * section:
 *
 *   1. At CLI startup, `thinkingLevel = options.thinkingLevel ?? settingsManager.getDefaultThinkingLevel()
 *      ?? DEFAULT_THINKING_LEVEL` resolves the raw requested level (`parsed.thinking` when
 *      `--thinking` was given).
 *   2. `thinkingLevel = clampThinkingLevel(model, thinkingLevel)` — **clamped here, silently,
 *      before the Agent exists**, using pi's own real view of the model's supported levels.
 *   3. `new Agent({initialState:{...,thinkingLevel},...})` — the Agent's state is constructed
 *      directly with this already-clamped value (`createMutableAgentState`'s `??"off"` fallback
 *      never triggers, since `initialState.thinkingLevel` is defined).
 *   4. Only when `--thinking` was actually given: `session.setThinkingLevel(session.thinkingLevel)`
 *      is called post-construction — but `session.thinkingLevel` is a getter reading straight back
 *      `agent.state.thinkingLevel`, i.e. the SAME value step 3 just set. Inside the gated setter,
 *      `previousLevel` reads that same value again, so `isChanging` (`effectiveLevel!==previousLevel`)
 *      is **always false** here: the "official" event-emitting setter is only ever asked to
 *      re-confirm a value pi already finished resolving one step earlier.
 *
 * Consequence: the old probe's fallback ("no event ⇒ requested level was accepted unclamped") is
 * reached on EVERY CLI-startup request and always reports back exactly the requested level,
 * whether or not real clamping happened in step 2. A run against the *contrary* reading (omitted
 * key ⇒ unsupported, silently clamped down) would have produced identical observable output to a
 * run against the *confirming* reading. The old design's pass was consistent with both hypotheses
 * and discriminated neither — an error caught only by tracing further into the bundle than the
 * first pass did.
 *
 * THE FIX: read the resolved level directly from state instead of waiting for a change
 * notification about it. `ExtensionContext.thinkingLevel` (available to any `pi.on(...)` handler)
 * is a live getter reading `session.thinkingLevel` -> `agent.state.thinkingLevel` directly (traced
 * at the `ExtensionContext` construction site: `thinkingLevel:this.session.thinkingLevel`) — the
 * TRUE, already-resolved value, with no dependency on any event ever firing. This test loads a
 * tiny, purpose-built diagnostic extension (`thinking-level-probe-extension.mjs`, in this same
 * directory — never `dist/reviewer-tools.js`, since this check needs no reviewer tools at all)
 * that reports `ctx.thinkingLevel` to stderr from `before_agent_start`/`agent_start` hooks. See
 * that file's own header for the full mechanism.
 *
 * If no marker line is ever observed, the probe FAILS LOUDLY as inconclusive — it does NOT fall
 * back to assuming anything, which is exactly the flaw being fixed here. A check that cannot
 * disconfirm its own hypothesis on silence is not a check.
 *
 * TWO PHASES, up to two live calls:
 *
 *   Phase 1 — SELF-CHECK, runs first. An instrument that cannot show a clamp cannot prove its
 *   absence (the exact lesson of correction #2's flawed design). Before trusting a silent-looking
 *   result on the real question, this probes a level the target's map marks EXPLICITLY unsupported
 *   (`map[level]===null`, never merely omitted, so the clamp is certain by construction, not by
 *   any fallback assumption this test is trying to check) and asserts `ctx.thinkingLevel` reports
 *   the CLAMPED value — genuinely different from what was requested. If phase 1 fails (no marker,
 *   or the reported level equals the request when it should not), the test stops there: the
 *   instrument has not proven it can discriminate, so phase 2 would settle nothing even if it
 *   "passed."
 *
 *   Phase 2 — the real verdict, runs only if phase 1 passes. Probes the selected model's omitted
 *   key (`off` when omitted, else the lowest-ordinal omitted key in the `off`..`high` band) and
 *   compares the reported level against `src/thinking.ts`'s prediction, exactly as before.
 *
 * VERDICT: phase 2's assertion IS the verdict, conditioned on phase 1 having proven the instrument
 * sound. If phase 2 passes, `src/thinking.ts`'s per-key-inside-a-partial-map fallback reading is
 * confirmed for the selected model and the design's open risk is closed for the case exercised
 * here. If it fails, or either phase reports inconclusive, per the team lead's brief: report the
 * evidence; do not amend `src/thinking.ts` or the `model-discovery` spec from this file — routing
 * that change is the team lead's call.
 *
 * COST: up to two tiny raw host calls (no findings-block prompt, no reviewer tools loaded at all —
 * this diagnostic extension registers none), each capped at `MAX_PROBE_OUTPUT_TOKENS` output
 * tokens via this file's own lightweight usage-watching kill switch (mirroring `runner.ts`'s
 * `checkBudget`, since this bypasses the runner and its budget enforcement) and a short wall-clock
 * timeout, with a prompt that asks for a single-word reply and touches no tool. Expect a small
 * fraction of a cent per call at the cheapest available candidate's rates.
 *
 * RESULT (2026-09-04, pi 0.84.4): run once, authorised, in this two-phase form. Target model both
 * phases: `openrouter/openai/gpt-oss-safeguard-20b`. Phase 1 requested the explicitly-unsupported
 * `off`; observed clamp to `minimal`, exactly as `src/thinking.ts` predicts — the instrument
 * proved it can show a real clamp. Phase 2 requested the omitted `minimal`; observed `minimal`
 * unclamped, exactly as predicted. **Verdict: CONFIRMED.** See `HOST-VERSION.md`'s "Live
 * end-to-end verification" section for the full record, including the two earlier, wrong verdicts
 * this file went through (first a false CONFIRMED from the retracted event-based design, then a
 * conservative ATTEMPTED-INCONCLUSIVE while the fix was being authored) — both are kept there, not
 * erased, because that file's job is to say what was actually verified.
 *
 * RESULT (2026-09-06, pi 0.85.1): run once, authorised, as post-upgrade re-verification against an
 * isolated `pi 0.85.1` install (via `COUNCIL_PI_BIN`, never touching this machine's global
 * `0.84.4`). Same target model both phases: `openrouter/openai/gpt-oss-safeguard-20b`. Phase 1
 * requested `off`; observed clamp to `minimal` as predicted, proving the instrument can still show
 * a clamp through 0.85.1's read path. Phase 2 requested the omitted `minimal`; observed `minimal`
 * unclamped, exactly as predicted. **Verdict: CONFIRMED**, same as 0.84.4. Note that on 0.85.1
 * `ExtensionContext.thinkingLevel` reaches `agent.state.thinkingLevel` through a longer chain than
 * the single inline getter described above — see `HOST-VERSION.md`'s "Host re-verification
 * (2026-09-06, pi 0.85.1)" section for the full traced chain, and its "Re-verifying after a host
 * upgrade" step 4 for why that chain must be re-traced (not assumed unchanged) on every future
 * upgrade.
 *
 * DO NOT set COUNCIL_LIVE=1 or invoke `pi` as a side effect of reading, editing or reviewing this
 * file. It has already been run twice, each time authorised (see the RESULT entries above) — do
 * not re-run it without a fresh, explicit instruction, and never as a side effect of routine work
 * on this file.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog, readyModels, type CatalogModel } from '../../src/providers.js';
import { supportedLevels, clampLevel } from '../../src/thinking.js';
import { THINKING_LEVELS, type ThinkingLevel } from '../../src/levels.js';
import {
  buildReviewerArgv,
  buildReviewerEnv,
  reviewerCwd,
  resolveHostBin,
} from '../../src/reviewer-spawn.js';

const LIVE = process.env.COUNCIL_LIVE === '1';

/** The diagnostic probe extension — see its own header. NOT `dist/reviewer-tools.js`: this check
 *  needs no reviewer tools, only `ExtensionContext.thinkingLevel`. */
const PROBE_EXTENSION_PATH = fileURLToPath(
  new URL('./thinking-level-probe-extension.mjs', import.meta.url),
);

const PROBE_PROMPT =
  'Reply with exactly one word: ACK. Do not call any tool. Do not explain your reasoning.';
const MAX_PROBE_OUTPUT_TOKENS = 200;
const PROBE_TIMEOUT_MS = 30_000;
const MARKER_PREFIX = 'COUNCIL_THINKING_PROBE:';

/**
 * The band where the two competing readings of the absent-key fallback actually disagree: an
 * omitted key here resolves "supported" under `src/thinking.ts`'s current per-key reading (the
 * one this test is checking), and is the interesting probe target. `xhigh`/`max` are the mirror
 * case (omitted resolves "unsupported") and are not what discriminates the readings as directly.
 */
const FALLBACK_SUPPORTED_BAND: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
];

/**
 * Same floor-guarded rate ranking as `smoke.test.ts`'s `combinedRate` — see that function's own
 * comment for why non-positive/non-finite rates are treated as unknown rather than "free".
 * Duplicated rather than imported: these are two independent, self-contained live-test files by
 * design (neither depends on the other, so a future edit to one can't silently change the other's
 * behaviour), matching how `SCRATCH/CONTRACT.md`'s "Module ownership" table already treats every
 * file under `test/live/` as one section's own, self-contained surface.
 */
function combinedRate(m: CatalogModel): number | null {
  const { inputCostPerMTok: i, outputCostPerMTok: o } = m;
  if (i === null || o === null) return null;
  if (!Number.isFinite(i) || !Number.isFinite(o) || i <= 0 || o <= 0) return null;
  return i + o;
}

interface PartialMapCandidate {
  model: CatalogModel;
  /** Keys from `FALLBACK_SUPPORTED_BAND` absent from this model's map, in ascending level order. */
  omitted: ThinkingLevel[];
  /** Keys anywhere in the map (any level, not just the band) with an EXPLICIT `null` value — i.e.
   *  certainly-unsupported by construction, not by any fallback assumption. Used for the phase-1
   *  self-check, which must not itself depend on the very fallback reading being tested. */
  explicitlyUnsupported: ThinkingLevel[];
}

function explicitlyUnsupportedLevels(map: CatalogModel['thinkingLevelMap']): ThinkingLevel[] {
  if (map === undefined) return [];
  return THINKING_LEVELS.filter((level) => map[level] === null);
}

/**
 * Every ready, reasoning model whose `thinkingLevelMap` is non-empty and omits at least one key
 * from `FALLBACK_SUPPORTED_BAND`, cheapest (by `combinedRate`, unknown-rate models sorted last)
 * first, then further preferring a model whose map ALSO carries an explicit `null` somewhere (a
 * "self-sufficient" candidate that can serve both the phase-1 self-check and the phase-2 real
 * probe without a second, unrelated model) over one that only offers the omitted-key half.
 */
function findPartialMapCandidates(models: readonly CatalogModel[]): PartialMapCandidate[] {
  const candidates: PartialMapCandidate[] = [];
  for (const model of models) {
    if (!model.reasoning) continue;
    const map = model.thinkingLevelMap;
    if (map === undefined || Object.keys(map).length === 0) continue;
    const omitted = FALLBACK_SUPPORTED_BAND.filter(
      (level) => !Object.prototype.hasOwnProperty.call(map, level),
    );
    if (omitted.length > 0) {
      candidates.push({ model, omitted, explicitlyUnsupported: explicitlyUnsupportedLevels(map) });
    }
  }
  candidates.sort((a, b) => {
    const selfSufficientA = a.explicitlyUnsupported.length > 0;
    const selfSufficientB = b.explicitlyUnsupported.length > 0;
    if (selfSufficientA !== selfSufficientB) return selfSufficientA ? -1 : 1;
    const ra = combinedRate(a.model);
    const rb = combinedRate(b.model);
    if (ra !== null && rb !== null && ra !== rb) return ra - rb;
    if (ra !== null && rb === null) return -1;
    if (ra === null && rb !== null) return 1;
    return 0;
  });
  return candidates;
}

/**
 * The cheapest ready, reasoning model carrying at least one EXPLICIT `null` entry anywhere in its
 * map — used only as a fallback self-check target when no `findPartialMapCandidates` result is
 * self-sufficient (see that function's own comment).
 */
function findCheapestExplicitlyUnsupportedCandidate(
  models: readonly CatalogModel[],
): { model: CatalogModel; explicitlyUnsupported: ThinkingLevel[] } | null {
  const candidates = models
    .filter((m) => m.reasoning)
    .map((model) => ({
      model,
      explicitlyUnsupported: explicitlyUnsupportedLevels(model.thinkingLevelMap),
    }))
    .filter((c) => c.explicitlyUnsupported.length > 0);
  candidates.sort((a, b) => {
    const ra = combinedRate(a.model);
    const rb = combinedRate(b.model);
    if (ra !== null && rb !== null && ra !== rb) return ra - rb;
    if (ra !== null && rb === null) return -1;
    if (ra === null && rb !== null) return 1;
    return 0;
  });
  return candidates[0] ?? null;
}

/** `off` when it's one of the omitted keys (the clearest discriminator); otherwise the
 *  lowest-ordinal omitted key in the band. */
function pickProbeLevel(omitted: readonly ThinkingLevel[]): ThinkingLevel {
  if (omitted.includes('off')) return 'off';
  return [...omitted].sort((a, b) => THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b))[0]!;
}

/** Lowest-ordinal explicitly-unsupported level — arbitrary among ties, deterministic. */
function pickSelfCheckLevel(explicitlyUnsupported: readonly ThinkingLevel[]): ThinkingLevel {
  return [...explicitlyUnsupported].sort(
    (a, b) => THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b),
  )[0]!;
}

interface MarkerReading {
  source: string;
  level: string | null;
}

interface ProbeResult {
  /** Every `COUNCIL_THINKING_PROBE:` marker line the diagnostic extension printed to stderr,
   *  parsed, in arrival order. Empty when the extension never fired — that is an INCONCLUSIVE
   *  result, not evidence of anything, and must be treated as a hard failure by the caller. */
  markers: MarkerReading[];
  /** Every JSON event line from stdout — kept only as failure-diagnostic context (e.g. to show a
   *  real error stream when the marker never appears), never consulted for the verdict itself. */
  stdoutEvents: Array<Record<string, unknown>>;
  stderrTail: string[];
  exitCode: number | null;
  killedForBudget: boolean;
  killedForTimeout: boolean;
}

/**
 * Spawns the REAL host directly (bypassing `runner.ts`) with the exact isolation argument vector
 * `reviewer-spawn.ts` composes for a real reviewer (`-nbt -ne -e <path> ...`), loading the
 * diagnostic probe extension instead of the real reviewer tools — this check needs no tool
 * surface, only the extension's own stderr marker.
 */
async function runRawProbe(
  provider: string,
  model: string,
  thinking: ThinkingLevel,
  cwd: string,
): Promise<ProbeResult> {
  const argv = buildReviewerArgv({
    extensionPath: PROBE_EXTENSION_PATH,
    provider,
    model,
    thinking,
    includeContextFiles: false,
    prompt: PROBE_PROMPT,
  });
  const env = buildReviewerEnv({
    ...process.env,
    COUNCIL_SNAPSHOT_ROOT: cwd,
    COUNCIL_REPO_ROOT: cwd,
  });
  const hostBin = resolveHostBin(process.env);

  const child = spawn(hostBin, argv, {
    cwd: reviewerCwd(cwd),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const markers: MarkerReading[] = [];
  const stdoutEvents: Array<Record<string, unknown>> = [];
  const stderrTail: string[] = [];
  let killedForBudget = false;
  let killedForTimeout = false;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let cumulativeOutputTokens = 0;

  function handleStdoutLine(line: string): void {
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // unparseable stdout lines are not this probe's concern; tolerated silently.
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    stdoutEvents.push(parsed as Record<string, unknown>);

    // Lightweight stand-in for `runner.ts`'s `checkBudget`: this probe bypasses the runner
    // entirely, so it must enforce its own output-token ceiling to stay cheap.
    const usage = (parsed as { usage?: { output?: unknown } }).usage;
    if (usage && typeof usage.output === 'number') {
      cumulativeOutputTokens = usage.output;
      if (cumulativeOutputTokens > MAX_PROBE_OUTPUT_TOKENS && !killedForBudget) {
        killedForBudget = true;
        child.kill('SIGTERM');
      }
    }
  }

  function handleStderrLine(line: string): void {
    if (line.length === 0) return;
    stderrTail.push(line);
    if (stderrTail.length > 40) stderrTail.shift(); // bounded diagnostic buffer only.
    if (!line.startsWith(MARKER_PREFIX)) return;
    const payload = line.slice(MARKER_PREFIX.length);
    try {
      const parsed = JSON.parse(payload) as { source?: unknown; level?: unknown };
      markers.push({
        source: typeof parsed.source === 'string' ? parsed.source : '(unknown)',
        level: typeof parsed.level === 'string' ? parsed.level : null,
      });
    } catch {
      // A malformed marker line is itself diagnostic (kept in stderrTail above) but not fatal —
      // fall through and let the "no valid marker" path handle it as inconclusive.
    }
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let idx: number;
    while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
      handleStdoutLine(stdoutBuffer.slice(0, idx));
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk;
    let idx: number;
    while ((idx = stderrBuffer.indexOf('\n')) !== -1) {
      handleStderrLine(stderrBuffer.slice(0, idx));
      stderrBuffer = stderrBuffer.slice(idx + 1);
    }
  });

  const timeoutHandle = setTimeout(() => {
    killedForTimeout = true;
    child.kill('SIGTERM');
  }, PROBE_TIMEOUT_MS);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
  });
  clearTimeout(timeoutHandle);
  if (stdoutBuffer.length > 0) handleStdoutLine(stdoutBuffer);
  if (stderrBuffer.length > 0) handleStderrLine(stderrBuffer);

  return { markers, stdoutEvents, stderrTail, exitCode, killedForBudget, killedForTimeout };
}

/**
 * Runs one probe against `provider`/`model` requesting `level`, and returns the single agreed
 * `ExtensionContext.thinkingLevel` reading. Throws (hard failure, never a silent fallback) when:
 *   - no marker was ever observed (INCONCLUSIVE: the instrument produced no signal at all), or
 *   - the two hooks disagreed (should be structurally impossible; worth surfacing, not picking one).
 * Shared by both phases so the "no silent fallback" fix applies identically to each.
 */
async function runProbeAndExtractLevel(
  label: string,
  provider: string,
  model: string,
  level: ThinkingLevel,
): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'council-review-live-thinking-'));
  try {
    const result = await runRawProbe(provider, model, level, tmp);

    if (result.markers.length === 0) {
      throw new Error(
        [
          `${label}: INCONCLUSIVE — the diagnostic probe extension never printed a ` +
            `${MARKER_PREFIX} marker line for ${provider}/${model} requesting "${level}". No ` +
            `direct reading of ExtensionContext.thinkingLevel was observed, so this run settles ` +
            `nothing and must NOT be treated as evidence either way.`,
          `exitCode=${result.exitCode} killedForBudget=${result.killedForBudget} ` +
            `killedForTimeout=${result.killedForTimeout}`,
          `stdout events captured: ${result.stdoutEvents.length}`,
          `stderr tail:`,
          ...result.stderrTail,
        ].join('\n'),
      );
    }

    const levels = new Set(result.markers.map((m) => m.level));
    if (levels.size !== 1) {
      throw new Error(
        `${label}: the extension's hooks disagreed on the resolved thinking level for ` +
          `${provider}/${model} requesting "${level}": ${JSON.stringify(result.markers)} — this ` +
          `should be structurally impossible (both hooks read the same live ` +
          `ExtensionContext.thinkingLevel getter within the same, single, no-tool-call turn); ` +
          `report this to the team lead before trusting either value.`,
      );
    }

    return result.markers[0]!.level!;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe.skipIf(!LIVE)('live check: partial (merged) thinkingLevelMap per-key fallback', () => {
  it(
    'phase 1 proves the instrument can show a clamp; phase 2 (run only if phase 1 passes) settles the real question',
    async () => {
      const catalog = await loadCatalog();
      const ready = readyModels(catalog);
      const candidates = findPartialMapCandidates(ready);
      expect(
        candidates.length,
        'no ready, reasoning model on this host currently has a genuinely partial merged ' +
          'thinkingLevelMap (omitting at least one of off..high) — this live check has nothing ' +
          "to probe against right now; see this file's header for why a hardcoded target is " +
          'exactly the wrong fix for that',
      ).toBeGreaterThan(0);

      const chosen = candidates[0]!;

      // ---- Self-check target: same model when it's self-sufficient (sorted first by
      // findPartialMapCandidates when available), else the cheapest model anywhere with a
      // certain (explicit-null) unsupported level. ----
      const selfCheck =
        chosen.explicitlyUnsupported.length > 0
          ? { model: chosen.model, explicitlyUnsupported: chosen.explicitlyUnsupported }
          : findCheapestExplicitlyUnsupportedCandidate(ready);
      expect(
        selfCheck,
        'no ready, reasoning model on this host carries even one EXPLICIT null thinking-level ' +
          'entry — there is nothing to build a certain self-check probe against right now, so ' +
          'this live check cannot prove its own instrument works and must not proceed',
      ).not.toBeNull();
      const selfCheckLevel = pickSelfCheckLevel(selfCheck!.explicitlyUnsupported);
      const selfCheckSupported = supportedLevels(selfCheck!.model);
      const selfCheckExpectedClamp = clampLevel(selfCheckLevel, selfCheckSupported);
      expect(
        selfCheckExpectedClamp,
        `internal: clampLevel produced null for a reasoning model (${selfCheck!.model.provider}/` +
          `${selfCheck!.model.id}) with supported=${JSON.stringify(selfCheckSupported)} — that ` +
          'should be impossible for a model with any supported level at all',
      ).not.toBeNull();

      console.error(
        `[live thinking-map check] PHASE 1 self-check: ${selfCheck!.model.provider}/` +
          `${selfCheck!.model.id}, requesting explicitly-unsupported "${selfCheckLevel}", ` +
          `expecting clamp to "${selfCheckExpectedClamp}"`,
      );
      const selfCheckObserved = await runProbeAndExtractLevel(
        'phase 1 (self-check)',
        selfCheck!.model.provider,
        selfCheck!.model.id,
        selfCheckLevel,
      );
      // The instrument must show a REAL clamp: not the requested level, and specifically the
      // predicted clamp target. Either failure means "this instrument cannot show a clamp" and
      // phase 2 must not run — a passing phase 2 after a failed phase 1 would prove nothing.
      expect(
        selfCheckObserved,
        `PHASE 1 FAILED: requested the certainly-unsupported "${selfCheckLevel}" for ` +
          `${selfCheck!.model.provider}/${selfCheck!.model.id} and ExtensionContext.thinkingLevel ` +
          `reported back the SAME level ("${selfCheckObserved}") instead of a clamped one. This ` +
          `instrument cannot demonstrate a clamp, so it cannot be trusted to demonstrate the ` +
          `absence of one either — STOPPING before phase 2. Report this to the team lead; do not ` +
          `treat phase 2 as meaningful even if it happens to "pass."`,
      ).not.toBe(selfCheckLevel);
      expect(
        selfCheckObserved,
        `PHASE 1: requested "${selfCheckLevel}" (certainly unsupported) for ` +
          `${selfCheck!.model.provider}/${selfCheck!.model.id}; expected clamp to ` +
          `"${selfCheckExpectedClamp}" but observed "${selfCheckObserved}" — the instrument DID ` +
          `show a clamp (differs from the request, so it is not the earlier vacuous-fallback ` +
          `failure mode), but not the one src/thinking.ts's own clampLevel predicts. Report this ` +
          `mismatch to the team lead; do not proceed to treat phase 2 as settling anything until ` +
          `this is understood.`,
      ).toBe(selfCheckExpectedClamp);
      console.error(
        `[live thinking-map check] PHASE 1 passed: observed clamp "${selfCheckObserved}" as predicted.`,
      );

      // ---- Phase 2: the real question, only reached because phase 1 proved the instrument sound. ----
      const probeLevel = pickProbeLevel(chosen.omitted);
      const supported = supportedLevels(chosen.model);
      const expected = clampLevel(probeLevel, supported);

      console.error(
        `[live thinking-map check] PHASE 2 real probe: ${chosen.model.provider}/${chosen.model.id} ` +
          `(omitted=${JSON.stringify(chosen.omitted)}, probing "${probeLevel}", ` +
          `supported=${JSON.stringify(supported)}, expected effective="${expected}")`,
      );
      const observed = await runProbeAndExtractLevel(
        'phase 2 (real verdict)',
        chosen.model.provider,
        chosen.model.id,
        probeLevel,
      );
      expect(
        observed,
        `requested "${probeLevel}" (an omitted map key) for ${chosen.model.provider}/` +
          `${chosen.model.id}: src/thinking.ts predicts effective="${expected}" (supported=` +
          `${JSON.stringify(supported)}); ExtensionContext.thinkingLevel reported "${observed}" ` +
          `directly from agent state. A mismatch here means the omitted-key fallback does NOT ` +
          `apply the same way inside a partial map as it does for a wholly absent one — report ` +
          `this to the team lead; do not amend src/thinking.ts or the model-discovery spec from ` +
          `this file.`,
      ).toBe(expected);
    },
    PROBE_TIMEOUT_MS * 2 + 20_000,
  );
});
