/**
 * Runner tests against the fake host (Section 10): fan-out, stream parsing, usage/cost, depth
 * extraction, timeout, ceiling breach, truncated stream, unparseable lines, one reviewer failing
 * without aborting the others, and no-cross-contamination.
 *
 * No real `pi` invocation and no model call is ever made here: every reviewer spawn resolves to
 * `FAKE_HOST_BIN` (or, for the one test that needs per-reviewer-deterministic behaviour under
 * real concurrency, a tiny wrapper this file writes at runtime that dispatches to the fake host
 * based on the `--model` argument the runner itself supplies -- see
 * `writeModelSwitchedHostWrapper` below for why that's needed instead of `sequenceEnv` there).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// `node:child_process`'s ESM namespace is not configurable, so `vi.spyOn` cannot wrap it
// directly (see https://vitest.dev/guide/browser/#limitations). Re-exporting it through
// `vi.mock` gives Vitest a mocked (configurable) module record to spy on instead, while
// `importOriginal` keeps every real spawn behaviour this suite depends on -- `vi.spyOn` below
// wraps `spawn` without a `mockImplementation`, so it still calls straight through.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual };
});
import * as cp from 'node:child_process';

import { runPanel, type ProgressSink, type RunPanelOptions } from '../../src/runner.js';
import { buildReviewerEnv } from '../../src/reviewer-spawn.js';
import type { Reviewer } from '../../src/panel.js';
import type { CatalogModel } from '../../src/providers.js';
import type { Snapshot } from '../../src/snapshot.js';
import { FAKE_HOST_BIN, fixtureEnv, sequenceEnv, type FixtureName } from '../helpers/fake-host.js';

// ---------------------------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------------------------

function makeReviewer(
  overrides: Partial<CatalogModel> & { id: string; provider: string },
): Reviewer {
  const catalog: CatalogModel = {
    name: overrides.id,
    vendor: 'test-vendor',
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    inputCostPerMTok: 3,
    outputCostPerMTok: 15,
    reasoning: false,
    thinkingLevelMap: undefined,
    ...overrides,
  };
  return {
    provider: catalog.provider,
    model: catalog.id,
    vendor: catalog.vendor,
    catalog,
    thinking: { applicable: false, requested: null, effective: null, clamped: false },
  };
}

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'council-runner-test-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function makeSnapshot(files: string[] = ['src/foo.ts']): Snapshot {
  const root = mkdtempSync(join(baseDir, 'snap-'));
  return {
    root,
    files,
    identity: { head: 'deadbeef', dirty: false, treeHash: 'abc123' },
    cleanup: vi.fn(),
  };
}

function makePatch(
  content = 'diff --git a/src/foo.ts b/src/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
): string {
  const path = join(mkdtempSync(join(baseDir, 'patch-')), 'patch.diff');
  writeFileSync(path, content, 'utf8');
  return path;
}

function baseOptions(overrides: Partial<RunPanelOptions>): RunPanelOptions {
  return {
    reviewers: [],
    snapshot: makeSnapshot(),
    repoRoot: '/does/not/matter/for/the/fake/host',
    patchPath: makePatch(),
    prompt: 'Review this patch for correctness and security issues.',
    extensionPath: '/does/not/matter/for/the/fake/host/reviewer-tools.js',
    includeContextFiles: false,
    timeoutSeconds: 30,
    maxOutputTokens: 100_000,
    ...overrides,
  };
}

/**
 * Writes a tiny host stand-in that picks a fixture DETERMINISTICALLY from the `--model` argument
 * the runner supplies, then imports the real fake host to replay it. Used only for the
 * "one reviewer fails without aborting the others" test.
 *
 * `sequenceEnv` (the general mechanism for making two spawns of the same reviewer diverge, used
 * throughout the repair-retry tests below) is unsuitable there: its counter file is shared
 * process-wide, and that test needs three *concurrently launched* reviewers to get three
 * different, specific outcomes. Concurrent, unsynchronized reads of that counter file across
 * separately-forked processes is a genuine (if narrow) race -- fine for the repair tests, which
 * only ever have one attempt in flight per reviewer at a time, but not something to build a
 * "reviewer X specifically fails" assertion on. Branching on `--model`, which `buildReviewerArgv`
 * always supplies per reviewer, has no shared mutable state at all.
 */
