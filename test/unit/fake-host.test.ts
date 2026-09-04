/**
 * Self-test for the fake host binary and its fixture streams (Section 10). This is not a test of
 * the runner (Section 11 owns `test/unit/runner.test.ts`) — it verifies the stub and fixtures are
 * trustworthy building blocks: the stub replays what's on disk faithfully and exits the way it
 * documents, the fixtures are syntactically what they claim to be (mostly-valid JSONL with
 * deliberate exceptions where documented), and every findings block embedded in a fixture parses
 * against the real `src/schema.ts` exactly the way it's meant to.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { extractFindings } from '../../src/schema.js';
import {
  FAKE_HOST_BIN,
  FIXTURE_NAMES,
  fixtureEnv,
  fixturePath,
  sequenceEnv,
} from '../helpers/fake-host.js';

const execFileAsync = promisify(execFile);

/** Reads a fixture, returning its raw lines and how many parse as JSON. */
function readFixtureLines(name: (typeof FIXTURE_NAMES)[number]) {
  const raw = readFileSync(fixturePath(name), 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const parsed = lines.map((l) => {
    try {
      return { ok: true as const, value: JSON.parse(l) };
    } catch {
      return { ok: false as const, value: undefined };
    }
  });
  return { lines, parsed };
}

/** Concatenates every `text` block off the LAST assistant `message_end` in a fixture, per the
 * extraction rule verified in host-notes section A. Returns null if there is no such event
 * (the truncated fixture, by design). */
function finalAssistantText(name: (typeof FIXTURE_NAMES)[number]): string | null {
  const { parsed } = readFixtureLines(name);
  let last: unknown = null;
  for (const p of parsed) {
    if (!p.ok) continue;
    const ev = p.value as { type?: string; message?: { role?: string } };
    if (ev.type === 'message_end' && ev.message?.role === 'assistant') last = ev.message;
  }
  if (!last) return null;
  const content = (last as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

describe('fixture files are well-formed', () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name}.jsonl exists and is non-empty`, () => {
      const { lines } = readFixtureLines(name);
      expect(lines.length).toBeGreaterThan(0);
    });
  }

  it('only unparseable-lines contains lines that fail to JSON.parse', () => {
    for (const name of FIXTURE_NAMES) {
      const { parsed } = readFixtureLines(name);
      const badCount = parsed.filter((p) => !p.ok).length;
      if (name === 'unparseable-lines') {
        expect(badCount).toBeGreaterThan(0);
      } else {
        expect(badCount).toBe(0);
      }
    }
  });

  it('truncated has no terminal message_end/turn_end/agent_end', () => {
    const { parsed } = readFixtureLines('truncated');
    const types = parsed.filter((p) => p.ok).map((p) => (p.value as { type: string }).type);
    expect(types).not.toContain('agent_end');
    expect(types).not.toContain('turn_end');
    expect(types.filter((t) => t === 'message_end')).toHaveLength(1); // only the user message's message_end
  });

  it('never-ends has no terminal message in its base lines', () => {
    const { parsed } = readFixtureLines('never-ends');
    const types = parsed.filter((p) => p.ok).map((p) => (p.value as { type: string }).type);
    expect(types).not.toContain('agent_end');
    expect(types).not.toContain('message_end');
  });

  it('clean-with-tools carries both council_read and council_grep tool calls', () => {
    const { parsed } = readFixtureLines('clean-with-tools');
    const toolNames = parsed
      .filter((p) => p.ok)
      .map((p) => p.value as { type: string; toolName?: string })
      .filter((ev) => ev.type === 'tool_execution_start')
      .map((ev) => ev.toolName);
    expect(toolNames).toContain('council_read');
    expect(toolNames).toContain('council_grep');
  });
});

describe('fixture findings blocks parse against the real schema module', () => {
  it('clean-with-tools final text yields one valid, high-severity finding', () => {
    const text = finalAssistantText('clean-with-tools');
    expect(text).not.toBeNull();
    const result = extractFindings(text!);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.severity).toBe('high');
      expect(result.findings[0]?.file).toBe('src/foo.ts');
    }
  });

  it('invalid-findings final text fails extraction (bad severity, missing impact)', () => {
    const text = finalAssistantText('invalid-findings');
    expect(text).not.toBeNull();
    const result = extractFindings(text!);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('valid-findings final text yields one valid finding', () => {
    const text = finalAssistantText('valid-findings');
    expect(text).not.toBeNull();
    const result = extractFindings(text!);
    expect(result.ok).toBe(true);
  });

  it('unparseable-lines final text yields a valid, empty findings list', () => {
    const text = finalAssistantText('unparseable-lines');
    expect(text).not.toBeNull();
    const result = extractFindings(text!);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.findings).toHaveLength(0);
  });

  it('truncated has no final assistant message to extract from', () => {
    expect(finalAssistantText('truncated')).toBeNull();
  });
});

describe('the stub binary, run directly', () => {
  it('replays clean-with-tools to stdout and exits 0', async () => {
    const { stdout } = await execFileAsync('node', [FAKE_HOST_BIN, '--mode', 'json'], {
      env: { ...process.env, ...fixtureEnv('clean-with-tools') },
    });
    const lines = stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThan(10);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'agent_start' });
    expect(JSON.parse(lines[lines.length - 1]!).type).toBe('agent_end');
  });

  it('exits 1 with no closing event for the truncated fixture', async () => {
    await expect(
      execFileAsync('node', [FAKE_HOST_BIN, '--mode', 'json'], {
        env: { ...process.env, ...fixtureEnv('truncated') },
      }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('accepts and ignores a realistic reviewer-spawn argument vector', async () => {
    const argv = [
      FAKE_HOST_BIN,
      '-p',
      '--mode',
      'json',
      '--no-builtin-tools',
      '--no-extensions',
      '--extension',
      '/fake/path/reviewer-tools.js',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-approve',
      '--no-session',
      '--no-themes',
      '--thinking',
      'high',
      '--provider',
      'openrouter',
      '--model',
      'some/model',
      'the review prompt',
    ];
    const { stdout } = await execFileAsync('node', argv, {
      env: { ...process.env, ...fixtureEnv('unparseable-lines') },
    });
    expect(stdout.trim().split('\n').length).toBeGreaterThan(0);
  });

  it('selects a fixture via --council-fixture, overriding the env var', async () => {
    const { stdout } = await execFileAsync(
      'node',
      [FAKE_HOST_BIN, '--mode', 'json', '--council-fixture', 'valid-findings'],
      { env: { ...process.env, COUNCIL_FAKE_HOST_STREAM: 'clean-with-tools' } },
    );
    const lines = stdout.trim().split('\n');
    expect(lines.length).toBe(readFixtureLines('valid-findings').lines.length);
  });

  it('exits 2 with no fixture selected at all', async () => {
    const env = { ...process.env };
    delete env.COUNCIL_FAKE_HOST_STREAM;
    await expect(
      execFileAsync('node', [FAKE_HOST_BIN, '--mode', 'json'], { env }),
    ).rejects.toMatchObject({
      code: 2,
    });
  });

  it('sequenceEnv advances across independent process spawns and clamps at the end', async () => {
    const env = { ...process.env, ...sequenceEnv(['invalid-findings', 'valid-findings']) };
    const first = await execFileAsync('node', [FAKE_HOST_BIN, '--mode', 'json'], { env });
    const second = await execFileAsync('node', [FAKE_HOST_BIN, '--mode', 'json'], { env });
    const third = await execFileAsync('node', [FAKE_HOST_BIN, '--mode', 'json'], { env });

    const firstText = extractFindings(lastAssistantTextFromStdout(first.stdout));
    const secondText = extractFindings(lastAssistantTextFromStdout(second.stdout));
    const thirdText = extractFindings(lastAssistantTextFromStdout(third.stdout));

    expect(firstText.ok).toBe(false); // invalid-findings
    expect(secondText.ok).toBe(true); // valid-findings
    expect(thirdText.ok).toBe(true); // clamped to valid-findings again
  });

  it('a plain (non-sequence) selector reused twice gives identical content both times — "invalid twice"', async () => {
    const env = { ...process.env, ...fixtureEnv('invalid-findings') };
    const first = await execFileAsync('node', [FAKE_HOST_BIN, '--mode', 'json'], { env });
    const second = await execFileAsync('node', [FAKE_HOST_BIN, '--mode', 'json'], { env });
    expect(extractFindings(lastAssistantTextFromStdout(first.stdout)).ok).toBe(false);
    expect(extractFindings(lastAssistantTextFromStdout(second.stdout)).ok).toBe(false);
    expect(first.stdout).toBe(second.stdout);
  });

  it('never-ends keeps streaming until SIGTERM, then exits 143 with no closing event', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn('node', [FAKE_HOST_BIN, '--mode', 'json'], {
      env: { ...process.env, ...fixtureEnv('never-ends') },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));

    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    // Wait for actual output rather than sleeping a fixed duration: under a loaded test run
    // (many suites in parallel), a blind sleep is exactly the kind of thing that makes a test
    // flaky. Poll until at least one full line has arrived, generously bounded.
    const deadline = Date.now() + 15000;
    while (!out.includes('\n') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(out.length).toBeGreaterThan(0); // fails loudly, not silently, if nothing ever arrived

    child.kill('SIGTERM');
    const code = await exited;

    expect(code).toBe(143);
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(lines.some((l) => JSON.parse(l).type === 'agent_end')).toBe(false);
  }, 20000);
});

/** Test-local helper: same extraction rule as `finalAssistantText`, but over already-captured stdout. */
function lastAssistantTextFromStdout(stdout: string): string {
  const lines = stdout.trim().split('\n');
  let last: { content: Array<{ type: string; text?: string }> } | null = null;
  for (const l of lines) {
    let ev: {
      type?: string;
      message?: { role?: string; content?: Array<{ type: string; text?: string }> };
    };
    try {
      ev = JSON.parse(l);
    } catch {
      continue;
    }
    if (ev.type === 'message_end' && ev.message?.role === 'assistant' && ev.message.content) {
      last = ev.message as { content: Array<{ type: string; text?: string }> };
    }
  }
  if (!last) throw new Error('no assistant message_end found in stdout');
  return last.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}
