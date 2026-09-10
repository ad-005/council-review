# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Each thinking-level prompt from the second reasoning model on offers a trailing "back"
  choice that returns to the previous reasoning model, so a mis-picked effort level can be
  corrected without restarting `init`. A re-visited prompt re-opens on its previous pick.

## [0.1.2] - 2026-09-10

### Added

- New fifth reviewer tool, `council_codegraph`: read-only CodeGraph queries (`explore`, `query`,
  `node`, `callers`, `callees`, `impact`, `affected`) over a per-run index of the frozen snapshot.
  Reviewers are instructed to start with it before plain-text search, and its calls count toward
  the review-depth signal.
- New `codegraph` config object in `.council/config.json` (`enabled`, default `true`;
  `indexTimeoutSeconds`, default `300`). Indexing never fails a run: a missing, slow, or broken
  `codegraph` binary degrades to grep/read, and the manifest (`codegraph: { available, reason? }`)
  plus REPORT.md record the outcome.

### Fixed

- `council_codegraph` file arguments are passed to the binary as project-relative paths. The
  index is keyed by relative path, so the previous absolute form made `node --file` silently
  miss every file against a real index.
- An index build that exits 0 without producing `codegraph.db` is now reported as
  `index-failed` instead of `available`, and a failed or timed-out build leaves no partial
  index behind — reviewers can no longer query a torn database they are told is complete.
- A `.codegraph/` directory tracked by the reviewed repository is excluded from the snapshot,
  so a repo-supplied database can no longer pose as this run's own index (or leak into the
  file list and tree hash).
- The snapshot liveness marker is written before materialisation and indexing, closing a
  window in which a concurrent `council-review gc` could remove the snapshot mid-index.
- A timed-out index build is now killed with SIGKILL instead of SIGTERM, so an indexer that
  ignores SIGTERM cannot keep mutating the tree reviewers are reading.
- README no longer tells you to install unreleased changes with
  `npm install -g github:ad-005/council-review`. That fails on the npm bundled with Node 22, which
  installs no dependencies into its temporary git clone and so cannot run the `prepare` build; the
  documented path is now a clone plus `npm pack`.

## [0.1.1] - 2026-09-08

### Changed

- **Breaking:** raised the minimum supported Node.js version from `>=20` to `>=22.19.0`. Node 20
  reached its end of life; `22.19.0` is also what the `pi` host CLI already requires to run a
  review, so this collapses what used to be a two-tier floor into one.
- Updated `@inquirer/prompts` to 8. Its own engines range (`>=23.5.0 || ^22.13.0 || ^20.17.0`) is
  part of why the Node floor moved.
- Updated the development toolchain: eslint 10, vitest 5, `globals` 17, `eslint-config-prettier`
  10, `@types/picomatch` 4, and the GitHub Actions bumped to checkout v7 / setup-node v7.
- ESLint 10's expanded default rule set surfaced four `throw` sites in `src/reviewer-tools.ts`
  that discarded the original error; they now attach it via `{ cause }` for better diagnostics.

## [0.1.0] - 2026-09-06

Initial release.

### Added

- Multi-vendor review panel: sends the reviewed diff to several independent models from
  **different vendors**, not just different gateways.
- Vendor-independence guard: a panel is admitted only with at least three models resolving to at
  least three distinct vendors, checked at selection time and again immediately before every
  launch. `--allow-correlated` waives it deliberately; refusal exits `4` and spawns nothing.
- Read-only reviewer isolation: every host built-in tool removed, no repo-supplied extensions or
  skills loaded into the reviewing process, agent context files excluded by default
  (`includeContextFiles` to opt in), a reviewer's entire tool surface limited to four read-only
  tools (`council_read`, `council_grep`, `council_list`, `council_git`) with realpath-checked path
  containment and a fixed read-only `council_git` subcommand allowlist (log, show, blame, diff).
- Frozen, non-writable snapshot (`chmod -R a-w`) taken before any reviewer launches, so every
  reviewer reads the same tree regardless of concurrent edits to the live worktree.
- Deterministic findings merge: reviewer output is combined in code, never through another model.
- Scope flags: `--staged`, `--range`, `--revision`, `--paths`, `--base`.
- Panel flags: `--models`, `--pick`, `--thinking`, `--allow-correlated`.
- Run flags: `--timeout`, `--max-tokens`, `--since`, `--fail-on`, `--no-suppress`, `--json`.
- herdr integration flags (`--pane`, `--direction`, `--no-pane`, `--handoff`, `--no-notify`),
  gated on detecting a herdr pane and degrading to a single notice outside one.
- Subcommands: `init` (panel picker, writes `.council/config.json` and `.council/ignore.json`),
  `models` (list discovered ready models, no model call), `status` (configuration and readiness
  check for a coding agent, `--json` and `--verify`), `show` (render a stored run's report),
  `ignore` (suppress a finding by fingerprint), `gc` (prune stored runs, sweep orphaned snapshots).
- Run artifacts under `.council/reviews/<run-id>/`: `manifest.json`, `patch.diff`,
  `findings.json`, `REPORT.md`, `HANDOFF.md`, and per-reviewer raw output.
- Exit-code taxonomy: `0` clean, `1` findings at/above `failOn`, `2` configuration/usage error,
  `3` degraded (partial report, outranks `1`), `4` vendor-independence guard refusal, `130`
  interrupted.

[0.1.2]: https://github.com/ad-005/council-review/releases/tag/v0.1.2
[0.1.1]: https://github.com/ad-005/council-review/releases/tag/v0.1.1
[0.1.0]: https://www.npmjs.com/package/council-review/v/0.1.0
