#!/usr/bin/env node
/**
 * The process entry point for the `council-review` binary. This file's only purpose is to run,
 * so it needs no "am I the actual entry point" detection: the heuristic this replaces (comparing
 * `import.meta.url` against `pathToFileURL(process.argv[1])`) was unfixable for an npm-installed
 * bin, because npm installs a `bin` as a symlink and Node resolves `import.meta.url` to the
 * module's real path while leaving `process.argv[1]` as the symlink path used to invoke it — the
 * two can never match, so the guard silently swallowed every invocation of the installed binary.
 * Splitting the entry point out of `cli.ts` removes the need for that comparison entirely: `cli.ts`
 * stays a pure library module that `test/unit/cli.test.ts` can import without triggering `main()`.
 */
import { assertNodeVersion } from './node-guard.js';
import { runCli } from './cli.js';

async function main(): Promise<void> {
  assertNodeVersion();
  process.exitCode = await runCli(process.argv.slice(2));
}

void main();
