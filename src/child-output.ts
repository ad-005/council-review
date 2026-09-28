/**
 * Small helpers shared by every CLI-side module that runs a child process and reads its whole
 * output (git in `scope.ts` / `snapshot.ts`, CodeGraph in `codegraph.ts` / `blast-radius.ts`).
 * Not for `reviewer-tools.ts`, which may import only `node:` builtins and keeps its own copies.
 */

/** `maxBuffer` for a child whose whole stdout is read at once: large enough that a big diff,
 *  tree listing or query result is never silently truncated at Node's 1MB default. */
export const CHILD_MAX_BUFFER = 1024 * 1024 * 256;

export function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** The most useful description of a failed child process: its stderr when it wrote any (as a
 *  string or a Buffer), else the error's own message. */
export function childErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      return stderr.trim();
    }
    if (Buffer.isBuffer(stderr) && stderr.length > 0) {
      return stderr.toString('utf8').trim();
    }
  }
  return err instanceof Error ? err.message : String(err);
}
