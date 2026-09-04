import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetHerdrNoticeForTests,
  handoffToAgent,
  isHerdrEnv,
  notifyComplete,
  setPaneTitle,
  splitPaneAndRun,
} from '../../src/herdr.js';

let dir: string;
let logFile: string;

/**
 * Writes a stub `herdr` binary that logs every argv it receives (one JSON array per line, to
 * `HERDR_STUB_LOG`) and returns canned responses for the subcommands this module calls. Failure
 * injection: `HERDR_STUB_FAIL` is a comma-joined argv prefix (e.g. `"pane,split"`) that makes a
 * matching call exit non-zero. Never invokes the real `herdr`.
 */
function writeStub(d: string): string {
  const stubPath = path.join(d, 'herdr-stub.cjs');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.HERDR_STUB_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(args) + '\\n');

const fail = process.env.HERDR_STUB_FAIL;
if (fail) {
  const parts = fail.split(',');
  if (parts.every((p, i) => args[i] === p)) {
    process.stderr.write('stub: simulated failure\\n');
    process.exit(1);
  }
}

if (args[0] === 'agent' && args[1] === 'prompt') {
  const delay = Number(process.env.HERDR_STUB_PROMPT_DELAY_MS || '0');
  if (delay > 0) {
    const until = Date.now() + delay;
    while (Date.now() < until) {
      // busy-wait: proves the caller did not block on this process
    }
  }
  // Written only once the (possibly delayed) delivery has actually finished -- a signal the
  // stub itself controls, so a test can prove "the caller returned before this" as an event
  // ordering rather than a wall-clock margin.
  const doneFile = process.env.HERDR_STUB_PROMPT_DONE_FILE;
  if (doneFile) fs.writeFileSync(doneFile, 'done');
  process.exit(0);
}

if (args[0] === 'pane' && args[1] === 'split') {
  process.stdout.write(JSON.stringify({ id: 'cli:pane:split', result: { pane: { pane_id: 'stub:pane:new' } } }));
  process.exit(0);
}

if (args[0] === 'agent' && args[1] === 'get') {
  if (args[2] === 'missing-agent') {
    process.stderr.write(JSON.stringify({ error: { code: 'agent_not_found' } }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ result: { agent: { agent: args[2] } } }));
  process.exit(0);
}