function writeModelSwitchedHostWrapper(
  mapping: Record<string, FixtureName>,
  fallback: FixtureName,
): string {
  const dir = mkdtempSync(join(baseDir, 'wrapper-'));
  const wrapperPath = join(dir, 'model-switch-host.mjs');
  const content = [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    'const modelIdx = args.indexOf("--model");',
    'const model = modelIdx >= 0 ? args[modelIdx + 1] : "";',
    `const mapping = ${JSON.stringify(mapping)};`,
    `process.env.COUNCIL_FAKE_HOST_STREAM = mapping[model] ?? ${JSON.stringify(fallback)};`,
    `await import(${JSON.stringify(pathToFileURL(FAKE_HOST_BIN).href)});`,
    '',
  ].join('\n');
  writeFileSync(wrapperPath, content, 'utf8');
  chmodSync(wrapperPath, 0o755); // the runner spawns this path directly, relying on the shebang
  return wrapperPath;
}

const ORIGINAL_ENV: Record<string, string | undefined> = {};
const MANAGED_ENV_KEYS = ['COUNCIL_PI_BIN', 'COUNCIL_FAKE_HOST_STREAM'] as const;

beforeEach(() => {
  for (const key of MANAGED_ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];
  process.env.COUNCIL_PI_BIN = FAKE_HOST_BIN;
  delete process.env.COUNCIL_FAKE_HOST_STREAM;
});

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  vi.restoreAllMocks();
});

function setFixture(name: FixtureName): void {
  Object.assign(process.env, fixtureEnv(name));
}

// ---------------------------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------------------------

