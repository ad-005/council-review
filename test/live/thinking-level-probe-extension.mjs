/**
 * Test-only diagnostic extension for `test/live/partial-thinking-map.test.ts`. Never shipped
 * (not referenced from `package.json`'s `files`, not imported by anything under `src/`), never
 * loaded by the CLI process, and never used as the real reviewer tool surface — `dist/reviewer-tools.js`
 * remains the only extension any real reviewer ever loads.
 *
 * WHY THIS EXISTS (see `HOST-VERSION.md`'s "Live end-to-end verification" section for the full
 * trace this is built on): this file's predecessor watched the host's `thinking_level_changed`
 * session event to learn the real effective thinking level. That signal turned out to be
 * structurally unable to fire for a CLI-startup `--thinking` flag — tracing pi's own bundle shows
 * the requested level is clamped once, silently, against the model's real supported levels
 * *before* the Agent object is even constructed (`thinkingLevel=clampThinkingLevel(model,thinkingLevel)`,
 * then `new Agent({initialState:{...,thinkingLevel},...})`); the "official" gated setter that
 * would emit the event is only ever invoked afterward to re-confirm a value pi already finished
 * resolving one step earlier, so `isChanging` is always false and the event never fires for this
 * code path — regardless of whether real clamping happened. A probe that fell back to "no event
 * means unclamped" on silence would report the SAME thing under both the confirming and the
 * contrary reading, discriminating neither.
 *
 * The fix: `ExtensionContext.thinkingLevel` is a live getter that reads
 * `session.thinkingLevel` -> `agent.state.thinkingLevel` directly (traced at the
 * `ExtensionContext` construction site: `thinkingLevel:this.session.thinkingLevel`) — i.e. it is
 * the true, already-resolved value itself, not a change notification about it. Reading it from
 * inside a hook sidesteps the blind spot entirely: there is no "silent, unobservable" case,
 * because this is a direct state read rather than a wait for an event that may never come.
 *
 * Registers two redundant hooks (`before_agent_start` and `agent_start` — both fire once for a
 * simple, no-tool-call, single-turn run) that each print one marker line to stderr.
 * `console.error`/`console.log` both route to the real stderr fd in headless/`--mode json` mode
 * regardless of the stdout takeover (host-notes section A), so this is safe to read from the
 * spawning process's stderr stream without contaminating the JSON stdout stream at all.
 */
export default function (pi) {
  const report = (source) => (_event, ctx) => {
    console.error(
      `COUNCIL_THINKING_PROBE:${JSON.stringify({ source, level: ctx.thinkingLevel ?? null })}`,
    );
  };
  pi.on('before_agent_start', report('before_agent_start'));
  pi.on('agent_start', report('agent_start'));
}
