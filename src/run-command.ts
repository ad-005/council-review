/**
 * The one bounded host-command runner shared by `providers.ts` (catalog listing, readiness
 * checks) and `pi-update.ts` (the start-of-run self-update). Deliberately not re-exported from
 * `index.ts`: it is internal plumbing, not library surface.
 *
 * Never rejects. A spawn failure, a timeout and a normal exit (of any code) each resolve to a
 * distinct `kind`, so every caller maps outcomes to its own vocabulary without a try/catch.
 *
 * A timeout is a kill, not an abandonment: the child gets SIGTERM, then SIGKILL after a grace
 * period, and the promise settles only once the child has actually closed (or a further bounded
 * wait has passed, for a child whose stdio is held open by a grandchild). That ordering is what
 * guarantees a timed-out `pi update --self` is no longer rewriting the host binary by the time the
 * caller goes on to launch reviewers from it. Every timer is `unref`'d, so none of them alone can
 * hold the CLI process open.
 */
import { spawn } from 'node:child_process';

export type CommandOutcome =
  | {
      kind: 'exited';
      /** Exit code, or null when the child was ended by a signal (see `signal`). */
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }
  | { kind: 'spawn-failed'; message: string }
  | { kind: 'timeout' };

export interface RunCommandOptions {
  timeoutMs: number;
  /** How long after SIGTERM to escalate to SIGKILL, and how long after SIGKILL to wait for
   *  `close` before settling anyway. Principally a test seam. */
  killGraceMs?: number;
}

export const DEFAULT_KILL_GRACE_MS = 2_000;

export function runCommand(
  bin: string,
  args: readonly string[],
  opts: RunCommandOptions,
): Promise<CommandOutcome> {
  const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ kind: 'spawn-failed', message: err instanceof Error ? err.message : String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];

    const later = (ms: number, fn: () => void): void => {
      const t = setTimeout(fn, ms);
      t.unref();
      timers.push(t);
    };

    const settle = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      resolve(outcome);
    };

    later(opts.timeoutMs, () => {
      timedOut = true;
      child.kill('SIGTERM');
      later(graceMs, () => {
        child.kill('SIGKILL');
        // Bounded: a grandchild holding the pipes open must not stall the caller forever.
        later(graceMs, () => settle({ kind: 'timeout' }));
      });
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      settle(timedOut ? { kind: 'timeout' } : { kind: 'spawn-failed', message: err.message });
    });

    child.on('close', (code, signal) => {
      settle(timedOut ? { kind: 'timeout' } : { kind: 'exited', code, signal, stdout, stderr });
    });
  });
}