describe('parallel launch', () => {
  it('starts every reviewer without waiting for any other to finish', () => {
    setFixture('clean-with-tools');
    const reviewers = [
      makeReviewer({ id: 'model-a', provider: 'prov-a' }),
      makeReviewer({ id: 'model-b', provider: 'prov-b' }),
      makeReviewer({ id: 'model-c', provider: 'prov-c' }),
    ];
    const spawnSpy = vi.spyOn(cp, 'spawn');

    const promise = runPanel(baseOptions({ reviewers }));

    // `runPanel` executes synchronously up to its first await; since `Promise.all` is built from
    // an array of already-synchronously-invoked reviewer runs, every reviewer's first attempt has
    // already been spawned by the time this line runs -- before any of them could possibly have
    // finished. This is what "started without waiting for any other" means operationally.
    expect(spawnSpy).toHaveBeenCalledTimes(3);

    return promise.then((outcome) => {
      expect(outcome.launched).toBe(3);
      expect(outcome.results).toHaveLength(3);
      expect(outcome.results.every((r) => r.state === 'ok')).toBe(true);
    });
  });

  it("one reviewer's failure does not abort the others", async () => {
    const wrapper = writeModelSwitchedHostWrapper({ dies: 'truncated' }, 'clean-with-tools');
    process.env.COUNCIL_PI_BIN = wrapper;

    const reviewers = [
      makeReviewer({ id: 'lives-1', provider: 'prov-a' }),
      makeReviewer({ id: 'dies', provider: 'prov-b' }),
      makeReviewer({ id: 'lives-2', provider: 'prov-c' }),
    ];

    const outcome = await runPanel(baseOptions({ reviewers }));

    expect(outcome.results).toHaveLength(3);
    const byModel = new Map(outcome.results.map((r) => [r.reviewer.model, r]));
    expect(byModel.get('lives-1')?.state).toBe('ok');
    expect(byModel.get('lives-2')?.state).toBe('ok');
    expect(byModel.get('dies')?.state).toBe('failed');
    expect(outcome.reporting).toBe(2);
    expect(outcome.degraded).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Stream parsing: final text, usage, tool calls
// ---------------------------------------------------------------------------------------------

describe('event-stream parsing', () => {
  it('captures the terminal assistant text, cumulative usage and every tool call', async () => {
    setFixture('clean-with-tools');
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });

    const outcome = await runPanel(baseOptions({ reviewers: [reviewer] }));
    const result = outcome.results[0]!;

    expect(result.state).toBe('ok');
    expect(result.finalText).toContain('off-by-one when slicing the trailing chunk');
    expect(result.repairText).toBeNull();

    // Cumulative across all three turns in the fixture: 812+940+1080 input, 38+28+130 output.
    expect(result.usage).toEqual({ inputTokens: 2832, outputTokens: 196 });

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toMatchObject({
      name: 'council_read',
      args: { path: 'src/foo.ts' },
    });
    expect(result.toolCalls[1]).toMatchObject({
      name: 'council_grep',
      args: { pattern: 'slice(0, len - 1)', path: 'src' },
    });
    expect(result.toolCalls[0]!.at).toBeGreaterThanOrEqual(0);
    expect(result.toolCalls[1]!.at).toBeGreaterThanOrEqual(result.toolCalls[0]!.at);
  });

  it('tolerates interleaved unparseable lines without aborting extraction', async () => {
    setFixture('unparseable-lines');
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });

    const outcome = await runPanel(baseOptions({ reviewers: [reviewer] }));
    const result = outcome.results[0]!;

    expect(result.state).toBe('ok');
    expect(result.findings).toEqual([]); // valid, empty findings list -- still a successful report
    expect(result.rawTrace).toHaveLength(18); // every line, garbage included
    expect(result.rawTrace.some((l) => l.includes('connection reset by peer'))).toBe(true);
    expect(result.rawTrace.some((l) => l.includes('not json at all'))).toBe(true);
  });

  it('preserves partial text verbatim and marks the reviewer failed when the stream truncates', async () => {
    setFixture('truncated');
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });

    const outcome = await runPanel(baseOptions({ reviewers: [reviewer] }));
    const result = outcome.results[0]!;

    expect(result.state).toBe('failed');
    expect(result.findings).toBeNull();
    expect(result.finalText).toBe(
      'Looking at the diff, the change to the buffer handling in src/foo.ts appears to intro',
    );
    expect(result.repairText).toBeNull(); // a process that never produced a terminal message gets no repair spawn
    expect(result.rawTrace).toHaveLength(10);
    expect(outcome.degraded).toBe(true);
    expect(outcome.reporting).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Cost accounting and review depth
// ---------------------------------------------------------------------------------------------

describe('cost accounting', () => {
  it('computes per-reviewer cost from usage and catalog rates, and a run total', async () => {
    setFixture('clean-with-tools');
    const reviewer = makeReviewer({
      id: 'model-a',
      provider: 'prov-a',
      inputCostPerMTok: 3,
      outputCostPerMTok: 15,
    });

    const outcome = await runPanel(baseOptions({ reviewers: [reviewer] }));
    const result = outcome.results[0]!;

    const expectedCost = (2832 / 1_000_000) * 3 + (196 / 1_000_000) * 15;
    expect(result.cost).not.toBeNull();
    expect(result.cost!).toBeCloseTo(expectedCost, 10);
    expect(outcome.totalCost).not.toBeNull();
    expect(outcome.totalCost!).toBeCloseTo(expectedCost, 10);
    expect(outcome.costIncomplete).toBe(false);
  });

  it('records unknown (not zero) cost when catalog rates are absent, and marks the total incomplete', async () => {
    const wrapper = writeModelSwitchedHostWrapper({}, 'clean-with-tools');
    process.env.COUNCIL_PI_BIN = wrapper;

    const knownRate = makeReviewer({
      id: 'known',
      provider: 'prov-a',
      inputCostPerMTok: 3,
      outputCostPerMTok: 15,
    });
    const unknownRate = makeReviewer({
      id: 'unknown',
      provider: 'prov-b',
      inputCostPerMTok: null,
      outputCostPerMTok: null,
    });

    const outcome = await runPanel(baseOptions({ reviewers: [knownRate, unknownRate] }));
    const byModel = new Map(outcome.results.map((r) => [r.reviewer.model, r]));

    expect(byModel.get('known')!.cost).not.toBeNull();
    expect(byModel.get('unknown')!.cost).toBeNull();
    expect(outcome.costIncomplete).toBe(true);
    // The total still reports what IS known, rather than collapsing to null outright.
    expect(outcome.totalCost).not.toBeNull();
    expect(outcome.totalCost!).toBeCloseTo(byModel.get('known')!.cost!, 10);
  });
});

describe('review depth', () => {
  it('records which files were opened and how many searches were run', async () => {
    setFixture('clean-with-tools');
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });

    const outcome = await runPanel(baseOptions({ reviewers: [reviewer] }));
    const result = outcome.results[0]!;

    expect(result.depth).toEqual({ filesOpened: ['src/foo.ts'], searches: 1 });
  });

  it('makes a shallow reviewer visibly different from a thorough one', async () => {
    const wrapper = writeModelSwitchedHostWrapper(
      { shallow: 'unparseable-lines' },
      'clean-with-tools',
    );
    process.env.COUNCIL_PI_BIN = wrapper;

    const shallow = makeReviewer({ id: 'shallow', provider: 'prov-a' });
    const thorough = makeReviewer({ id: 'thorough', provider: 'prov-b' });

    const outcome = await runPanel(baseOptions({ reviewers: [shallow, thorough] }));
    const byModel = new Map(outcome.results.map((r) => [r.reviewer.model, r]));

    expect(byModel.get('shallow')!.depth).toEqual({ filesOpened: [], searches: 0 });
    expect(byModel.get('thorough')!.depth.filesOpened.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Per-reviewer budgets
// ---------------------------------------------------------------------------------------------

describe('per-reviewer budgets', () => {
  it('terminates a reviewer that exceeds its wall-clock timeout, marks it, and preserves partial text', async () => {
    setFixture('never-ends');
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });

    const outcome = await runPanel(
      baseOptions({ reviewers: [reviewer], timeoutSeconds: 1, maxOutputTokens: 1_000_000 }),
    );
    const result = outcome.results[0]!;

    expect(result.state).toBe('timeout');
    expect(result.error).toContain('timeout');
    expect(outcome.degraded).toBe(true);
    expect(outcome.reporting).toBe(0);
  }, 15_000);

  it('terminates a reviewer that exceeds its output-token ceiling and preserves its partial text', async () => {
    // `clean-with-tools`'s first turn streams real `text_delta` content (unlike `never-ends`,
    // which only ever emits `thinking_delta` before it's killed -- thinking content is
    // deliberately excluded from "final text", so a breach against it always yields an empty,
    // if still correctly-reported, string). The breach point here (ceiling 10, output climbing
    // 4/6/10/16/...) trips partway through that first turn's text, after two `text_delta`
    // events have already been folded into the partial-text accumulator and strictly before
    // the process would otherwise finish -- deterministic by event order, not by real timing,
    // since every event up to the breach is processed synchronously regardless of how fast the
    // (unpaced) fixture's lines actually arrive.
    setFixture('clean-with-tools');
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });

    const outcome = await runPanel(
      baseOptions({ reviewers: [reviewer], timeoutSeconds: 30, maxOutputTokens: 10 }),
    );
    const result = outcome.results[0]!;

    expect(result.state).toBe('over-budget');
    expect(result.error).toContain('output ceiling');
    expect(result.finalText).toBe("I'll start by reading the changed file "); // partial text preserved, not discarded
    expect(outcome.degraded).toBe(true);
  }, 15_000);

  it('runs to completion with no output-token ceiling at all (maxOutputTokens: null)', async () => {
    // `clean-with-tools` accrues 196 cumulative output tokens across its three turns (see the
    // "captures the terminal assistant text" test above) -- comfortably over the ceiling of 10
    // that breaches in the sibling test just above, so a null ceiling completing here is a real
    // contrast, not a vacuous pass. Only the wall-clock timeout would stop an unbounded run, so
    // this deliberately does not use the `never-ends` fixture.
    setFixture('clean-with-tools');
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });

    const outcome = await runPanel(
      baseOptions({ reviewers: [reviewer], timeoutSeconds: 30, maxOutputTokens: null }),
    );
    const result = outcome.results[0]!;

    expect(result.state).toBe('ok');
    expect(outcome.degraded).toBe(false);
  }, 15_000);

  it('applies command-line-supplied overrides for timeout and ceiling (i.e. whatever the caller passes)', async () => {
    // RunPanelOptions carries only the effective (already-resolved) values -- there is no
    // separate "config default" field on it. Section 16 is responsible for the `cliValue ??
    // configValue` merge before calling runPanel; this asserts the runner honours whatever value
    // it is actually given, with no baked-in default of its own.
    setFixture('never-ends');
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });

    const outcome = await runPanel(
      baseOptions({ reviewers: [reviewer], timeoutSeconds: 600, maxOutputTokens: 1 }),
    );
    expect(outcome.results[0]!.state).toBe('over-budget'); // the tiny override value took effect
  }, 15_000);

  it('still writes a degraded, findings-free outcome when every reviewer breaches its budget', async () => {
    setFixture('never-ends');
    const reviewers = [
      makeReviewer({ id: 'model-a', provider: 'prov-a' }),
      makeReviewer({ id: 'model-b', provider: 'prov-b' }),
    ];

    const outcome = await runPanel(
      baseOptions({ reviewers, timeoutSeconds: 30, maxOutputTokens: 1 }),
    );

    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.every((r) => r.state === 'over-budget')).toBe(true);
    expect(outcome.reporting).toBe(0);
    expect(outcome.degraded).toBe(true);
    // Section 16 maps `reporting === 0` to exit code 3; runPanel itself never calls process.exit.
  }, 15_000);
});

