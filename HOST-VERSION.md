# Verified host version

`council-review` spawns the `pi` review-agent host as a subprocess (see
`src/reviewer-spawn.ts` and `src/providers.ts`). Its isolation guarantees, its model-catalog
reading, and its JSON event-stream parsing all depend on that binary's exact flag surface and
output shapes, which are **not** part of any stability contract `council-review` controls.

## Currently verified against

```
pi 0.84.4
```

npm package: `@earendil-works/pi-coding-agent`. Verified on this development machine by static
analysis of the installed package's shipped `.d.ts` declarations and its minified bundle (see
[`docs/design/council-review-design.md`](./docs/design/council-review-design.md)'s
"Empirical baseline" and the recon notes it was built from), plus `pi auth check`. No live model
call was required to establish the facts this tool depends on.

What was verified, specifically (each has a corresponding assertion in the test suite — see
"Re-verifying after a host upgrade" below for which tests to re-run):

- The isolation flag surface: with `-nbt -ne -e <path>` and no `-t`, a reviewer's only callable
  tools are exactly the ones the loaded extension registers — no host built-in, no other
  extension's tools, no re-enabling path reachable from extension code.
- The `--mode json` event stream shape: one JSON object per line, the event union `runner.ts`
  parses, and the fact that `console.log`/banner output is redirected to stderr in headless
  modes regardless of `-ne`, so the JSON stream on stdout is clean by construction.
- `pi auth check --provider <p> --json` returns `{"status":"ready","provider":...,"authType":...}`
  and nothing else — no credential material.
- `~/.pi/agent/models-store.json` and `~/.pi/agent/models.json` shapes, including the tristate
  `thinkingLevelMap`.
