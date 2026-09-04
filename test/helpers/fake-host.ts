/**
 * Test-only API onto the fake `pi` host binary (`test/fake-host/pi.mjs`) and its recorded
 * fixture streams (`test/fixtures/streams/*.jsonl`). Section 11 (the runner) and its tests are
 * the intended consumers: everything the runner needs to resolve the stub instead of the real
 * host, and to select which recorded event stream a given reviewer spawn should see, lives here.
 *
 * No model call is ever made through this module or the stub it points at.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the fake host binary. Assign to `COUNCIL_PI_BIN` (or pass as `piBin`/`env.COUNCIL_PI_BIN`
 * wherever the code under test resolves its host binary) so the runner spawns this instead of the real `pi`. */
export const FAKE_HOST_BIN = fileURLToPath(new URL('../fake-host/pi.mjs', import.meta.url));

/**
 * The recorded fixture streams, named for what each exercises. These are the base building
 * blocks; `test/fixtures/streams/<name>.jsonl` is the literal recorded content for each. See
 * that directory's files for the exact event sequences.
 */
export const FIXTURE_NAMES = [
  /** A clean run: two tool-using turns (`council_read` then `council_grep`), then a final turn
   * with a valid `council-findings` block. Exercises usage accumulation, tool-call parsing and
   * the review-depth signal (files opened, searches run). */
  'clean-with-tools',
  /** A single turn, no tool calls, whose findings block fails schema validation (bad `severity`
   * value, missing required `impact`). Use directly for a reviewer that fails validation once;
   * combine with `valid-findings` via `sequenceEnv` for the repair-succeeds scenario, or with
   * itself for the repair-fails ("invalid twice") scenario. */
  'invalid-findings',
  /** A single turn, no tool calls, with a valid, non-empty findings block — the "repair
   * succeeded" half of the invalid-then-valid pair. */
  'valid-findings',
  /** Cuts off mid-response: partial `text_delta` events, then nothing — no `text_end`, no
   * `message_end`, no `turn_end`, no `agent_end`. The stub exits(1) right after the last written
   * line, with no closing event, simulating a crashed host process. */
  'truncated',
  /** A short clean run (no tool calls, empty findings) with three garbage lines interleaved —
   * before the first real event, mid-stream between two valid events, and between the final
   * `message_end` and `turn_end`/`agent_end`. Exercises tolerance of unparseable lines without
   * aborting extraction of the surrounding valid events. */
  'unparseable-lines',
  /** A handful of "still thinking" events with no terminal message, replayed by the stub in an
   * infinite loop (one line every 250ms) until killed. Use to exercise a runner-enforced
   * timeout; the stub does not stop on its own. */
  'never-ends',
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

export function isFixtureName(v: unknown): v is FixtureName {
  return typeof v === 'string' && (FIXTURE_NAMES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------------------------
// Selector wrapper generation
// ---------------------------------------------------------------------------------------------
//
// `COUNCIL_PI_BIN` alone must be sufficient to pick both the binary AND the fixture a spawned
// reviewer sees: the runner's environment allowlist (`reviewer-spawn.ts`'s `buildReviewerEnv`)
// is a security-critical, no-exceptions allowlist, and `COUNCIL_FAKE_HOST_STREAM` is deliberately
// not on it -- it is one of this tool's own test-only variables, not a real host concern, and the
// runner must never carry a test-only exception through that allowlist. So instead of relying on
// the *environment* to select a fixture, generate a tiny wrapper binary that bakes the selector
// into an argument (`test/fake-host/pi.mjs` already accepts `--council-fixture <selector>`,
// preferred over the env var) and forwards everything else untouched:
//
//   #!/bin/sh
//   exec node <FAKE_HOST_BIN> --council-fixture '<selector>' "$@"
//
// `COUNCIL_PI_BIN` pointing at this wrapper is then a complete, self-contained substitute for
// the real host: nothing about which fixture gets replayed depends on any variable in the child's
// environment, so a spawn using exactly `buildReviewerEnv`'s output works identically to one
// using a hand-built superset.

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function writeSelectorWrapper(selector: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'council-fake-host-wrapper-'));
  const wrapperPath = join(dir, 'pi');
  const content = [
    '#!/bin/sh',
    `exec node ${shQuote(FAKE_HOST_BIN)} --council-fixture ${shQuote(selector)} "$@"`,
    '',
  ].join('\n');
  writeFileSync(wrapperPath, content, 'utf8');
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

/**
 * Env additions that select a single fixture, unconditionally, for every invocation that reads
 * this env. Suitable for every scenario except the repair-succeeds pair, where the initial and
 * repair spawn must see different content — use `sequenceEnv` for that one.
 *
 * Also covers "invalid twice": pass `'invalid-findings'` here and reuse the same env for both
 * the initial spawn and the repair spawn — a plain (non-sequence) selector returns the same
 * content every time it's read, which is exactly what "invalid twice" means.
 *
 * `COUNCIL_PI_BIN` points at a generated wrapper with the fixture already baked in (see above);
 * `COUNCIL_FAKE_HOST_STREAM` is still returned alongside it for callers that spawn
 * `FAKE_HOST_BIN` directly rather than resolving `COUNCIL_PI_BIN` (this file's own self-test
 * does), but code under test that resolves and spawns `COUNCIL_PI_BIN` — the runner included —
 * needs nothing beyond that one variable.
 */
export function fixtureEnv(name: FixtureName): {
  COUNCIL_PI_BIN: string;
  COUNCIL_FAKE_HOST_STREAM: string;
} {
  return { COUNCIL_PI_BIN: writeSelectorWrapper(name), COUNCIL_FAKE_HOST_STREAM: name };
}

/**
 * Env additions that select a *sequence* of fixtures: the first process spawn that reads this
 * env gets `names[0]`'s content, the second gets `names[1]`'s, and so on (clamped to the last
 * name for any further spawn). Backed by a fresh counter file under a fresh `mkdtemp` directory,
 * so concurrent tests never share state and don't need to coordinate cleanup — the OS temp
 * directory is reclaimed the normal way.
 *
 * This exists because a reviewer's repair attempt is a *second, independent* `pi` process spawn
 * that the runner otherwise gives an env identical to the first attempt's (no per-attempt hook
 * exists in `RunPanelOptions`) — so the two attempts diverging has to be encoded in the selector
 * itself, not in which env object is passed. The stateful counter lives in the selector string
 * baked into the returned wrapper (see `writeSelectorWrapper`), so every spawn that uses
 * `COUNCIL_PI_BIN` from one `sequenceEnv(...)` call — however many, whichever process — advances
 * the same counter file, exactly as it did when the selector travelled by environment variable.
 *
 * Example (repair succeeds):
 * ```ts
 * const env = { ...process.env, ...sequenceEnv(['invalid-findings', 'valid-findings']) };
 * // first spawn using `env` replays invalid-findings.jsonl; the next spawn using the SAME
 * // `env` object replays valid-findings.jsonl.
 * ```
 */
export function sequenceEnv(names: readonly FixtureName[]): {
  COUNCIL_PI_BIN: string;
  COUNCIL_FAKE_HOST_STREAM: string;
} {
  if (names.length === 0) {
    throw new Error('sequenceEnv: names must be non-empty');
  }
  const dir = mkdtempSync(join(tmpdir(), 'council-fake-host-seq-'));
  const counterPath = join(dir, 'counter');
  const selector = `seq:${counterPath}:${names.join(',')}`;
  return {
    COUNCIL_PI_BIN: writeSelectorWrapper(selector),
    COUNCIL_FAKE_HOST_STREAM: selector,
  };
}

/** Absolute path to a fixture's raw `.jsonl` file, for tests that want to read or assert on it directly. */
export function fixturePath(name: FixtureName): string {
  return fileURLToPath(new URL(`../fixtures/streams/${name}.jsonl`, import.meta.url));
}