// ---------------------------------------------------------------------------------------------
// Repair retry
// ---------------------------------------------------------------------------------------------

describe('exactly one repair retry', () => {
  it('uses the repaired findings when the repair attempt succeeds', async () => {
    Object.assign(process.env, sequenceEnv(['invalid-findings', 'valid-findings']));
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });

    const outcome = await runPanel(baseOptions({ reviewers: [reviewer] }));
    const result = outcome.results[0]!;

    expect(result.state).toBe('ok');
    expect(result.findings).not.toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.repairText).not.toBeNull();
    expect(result.repairText).toContain('corrected below');
    expect(result.finalText).toContain('severe'); // the FIRST attempt's own text is still preserved verbatim
  });

  it('marks the reviewer failed, preserving both texts, when the repair attempt is also invalid', async () => {
    setFixture('invalid-findings'); // same fixture both times -- "invalid twice"
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });

    const outcome = await runPanel(baseOptions({ reviewers: [reviewer] }));
    const result = outcome.results[0]!;

    expect(result.state).toBe('failed');
    expect(result.findings).toBeNull();
    expect(result.finalText.length).toBeGreaterThan(0);
    expect(result.repairText).not.toBeNull();
    expect(result.repairText!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// No cross-contamination
// ---------------------------------------------------------------------------------------------

describe('no cross-contamination', () => {
  it('gives every reviewer the identical task/prompt/patch and nothing produced by another reviewer', async () => {
    setFixture('clean-with-tools');
    const reviewers = [
      makeReviewer({ id: 'model-a', provider: 'prov-a' }),
      makeReviewer({ id: 'model-b', provider: 'prov-b' }),
      makeReviewer({ id: 'model-c', provider: 'prov-c' }),
    ];
    const spawnSpy = vi.spyOn(cp, 'spawn');

    await runPanel(baseOptions({ reviewers }));

    expect(spawnSpy).toHaveBeenCalledTimes(3);
    const calls = spawnSpy.mock.calls as unknown as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv },
    ][];

    const prompts = calls.map(([, argv]) => argv[argv.length - 1]!);
    expect(new Set(prompts).size).toBe(1); // byte-identical trailing prompt argument for all three
    // The prompt itself never rides on argv (see the E2BIG regression tests below) -- the
    // trailing argument is always a short `@<path>` file reference, and it's the referenced
    // file's content that must carry the task prompt and the patch.
    expect(prompts[0]).toMatch(/^@\//);
    const promptFileContent = readFileSync(prompts[0]!.slice(1), 'utf8');
    expect(promptFileContent).toContain('Review this patch');
    expect(promptFileContent).toContain('diff --git');

    const cwds = calls.map(([, , opts]) => opts.cwd);
    expect(new Set(cwds).size).toBe(1); // shared snapshot root, nothing reviewer-specific

    const envs = calls.map(([, , opts]) => opts.env);
    expect(envs[1]).toEqual(envs[0]);
    expect(envs[2]).toEqual(envs[0]); // env carries nothing that varies by reviewer identity

    // The only per-call differentiation is the reviewer's own provider/model, in argv --
    // structurally incapable of carrying another reviewer's output because nothing else varies.
    const models = calls.map(([, argv]) => argv[argv.indexOf('--model') + 1]);
    expect(models).toEqual(['model-a', 'model-b', 'model-c']);
  });
});

