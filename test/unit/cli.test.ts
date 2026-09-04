/**
 * End-to-end CLI tests: every subcommand, the full exit-code taxonomy (including the
 * degraded-plus-threshold precedence case and the guard-refusal path), and stdio routing in
 * `--json` mode. Drives `runCli` in-process (exported by `src/cli.ts` for exactly this purpose)
 * rather than spawning a subprocess per scenario, so a run's outcome can be asserted directly
 * without re-parsing captured stdio for every case.
 *
 * No real `pi` or `herdr` binary is ever invoked: `COUNCIL_PI_BIN` points at a small combined
 * stub (auth-check plus delegation to the shared fake host for the reviewer-stream replay) and
 * `HERDR_ENV` is never set, so every herdr interaction degrades to its documented no-op.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli.js';
import { writeConfig, type CouncilConfig } from '../../src/config.js';
import type { PickerIO } from '../../src/picker.js';
import { SNAPSHOT_PREFIX } from '../../src/snapshot.js';
import { FAKE_HOST_BIN } from '../helpers/fake-host.js';
import { createTestRepo, type TestRepo } from '../helpers/git-repo.js';

const CATALOG_FIXTURE = fileURLToPath(
  new URL('../fixtures/catalog/models-store.json', import.meta.url),
);

// Three real, distinct-vendor models drawn from the shared catalog fixture (test/fixtures/catalog
// owned by Section 3): minimax/MiniMax-M2.7 -> vendor "minimax", opencode-go/glm-5.2 -> "zhipu",
// opencode-go/kimi-k2.6 -> "moonshot" (both derived from the shipped prefix table). Three models,
// three vendors -- exactly what the independence guard requires.
const PANEL = [
  { provider: 'minimax', model: 'MiniMax-M2.7' },
  { provider: 'opencode-go', model: 'glm-5.2' },
  { provider: 'opencode-go', model: 'kimi-k2.6' },
];

function baseConfig(overrides: Partial<CouncilConfig> = {}): Partial<CouncilConfig> {
  return {
    version: 1,
    baseBranch: 'main',
    panel: PANEL,
    includeContextFiles: false,
    // Generous even though every fixture here completes in well under a second normally: this
    // is the reviewer's own per-process timeout (runner.ts, unrelated to Vitest's own test
    // timeout below), and a shared, heavily loaded test worker can occasionally push a real
    // subprocess spawn chain (this wrapper -> node -> the fake host) past a tight bound for
    // reasons that have nothing to do with the behaviour under test. A generous value costs
    // nothing in the normal case and only matters exactly when it's needed.
    timeoutSeconds: 20,
    maxOutputTokens: 8000,
    mergeWindow: 10,
    claimSimilarity: 0.6,
    failOn: 'high',
    retain: 20,
    ...overrides,
  };
}

let fakePiCounter = 0;

/**
 * Writes a combined fake `pi` binary: `auth check` always reports ready (no test here exercises
 * unready-provider handling — that is `providers.test.ts`'s surface), `--list-models` fails (the
 * store fixture is always present, so the fallback is never needed), and any other invocation is
 * a reviewer spawn, delegated to the shared fake host with the fixture selected per
 * `provider/model` from `modelFixtures`, falling back to `defaultFixture`.
 *
 * The fixture map is baked into the generated script's own source text (a `JSON.stringify`'d
 * literal), NOT read from an environment variable at spawn time: `reviewer-spawn.ts`'s
 * `buildReviewerEnv` is a strict, security-critical allowlist (`PATH`, `HOME`,
 * `COUNCIL_SNAPSHOT_ROOT`, `COUNCIL_REPO_ROOT`, `PI_*` only) that strips any test-only variable
 * before a reviewer child ever sees it — the same reason `test/helpers/fake-host.ts`'s own
 * `fixtureEnv`/`sequenceEnv` bake their selector into a generated wrapper binary rather than
 * pass it by environment. `--provider`/`--model` are real argv, unaffected by that allowlist, so
 * the wrapper reads those to pick a per-model fixture. Delegation forwards SIGTERM/SIGINT to the
 * child so the runner's own timeout/interruption handling still works end to end.
 */
function writeFakePi(
  dir: string,
  opts: { modelFixtures?: Record<string, string>; defaultFixture?: string } = {},
): string {
  fakePiCounter += 1;
  const p = path.join(dir, `fake-pi-${fakePiCounter}.cjs`);
  const modelFixturesLiteral = JSON.stringify(opts.modelFixtures ?? {});
  const defaultFixtureLiteral = JSON.stringify(opts.defaultFixture ?? 'clean-with-tools');
  const fakeHostBinLiteral = JSON.stringify(FAKE_HOST_BIN);
  const script = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);

if (args[0] === 'auth' && args[1] === 'check') {
  const i = args.indexOf('--provider');
  const provider = i >= 0 ? args[i + 1] : null;
  process.stdout.write(JSON.stringify({ status: 'ready', provider, authType: 'api_key' }));
  process.exit(0);
}

