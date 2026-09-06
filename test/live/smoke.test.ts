/**
 * Task 18.1 — opt-in live smoke test.
 *
 * Runs ONE real reviewer, end to end, against the REAL `pi` host and the REAL model catalog on
 * this machine: `loadCatalog()` (no `piBin`/`homeDir` override — the actual host and the actual
 * `~/.pi/agent/` config), a real throwaway git repository, a real frozen snapshot, and the real
 * `runPanel()` runner spawning the real host process with the real isolation flag vector from
 * `reviewer-spawn.ts`.
 *
 * Purpose (design.md, "Risks / Trade-offs"): "keep one live smoke test that fails loudly on a
 * flag rename rather than degrading quietly." If a future `pi` release renames or removes one of
 * the isolation flags `buildReviewerArgv` composes, the spawned process will reject the argument
 * vector (or otherwise misbehave) and the reviewer will come back `state: 'failed'` — which this
 * test turns into a hard, diagnostic-carrying failure rather than a silently-degraded pass. This
 * is deliberately NOT a subset of the fake-host-backed runner tests: those pin *our* parsing of a
 * recorded stream shape; this one is the only test in the suite that pins the real host's actual
 * behaviour against that same parsing.
 *
 * Model selection: dynamic, not hardcoded. At run time this test loads the real catalog, keeps
 * only ready providers' models, and picks the cheapest one by combined input+output cost per
 * million tokens (falling back to any ready model if every one has unknown rates), preferring a
 * non-reasoning model so cost is not inflated by hidden reasoning tokens. This keeps the test
 * from silently pointing at a model that has been deprecated or repriced since this file was
 * written, at the cost of not being able to name one fixed dollar figure here.
 * `combinedRate` treats any non-finite or non-positive (zero included) rate as unknown and ranks
 * it strictly behind every model with a real known rate — see that function's own comment for why
 * this floor exists: an earlier run of this file picked a catalog entry carrying a `-1000000`
 * USD/Mtok sentinel rate and reported a nonsense negative cost as a result.
 *
 * RESULT (2026-09-04, pi 0.84.4): run once, authorised. `state=ok`, one schema-valid finding
 * returned, real host round-trip confirmed end to end — this test's purpose (prove the flag
 * surface and event-stream shape still work against the pinned host) is satisfied. See
 * `HOST-VERSION.md` for the recorded verdict. Per the team lead: do NOT re-run this file solely to
 * re-confirm a fixed selector picks a different model — that is not worth a second live spend.
 * Re-run it only after an actual `pi` upgrade (per `HOST-VERSION.md`'s re-verification checklist)
 * or a change to the isolation flag vector in `reviewer-spawn.ts`.
 *
 * RESULT (2026-09-06, pi 0.85.1): run once, authorised, as post-upgrade re-verification against an
 * isolated `pi 0.85.1` install (via `COUNCIL_PI_BIN`, never touching this machine's global
 * `0.84.4`). Dynamically selected `openrouter/mistralai/mistral-nemo`. `state=ok`, `in=2084
 * out=114`, cost `$0.000043`, one schema-valid finding. Confirms the isolation flag surface and
 * event-stream shape still work end to end against 0.85.1. See `HOST-VERSION.md`'s "Host
 * re-verification (2026-09-06, pi 0.85.1)" section for the full record.
 *
 * COST: bounded by `MAX_OUTPUT_TOKENS` (2000) and `TIMEOUT_SECONDS` (120) below, plus the input
 * side (the task prompt, a single-file diff of a few lines, and the findings-block instructions —
 * on the order of a few hundred input tokens). At typical OpenRouter-class rates for a genuinely
 * cheap model (sub-$1/Mtok each direction, per the aion-labs/aion-2.0 example rate recorded in
 * `SCRATCH/CONTRACT.md` — $0.8 in / $1.6 out per Mtok), one run of this test should cost a small
 * fraction of a cent to a few cents. It is still a real charge against a real account — see the
 * repository-wide instruction that this file is authored and ready, but must NOT be executed
 * without explicit authorisation (COUNCIL_LIVE=1 must be set deliberately, never as a side effect
 * of a bare `npm test` or CI run — see `vitest.config.ts`, which only collects this directory at
 * all when that flag is already set).
 *
 * Preconditions to actually run this file (once authorised):
 *   - `npm run build` first, so `dist/reviewer-tools.js` exists (the CLI resolves the same path
 *     at runtime; this test resolves it the same way from `src/` relative to this file).
 *   - `pi` on `PATH` (or `COUNCIL_PI_BIN` pointing at it), authenticated for at least one ready
 *     provider.
 *   - `COUNCIL_LIVE=1 npx vitest run --project live test/live/smoke.test.ts`
 *
 * DO NOT set COUNCIL_LIVE=1 or invoke `pi` as a side effect of reading, editing or reviewing this
 * file. It has already been run twice, each time authorised (see the RESULT entries above) — do
 * not re-run it without a fresh, explicit instruction, and never as a side effect of routine work
 * on this file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog, readyModels, type CatalogModel } from '../../src/providers.js';
import { resolveThinking } from '../../src/thinking.js';
import { resolveScope } from '../../src/scope.js';
import { buildSnapshot, writePatch, type Snapshot } from '../../src/snapshot.js';
import { runPanel } from '../../src/runner.js';
import type { Reviewer } from '../../src/panel.js';
import { createTestRepo, type TestRepo } from '../helpers/git-repo.js';

// Gate 1 (primary): `vitest.config.ts`'s `live` project only globs `test/live/**/*.test.ts` at
// all when COUNCIL_LIVE=1 was set at config-load time, so a bare `vitest run` / `npm test`
// collects zero tests from this file regardless of the guard below.
//
// Gate 2 (belt-and-suspenders): in case this file is ever pointed at directly
// (`vitest run test/live/smoke.test.ts`, bypassing the project filter), skip explicitly too.
const LIVE = process.env.COUNCIL_LIVE === '1';

const EXTENSION_PATH = fileURLToPath(new URL('../../dist/reviewer-tools.js', import.meta.url));

const TASK_PROMPT = `You are one independent reviewer in a multi-model code review panel. You are
given a unified diff patch and read-only access to a frozen snapshot of the repository at the
tree the patch ends at, via your council_read, council_grep, council_list and council_git tools.