// ---------------------------------------------------------------------------------------------
// E2BIG regression: a large patch must never be inlined into argv
// ---------------------------------------------------------------------------------------------
//
// A single ordinary large diff used to make the entire panel fail with a raw `spawn E2BIG`: the
// whole composed prompt (task instructions + the patch, verbatim) was pushed as one `argv`
// element, and once that string's byte length (combined with the process environment) exceeded
// the OS's `ARG_MAX`, `spawn()` failed outright and no reviewer in the panel ran at all. The fix
// writes the prompt to a file in the run directory and hands the reviewer an `@<path>` reference
// instead -- these tests hold both ends of that: the mechanism actually avoids the OS failure
// (against a real `spawn()`, not a mock), and a spawn failure that still occurs is never reported
// as a bare, unexplained string.

describe('E2BIG regression: large-patch delivery', () => {
  it('spawning a single huge argv element really does fail with E2BIG on this system (documents the bug this fix targets)', async () => {
    // Not exercising runPanel here -- this is the shape of the OLD, buggy call (the entire
    // payload inlined as one argv element), reproduced directly against the real `spawn()` to
    // establish, with a live assertion rather than a comment, that the underlying OS failure is
    // real on this machine and not merely hypothetical.
    // `spawn()` can fail either synchronously (this platform throws the E2BIG failure directly
    // out of the call) or asynchronously via the child's `'error'` event -- exactly the two
    // sites `runAttempt` guards, and exactly why this test tolerates both.
    const hugeArg = 'x'.repeat(4_000_000);
    let code: string | undefined;
    try {
      const child = cp.spawn(process.execPath, ['-e', '0', hugeArg]);
      code = await new Promise<string | undefined>((resolvePromise) => {
        child.on('error', (e) => resolvePromise((e as NodeJS.ErrnoException).code));
        child.on('spawn', () => {
          child.kill();
          resolvePromise(undefined); // spawn unexpectedly succeeded on this system
        });
      });
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(code).toBe('E2BIG');
  });

  it('reviews a patch far larger than would fit on the command line without any reviewer failing', async () => {
    setFixture('clean-with-tools');
    // Larger than any real system's ARG_MAX (and larger than Linux's 128KiB per-argument cap) --
    // under the old inline-argv delivery this alone would have failed every reviewer.
    const hugePatchContent = `diff --git a/src/foo.ts b/src/foo.ts\n${'+// padding line\n'.repeat(150_000)}`;
    const patchPath = makePatch(hugePatchContent);
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });
    const spawnSpy = vi.spyOn(cp, 'spawn');

    const outcome = await runPanel(baseOptions({ reviewers: [reviewer], patchPath }));
    const result = outcome.results[0]!;

    expect(result.error).toBeUndefined();
    expect(result.state).toBe('ok');
    expect(result.findings).not.toBeNull();

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const argv = spawnSpy.mock.calls[0]![1] as string[];
    const trailingArg = argv[argv.length - 1]!;
    // The one thing that must NOT scale with patch size is the argv token itself.
    expect(trailingArg.length).toBeLessThan(500);
    expect(trailingArg).toMatch(/^@\//);

    const promptFilePath = trailingArg.slice(1);
    const promptFileContent = readFileSync(promptFilePath, 'utf8');
    expect(promptFileContent).toContain(hugePatchContent);

    // Written into the run directory (next to `patch.diff`), never into the snapshot.
    expect(dirname(dirname(promptFilePath))).toBe(dirname(patchPath));
  });

  it('writes each reviewer a distinct repair-prompt file, never colliding, when a repair attempt is needed', async () => {
    Object.assign(process.env, sequenceEnv(['invalid-findings', 'valid-findings']));
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });
    const patchPath = makePatch();
    const spawnSpy = vi.spyOn(cp, 'spawn');

    const outcome = await runPanel(baseOptions({ reviewers: [reviewer], patchPath }));
    expect(outcome.results[0]!.state).toBe('ok');

    expect(spawnSpy).toHaveBeenCalledTimes(2); // first attempt, then the repair
    const repairArgv = spawnSpy.mock.calls[1]![1] as string[];
    const repairTrailingArg = repairArgv[repairArgv.length - 1]!;
    expect(repairTrailingArg).toMatch(/^@\//);
    const repairPromptContent = readFileSync(repairTrailingArg.slice(1), 'utf8');
    expect(repairPromptContent).toContain('Re-emit your complete findings'); // the repair instruction text
    expect(repairPromptContent).toContain('severe'); // the reviewer's own first-attempt output
  });

  it('never surfaces a bare spawn errno: a real spawn failure is mapped to an explanatory message', async () => {
    setFixture('clean-with-tools');
    // ENOENT is the easiest real spawn failure to force deterministically and cross-platform.
    process.env.COUNCIL_PI_BIN = join(baseDir, 'this-binary-does-not-exist');
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });

    const outcome = await runPanel(baseOptions({ reviewers: [reviewer] }));
    const result = outcome.results[0]!;

    expect(result.state).toBe('failed');
    expect(result.error).toBeDefined();
    expect(result.error).not.toBe('spawn ENOENT'); // never a bare, unexplained errno string
    expect(result.error).toContain('ENOENT');
    expect(result.error).toContain('was not found');
  });
});

