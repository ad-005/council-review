/**
 * Security tests for the reviewer spawn composition (`src/reviewer-spawn.ts`):
 *  - the argument vector removes host built-ins and contains nothing that would re-enable one
 *  - the environment allowlist drops an injected foreign secret
 *  - `src/reviewer-tools.ts` is never imported by the CLI process (structural, static check)
 *
 * See "Reviewers have no built-in capabilities" and "Reviewer process environment is
 * allowlisted" in `specs/council-review/reviewer-isolation/spec.md`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REVIEWER_TOOL_NAMES,
  buildReviewerArgv,
  buildReviewerEnv,
  resolveHostBin,
  reviewerCwd,
  type SpawnOptions,
} from '../../src/reviewer-spawn.js';

const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url));

const BASE_OPTIONS: SpawnOptions = {
  extensionPath: '/abs/path/to/dist/reviewer-tools.js',
  provider: 'openrouter',
  model: 'anthropic/claude-x',
  thinking: null,
  includeContextFiles: false,
  prompt: 'Review this diff.',
};

describe('buildReviewerArgv', () => {
  it('removes host built-in tools', () => {
    const argv = buildReviewerArgv(BASE_OPTIONS);
    expect(argv).toContain('-nbt');
  });

  it('disables extension auto-discovery and loads only the shipped extension by path', () => {
    const argv = buildReviewerArgv(BASE_OPTIONS);
    expect(argv).toContain('-ne');
    const eIndex = argv.indexOf('-e');
    expect(eIndex).toBeGreaterThanOrEqual(0);
    expect(argv[eIndex + 1]).toBe(BASE_OPTIONS.extensionPath);
  });

  it('disables skills, prompt templates and project trust', () => {
    const argv = buildReviewerArgv(BASE_OPTIONS);
    expect(argv).toContain('-ns');
    expect(argv).toContain('-np');
    expect(argv).toContain('-na');
  });

  it('disables session persistence', () => {
    expect(buildReviewerArgv(BASE_OPTIONS)).toContain('--no-session');
  });

  it('uses the structured JSON event stream in headless/print mode', () => {
    const argv = buildReviewerArgv(BASE_OPTIONS);
    const modeIndex = argv.indexOf('--mode');
    expect(modeIndex).toBeGreaterThanOrEqual(0);
    expect(argv[modeIndex + 1]).toBe('json');
    expect(argv).toContain('-p');
  });

  it('contains no flag or argument that would re-enable a built-in tool', () => {
    const argv = buildReviewerArgv(BASE_OPTIONS);
    const reEnablingFlags = ['-t', '--tools', '--no-builtin-tools=false', '-bt', '--builtin-tools'];
    for (const flag of reEnablingFlags) {
      expect(argv).not.toContain(flag);
    }
    // No occurrence of any built-in tool's name as a bare flag value that could re-activate it
    // via some allowlist flag this vector doesn't even pass.
    const builtinToolNames = ['bash', 'powershell', 'edit', 'write', 'read', 'grep', 'find', 'ls'];
    for (const name of builtinToolNames) {
      expect(argv).not.toContain(name);
    }
  });

  it('excludes context files by default and includes them only on opt-in', () => {
    expect(buildReviewerArgv(BASE_OPTIONS)).toContain('-nc');
    const optedIn = buildReviewerArgv({ ...BASE_OPTIONS, includeContextFiles: true });
    expect(optedIn).not.toContain('-nc');
  });

  it('passes no --thinking flag when thinking is null, and passes the level when set', () => {
    expect(buildReviewerArgv(BASE_OPTIONS)).not.toContain('--thinking');
    const withThinking = buildReviewerArgv({ ...BASE_OPTIONS, thinking: 'high' });
    const idx = withThinking.indexOf('--thinking');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(withThinking[idx + 1]).toBe('high');
  });

  it('passes provider, model and the trailing prompt', () => {
    const argv = buildReviewerArgv(BASE_OPTIONS);
    expect(argv[argv.indexOf('--provider') + 1]).toBe(BASE_OPTIONS.provider);
    expect(argv[argv.indexOf('--model') + 1]).toBe(BASE_OPTIONS.model);
    expect(argv[argv.length - 1]).toBe(BASE_OPTIONS.prompt);
  });
});

describe('buildReviewerEnv', () => {
  it('drops an injected foreign secret entirely', () => {
    const env = buildReviewerEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/reviewer',
      AWS_SECRET_ACCESS_KEY: 'super-secret-value',
      OPENAI_API_KEY: 'sk-should-not-leak',
      GITHUB_TOKEN: 'ghp_shouldnotleak',
      SOME_RANDOM_VAR: 'irrelevant',
    });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SOME_RANDOM_VAR).toBeUndefined();
    expect(Object.values(env)).not.toContain('super-secret-value');
    expect(Object.values(env)).not.toContain('sk-should-not-leak');
    expect(Object.values(env)).not.toContain('ghp_shouldnotleak');
  });

  it('keeps the executable search path and home directory', () => {
    const env = buildReviewerEnv({ PATH: '/usr/bin:/bin', HOME: '/Users/reviewer' });
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/Users/reviewer');
  });

  it('keeps the two roots reviewer-tools.ts reads', () => {
    const env = buildReviewerEnv({
      COUNCIL_SNAPSHOT_ROOT: '/tmp/snap',
      COUNCIL_REPO_ROOT: '/repo',
    });
    expect(env.COUNCIL_SNAPSHOT_ROOT).toBe('/tmp/snap');
    expect(env.COUNCIL_REPO_ROOT).toBe('/repo');
  });

  it('keeps the resolved CodeGraph binary path', () => {
    const env = buildReviewerEnv({ COUNCIL_CODEGRAPH_BIN: '/opt/bin/codegraph' });
    expect(env.COUNCIL_CODEGRAPH_BIN).toBe('/opt/bin/codegraph');
  });

  it("keeps the host's own PI_* namespace", () => {
    const env = buildReviewerEnv({ PI_OFFLINE: '1', PI_TELEMETRY: '0' });
    expect(env.PI_OFFLINE).toBe('1');
    expect(env.PI_TELEMETRY).toBe('0');
  });

  it('produces an empty environment from an empty input', () => {
    expect(buildReviewerEnv({})).toEqual({});
  });
});

describe('reviewerCwd', () => {
  it('is the snapshot root', () => {
    expect(reviewerCwd('/tmp/some-snapshot')).toBe('/tmp/some-snapshot');
  });
});

describe('resolveHostBin', () => {
  it('honours COUNCIL_PI_BIN when set', () => {
    expect(resolveHostBin({ COUNCIL_PI_BIN: '/custom/pi' })).toBe('/custom/pi');
  });

  it('falls back to "pi" on PATH otherwise', () => {
    expect(resolveHostBin({})).toBe('pi');
  });
});

describe('REVIEWER_TOOL_NAMES', () => {
  it('is exactly the five council tools', () => {
    expect(REVIEWER_TOOL_NAMES).toEqual([
      'council_read',
      'council_grep',
      'council_list',
      'council_git',
      'council_codegraph',
    ]);
  });
});

describe('src/reviewer-tools.ts is never imported by any other src/ module', () => {
  function listSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listSourceFiles(full));
      } else if (extname(entry.name) === '.ts') {
        out.push(full);
      }
    }
    return out;
  }

  const IMPORT_PATTERN =
    /from\s+['"][^'"]*reviewer-tools(\.js)?['"]|require\(\s*['"][^'"]*reviewer-tools(\.js)?['"]\s*\)/;

  it('no src/ file other than reviewer-tools.ts itself references it', () => {
    const files = listSourceFiles(SRC_DIR).filter(
      (f) => relative(SRC_DIR, f) !== 'reviewer-tools.ts',
    );
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => IMPORT_PATTERN.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('reviewer-tools.ts is loaded only by path (dist/reviewer-tools.js), never as a package import, in reviewer-spawn.ts', () => {
    const spawnSource = readFileSync(join(SRC_DIR, 'reviewer-spawn.ts'), 'utf8');
    expect(IMPORT_PATTERN.test(spawnSource)).toBe(false);
  });
});