if (args[0] === '--list-models') {
  process.exit(1);
}

const mi = args.indexOf('--model');
const pi = args.indexOf('--provider');
const model = mi >= 0 ? args[mi + 1] : null;
const provider = pi >= 0 ? args[pi + 1] : null;
const key = provider + '/' + model;

const modelMap = ${modelFixturesLiteral};
const fixture = modelMap[key] || ${defaultFixtureLiteral};

const child = spawn('node', [${fakeHostBinLiteral}, '--council-fixture', fixture, ...args], { stdio: 'inherit' });
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
child.on('exit', (code) => process.exit(code === null ? 1 : code));
child.on('error', () => process.exit(1));
`;
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
}

/** Points `COUNCIL_PI_BIN` at a freshly generated fake `pi` for the given fixture selection. */
function useFixtures(
  opts: { modelFixtures?: Record<string, string>; defaultFixture?: string } = {},
): void {
  process.env.COUNCIL_PI_BIN = writeFakePi(toolDir, opts);
}

// -------------------------------------------------------------------------------------------
// Driving the interactive picker through init / --pick
//
// The shared 4-provider catalog fixture used everywhere else in this file has real-world shape
// (several models per gateway, some ready providers unrelated to the panel under test), which
// makes it painful to script a checkbox-list picker session against reliably -- exact key
// sequences would depend on exact list positions across many unrelated entries. For the tests in
// this section only, `homeDir`'s catalog is overwritten with a minimal, purpose-built one: one
// gateway ("test-gw") holding exactly three reasoning models, each a `vendor/model`-shaped id so
// each derives a distinct vendor (`anthropic`, `openai`, `google`) -- satisfying the
// independence guard with the simplest possible provider stage (one checkbox) and model stage
// (three checkboxes, all wanted).
// -------------------------------------------------------------------------------------------

const PICKER_TEST_MODELS = ['anthropic/model-a', 'openai/model-b', 'google/model-c'];

function writeMinimalPickerCatalog(): void {
  const store = {
    'test-gw': {
      models: PICKER_TEST_MODELS.map((id) => ({
        id,
        name: id,
        provider: 'test-gw',
        reasoning: true,
        cost: { input: 1, output: 2 },
        contextWindow: 100_000,
        maxTokens: 8_000,
      })),
    },
  };
  fs.writeFileSync(
    path.join(homeDir, '.pi', 'agent', 'models-store.json'),
    JSON.stringify(store, null, 2),
    'utf8',
  );
}

const DOWN = '\x1B[B';
const SPACE = ' ';
const ENTER = '\r';

/**
 * A scripted terminal driving `pickPanel` through `src/cli.ts`'s injected `PickerIO` seam,
 * exactly as `picker.test.ts` drives `pickPanel` directly -- see that file's own header comment
 * for why a plain `PassThrough` works regardless of `isTTY` (`readline.createInterface` is
 * created with `terminal: true` unconditionally inside `@inquirer/core`).
 */
class ScriptedTerminal {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  buffer = '';

  constructor() {
    this.output.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
    });
  }

  get io(): PickerIO {
    return { input: this.input, output: this.output, isTTY: true };
  }

  send(keys: string): void {
    this.input.write(keys);
  }

  /** Polls the accumulated rendered output for `needle`, so each scripted keystroke is sent
   * only once the prompt it targets has actually rendered. */
  async waitFor(needle: string, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    while (!this.buffer.includes(needle)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timed out waiting for rendered output to contain ${JSON.stringify(needle)}; got:\n${this.buffer}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** Drives a `ScriptedTerminal` through the full three-stage selection of all of
 * `PICKER_TEST_MODELS`: select the one provider, select all three models, and for each (all
 * reasoning, none with a `thinkingLevelMap`, so all support "off" through "high") accept the
 * first-offered level ("off") by pressing enter. */
async function driveFullPickerSelection(term: ScriptedTerminal): Promise<void> {
  await term.waitFor('Select providers');
  term.send(SPACE + ENTER); // the only provider, "test-gw"

  await term.waitFor('Select models');
  term.send(SPACE + DOWN + SPACE + DOWN + SPACE + ENTER); // all three models

  for (const id of PICKER_TEST_MODELS) {
    await term.waitFor(`Thinking level for test-gw/${id}`);
    term.send(ENTER); // accept "off", the first offered level
  }
}

function captureStream(stream: NodeJS.WriteStream): {
  chunks: string[];
  text: () => string;
  restore: () => void;
} {
  const original = stream.write.bind(stream);
  const chunks: string[] = [];
  // Deliberately a plain property reassignment (matching how src/cli.ts's own
  // `withStdoutRedirectedToStderr` redirects stdout in --json mode) rather than `vi.spyOn`, so the
  // two compose by simple sequential reassignment/restoration instead of fighting over the same
  // instrumented property.
  stream.write = ((chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof stream.write;
  return {
    chunks,
    text: () => chunks.join(''),
    restore: () => {
      stream.write = original;
    },
  };
}

let repo: TestRepo;
let homeDir: string;
let toolDir: string;
let prevCwd: string;
let prevEnv: Record<string, string | undefined>;

beforeEach(() => {
  prevCwd = process.cwd();
  prevEnv = {
    COUNCIL_PI_BIN: process.env.COUNCIL_PI_BIN,
    COUNCIL_HERDR_BIN: process.env.COUNCIL_HERDR_BIN,
    HERDR_ENV: process.env.HERDR_ENV,
    HOME: process.env.HOME,
  };

  repo = createTestRepo();
  repo.writeAndCommit(
    'src/foo.ts',
    'export function foo(buf: Buffer, len: number) {\n  return buf.slice(0, len - 1);\n}\n',
    'init',
  );

  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-cli-test-home-'));
  fs.mkdirSync(path.join(homeDir, '.pi', 'agent'), { recursive: true });
  fs.copyFileSync(CATALOG_FIXTURE, path.join(homeDir, '.pi', 'agent', 'models-store.json'));

  toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-cli-test-bin-'));

  process.env.HOME = homeDir;
  process.env.COUNCIL_HERDR_BIN = path.join(toolDir, 'no-such-herdr-binary');
  delete process.env.HERDR_ENV;
  useFixtures(); // sensible default (clean-with-tools for every model); tests override as needed

  process.chdir(repo.root);
});

afterEach(() => {
  process.chdir(prevCwd);
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  repo.cleanup();
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(toolDir, { recursive: true, force: true });
});

/**
 * Writes `.council/config.json` and `.council/ignore.json` and commits them, mirroring real
 * project state (the cli spec's configuration files "are intended to be committed"). Committing
 * matters here specifically: otherwise these two files would sit as untracked-not-ignored paths
 * and the default (worktree) scope folds those into the reviewed patch as spurious new-file
 * additions, corrupting both the "empty scope" scenario and every finding-count assertion below.
 */
function writeConfigFile(overrides: Partial<CouncilConfig> = {}): void {
  writeConfig(repo.root, baseConfig(overrides));
  fs.mkdirSync(path.join(repo.root, '.council'), { recursive: true });
  fs.writeFileSync(
    path.join(repo.root, '.council', 'ignore.json'),
    `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`,
    'utf8',
  );
  repo.add(['.council/config.json', '.council/ignore.json']);
  // Idempotent: a second call with unchanged content (e.g. `runOneReview` called twice) has
  // nothing staged to commit, and `git commit` with nothing staged exits non-zero.
  if (repo.git(['diff', '--cached', '--name-only']).length > 0) {
    repo.commit('add council config');
  }
}

/** Makes an uncommitted change so the default (worktree) scope is non-empty. */
function makeWorkingChange(): void {
  repo.writeFile(
    'src/foo.ts',
    'export function foo(buf: Buffer, len: number) {\n  return buf.slice(0, len);\n}\n',
  );
}

// -------------------------------------------------------------------------------------------
// Global surface: --version, --help, unknown subcommand
// -------------------------------------------------------------------------------------------

describe('global flags and dispatch', () => {
  it('--version prints a version and exits 0', async () => {
    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli(['--version']);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);
    expect(stdout.text().trim().length).toBeGreaterThan(0);
  });

  it('--help with no subcommand prints usage and exits 0', async () => {
    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli(['--help']);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);
    expect(stdout.text()).toContain('council-review');
    expect(stdout.text()).toContain('init');
  });

  it('init --help prints init-specific usage and exits 0', async () => {
    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli(['init', '--help']);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);
    expect(stdout.text()).toContain('council-review init');
  });

  it('an unrecognised subcommand exits 2 and names the token', async () => {
    const stderr = captureStream(process.stderr);
    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli(['frobnicate']);
    } finally {
      stderr.restore();
      stdout.restore();
    }
    expect(code).toBe(2);
    expect(stderr.text()).toContain('frobnicate');
  });

  it('an unrecognised flag on a review run exits 2, names it, and prints usage', async () => {
    const stderr = captureStream(process.stderr);
    let code: number;
    try {
      code = await runCli(['--this-flag-does-not-exist']);
    } finally {
      stderr.restore();
    }
    expect(code).toBe(2);
    expect(stderr.text()).toContain('this-flag-does-not-exist');
    expect(stderr.text()).toContain('council-review [flags]'); // the printed usage block
  });

  it('conflicting scope selectors exit 2 without any model call', async () => {
    writeConfigFile();
    const stderr = captureStream(process.stderr);
    let code: number;
    try {
      code = await runCli(['--staged', '--range', 'HEAD~1..HEAD']);
    } finally {
      stderr.restore();
    }
    expect(code).toBe(2);
    expect(stderr.text()).toContain('--staged');
    expect(stderr.text()).toContain('--range');
  });

  it('a review run outside a git repository exits 2', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'council-cli-test-outside-'));
    process.chdir(outside);
    const stderr = captureStream(process.stderr);
    let code: number;
    try {
      code = await runCli([]);
    } finally {
      stderr.restore();
      fs.rmSync(outside, { recursive: true, force: true });
    }
    expect(code).toBe(2);
  });

  it('a review run with no configuration and no panel flag exits 2 and directs to init', async () => {
    const stderr = captureStream(process.stderr);
    let code: number;
    try {
      code = await runCli([]);
    } finally {
      stderr.restore();
    }
    expect(code).toBe(2);
    expect(stderr.text()).toContain('init');
  });
});

// -------------------------------------------------------------------------------------------
// init
// -------------------------------------------------------------------------------------------

describe('init', () => {
  it('exits 2 outside a git repository', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'council-cli-test-outside-'));
    process.chdir(outside);
    let code: number;
    try {
      code = await runCli(['init']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
    expect(code).toBe(2);
  });

  it('without a terminal, and without a scripted PickerIO, exits 2 rather than hanging', async () => {
    // No `pickerIO` dep given, so `pickPanel` falls back to its own real-stdio default -- this
    // asserts the wiring from `PickerNonInteractive` to exit 2, which is what init actually does
    // under a non-interactive test runner. The scripted-selection tests below are what exercise
    // the injected `PickerIO` seam (`src/cli.ts`'s `CliDeps.pickerIO`); this test deliberately
    // does not pass one, to keep this specific path covered too.
    let code: number;
    const stderr = captureStream(process.stderr);
    try {
      code = await runCli(['init']);
    } finally {
      stderr.restore();
    }
    expect(code).toBe(2);
  });

  it('a fresh initialization writes config.json, ignore.json and a .gitignore entry', async () => {
    writeMinimalPickerCatalog();
    const term = new ScriptedTerminal();

    const stdout = captureStream(process.stdout);
    const runPromise = runCli(['init'], { pickerIO: term.io });
    let code: number;
    try {
      await driveFullPickerSelection(term);
      code = await runPromise;
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);

    const cfg = JSON.parse(
      fs.readFileSync(path.join(repo.root, '.council', 'config.json'), 'utf8'),
    ) as {
      version: number;
      panel: { provider: string; model: string; thinking?: string }[];
      modelThinkingLevels?: Record<string, string>;
    };
    expect(cfg.version).toBe(1);
    expect(cfg.panel).toHaveLength(3);
    expect(cfg.panel.map((p) => `${p.provider}/${p.model}`).sort()).toEqual(
      PICKER_TEST_MODELS.map((id) => `test-gw/${id}`).sort(),
    );
    // PINNED (CONTRACT.md "where selected thinking levels are written"): init/--pick write the
    // chosen level into modelThinkingLevels, keyed "provider/modelId" -- never into panel[].thinking.
    for (const entry of cfg.panel) {
      expect(entry.thinking).toBeUndefined();
    }
    for (const id of PICKER_TEST_MODELS) {
      expect(cfg.modelThinkingLevels?.[`test-gw/${id}`]).toBe('off');
    }

    const ignoreFile = JSON.parse(
      fs.readFileSync(path.join(repo.root, '.council', 'ignore.json'), 'utf8'),
    ) as { version: number; entries: unknown[] };
    expect(ignoreFile).toEqual({ version: 1, entries: [] });

    const gitignore = fs.readFileSync(path.join(repo.root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.council/reviews/');
  });

  it('re-initialization preserves existing suppressions and does not duplicate the .gitignore entry', async () => {
    writeMinimalPickerCatalog();

    // Simulates a repository that was already initialized once and has a real suppression on
    // disk, and a .gitignore that already excludes .council/reviews/ -- the "Re-initialization
    // preserves suppressions" and "Gitignore entry is not duplicated" scenarios both start here.
    fs.mkdirSync(path.join(repo.root, '.council'), { recursive: true });
    const preexistingIgnore = {
      version: 1,
      entries: [
        {
          fingerprint: 'preexisting-fingerprint',
          reason: 'already suppressed',
          addedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    fs.writeFileSync(
      path.join(repo.root, '.council', 'ignore.json'),
      JSON.stringify(preexistingIgnore, null, 2),
    );
    fs.writeFileSync(path.join(repo.root, '.gitignore'), '.council/reviews/\n');

    const term = new ScriptedTerminal();
    const stdout = captureStream(process.stdout);
    const runPromise = runCli(['init'], { pickerIO: term.io });
    let code: number;
    try {
      await driveFullPickerSelection(term);
      code = await runPromise;
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);

    const ignoreAfter = JSON.parse(
      fs.readFileSync(path.join(repo.root, '.council', 'ignore.json'), 'utf8'),
    );
    expect(ignoreAfter).toEqual(preexistingIgnore);

    const gitignoreAfter = fs.readFileSync(path.join(repo.root, '.gitignore'), 'utf8');
    const occurrences = gitignoreAfter
      .split('\n')
      .filter((l) => l.trim() === '.council/reviews/').length;
    expect(occurrences).toBe(1);

    // The panel itself was still (re-)written, proving init actually re-ran selection rather
    // than short-circuiting because a config already existed ("Re-running the picker later").
    const cfg = JSON.parse(
      fs.readFileSync(path.join(repo.root, '.council', 'config.json'), 'utf8'),
    ) as {
      panel: { provider: string; model: string }[];
    };
    expect(cfg.panel).toHaveLength(3);
  });

  it('init --pick behaves identically to plain init: the flag is a deliberate no-op, not an incidental one', async () => {
    // cmdInit's own comment states that init always re-opens selection regardless of --pick;
    // pinning it here means that claim is a tested fact, not just a comment nobody would notice
    // going stale.
    writeMinimalPickerCatalog();
    const term = new ScriptedTerminal();

    const stdout = captureStream(process.stdout);
    const runPromise = runCli(['init', '--pick'], { pickerIO: term.io });
    let code: number;
    try {
      await driveFullPickerSelection(term);
      code = await runPromise;
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);

    const cfg = JSON.parse(
      fs.readFileSync(path.join(repo.root, '.council', 'config.json'), 'utf8'),
    ) as {
      version: number;
      panel: { provider: string; model: string; thinking?: string }[];
      modelThinkingLevels?: Record<string, string>;
    };
    expect(cfg.panel.map((p) => `${p.provider}/${p.model}`).sort()).toEqual(
      PICKER_TEST_MODELS.map((id) => `test-gw/${id}`).sort(),
    );
    for (const id of PICKER_TEST_MODELS) {
      expect(cfg.modelThinkingLevels?.[`test-gw/${id}`]).toBe('off');
    }

    expect(fs.existsSync(path.join(repo.root, '.council', 'ignore.json'))).toBe(true);
    expect(fs.readFileSync(path.join(repo.root, '.gitignore'), 'utf8')).toContain(
      '.council/reviews/',
    );
  });
});

// -------------------------------------------------------------------------------------------
// models
// -------------------------------------------------------------------------------------------

describe('models', () => {
  it('lists ready models without prompting or exiting non-zero', async () => {
    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli(['models']);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);
    expect(stdout.text()).toContain('minimax/MiniMax-M2.7');
    expect(stdout.text()).toContain('opencode-go/glm-5.2');
    expect(stdout.text()).toContain('vendor=');
  });

  it('unrecognised flag exits 2', async () => {
    const stderr = captureStream(process.stderr);
    let code: number;
    try {
      code = await runCli(['models', '--nope']);
    } finally {
      stderr.restore();
    }
    expect(code).toBe(2);
  });
});

// -------------------------------------------------------------------------------------------
// Guard refusal (exit 4)
// -------------------------------------------------------------------------------------------

describe('vendor-independence guard', () => {
  it('refuses a panel with too few models and exits 4 without spawning a reviewer', async () => {
    writeConfigFile({ panel: [PANEL[0]!] });
    const stderr = captureStream(process.stderr);
    let code: number;
    try {
      code = await runCli([]);
    } finally {
      stderr.restore();
    }
    expect(code).toBe(4);
    expect(fs.existsSync(path.join(repo.root, '.council', 'reviews'))).toBe(false);
  });

  it('--allow-correlated waives the guard and the run proceeds', async () => {
    useFixtures({ defaultFixture: 'unparseable-lines' }); // empty findings, fast
    writeConfigFile({ panel: [PANEL[0]!], failOn: 'none' });
    makeWorkingChange();
    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli(['--allow-correlated']);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// Full review runs: exit-code taxonomy
// -------------------------------------------------------------------------------------------

describe('review run exit codes', () => {
  it('a clean run with no findings exits 0', async () => {
    useFixtures({ defaultFixture: 'unparseable-lines' });
    writeConfigFile();
    makeWorkingChange();

    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli([]);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);
    expect(stdout.text()).toContain('report written to');
  });

  it('an empty scope reports nothing to review and exits 0 without a run directory', async () => {
    useFixtures({ defaultFixture: 'unparseable-lines' });
    writeConfigFile();
    // No working-tree change: HEAD already equals the merge base with "main".

    let code: number;
    const stdout = captureStream(process.stdout);
    try {
      code = await runCli([]);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(repo.root, '.council', 'reviews'))).toBe(false);
  });

  it('findings at or above the fail-on threshold exit 1', async () => {
    useFixtures({ defaultFixture: 'valid-findings' }); // one "high" finding
    writeConfigFile(); // failOn: 'high' by default
    makeWorkingChange();

    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli([]);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(1);
  });

  it('fail-on none never breaches the threshold', async () => {
    useFixtures({ defaultFixture: 'valid-findings' });
    writeConfigFile({ failOn: 'none' });
    makeWorkingChange();

    let code: number;
    try {
      code = await runCli([]);
    } finally {
      /* no capture needed */
    }
    expect(code).toBe(0);
  });

  it('a partial panel (one reviewer failed) exits 3, degraded, even with no threshold breach', async () => {
    useFixtures({
      modelFixtures: {
        [`${PANEL[0]!.provider}/${PANEL[0]!.model}`]: 'truncated',
        [`${PANEL[1]!.provider}/${PANEL[1]!.model}`]: 'unparseable-lines',
        [`${PANEL[2]!.provider}/${PANEL[2]!.model}`]: 'unparseable-lines',
      },
    });
    writeConfigFile({ failOn: 'none' });
    makeWorkingChange();

    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli([]);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(3);
  });

  it('degraded panel outranks a threshold breach: exits 3, not 1', async () => {
    useFixtures({
      modelFixtures: {
        [`${PANEL[0]!.provider}/${PANEL[0]!.model}`]: 'truncated',
        [`${PANEL[1]!.provider}/${PANEL[1]!.model}`]: 'valid-findings',
        [`${PANEL[2]!.provider}/${PANEL[2]!.model}`]: 'valid-findings',
      },
    });
    writeConfigFile(); // failOn: 'high' by default; the surviving finding is "high"
    makeWorkingChange();

    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli([]);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(3);
  });

  it('--models defines a one-off panel and does not persist it', async () => {
    useFixtures({ defaultFixture: 'unparseable-lines' });
    // No saved config at all -- --models must be sufficient on its own.
    makeWorkingChange();
    const spec = PANEL.map((p) => `${p.provider}/${p.model}`).join(',');

    let code: number;
    try {
      code = await runCli(['--models', spec]);
    } finally {
      /* no capture needed */
    }
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(repo.root, '.council', 'config.json'))).toBe(false);
  });

  it('--json emits only the findings document on stdout; progress goes to stderr', async () => {
    useFixtures({ defaultFixture: 'valid-findings' });
    writeConfigFile();
    makeWorkingChange();

    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let code: number;
    try {
      code = await runCli(['--json']);
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(code).toBe(1); // the "high" finding still breaches the default threshold

    const parsed = JSON.parse(stdout.text()) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    // Nothing else was written to stdout: the whole stream parses as exactly one JSON document.
    expect(stdout.text().trim().endsWith(']')).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------
// Review-time --pick vs --models: the panel-selection spec's "Re-opening selection" and
// "Bypassing selection for one run" scenarios have a distinct assertion each -- --pick REPLACES
// the saved panel, --models must leave it untouched. Both need an existing saved panel to prove
// anything: without one, "unchanged" is vacuously true.
// -------------------------------------------------------------------------------------------

describe('review-time panel flags: --pick vs --models', () => {
  it('--pick replaces the saved panel with the newly selected one', async () => {
    writeMinimalPickerCatalog();
    useFixtures({ defaultFixture: 'unparseable-lines' });
    // A saved panel naming a model that does not exist in this test's minimal catalog -- it must
    // never be resolved (resolveConfiguredPanel is not on the --pick path at all), only replaced.
    writeConfigFile({ panel: [{ provider: 'old-provider', model: 'old-model' }], failOn: 'none' });
    makeWorkingChange();

    const term = new ScriptedTerminal();
    const stdout = captureStream(process.stdout);
    const runPromise = runCli(['--pick'], { pickerIO: term.io });
    let code: number;
    try {
      await driveFullPickerSelection(term);
      code = await runPromise;
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);

    const cfg = JSON.parse(
      fs.readFileSync(path.join(repo.root, '.council', 'config.json'), 'utf8'),
    ) as {
      panel: { provider: string; model: string }[];
    };
    expect(cfg.panel.map((p) => `${p.provider}/${p.model}`).sort()).toEqual(
      PICKER_TEST_MODELS.map((id) => `test-gw/${id}`).sort(),
    );
    expect(cfg.panel.some((p) => p.provider === 'old-provider')).toBe(false);
  });

  it('--models leaves an existing saved panel byte-for-byte untouched', async () => {
    useFixtures({ defaultFixture: 'unparseable-lines' });
    writeConfigFile(); // the real, resolvable PANEL from the shared catalog
    makeWorkingChange();

    const configFile = path.join(repo.root, '.council', 'config.json');
    const before = fs.readFileSync(configFile, 'utf8');

    const spec = PANEL.map((p) => `${p.provider}/${p.model}`).join(',');
    let code: number;
    try {
      code = await runCli(['--models', spec]);
    } finally {
      /* no capture needed */
    }
    expect(code).toBe(0);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
  });
});

// -------------------------------------------------------------------------------------------
// show, ignore, gc
// -------------------------------------------------------------------------------------------

describe('show / ignore / gc', () => {
  async function runOneReview(): Promise<void> {
    useFixtures({ defaultFixture: 'valid-findings' });
    writeConfigFile();
    makeWorkingChange();
    const stdout = captureStream(process.stdout);
    try {
      const code = await runCli([]);
      expect(code).toBe(1);
    } finally {
      stdout.restore();
    }
  }

  it('show with no argument renders the most recent run and makes no model call', async () => {
    await runOneReview();
    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli(['show']);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);
    expect(stdout.text()).toContain('Council Review');
  });

  it('show <run-id> renders that run; an unknown run exits 2', async () => {
    await runOneReview();
    const reviewsDir = path.join(repo.root, '.council', 'reviews');
    const runId = fs.readdirSync(reviewsDir).find((e) => e !== 'last')!;

    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli(['show', runId]);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);
    expect(stdout.text()).toContain(runId);

    let unknownCode: number;
    try {
      unknownCode = await runCli(['show', 'no-such-run']);
    } finally {
      /* no capture needed */
    }
    expect(unknownCode).toBe(2);
  });

  it('ignore suppresses a finding idempotently; an unknown id exits 2 and leaves the file unchanged', async () => {
    await runOneReview();
    const ignoreFile = path.join(repo.root, '.council', 'ignore.json');
    const before = fs.readFileSync(ignoreFile, 'utf8');

    let unknownCode: number;
    try {
      unknownCode = await runCli(['ignore', 'F999']);
    } finally {
      /* no capture needed */
    }
    expect(unknownCode).toBe(2);
    expect(fs.readFileSync(ignoreFile, 'utf8')).toBe(before);

    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli(['ignore', 'F001', '--reason', 'known issue']);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);
    const afterOnce = JSON.parse(fs.readFileSync(ignoreFile, 'utf8')) as { entries: unknown[] };
    expect(afterOnce.entries.length).toBe(1);

    // Suppressing the same finding again leaves exactly one entry.
    const code2 = await runCli(['ignore', 'F001']);
    expect(code2).toBe(0);
    const afterTwice = JSON.parse(fs.readFileSync(ignoreFile, 'utf8')) as { entries: unknown[] };
    expect(afterTwice.entries.length).toBe(1);
  });

  it('ignore --run <run-id> resolves the fingerprint from the named run, not the most recent one', async () => {
    // Two completed runs. Every fixture here produces the exact same canned finding, so their
    // real fingerprints would be identical and this scenario ("from THAT run's findings, not the
    // most recent") would be unable to tell the two apart. Each run's on-disk findings.json is
    // therefore given a distinguishing, known fingerprint for F001 directly -- legitimate test
    // setup, not a claim about what the fake host actually produced.
    await runOneReview();
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct millisecond-resolution run ids
    await runOneReview();

    const reviewsDir = path.join(repo.root, '.council', 'reviews');
    const runIds = fs
      .readdirSync(reviewsDir)
      .filter((e) => e !== 'last')
      .sort();
    expect(runIds).toHaveLength(2);
    const [olderRunId, newerRunId] = runIds as [string, string];
    expect(path.basename(fs.realpathSync(path.join(reviewsDir, 'last')))).toBe(newerRunId);

    function setF001Fingerprint(runId: string, fingerprint: string): void {
      const findingsPath = path.join(reviewsDir, runId, 'findings.json');
      const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8')) as {
        id: string;
        fingerprint: string;
      }[];
      const f001 = findings.find((f) => f.id === 'F001')!;
      f001.fingerprint = fingerprint;
      fs.writeFileSync(findingsPath, JSON.stringify(findings, null, 2), 'utf8');
    }
    setF001Fingerprint(olderRunId, 'sentinel-fingerprint-older-run');
    setF001Fingerprint(newerRunId, 'sentinel-fingerprint-newer-run');

    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli(['ignore', 'F001', '--run', olderRunId]);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);

    const ignoreFile = path.join(repo.root, '.council', 'ignore.json');
    const entries = (
      JSON.parse(fs.readFileSync(ignoreFile, 'utf8')) as { entries: { fingerprint: string }[] }
    ).entries;
    expect(entries.map((e) => e.fingerprint)).toEqual(['sentinel-fingerprint-older-run']);
    expect(entries.map((e) => e.fingerprint)).not.toContain('sentinel-fingerprint-newer-run');
  });

  it('gc prunes to the retention count, protects the most recent run, and reports nothing to prune when within it', async () => {
    // Two runs, one after another.
    await runOneReview();
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct millisecond-resolution run ids
    await runOneReview();

    const reviewsDir = path.join(repo.root, '.council', 'reviews');
    const before = fs.readdirSync(reviewsDir).filter((e) => e !== 'last');
    expect(before.length).toBe(2);

    const lastId = path.basename(fs.realpathSync(path.join(reviewsDir, 'last')));

    const stdout = captureStream(process.stdout);
    let code: number;
    try {
      code = await runCli(['gc', '--keep', '1']);
    } finally {
      stdout.restore();
    }
    expect(code).toBe(0);

    const after = fs.readdirSync(reviewsDir).filter((e) => e !== 'last');
    expect(after.length).toBe(1);
    expect(after[0]).toBe(lastId);

    const nothingToPrune = captureStream(process.stdout);
    let code2: number;
    try {
      code2 = await runCli(['gc', '--keep', '5']);
    } finally {
      nothingToPrune.restore();
    }
    expect(code2).toBe(0);
    expect(nothingToPrune.text()).toContain('nothing to prune');
  });
});

// -------------------------------------------------------------------------------------------
// herdr integration is otherwise Section 17's own test surface; this only checks that a plain
// shell / CI run (HERDR_ENV unset) is unaffected by the herdr-related flags being present.
// -------------------------------------------------------------------------------------------

describe('herdr flags outside a herdr environment', () => {
  it('--no-notify and --handoff do not change the review outcome outside herdr', async () => {
    useFixtures({ defaultFixture: 'unparseable-lines' });
    writeConfigFile();
    makeWorkingChange();

    const stderr = captureStream(process.stderr);
    let code: number;
    try {
      code = await runCli(['--no-notify', '--handoff', 'some-agent']);
    } finally {
      stderr.restore();
    }
    expect(code).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// Interruption: cmdReview manages SIGINT/SIGTERM itself (buildSnapshot is called with
// `handleSignals: false` precisely so it can), so the interruption must actually be reported and
// the snapshot must actually be removed -- not silently pre-empted by snapshot.ts's own signal
// safety net calling `process.exit()` out from under this reporting path.
// -------------------------------------------------------------------------------------------

describe('interruption', () => {
  it('an interrupted run reports the interruption and removes its snapshot directory', async () => {
    // Every reviewer loops forever until killed, guaranteeing they are still in flight when the
    // synthetic signal below arrives, and that the run cannot finish "naturally" out from under
    // the test.
    useFixtures({ defaultFixture: 'never-ends' });
    writeConfigFile({ timeoutSeconds: 30 });
    makeWorkingChange();

    // Defensive isolation: a `SIGINT`/`SIGTERM` listener left behind by some other snapshot.ts
    // caller sharing this Vitest worker (e.g. a default-`handleSignals` snapshot built by another
    // test file) would call `process.exit()` on `process.emit('SIGINT')` below, tearing down the
    // whole test worker. Removing every pre-existing listener for the duration of this test and
    // restoring them afterward means the synthetic signal can only ever reach cmdReview's own
    // handler, registered fresh by the `runCli` call started just below.
    const savedSigint = process.listeners('SIGINT');
    const savedSigterm = process.listeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');

    // Isolates this test's snapshot from the process-wide OS temp directory: `cli.ts` never
    // passes `scratchDir` itself (it keeps snapshot.ts's own default), so this is the seam
    // `resolveScratchDir` reads for exactly this situation -- a caller going through `cli.ts`'s
    // unmodified call site that still needs to enumerate "every snapshot dir" deterministically,
    // without seeing whatever an unrelated, concurrently-running test file is also building in
    // the shared temp directory right now.
    const snapshotScratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'council-cli-test-snapshot-scratch-'),
    );
    const prevScratchEnv = process.env.COUNCIL_SNAPSHOT_SCRATCH_DIR;
    process.env.COUNCIL_SNAPSHOT_SCRATCH_DIR = snapshotScratchDir;

    // Not `--json`, so the interruption notice goes through `out(false, ...)`, which routes to
    // stdout -- captured here rather than stderr for that reason.
    const stdout = captureStream(process.stdout);
    const runPromise = runCli([]);

    try {
      // Poll for the run directory (created just before `process.on('SIGINT', ...)` is
      // registered and reviewers are spawned) rather than a fixed sleep, so this test's timing
      // does not depend on how loaded the machine running it happens to be -- a blind sleep
      // short enough to be fast on an idle machine is exactly the kind of thing that flakes
      // under a busy shared test worker (many prior tests in this file alone spawn real
      // subprocesses).
      const reviewsDir = path.join(repo.root, '.council', 'reviews');
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (fs.existsSync(reviewsDir) && fs.readdirSync(reviewsDir).length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      // A short buffer past run-dir creation: signal registration and reviewer spawning happen
      // in the same synchronous block right after it.
      await new Promise((r) => setTimeout(r, 150));

      process.emit('SIGINT');

      const code = await runPromise;
      expect(code).toBe(130);
      expect(stdout.text()).toContain('interrupted');
    } finally {
      stdout.restore();
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
      for (const l of savedSigint) process.on('SIGINT', l as NodeJS.SignalsListener);
      for (const l of savedSigterm) process.on('SIGTERM', l as NodeJS.SignalsListener);
      if (prevScratchEnv === undefined) delete process.env.COUNCIL_SNAPSHOT_SCRATCH_DIR;
      else process.env.COUNCIL_SNAPSHOT_SCRATCH_DIR = prevScratchEnv;
    }

    // No snapshot directory survives the interruption, checked in this test's own isolated
    // scratch dir -- not the shared OS temp dir, which a concurrently-running unrelated test file
    // may also be populating with its own snapshots right now.
    const snapshotDirsAfter = fs
      .readdirSync(snapshotScratchDir)
      .filter((e) => e.startsWith(SNAPSHOT_PREFIX));
    expect(snapshotDirsAfter).toEqual([]);
    fs.rmSync(snapshotScratchDir, { recursive: true, force: true });
  }, 30_000);
});