// ---------------------------------------------------------------------------------------------
// File-envelope notice: a live run found a reviewer chasing the wrapper path
// ---------------------------------------------------------------------------------------------
//
// pi's own `processFileArguments` wraps whatever `@file` delivery hands it in a
// `<file name="<absolute path>">...</file>` tag. A live run against real pi 0.84.4 found one
// reviewer (`openrouter/amazon/nova-micro-v1`) take that name at face value: it called
// `council_read` and `council_grep` on the prompt file's own path, was correctly refused ("path
// escapes the allowed root" -- containment held, this was a quality problem, not a security one),
// and explicitly degraded its own review as a result. `writePromptFileArg` now prepends a fixed
// notice to every prompt it writes, unconditionally (both the initial prompt and a repair
// prompt), so no reviewer -- regardless of patch size -- is left to guess what the wrapper means.

describe('file-envelope notice', () => {
  it('tells the reviewer the wrapper path is a delivery artifact, on an ordinary small patch, before the actual task content', async () => {
    setFixture('clean-with-tools');
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });
    const patchPath = makePatch(); // the small, ordinary-size default patch
    const spawnSpy = vi.spyOn(cp, 'spawn');

    const outcome = await runPanel(baseOptions({ reviewers: [reviewer], patchPath }));
    expect(outcome.results[0]!.state).toBe('ok');

    const argv = spawnSpy.mock.calls[0]![1] as string[];
    const trailingArg = argv[argv.length - 1]!;
    expect(trailingArg).toMatch(/^@\//); // @file delivery unconditionally, not just for large patches
    const promptFileContent = readFileSync(trailingArg.slice(1), 'utf8');

    expect(promptFileContent).toContain('delivered as file content');
    expect(promptFileContent).toContain('not part of the repository under review');
    expect(promptFileContent).toContain('Do not attempt to read, grep, or list it');
    expect(promptFileContent).toContain('council_read, council_grep, council_list and council_git');

    // The notice comes BEFORE the actual task content, since the model reads top to bottom.
    const noticeIndex = promptFileContent.indexOf('delivered as file content');
    const taskIndex = promptFileContent.indexOf('Review this patch');
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(taskIndex).toBeGreaterThan(noticeIndex);
  });

  it('carries the same notice on a repair prompt', async () => {
    Object.assign(process.env, sequenceEnv(['invalid-findings', 'valid-findings']));
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });
    const spawnSpy = vi.spyOn(cp, 'spawn');

    const outcome = await runPanel(baseOptions({ reviewers: [reviewer] }));
    expect(outcome.results[0]!.state).toBe('ok');

    const repairArgv = spawnSpy.mock.calls[1]![1] as string[];
    const repairPromptContent = readFileSync(repairArgv[repairArgv.length - 1]!.slice(1), 'utf8');
    expect(repairPromptContent).toContain('delivered as file content');
    expect(repairPromptContent.indexOf('delivered as file content')).toBeLessThan(
      repairPromptContent.indexOf('Re-emit your complete findings'),
    );
  });

  it('still delivers the notice on the large patch from the E2BIG regression above -- one mechanism, not a size-conditional one', async () => {
    setFixture('clean-with-tools');
    const hugePatchContent = `diff --git a/src/foo.ts b/src/foo.ts\n${'+// padding line\n'.repeat(150_000)}`;
    const patchPath = makePatch(hugePatchContent);
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });
    const spawnSpy = vi.spyOn(cp, 'spawn');

    const outcome = await runPanel(baseOptions({ reviewers: [reviewer], patchPath }));
    expect(outcome.results[0]!.state).toBe('ok');

    const argv = spawnSpy.mock.calls[0]![1] as string[];
    const promptFileContent = readFileSync(argv[argv.length - 1]!.slice(1), 'utf8');
    expect(promptFileContent).toContain('delivered as file content');
    expect(promptFileContent).toContain(hugePatchContent);
  });
});

