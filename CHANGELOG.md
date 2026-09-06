# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

Initial release. Not yet published to npm; install from GitHub (see README's "Install" section).

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

[0.1.0]: https://github.com/ad-005/council-review/releases/tag/v0.1.0
