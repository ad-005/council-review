// Cooperation with the herdr pane environment (https://herdr.dev). Every interaction here is
// strictly optional: the tool must behave identically in a plain shell or in CI, where herdr is
// simply absent. Nothing in this module may throw into the caller's exit path — every herdr
// command is spawned defensively and a failure degrades to a printed warning, never an error.
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Resolves the herdr binary: `COUNCIL_HERDR_BIN` override, else `herdr` on `PATH`. */
function herdrBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.COUNCIL_HERDR_BIN ?? 'herdr';
}

/**
 * True when running inside a herdr-managed pane. herdr injects `HERDR_ENV=1` (along with
 * `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`)
 * into every pane it manages; verified against herdr 0.8.2's own `--skill` documentation, which
 * tells agents to gate on exactly this variable before issuing any control command.
 */
export function isHerdrEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV === '1';
}

// Printed at most once per process, no matter how many herdr-flagged interactions are attempted
// outside a herdr environment (Scenario: "Notice is printed once").
let noticeShown = false;

function noticeOutsideHerdr(): void {
  if (noticeShown) return;
  noticeShown = true;
  console.error(
    'council: herdr not detected (HERDR_ENV is not set) — herdr integration skipped; the review proceeds normally.',
  );
}

/** Test-only: clears the "notice already shown" latch between test cases. */
export function __resetHerdrNoticeForTests(): void {
  noticeShown = false;
}

function warn(message: string): void {
  console.error(`council: herdr warning: ${message}`);
}

interface HerdrCallResult {
  ok: boolean;
  stdout: string;
  message?: string;
}

/** Runs one herdr subcommand synchronously, swallowing every failure into a result flag. */
function runHerdrSync(args: readonly string[]): HerdrCallResult {
  const bin = herdrBin();
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(bin, args, { encoding: 'utf8' });
  } catch (err) {
    return { ok: false, stdout: '', message: (err as Error).message };
  }
  if (result.error) {
    return { ok: false, stdout: '', message: result.error.message };
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit code ${result.status}`).trim();
    return { ok: false, stdout: result.stdout ?? '', message: detail };
  }
  return { ok: true, stdout: result.stdout ?? '' };
}

/** Pulls `.result.pane.pane_id` out of a `herdr pane split` JSON response. */
function extractPaneId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } };
    const paneId = parsed.result?.pane?.pane_id;
    return typeof paneId === 'string' ? paneId : null;
  } catch {
    return null;
  }
}

// Set on the delegated pane's launched process (and again, belt-and-suspenders, as a literal
// `env` prefix on the command run inside it) so that when the review re-enters this module from
// inside the pane just created for it, splitPaneAndRun refuses to split a second time. This is
// enforced entirely within this module rather than relying on the CLI to omit a pane-requesting
// flag on the delegated invocation.
const DELEGATED_MARKER = 'COUNCIL_HERDR_DELEGATED';

/**
 * Splits a new pane from the current one and runs `argv` inside it. The herdr CLI's own
 * `--direction` flag only accepts `right` / `down` (side-by-side vs. stacked), not
 * `horizontal` / `vertical`; `horizontal` maps to `right` and `vertical` maps to `down`.
 */
export function splitPaneAndRun(
  argv: readonly string[],
  direction: 'horizontal' | 'vertical' = 'horizontal',
): { attempted: boolean } {
  if (!isHerdrEnv()) {
    noticeOutsideHerdr();
    return { attempted: false };
  }

  if (process.env[DELEGATED_MARKER] === '1') {
    // Already running inside a pane created for a delegated review; never split again.
    return { attempted: false };
  }

  const herdrDirection = direction === 'vertical' ? 'down' : 'right';

  const split = runHerdrSync([
    'pane',
    'split',
    '--current',
    '--direction',
    herdrDirection,
    '--cwd',
    process.cwd(),
    '--no-focus',
  ]);
  if (!split.ok) {
    warn(`could not split a pane for the review: ${split.message}`);
    return { attempted: true };
  }

  const paneId = extractPaneId(split.stdout);
  if (!paneId) {
    warn('herdr pane split did not return a pane id; review was not delegated to a new pane');
    return { attempted: true };
  }

  // `env COUNCIL_HERDR_DELEGATED=1 <argv...>` guarantees the delegated process sees the marker
  // regardless of whether herdr's own environment propagation persists across `pane run` calls.
  const run = runHerdrSync(['pane', 'run', paneId, 'env', `${DELEGATED_MARKER}=1`, ...argv]);
  if (!run.ok) {
    warn(`could not run the review in the split pane: ${run.message}`);
  }

  return { attempted: true };
}

/** Renames the current pane. `herdr pane rename` needs the pane id; herdr injects it as `HERDR_PANE_ID`. */
export function setPaneTitle(title: string): { attempted: boolean } {
  if (!isHerdrEnv()) {
    noticeOutsideHerdr();
    return { attempted: false };
  }

  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) {
    warn('HERDR_PANE_ID is not set; skipping pane title');
    return { attempted: true };
  }

  const result = runHerdrSync(['pane', 'rename', paneId, title]);
  if (!result.ok) {
    warn(`could not set the pane title: ${result.message}`);
  }
  return { attempted: true };
}

/** Raises a herdr desktop notification. A no-op, without a notice, when suppressed by the caller. */
export function notifyComplete(message: string, suppressed: boolean): { attempted: boolean } {
  if (!isHerdrEnv()) {
    noticeOutsideHerdr();
    return { attempted: false };
  }

  if (suppressed) {
    return { attempted: false };
  }

  const result = runHerdrSync([
    'notification',
    'show',
    'Council review complete',
    '--body',
    message,
  ]);
  if (!result.ok) {
    warn(`could not raise the completion notification: ${result.message}`);
  }
  return { attempted: true };
}

/**
 * Delivers the handoff prompt (already written to `promptPath` by the report writer) to a named
 * herdr-managed agent. The existence check (`herdr agent get`) is synchronous so an unknown
 * agent can be warned about immediately; delivery itself (`herdr agent prompt`, without `--wait`)
 * is fired without being awaited, so the review's own completion never depends on the agent's
 * response.
 */
export function handoffToAgent(agent: string, promptPath: string): { attempted: boolean } {
  if (!isHerdrEnv()) {
    noticeOutsideHerdr();
    return { attempted: false };
  }

  const bin = herdrBin();

  const check = runHerdrSync(['agent', 'get', agent]);
  if (!check.ok) {
    warn(
      `herdr agent "${agent}" was not found; the handoff prompt remains written at ${promptPath} for manual use`,
    );
    return { attempted: true };
  }

  let text: string;
  try {
    text = readFileSync(promptPath, 'utf8');
  } catch (err) {
    warn(`could not read the handoff prompt at ${promptPath}: ${(err as Error).message}`);
    return { attempted: true };
  }

  // Deliberately not awaited: `spawn`, not `spawnSync`, and no `--wait` flag, so a slow or
  // non-responding agent never delays the review command's own exit.
  try {
    const child = spawn(bin, ['agent', 'prompt', agent, text], { stdio: 'ignore' });
    child.on('error', (err) => {
      warn(`could not deliver the handoff prompt to "${agent}": ${err.message}`);
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        warn(`herdr agent prompt to "${agent}" exited with code ${code}`);
      }
    });
  } catch (err) {
    warn(`could not deliver the handoff prompt to "${agent}": ${(err as Error).message}`);
  }

  return { attempted: true };
}