This is a smoke test with a trivial, deliberately obvious patch. Review it briefly and honestly;
do not pad your answer.`;

const TIMEOUT_SECONDS = 120;
const MAX_OUTPUT_TOKENS = 2000;

/**
 * Combined per-Mtok rate used only to rank candidates by cost; `null` when either rate is
 * unknown OR fails a `> 0` and finite floor. The floor matters beyond `providers.ts`'s own
 * `null`-for-negative/non-finite normalisation (which this already benefits from): a live run of
 * this file previously picked `openrouter/openrouter/auto`, whose catalog entry carried a
 * `-1000000` USD/Mtok sentinel rate (OpenRouter's placeholder for "billed dynamically by whatever
 * model the auto-router picks") — the most negative number in the catalog sorts first under plain
 * ascending-numeric ranking, so it looked like "the cheapest model" and produced a nonsense
 * negative cost figure from real usage. `providers.ts` has since started normalising a
 * negative/non-finite rate to `null` at the source, but this ranking treats *any* non-positive
 * rate (zero included, not just negative) as unknown too, and ranks it strictly behind every
 * model with a real known rate — belt-and-suspenders against this exact failure mode recurring
 * from a different data anomaly upstream.
 */
function combinedRate(m: CatalogModel): number | null {
  const { inputCostPerMTok: i, outputCostPerMTok: o } = m;
  if (i === null || o === null) return null;
  if (!Number.isFinite(i) || !Number.isFinite(o) || i <= 0 || o <= 0) return null;
  return i + o;
}

/**
 * Picks the cheapest ready model, preferring one with known rates over one with unknown rates
 * (unknown is not necessarily cheap, just unquantified), and preferring non-reasoning over
 * reasoning among equally-ranked candidates so cost is not inflated by hidden reasoning tokens.
 */
function pickCheapestModel(models: readonly CatalogModel[]): CatalogModel | null {
  if (models.length === 0) return null;
  const ranked = [...models].sort((a, b) => {
    const ra = combinedRate(a);
    const rb = combinedRate(b);
    if (ra !== null && rb !== null && ra !== rb) return ra - rb;
    if (ra !== null && rb === null) return -1;
    if (ra === null && rb !== null) return 1;
    // Equal (or both unknown) rate: prefer non-reasoning.
    if (a.reasoning !== b.reasoning) return a.reasoning ? 1 : -1;
    return 0;
  });
  return ranked[0]!;
}

describe.skipIf(!LIVE)('live smoke: one cheap model end-to-end against the real host', () => {
  let repo: TestRepo | undefined;
  let snapshot: Snapshot | undefined;
  let runDir: string | undefined;

  afterEach(() => {
    snapshot?.cleanup();
    if (repo) repo.cleanup();
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    repo = undefined;
    snapshot = undefined;
    runDir = undefined;
  });

  it(
    'runs a single cheap reviewer to completion and gets back an ok/timeout/over-budget result — never an unexplained "failed"',
    async () => {
      // --- 1. A trivial repo with one obvious, cheap-to-review defect on top of one commit. ---
      repo = createTestRepo();
      repo.writeAndCommit(
        'src/add.js',
        'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n',
        'initial commit',
      );
      // An unstaged change with an obvious off-by-one style defect (subtracts instead of adds),
      // deliberately trivial so a cheap model can review it in very few output tokens.
      repo.writeFile(
        'src/add.js',
        'function add(a, b) {\n  return a - b; // BUG: should add, not subtract\n}\nmodule.exports = { add };\n',
      );

      const scope = await resolveScope(repo.root, {}, { baseBranch: 'main' });
      expect(
        scope.empty,
        'expected the deliberate unstaged edit to produce a non-empty scope',
      ).toBe(false);

      runDir = mkdtempSync(join(tmpdir(), 'council-review-live-run-'));
      const patchPath = writePatch(runDir, scope);

      // --- 2. Real catalog, real readiness, cheapest ready model. ---
      const catalog = await loadCatalog();
      const ready = readyModels(catalog);
      expect(
        ready.length,
        'no ready provider found on this host; authenticate at least one provider with `pi auth login` before running the live suite',
      ).toBeGreaterThan(0);

      const model = pickCheapestModel(ready)!;
      console.error(
        `[live smoke] selected ${model.provider}/${model.id} ` +
          `(in=${model.inputCostPerMTok ?? '?'} out=${model.outputCostPerMTok ?? '?'} USD/Mtok, reasoning=${model.reasoning})`,
      );

      const thinking = resolveThinking(model, {}); // no sources: cheapest, simplest — no explicit level requested.
      const reviewer: Reviewer = {
        provider: model.provider,
        model: model.id,
        vendor: model.vendor,
        catalog: model,
        thinking,
      };

      // --- 3. Real frozen snapshot of the tree the patch ends at (worktree scope: on-disk state). ---
      snapshot = await buildSnapshot(repo.root, scope, {});

      // --- 4. Real runner, real host process, real isolation flags. ---
      const outcome = await runPanel({
        reviewers: [reviewer],
        snapshot,
        repoRoot: repo.root,
        patchPath,
        prompt: TASK_PROMPT,
        extensionPath: EXTENSION_PATH,
        includeContextFiles: false,
        timeoutSeconds: TIMEOUT_SECONDS,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });

      expect(outcome.launched).toBe(1);
      const result = outcome.results[0]!;

      // The core "fails loudly on a flag rename" assertion: a renamed/removed isolation flag
      // makes the real `pi` process reject its argument vector or otherwise error out immediately,
      // which surfaces here as `state: 'failed'` with a truncated or empty stream. Surface every
      // diagnostic we have so a real failure here is actionable, not just red.
      if (result.state === 'failed') {
        throw new Error(
          [
            `live reviewer reported 'failed' — this is the exact signal the smoke test exists to`,
            `catch (see the file header). Investigate before assuming this is a flaky model call.`,
            `error: ${result.error ?? '(none)'}`,
            `finalText (first 1000 chars): ${result.finalText.slice(0, 1000)}`,
            `last 15 raw trace lines:`,
            ...result.rawTrace.slice(-15),
          ].join('\n'),
        );
      }

      // `timeout` / `over-budget` are tolerated outcomes of a real model call (slow provider, a
      // verbose model despite the low ceiling) — NOT the flag-rename failure mode this test is
      // for — but every other field is still checked so a genuine `ok` result is verified fully.
      expect(['ok', 'timeout', 'over-budget']).toContain(result.state);
      expect(result.startedAt).toBeLessThanOrEqual(result.endedAt);
      expect(result.usage.outputTokens).toBeGreaterThan(0);

      if (result.state === 'ok') {
        expect(
          result.findings,
          'an ok reviewer must have schema-valid findings, even if empty',
        ).not.toBeNull();
        expect(Array.isArray(result.findings)).toBe(true);
        expect(result.finalText.length).toBeGreaterThan(0);
      }

      console.error(
        `[live smoke] state=${result.state} in=${result.usage.inputTokens} out=${result.usage.outputTokens} ` +
          `cost=${result.cost ?? 'unknown'} findings=${result.findings?.length ?? 'null'}`,
      );
    },
    // Generous test-level timeout beyond the reviewer's own wall-clock budget, to cover process
    // spawn/catalog-read/snapshot overhead around the bounded reviewer call itself.
    (TIMEOUT_SECONDS + 30) * 1000,
  );
});
