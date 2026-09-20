# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is a symlink to this file. Edit `CLAUDE.md`; never replace the symlink with a copy.

## What this package is

`council-review` sends the work in a git worktree to several models from **different vendors** and
merges their findings in deterministic code, never through another model. Each reviewer is a
separate `pi` host process launched with every built-in removed; its entire tool surface is four
read-only tools scoped to a frozen, non-writable copy of the tree. Read
`docs/design/council-review-design.md` before any non-trivial change — it is the committed design
source of truth.

## Commands

```
npm install            # runs `prepare` → `npm run build`, so dist/ exists after clone
npm run build          # tsc -p tsconfig.json
npm run lint           # eslint .
npm run format         # prettier --check .   (format:fix to write)
npm test               # vitest run --project unit --project security
```

CI runs build, lint, format, `test:unit` and `test:security` on Node 22 and 24. Node >= 22.19.0 is
required to build or run.

Single file or single test (the `--project` flag is required — projects, not directories, select
the suite):

```
npx vitest run --project unit test/unit/merge.test.ts
npx vitest run --project unit -t 'clusters two reports of the same defect'
```

`npm run build` does **not** typecheck the tests: `tsconfig.json` includes only `src/**`. A test
with a broken type passes both `build` and `vitest`. Typecheck tests explicitly when changing a
shape they consume.

`npm run test:live` (`COUNCIL_LIVE=1`) makes **real, billable model calls** through whatever
credentials the local `pi` host holds. Never in CI, never "just to see it pass" — only when the
narrow question in a live test's own header comment is open again, following
[`HOST-VERSION.md`](./HOST-VERSION.md). `COUNCIL_PI_BIN` points the tool at a specific `pi` binary;
losing that export means real spend against the `pi` on `PATH`.

To verify an install end to end, run `npm pack` and install the resulting tarball globally
(`npm install -g ./council-review-<version>.tgz`) — that is exactly what a registry user gets.
`npm install <local-dir>` only symlinks the package and skips lifecycle scripts, and
`npm install -g git+file://$PWD` fails on npm 10.x, which installs nothing into its temporary clone
so the `prepare` build has no compiler.

## Architecture

One run is a pipeline, dispatched by `cli.ts`:

`scope.ts` (selector → one unified patch + file set) → `snapshot.ts` (frozen copy of the whole
reviewed tree) → `panel.ts` (reviewers, via `providers.ts` / `thinking.ts` / `picker.ts`) →
`runner.ts` (N parallel host processes, argv and env from `reviewer-spawn.ts`, JSONL event stream
parsed) → `schema.ts` (findings contract + one repair retry) → `merge.ts` (clustering, agreement,
suppression) → `resolve.ts` (`--since` diffing) → `report.ts` (run directory, manifest, `REPORT.md`,
`HANDOFF.md`). `status.ts` is a deliberately cheap, no-host, no-model check that a coding agent can
call first. `herdr.ts` is entirely optional cooperation with a herdr pane and must never throw into
the exit path.

Invariants that are not obvious from any single file:

- **Exit codes live in one place.** Every module throws a typed error carrying `exitCode`
  (`ConfigError`, `PanelError`, `GuardRefusal`, `ScopeError`, …); only `cli.ts` maps those to a
  process code and owns stdio routing for `--json`. Codes: 0 clean, 1 findings at/above threshold,
  2 config/usage, 3 degraded (outranks 1), 4 guard refusal, 130 interrupted.
- **`src/reviewer-tools.ts` is the security boundary.** It is loaded by path into a foreign
  reviewer process, is never imported by this package's runtime (deliberately absent from
  `index.ts`), may import **only** `node:` builtins (enforced by an eslint `no-restricted-imports`
  rule and by `test/security/reviewer-spawn.test.ts`), and registers exactly four tools:
  `council_read`, `council_grep`, `council_list`, `council_git`.
- **Two roots, never confused.** `COUNCIL_SNAPSHOT_ROOT` is the frozen tree the three read tools
  are contained within; `COUNCIL_REPO_ROOT` is the real repository, reachable only through
  `council_git`'s read-only subcommand allowlist with literal arguments.
- **The reviewer environment is an allowlist, not a denylist** (`buildReviewerEnv`). No
  `*_API_KEY`-shaped variable reaches a reviewer; a reviewer authenticates only through the host's
  own store under `HOME`.
- **The credential store is never opened.** `test/security/no-credentials.test.ts` scans every file
  under `src/` for paths and patterns that would reach `~/.pi/agent/auth.json`.
- **Merging is deterministic and model-free** — no model call, no clock, no randomness, no
  iteration-order dependence. Findings ids are assigned after sorting; fingerprints are what
  survive across runs, which is why `resolve.ts` diffs on fingerprint rather than id.
- **Nothing mutates the user's repository.** Every git call uses an argument array, never a shell
  string; the default scope folds untracked files against a throwaway index file. Freezing the
  snapshot (`chmod a-w`) exists so all reviewers read identical line numbers — it is explicitly
  _not_ the security boundary.
- **The `pi` host is an unstable dependency.** Isolation rests on `pi`'s flag names and event-stream
  shape, which this package does not control. After any `pi` upgrade, follow the re-verification
  procedure in `HOST-VERSION.md` (currently verified: pi 0.85.1).
- **The run-directory layout is a pinned contract** read by `resolve.ts` and `cli.ts`:
  `.council/reviews/<run-id>/{manifest.json,patch.diff,findings.json,REPORT.md,HANDOFF.md,reviewers/*}`,
  plus `.council/reviews/last` — a **symlink** to the newest run directory, not a text file.
- **Config is committed, reports are not.** `init` writes `.council/config.json` and
  `.council/ignore.json` and appends `.council/reviews/` to `.gitignore`.

## Testing conventions

Tests exercise real behaviour rather than mocks: real temporary git repositories
(`test/helpers/git-repo.ts`, always with local git config, never global) and a fake `pi` binary
replaying recorded JSONL streams (`test/helpers/fake-host.ts` → `test/fake-host/pi.mjs`,
`test/fixtures/streams/*`). That is honest subprocess overhead, which is why each vitest project
sets `testTimeout: 30000`.

Two `vitest.config.ts` quirks are load-bearing and verified empirically: a root-level `testTimeout`
is silently ignored by projects declared under `test.projects`, so it must be repeated per project;
`passWithNoTests` works only at the root and is a no-op per project.

Fake-host fixtures replay identical findings, so they cannot surface merge-quality or
prompt-delivery defects across real models — for those, a cheap live run is the only real signal.
A "machine load" flake is usually an isolation bug: reproduce it with repeat runs before raising
any timeout. The prettier baseline on `main` is clean and CI enforces it, so a `format` failure is
yours.

## Local tooling that is not part of the package

`openspec/`, `.claude/` and `.codegraph/` are gitignored local tooling and irrelevant to a
contribution; `docs/` is prettier-ignored. Module headers cite spec paths under
`openspec/changes/add-council-review/`, and older ones cite `SCRATCH/host-notes.md` and
`CONTRACT.md`, none of which exist in a clone — treat `docs/design/council-review-design.md` and
`HOST-VERSION.md` as the readable equivalents. The `.codegraph/` index here has been empty
(`codegraph status` reports 0 files); confirm it is populated before relying on it.

Releases publish on a `v*` tag via npm trusted publishing; the tag must match `package.json`'s
version, and `.github/workflows/release.yml` must not be renamed.