process.stdout.write('{}');
process.exit(0);
`;
  fs.writeFileSync(stubPath, script, { mode: 0o755 });
  return stubPath;
}

function readCalls(): string[][] {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const ENV_KEYS = [
  'HERDR_ENV',
  'HERDR_PANE_ID',
  'COUNCIL_HERDR_BIN',
  'COUNCIL_HERDR_DELEGATED',
  'HERDR_STUB_LOG',
  'HERDR_STUB_FAIL',
  'HERDR_STUB_PROMPT_DELAY_MS',
  'HERDR_STUB_PROMPT_DONE_FILE',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-review-herdr-'));
  logFile = path.join(dir, 'calls.log');

  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.COUNCIL_HERDR_BIN = writeStub(dir);
  process.env.HERDR_STUB_LOG = logFile;
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_PANE_ID;
  delete process.env.COUNCIL_HERDR_DELEGATED;
  delete process.env.HERDR_STUB_FAIL;
  delete process.env.HERDR_STUB_PROMPT_DELAY_MS;

  __resetHerdrNoticeForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('isHerdrEnv', () => {
  it('is true only when HERDR_ENV is exactly "1"', () => {
    expect(isHerdrEnv({ HERDR_ENV: '1' })).toBe(true);
    expect(isHerdrEnv({ HERDR_ENV: 'true' })).toBe(false);
    expect(isHerdrEnv({})).toBe(false);
  });

  it('defaults to reading process.env', () => {
    process.env.HERDR_ENV = '1';
    expect(isHerdrEnv()).toBe(true);
    delete process.env.HERDR_ENV;
    expect(isHerdrEnv()).toBe(false);
  });
});

describe('outside a herdr environment', () => {
  it('makes every interaction a no-op and invokes no herdr command', async () => {
    const promptPath = path.join(dir, 'handoff.md');
    fs.writeFileSync(promptPath, 'reproduce each finding before fixing it', 'utf8');

    expect(splitPaneAndRun(['node', 'cli.js', 'review'])).toEqual({ attempted: false });
    expect(setPaneTitle('Council review · 4 models')).toEqual({ attempted: false });
    expect(notifyComplete('done', false)).toEqual({ attempted: false });
    expect(handoffToAgent('reviewer', promptPath)).toEqual({ attempted: false });

    // give any wrongly-fired async work a chance to land before asserting it didn't
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readCalls()).toEqual([]);
  });

  it('prints exactly one notice no matter how many herdr flags were supplied', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const promptPath = path.join(dir, 'handoff.md');
    fs.writeFileSync(promptPath, 'x', 'utf8');

    splitPaneAndRun(['node', 'cli.js', 'review']);
    setPaneTitle('t');
    notifyComplete('m', false);
    handoffToAgent('reviewer', promptPath);
    splitPaneAndRun(['node', 'cli.js', 'review']);

    const notices = errorSpy.mock.calls.filter(([msg]) =>
      String(msg).includes('herdr not detected'),
    );
    expect(notices).toHaveLength(1);
  });

  it('leaves exit-code-relevant behaviour untouched (nothing thrown, nothing spawned)', () => {
    expect(() => splitPaneAndRun(['x'])).not.toThrow();
    expect(() => setPaneTitle('t')).not.toThrow();
    expect(() => notifyComplete('m', false)).not.toThrow();
    expect(readCalls()).toEqual([]);
  });
});

describe('inside a herdr environment: splitPaneAndRun', () => {
  beforeEach(() => {
    process.env.HERDR_ENV = '1';
    process.env.HERDR_PANE_ID = 'w1:p1';
  });

  it('splits in the default direction and runs argv in the new pane, without stealing focus', () => {
    const result = splitPaneAndRun(['node', 'cli.js', 'review']);
    expect(result).toEqual({ attempted: true });

    const calls = readCalls();
    expect(calls[0]).toEqual([
      'pane',
      'split',
      '--current',
      '--direction',
      'right',
      '--cwd',
      process.cwd(),
      '--no-focus',
    ]);
    expect(calls[1]).toEqual([
      'pane',
      'run',
      'stub:pane:new',
      'env',
      'COUNCIL_HERDR_DELEGATED=1',
      'node',
      'cli.js',
      'review',
    ]);
  });

  it('maps "vertical" to the herdr --direction down flag', () => {
    splitPaneAndRun(['node', 'cli.js', 'review'], 'vertical');
    expect(readCalls()[0]).toContain('down');
  });

  it('maps "horizontal" to the herdr --direction right flag', () => {
    splitPaneAndRun(['node', 'cli.js', 'review'], 'horizontal');
    expect(readCalls()[0]).toContain('right');
  });

  it('does not split again when already running inside a delegated pane', () => {
    process.env.COUNCIL_HERDR_DELEGATED = '1';
    const result = splitPaneAndRun(['node', 'cli.js', 'review']);
    expect(result).toEqual({ attempted: false });
    expect(readCalls()).toEqual([]);
  });

  it('degrades to a warning, without throwing, when the split command fails', () => {
    process.env.HERDR_STUB_FAIL = 'pane,split';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = splitPaneAndRun(['node', 'cli.js', 'review']);

    expect(result).toEqual({ attempted: true });
    expect(errorSpy.mock.calls.some(([msg]) => String(msg).includes('herdr warning'))).toBe(true);
  });

  it('degrades to a warning, without throwing, when the herdr binary is absent', () => {
    process.env.COUNCIL_HERDR_BIN = path.join(dir, 'does-not-exist-herdr');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => splitPaneAndRun(['node', 'cli.js', 'review'])).not.toThrow();
    expect(errorSpy.mock.calls.some(([msg]) => String(msg).includes('herdr warning'))).toBe(true);
  });
});

describe('inside a herdr environment: setPaneTitle', () => {
  beforeEach(() => {
    process.env.HERDR_ENV = '1';
    process.env.HERDR_PANE_ID = 'w1:p1';
  });

  it('renames the current pane, identifying it as a review with its panel size', () => {
    const result = setPaneTitle('Council review · 4 models');
    expect(result).toEqual({ attempted: true });
    expect(readCalls()).toEqual([['pane', 'rename', 'w1:p1', 'Council review · 4 models']]);
  });

  it('warns instead of throwing when the pane id is unavailable', () => {
    delete process.env.HERDR_PANE_ID;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = setPaneTitle('Council review · 4 models');

    expect(result).toEqual({ attempted: true });
    expect(readCalls()).toEqual([]);
    expect(errorSpy.mock.calls.some(([msg]) => String(msg).includes('herdr warning'))).toBe(true);
  });
});

describe('inside a herdr environment: notifyComplete', () => {
  beforeEach(() => {
    process.env.HERDR_ENV = '1';
  });

  it('raises a notification on completion', () => {
    const result = notifyComplete('3 findings at or above medium', false);
    expect(result).toEqual({ attempted: true });
    expect(readCalls()).toEqual([
      [
        'notification',
        'show',
        'Council review complete',
        '--body',
        '3 findings at or above medium',
      ],
    ]);
  });

  it('raises no notification when suppressed', () => {
    const result = notifyComplete('3 findings at or above medium', true);
    expect(result).toEqual({ attempted: false });
    expect(readCalls()).toEqual([]);
  });

  it('still notifies, conveying completion, after a degraded run', () => {
    const result = notifyComplete('Review completed with a degraded panel', false);
    expect(result).toEqual({ attempted: true });
    expect(readCalls()[0]).toContain('Review completed with a degraded panel');
  });

  it('degrades to a warning when the notification command fails', () => {
    process.env.HERDR_STUB_FAIL = 'notification,show';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = notifyComplete('done', false);

    expect(result).toEqual({ attempted: true });
    expect(errorSpy.mock.calls.some(([msg]) => String(msg).includes('herdr warning'))).toBe(true);
  });
});

describe('inside a herdr environment: handoffToAgent', () => {
  let promptPath: string;

  beforeEach(() => {
    process.env.HERDR_ENV = '1';
    promptPath = path.join(dir, 'handoff.md');
    fs.writeFileSync(
      promptPath,
      'Findings: .council/reviews/run-1/findings.json. Reproduce each finding before fixing it.',
      'utf8',
    );
  });

  it('delivers the written handoff prompt to a known agent, referencing the findings file', async () => {
    const result = handoffToAgent('reviewer', promptPath);
    expect(result).toEqual({ attempted: true });

    await waitFor(() => readCalls().some((c) => c[0] === 'agent' && c[1] === 'prompt'));

    const promptCall = readCalls().find((c) => c[0] === 'agent' && c[1] === 'prompt')!;
    expect(promptCall[2]).toBe('reviewer');
    expect(promptCall[3]).toContain('findings.json');
  });

  it('does not await delivery: returns before a slow agent finishes responding', async () => {
    // Proves the property as an event ordering rather than a wall-clock margin: the stub only
    // writes `doneFile` once its (possibly-delayed) delivery has actually finished, so checking
    // that file's absence immediately after `handoffToAgent` returns is a signal the stub
    // itself controls -- unlike a duration comparison (e.g. "returned in under 1500ms"), it
    // cannot flake under a loaded machine, since it never compares two independently-variable
    // durations against each other. The delay is large only to make delivery-still-pending
    // trivially true at the moment of the check, not because the test waits for it.
    process.env.HERDR_STUB_PROMPT_DELAY_MS = '3000';
    const doneFile = path.join(dir, 'prompt-done.marker');
    process.env.HERDR_STUB_PROMPT_DONE_FILE = doneFile;

    const result = handoffToAgent('reviewer', promptPath);

    expect(result).toEqual({ attempted: true });
    expect(fs.existsSync(doneFile)).toBe(false);

    // This test genuinely needs to wait out the real 3s delay above (plus real subprocess
    // spawn overhead) before its follow-up assertion -- more than Vitest's 5000ms default test
    // timeout leaves room for, especially on a busy shared worker. Both this test's own
    // timeout and `waitFor`'s internal deadline are widened accordingly, well past the fixed
    // 3s delay.
    await waitFor(() => fs.existsSync(doneFile), 15_000);
    expect(fs.existsSync(doneFile)).toBe(true);
  }, 20_000);

  it('warns on an unknown agent, and does not attempt delivery to it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = handoffToAgent('missing-agent', promptPath);

    expect(result).toEqual({ attempted: true });
    expect(errorSpy.mock.calls.some(([msg]) => String(msg).includes('was not found'))).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readCalls().some((c) => c[0] === 'agent' && c[1] === 'prompt')).toBe(false);
    // the prompt file itself is untouched by this module — writing it is the report writer's job
    expect(fs.existsSync(promptPath)).toBe(true);
  });

  it('degrades to a warning, without throwing, when the herdr binary is absent', () => {
    process.env.COUNCIL_HERDR_BIN = path.join(dir, 'does-not-exist-herdr');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => handoffToAgent('reviewer', promptPath)).not.toThrow();
    expect(errorSpy.mock.calls.some(([msg]) => String(msg).includes('herdr warning'))).toBe(true);
  });
});

describe('exit codes and artifacts are unaffected by herdr, present or absent', () => {
  it('never spawns a herdr command outside a herdr environment, whatever flags are requested', async () => {
    const promptPath = path.join(dir, 'handoff.md');
    fs.writeFileSync(promptPath, 'x', 'utf8');

    splitPaneAndRun(['node', 'cli.js', 'review'], 'vertical');
    setPaneTitle('Council review · 4 models');
    notifyComplete('done', false);
    handoffToAgent('reviewer', promptPath);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readCalls()).toEqual([]);
  });

  it('returns the same { attempted: false } shape from every function outside a herdr environment', () => {
    const promptPath = path.join(dir, 'handoff.md');
    fs.writeFileSync(promptPath, 'x', 'utf8');

    expect(splitPaneAndRun(['x'])).toEqual({ attempted: false });
    expect(setPaneTitle('t')).toEqual({ attempted: false });
    expect(notifyComplete('m', false)).toEqual({ attempted: false });
    expect(handoffToAgent('a', promptPath)).toEqual({ attempted: false });
  });
});