- Thinking-level clamping (`clampThinkingLevel` in `pi`'s own bundle) is silent and always
  succeeds for any of the 7 canonical levels — never a hard failure.
- `--no-session` reliably prevents any file being written under `~/.pi/agent/sessions/`.

## Live end-to-end verification (2026-09-04)

The two static-analysis-derived facts above that genuinely needed a live model call to settle have
now been run, once each, against real pi 0.84.4 — see `test/live/smoke.test.ts` and
`test/live/partial-thinking-map.test.ts` for the harnesses.

**Smoke test (`test/live/smoke.test.ts`): CONFIRMED.** A single reviewer, spawned with the real
isolation argument vector against a dynamically-selected cheap ready model, completed with
`state=ok` and one schema-valid finding. This confirms the isolation flag surface and the
`--mode json` event-stream shape still work exactly as the static analysis above predicted, against
this specific pinned host version. **Caveat:** the run's own reported cost figure was invalid — the
model it happened to select (`openrouter/openrouter/auto`) carried a `-1000000` USD/Mtok sentinel
rate in its catalog entry (OpenRouter's placeholder for "billed dynamically"), which the test's
cost-ranking logic at the time treated as "cheapest" rather than "unknown." Two fixes landed after
this run: `src/providers.ts` now normalises a negative/non-finite catalog rate to `null` at the
source, and `smoke.test.ts`'s own model-selection ranking independently floors any non-positive or
non-finite rate to "unknown," ranked behind every model with a real known rate. The test was **not**
re-run after these fixes — its purpose (prove the real pipeline still works, fail loudly on a flag
rename) was already fully satisfied by the run that happened; only the incidental cost figure from
that specific run was wrong, and it is not treated as a fact about the host.

**Partial-map fallback check (`test/live/partial-thinking-map.test.ts`): CONFIRMED — the design's
stated open question is genuinely settled.** This file recorded two earlier, wrong verdicts before
this one: first CONFIRMED (retracted — the probe watched an event that cannot fire for this code
path, so its pass proved nothing, see the retained trace below for exactly why), then ATTEMPTED,
INCONCLUSIVE (also superseded — the redesigned probe below was authored but not yet run when that
was written). Both corrections are kept, not deleted: this file's job is to tell a future
maintainer what was actually verified, and a retracted claim belongs here as much as a standing
one.

Trace of pi's own bundle (`chunk-OMWWHBTG.js`), the session-creation function that runs once at CLI
startup, in order:

1. `thinkingLevel = options.thinkingLevel ?? settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL`
   — resolves to the raw `--thinking` value when one was given (`parsed.thinking` flows into
   `options.thinkingLevel` upstream).
2. `model ? thinkingLevel=clampThinkingLevel(model,thinkingLevel) : thinkingLevel="off"` — **the
   value is clamped against the model's real supported levels right here, before the Agent even
   exists.** This is pi's own internal answer to "does this model really support the requested
   level," using the exact function host-notes section G already documented.
3. `agent=new Agent({initialState:{systemPrompt:"",model,thinkingLevel,tools:[]},...})` — the
   Agent's mutable state (`createMutableAgentState`) is constructed with this **already-clamped**
   value directly (`thinkingLevel:initialState?.thinkingLevel??"off"` only falls back to `"off"`
   when `initialState.thinkingLevel` itself is undefined, which it is not here).
4. Post-construction, only when `--thinking` was actually supplied:
   `created.session.setThinkingLevel(created.session.thinkingLevel)` — but `created.session.thinkingLevel`
   is a getter reading straight back `this.agent.state.thinkingLevel`, i.e. the **same already-clamped
   value** set in step 3. Inside `setThinkingLevel(level)`: `previousLevel=this.agent.state.thinkingLevel`
   (same value again) and `effectiveLevel` recomputes to the same thing (it's already valid), so
   `isChanging=effectiveLevel!==previousLevel` is **always false** here — **the `thinking_level_changed`
   event structurally cannot fire for a CLI-startup `--thinking` flag, regardless of whether real
   clamping happened in step 2.** Whether the true resolved level equals the requested one or was
   silently clamped down, the event stays silent either way, because the "official" gated setter is
   only ever asked to re-confirm a value pi already finished clamping one step earlier.

Consequence: this probe's `observedEffectiveLevel` fallback ("no event ⇒ treat the requested level
as accepted unclamped") is **not a sound inference for this code path** — it is reached on every
CLI-startup request, whether or not clamping actually occurred, and it always reports back exactly
the level that was requested. A run against the _contrary_ reading (omitted key ⇒ unsupported,
silently clamped to `off`) would have produced **identical observable output** — no event, fallback
reports `"minimal"` — as a run against the _spec's_ reading. The probe's pass is therefore
consistent with both hypotheses and discriminates neither. This was an error in the probe's design,
caught only by tracing further into the bundle than the first pass did; the first trace stopped at
a different, non-authoritative field on the session wrapper class and mistook it for the one that
mattered.

**The fix, and the run that settled it.** `ctx.thinkingLevel` on `ExtensionContext` (available to
any `pi.on(...)` handler) is a live getter reading `this.session.thinkingLevel` →
`this.agent.state.thinkingLevel` directly (traced: `thinkingLevel:this.session.thinkingLevel` at
the `ExtensionContext` construction site) — i.e. it reads the _true, already-resolved_ state
directly, with no dependency on any event ever firing. The redesigned probe loads a purpose-built,
test-only diagnostic extension (`test/live/thinking-level-probe-extension.mjs` — never
`dist/reviewer-tools.js`; excluded from the published package, confirmed via `npm pack --dry-run`)
that reports `ctx.thinkingLevel` from `before_agent_start`/`agent_start` hooks.

**Before trusting that instrument at all, it had to prove it could show a clamp.** An instrument
that only ever reports "no clamp" cannot distinguish a genuine absence of clamping from an
instrument that is simply broken or blind to clamping. So the probe runs in two phases, one live
host call each:

- **Phase 1 (self-check):** requested a level the target model's map marks **explicitly**
  unsupported (`map[level]===null` — certain by construction, not by the fallback assumption being
  tested). Target: `openrouter/openai/gpt-oss-safeguard-20b`, whose real merged map explicitly sets
  `off: null`. Requested `off`; `src/thinking.ts`'s own `clampLevel` predicts a clamp to `minimal`
  (nearest supported, from `supported=["minimal","low","medium","high"]`). **Observed:
  `ExtensionContext.thinkingLevel` reported `"minimal"`** — genuinely different from the request,
  and exactly the predicted clamp target. The instrument can show a clamp.
- **Phase 2 (the real verdict), run only because phase 1 passed:** same model (its map also omits
  `minimal`, `low`, `medium` and `high` from the `off`..`high` band — the case the design's open
  question is actually about). Requested the omitted `minimal`; `src/thinking.ts` predicts no
  clamp needed (`minimal` is supported via the per-key absent-key fallback). **Observed:
  `ExtensionContext.thinkingLevel` reported `"minimal"`** — unclamped, exactly as predicted.

**Verdict: `src/thinking.ts`'s current per-key-inside-a-partial-map fallback reading is CONFIRMED**
for this model, verified by an instrument independently shown capable of reporting the _other_
outcome when the other outcome is what actually happens. No change to `src/thinking.ts` or to the
`model-discovery` spec's "Level absent from a partially specified map" scenario is warranted.

Cost: two tiny raw host calls, neither logged for token usage (this probe deliberately bypasses
`runner.ts`, so no manifest is written); bounded by `MAX_PROBE_OUTPUT_TOKENS` (200) and a
single-sentence prompt each, at the selected model's real catalog rate ($0.075 in / $0.30 out per
Mtok) — an upper-bound estimate from the rate and the ceiling, not a measured figure.

**This file originally targeted `opencode-go/glm-5.2` and recorded its map as omitting `off` and
`max`. That was wrong, and worth stating precisely because the wrong explanation was floated first:
it was not catalog drift.** The note described an _override fragment_ from
`~/.pi/agent/models.json` in isolation and mislabelled it as the model's effective map. pi's own
`applyModelOverride` deep-merges an override's `thinkingLevelMap` onto the catalog store's
(`{...model.thinkingLevelMap, ...override.thinkingLevelMap}`), so a key present in the store but
absent from the override survives into the effective map. The store already specifies `off` and
`max` for `glm-5.2`, so its real, effective, merged map (exactly what `loadCatalog` returns, and
exactly what governs a live `--thinking` request) is fully specified across all seven levels —
`loadCatalog` reproduces pi's own merge semantics correctly here. The live check was retargeted to
select a partial-map model _dynamically_ at run time rather than trusting a hardcoded one, which is
the durable fix: it is no longer sensitive to which specific model happens to have a partial merged
map on a given day.

## Re-verifying after a host upgrade

**Treat every `pi` upgrade on a machine running `council-review` as requiring re-verification
before trusting the isolation guarantee against the new version.** This is a stated risk in the
design (`design.md`, "Risks / Trade-offs": _"The host CLI's flags or stream format change under
us, and the isolation flags silently stop meaning what they meant."_), not a theoretical one — the
whole read-only guarantee rests on flags whose names and behaviour `council-review` does not
control.

To re-verify:

1. Run the security suite: `npm run test:security` (in particular
   `test/security/reviewer-tool-surface.test.ts`, which asserts the reviewer extension registers
   exactly the four `council_*` tools, and `test/security/reviewer-spawn.test.ts`, which asserts
   the spawn argument vector). These are zero-cost and zero-model-call, and will catch a renamed
   export or a changed extension-loading contract on this package's own side.
2. Run the opt-in live suite once, deliberately, with `COUNCIL_LIVE=1`
   (`test/live/smoke.test.ts` and `test/live/partial-thinking-map.test.ts` — see their file
   headers). These are the only tests that invoke the real host end to end, and are the ones that
   will fail loudly if a `pi` release has renamed or removed one of the isolation flags
   `buildReviewerArgv` composes (`-nbt`, `-ne`, `-e`, `-ns`, `-np`, `-na`, `--no-session`,
   `--no-themes`, `--mode json`, `-p`, `-nc`, `--provider`, `--model`, `--thinking`) — this is a
   real, billable model call; see those files' headers before running them.
3. If the tool surface has genuinely changed (a new built-in reappears, a flag is renamed, the
   event stream shape changes), update this file's verified version and
   `src/reviewer-spawn.ts`/`src/runner.ts` as needed, then re-run steps 1–2 to close the loop.
4. **Before trusting `test/live/partial-thinking-map.test.ts`'s result against a new host version,
   re-verify the clamp-timing chain the probe depends on, not just that the probe still runs.**
   The probe reads `ExtensionContext.thinkingLevel` directly rather than watching for a change
   event, specifically because — on pi 0.84.4 — a CLI-startup `--thinking` request is clamped
   once, silently, against the model's real supported levels _before_ the Agent is constructed
   (`thinkingLevel=clampThinkingLevel(model,thinkingLevel)`, then `new Agent({initialState:{...,
thinkingLevel},...})`), so the resolved state the extension reads is already the true effective
   value by the time any hook fires. **If a future `pi` version instead resolves `--thinking`
   lazily (e.g. clamps only when the first turn actually starts, after extension hooks have
   already fired), `ctx.thinkingLevel` read from `before_agent_start` could observe a
   not-yet-clamped value, and this probe would need a different hook point or a different signal
   entirely.** This is exactly the failure mode that made the _previous_ design (watching
   `thinking_level_changed`) silently produce a tautological pass — re-trace the chain (grep the
   installed bundle for `clampThinkingLevel(` and confirm it still runs before `new Agent(...)`,
   as itemised in "Live end-to-end verification" above) before trusting a new run's verdict either
   way.

Nothing in `council-review` pins an exact `pi` version at runtime — there is no version check
against this file. This document is a maintainer's re-verification checklist, not an enforced
gate.
