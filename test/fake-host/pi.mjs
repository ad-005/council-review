#!/usr/bin/env node
/**
 * Fake `pi` host binary for council-review's test suite.
 *
 * This is a stand-in for the real `pi` CLI (verified version 0.84.4 — see
 * `SCRATCH/host-notes.md` section A) that the runner spawns to drive each reviewer. It never
 * calls a model: it replays a recorded JSONL event stream, verbatim, to stdout — the exact
 * framing `pi --mode json` uses (one JSON object per line, no session-header line since every
 * real invocation here passes `--no-session`).
 *
 * ## Selecting a stream
 *
 * A "selector" names which fixture(s) to replay. Two forms:
 *
 *   - `<fixtureName>`                     — always replay that one fixture, every invocation.
 *   - `seq:<counterFilePath>:<n1>,<n2>,…`  — stateful: replay `n1` on the first invocation that
 *     reads this exact selector, `n2` on the second, and so on (clamped to the last name for any
 *     further invocation). State is a single integer written to `<counterFilePath>`, which the
 *     caller must supply as a path unique to that test (see `test/helpers/fake-host.ts`,
 *     `sequenceEnv`). This is how a single reviewer's *first* attempt and its *repair* attempt —
 *     two separate `pi` process spawns that the runner otherwise gives identical env — can be
 *     scripted to return different content.
 *
 * The selector is read from, in precedence order:
 *   1. `--council-fixture <selector>` (or `--council-fixture=<selector>`) on the command line.
 *   2. the `COUNCIL_FAKE_HOST_STREAM` environment variable (the convention documented for
 *      council-review's test seams).
 *
 * Fixture files live at `test/fixtures/streams/<name>.jsonl`, resolved relative to this script's
 * own directory (not the caller's cwd) so the stub works regardless of where it's invoked from.
 *
 * ## Flags
 *
 * Every other argument (host flags like `-p`, `--mode json`, `--no-builtin-tools`, `--thinking`,
 * `--provider`, `--model`, `--extension <path>`, the trailing prompt string, etc.) is accepted
 * and ignored — this stub only needs to not choke on the real reviewer-spawn argument vector, not
 * reproduce its semantics.
 *
 * ## Exit behaviour
 *
 * - A stream ending in a terminal `agent_end` exits 0.
 * - A stream that cuts off mid-response (the `truncated` fixture) exits 1 immediately after its
 *   last line, with no closing event — simulating an abrupt host crash.
 * - A stream that never ends (the `never-ends` fixture) is replayed in a loop, one line every
 *   250ms, forever. It only stops on a signal.
 * - SIGTERM and SIGHUP are handled the way host-notes verified the real binary handles them:
 *   no closing JSON line is written, and the process exits 143 (SIGTERM) or 129 (SIGHUP)
 *   immediately. This matters for the timeout scenario: a killed reviewer must look like a pipe
 *   that just stopped, not like one that reported its own death.
 */
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STREAMS_DIR = join(HERE, '..', 'fixtures', 'streams');

function parseSelectorArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--council-fixture') return argv[i + 1];
    if (a.startsWith('--council-fixture=')) return a.slice('--council-fixture='.length);
  }
  return undefined;
}

function resolveSelector() {
  return parseSelectorArg(process.argv.slice(2)) ?? process.env.COUNCIL_FAKE_HOST_STREAM;
}

/** Parses a `seq:<path>:<n1>,<n2>,...` selector into { counterPath, names }, or null if not a sequence selector. */
function parseSequenceSelector(selector) {
  if (!selector.startsWith('seq:')) return null;
  const rest = selector.slice('seq:'.length);
  const lastColon = rest.lastIndexOf(':');
  if (lastColon === -1) {
    throw new Error(
      `fake-host: malformed sequence selector (missing names after last ":"): ${selector}`,
    );
  }
  const counterPath = rest.slice(0, lastColon);
  const names = rest
    .slice(lastColon + 1)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error(`fake-host: sequence selector names its target list as empty: ${selector}`);
  }
  return { counterPath, names };
}

/** Advances and returns the fixture name for this invocation of a stateful sequence selector. */
function nextSequenceName(counterPath, names) {
  let index = 0;
  try {
    const raw = readFileSync(counterPath, 'utf8').trim();
    if (raw.length > 0) index = Number.parseInt(raw, 10);
    if (!Number.isFinite(index) || index < 0) index = 0;
  } catch {
    // No counter file yet: this is the first invocation.
    index = 0;
  }
  const clamped = Math.min(index, names.length - 1);
  writeFileSync(counterPath, String(index + 1));
  return names[clamped];
}

function fixtureNameFor(selector) {
  const seq = parseSequenceSelector(selector);
  if (seq) return nextSequenceName(seq.counterPath, seq.names);
  return selector;
}

function fixturePath(name) {
  // Fixture names are always a bare filename stem; reject anything that looks like a path
  // component so a malformed selector can't be used to read an arbitrary file.
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`fake-host: invalid fixture name: ${name}`);
  }
  return join(STREAMS_DIR, `${name}.jsonl`);
}

// If the reader on the other end of the pipe stops reading (a test that only wants the first few
// lines, or a runner that kills us mid-write), writes past that point raise EPIPE. That is not a
// bug in this stub — it is exactly what a killed/abandoned reviewer process should experience —
// so treat it as a reason to stop writing, not an unhandled crash.
let exiting = false;
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') {
    exiting = true;
    process.exit(0);
  }
});

// --- Signal handling: no closing line, exit code matches the real host's verified behaviour. ---
process.on('SIGTERM', () => {
  if (exiting) return;
  exiting = true;
  process.exit(143);
});
process.on('SIGHUP', () => {
  if (exiting) return;
  exiting = true;
  process.exit(129);
});

async function replayOnce(path) {
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const rawLine of rl) {
    if (exiting) return;
    // Write raw lines through untouched — some fixtures deliberately carry malformed JSON to
    // exercise the runner's tolerance of unparseable lines; the stub must not "fix" them.
    process.stdout.write(rawLine + '\n');
  }
}

async function replayForever(path) {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return;
  while (!exiting) {
    for (const l of lines) {
      if (exiting) return;
      process.stdout.write(l + '\n');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function main() {
  const selector = resolveSelector();
  if (!selector) {
    process.stderr.write(
      'fake-host: no fixture selected — pass --council-fixture <name> or set COUNCIL_FAKE_HOST_STREAM\n',
    );
    process.exit(2);
  }

  const name = fixtureNameFor(selector);
  const path = fixturePath(name);

  if (name === 'never-ends') {
    await replayForever(path);
    // Only reached if something set `exiting` without going through a signal handler's own exit.
    return;
  }

  await replayOnce(path);

  if (name === 'truncated') {
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`fake-host: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
