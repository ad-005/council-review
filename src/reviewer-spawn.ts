/**
 * Composes what it takes to launch one isolated reviewer process: the host CLI argument vector
 * and the allowlisted process environment. This module never spawns anything itself -- that is
 * the runner's job (Section 11); this module only builds the two things the runner needs, so
 * they can be asserted on in isolation without a real host binary.
 *
 * Every flag below is taken from `SCRATCH/host-notes.md` section B (the isolation flag surface,
 * verified against pi 0.84.4's own bundle) and cross-checked against
 * `specs/council-review/reviewer-isolation/spec.md`. See that spec for the "why" behind each
 * flag; this file is just the composition.
 */
import type { ThinkingLevel } from './levels.js';

/** The reviewer's entire callable tool surface. Must match, name for name, what
 *  `src/reviewer-tools.ts` registers. */
export const REVIEWER_TOOL_NAMES: readonly [
  'council_read',
  'council_grep',
  'council_list',
  'council_git',
] = ['council_read', 'council_grep', 'council_list', 'council_git'];

export interface SpawnOptions {
  /** Absolute path to the built extension module (dist/reviewer-tools.js). */
  extensionPath: string;
  provider: string;
  model: string;
  /** null means "pass no --thinking flag at all", distinct from any explicit level. */
  thinking: ThinkingLevel | null;
  includeContextFiles: boolean;
  prompt: string;
}

/**
 * Builds the reviewer's CLI argument vector. Every flag here removes a capability or a
 * resource-discovery path; none of them re-enables anything `-nbt`/`-ne` just disabled.
 *
 *  -nbt          no built-in tools (shell, read, write, edit, grep, find, ls all inactive)
 *  -ne -e <path> disable extension auto-discovery, then load ONLY the shipped extension by path
 *                -- together these make the extension's own registered tools the reviewer's
 *                entire tool surface (host-notes section B, point 3)
 *  -ns           no skills
 *  -np           no prompt templates
 *  -na           no-approve: ignore project-local trust state from the reviewed repository
 *  --no-session  reviewer transcripts (which contain repository source) are never persisted
 *  --no-themes   no theme-file discovery; harmless in headless mode, cheap to drop anyway
 *  --mode json   the structured JSONL event stream the runner parses
 *  -p            print/headless mode (no interactive UI, ctx.hasUI === false)
 *  -nc           context files excluded by default (spec: "Agent context files are excluded by
 *                default"); omitted only when the run has opted in
 */
export function buildReviewerArgv(o: SpawnOptions): string[] {
  const argv: string[] = [
    '-nbt',
    '-ne',
    '-e',
    o.extensionPath,
    '-ns',
    '-np',
    '-na',
    '--no-session',
    '--no-themes',
    '--mode',
    'json',
    '-p',
    '--provider',
    o.provider,
    '--model',
    o.model,
  ];

  if (!o.includeContextFiles) {
    argv.push('-nc');
  }

  if (o.thinking !== null) {
    argv.push('--thinking', o.thinking);
  }

  argv.push(o.prompt);
  return argv;
}

/** Exact-name variables always passed through when present in the parent environment. */
const ALLOWLISTED_EXACT_VARS: readonly string[] = [
  'PATH',
  'HOME',
  'COUNCIL_SNAPSHOT_ROOT',
  'COUNCIL_REPO_ROOT',
];

/** pi's own env-var namespace (host-notes section D): startup/debug/telemetry toggles, none of
 *  them tool-surface- or credential-related. Passed through by prefix so a future pi release
 *  adding another `PI_*` var does not require a code change here. */
const ALLOWLISTED_PREFIXES: readonly string[] = ['PI_'];

/**
 * Builds the reviewer process environment: an allowlist, not a denylist. Every variable from
 * `parentEnv` is dropped unless it is the executable search path, the home directory (needed so
 * the host can find its own config and credentials under `~/.pi/agent/`), one of the two roots
 * `reviewer-tools.ts` reads, or one of the host's own `PI_*` variables. In particular, no
 * provider `*_API_KEY`-shaped variable and no unrelated secret from the invoking environment
 * ever reaches a reviewer process -- per spec, a reviewer authenticates only through the host's
 * own OAuth store under `HOME`, never through an inherited API key.
 */
export function buildReviewerEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    const allowed =
      ALLOWLISTED_EXACT_VARS.includes(key) ||
      ALLOWLISTED_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (allowed) {
      env[key] = value;
    }
  }
  return env;
}

/** The reviewer's working directory: always the frozen snapshot root, never the real repository
 *  and never the invoking process's own cwd. The runner (Section 11) must pass this as the `cwd`
 *  option to whatever it uses to spawn the host process. */
export function reviewerCwd(snapshotRoot: string): string {
  return snapshotRoot;
}

/** Resolves the host binary: `$COUNCIL_PI_BIN` if set (the test seam every host-spawning module
 *  must honour), else `pi` on `PATH`. */
export function resolveHostBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.COUNCIL_PI_BIN ?? 'pi';
}