// ---------------------------------------------------------------------------------------------
// Environment allowlist: no test-only exception
// ---------------------------------------------------------------------------------------------

describe('child environment', () => {
  it("is exactly buildReviewerEnv's output plus nothing else -- no test-only allowlist exception", async () => {
    // The fake host's fixture selection travels via a `--council-fixture` argument baked into the
    // wrapper `COUNCIL_PI_BIN` resolves to (see test/helpers/fake-host.ts), never via environment.
    // This asserts that structurally: the environment the runner actually hands to a spawned
    // reviewer must be identical to what `buildReviewerEnv` computes from the same inputs, so a
    // future edit that reintroduces a "just for this one test var" passthrough fails loudly here
    // rather than being noticed only by someone reading the diff.
    setFixture('clean-with-tools');
    const reviewer = makeReviewer({ id: 'model-a', provider: 'prov-a' });
    const snapshot = makeSnapshot();
    const repoRoot = '/does/not/matter/for/the/fake/host';
    const spawnSpy = vi.spyOn(cp, 'spawn');

    await runPanel(baseOptions({ reviewers: [reviewer], snapshot, repoRoot }));

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [, , opts] = spawnSpy.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];

    const expectedEnv = buildReviewerEnv({
      ...process.env,
      COUNCIL_SNAPSHOT_ROOT: snapshot.root,
      COUNCIL_REPO_ROOT: repoRoot,
    });

    expect(opts.env).toEqual(expectedEnv);
    expect(Object.keys(opts.env).sort()).toEqual(Object.keys(expectedEnv).sort());
    expect(opts.env.COUNCIL_FAKE_HOST_STREAM).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------------------------

function makeSink(isTTY: boolean): { sink: ProgressSink; chunks: string[] } {
  const chunks: string[] = [];
  const sink: ProgressSink = {
    write: (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    },
    isTTY,
  };
  return { sink, chunks };
}

describe('progress reporting', () => {
  it('under a terminal, renders one live line per reviewer with state, elapsed time and tokens', async () => {
    setFixture('clean-with-tools');
    const { sink, chunks } = makeSink(true);
    const reviewers = [
      makeReviewer({ id: 'model-a', provider: 'prov-a' }),
      makeReviewer({ id: 'model-b', provider: 'prov-b' }),
    ];

    await runPanel(baseOptions({ reviewers, progressStream: sink }));

    // The constructor writes one initial "running" line per reviewer before anything else runs.
    expect(chunks[0]).toContain('prov-a/model-a: running');
    expect(chunks[1]).toContain('prov-b/model-b: running');

    // Redrawn in place with ANSI cursor movement -- what makes it "live" rather than a plain
    // appended trail, and the thing a refactor to the non-interactive path must not lose either.
    expect(chunks.some((c) => c.includes('\x1b['))).toBe(true);

    const joined = chunks.join('');
    expect(joined).toContain('prov-a/model-a: ok');
    expect(joined).toContain('prov-b/model-b: ok');
    expect(joined).toMatch(/elapsed=\d+\.\d+s/);
    expect(joined).toMatch(/tokens=\d+\/\d+/);
  });

  it('without a terminal, degrades to plain appended lines with no cursor-control sequences', async () => {
    setFixture('clean-with-tools');
    const { sink, chunks } = makeSink(false);
    const reviewers = [
      makeReviewer({ id: 'model-a', provider: 'prov-a' }),
      makeReviewer({ id: 'model-b', provider: 'prov-b' }),
    ];

    await runPanel(baseOptions({ reviewers, progressStream: sink }));

    // No cursor-control sequence anywhere -- the substantive assertion for this scenario: a
    // refactor that accidentally shares the TTY redraw path with the non-interactive one fails
    // here even if every other assertion in this file still passes.
    for (const chunk of chunks) {
      // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of a control character
      expect(chunk).not.toMatch(/\x1b\[/);
    }

    // One appended line per reviewer, carrying state/elapsed/tokens, nothing more.
    expect(chunks).toHaveLength(2);
    const byKey = new Map(chunks.map((c) => [c.split(':')[0], c]));
    expect(byKey.get('prov-a/model-a')).toMatch(
      /^prov-a\/model-a: ok elapsed=\d+\.\d+s tokens=\d+\/\d+\n$/,
    );
    expect(byKey.get('prov-b/model-b')).toMatch(
      /^prov-b\/model-b: ok elapsed=\d+\.\d+s tokens=\d+\/\d+\n$/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Interruption
// ---------------------------------------------------------------------------------------------

describe('interruption', () => {
  it('rejects with AbortError, terminates every in-flight reviewer process and cleans up the snapshot', async () => {
    setFixture('never-ends');
    const reviewers = [
      makeReviewer({ id: 'model-a', provider: 'prov-a' }),
      makeReviewer({ id: 'model-b', provider: 'prov-b' }),
    ];
    const snapshot = makeSnapshot();
    const controller = new AbortController();
    const spawnSpy = vi.spyOn(cp, 'spawn');

    const promise = runPanel(
      baseOptions({
        reviewers,
        snapshot,
        timeoutSeconds: 30,
        maxOutputTokens: 1_000_000,
        signal: controller.signal,
      }),
    );

    // By the time `runPanel(...)` above returns a pending promise, both children have already
    // been spawned and their abort listeners registered -- both spawning and listener
    // registration happen synchronously before the first `await` inside `runAttempt`'s Promise
    // executor (the same property the fan-out test pins). So aborting right here, with no
    // sleep, reliably reaches processes that are actually running.
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    expect(spawnSpy).toHaveBeenCalledTimes(2);
    const children = spawnSpy.mock.results.map((r) => r.value as cp.ChildProcess);

    // Poll for real process exit rather than a fixed sleep -- runPanel() has already resolved
    // (rejected) by this point, which only happens once each attempt's child has both drained
    // stdout and exited, so this loop is expected to end almost immediately; it exists to
    // avoid a hard assumption about scheduling order between the assertion and the OS.
    const deadline = Date.now() + 10_000;
    while (
      children.some((c) => c.exitCode === null && c.signalCode === null) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    for (const child of children) {
      expect(child.killed).toBe(true); // SIGTERM was actually sent to this process
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true); // and it actually exited
    }

    expect(snapshot.cleanup).toHaveBeenCalledTimes(1);
  }, 15_000);
});
