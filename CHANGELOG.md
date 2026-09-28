# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Start-of-run Pi self-update: each review run now runs `pi update --self` (self only,
  never extensions) exactly once, in the CLI process before any reviewer launches, and
  applies the update when one is available. Best-effort like indexing — any failure
  degrades to a warning and the run proceeds with the host as-is. Skipped silently when
  `COUNCIL_NO_PI_UPDATE=1` or `PI_OFFLINE=1` is set. The host version in effect is now
  recorded as `hostVersion` in each run's `manifest.json` (previously always null).

### Changed

- Fingerprints no longer lowercase the file path: `src/Foo.ts` and `src/foo.ts` are distinct
  files in a git tree and now fingerprint (and cluster) separately. Fingerprints of findings on
  mixed-case paths therefore change once, so an `.council/ignore.json` entry for such a finding
  must be re-added, and a `--since` diff across this upgrade shows it as one resolved plus one
  new. All-lowercase paths are unaffected.
- `--since <run-id>` must name a run directory listed under `.council/reviews/` (or `last`);
  anything else, including `.` and `..`, is rejected.
- Findings reporting `endLine` before `line`, or a whitespace-only `file`, `category`, `claim` or
  `impact`, now fail validation and go through the repair retry.
- `--timeout` and `--max-tokens` bound each reviewer as a whole: a repair attempt gets what the
  first attempt left, not a fresh allowance.
- A reviewer whose final turn the host ends with `stopReason` `error`/`aborted` (e.g. a provider
  auth failure) fails with the host's error message instead of spending a repair attempt.
- `--timeout`, `--max-tokens`, `--fail-on`, `--since` and the ignore file are validated before
  model discovery, the snapshot or any reviewer; `--no-suppress` no longer reads the ignore file.
- `findings.json`, `--json` output and the manifest carry each finding's `resolution` when
  `--since` is given.
- `status` reports only the `last` pointer's run as the last run, like `show` and `--since`.
- Vendor names are canonicalised (lower-cased, aliases such as `x-ai`→`xai`, `z-ai`→`zhipu`,
  `meta-llama`→`meta`), so the same vendor under two spellings no longer passes the
  independence guard as two vendors.
- `--models` entries and globs are held to the same provider-readiness check as the configured
  panel; an empty `--models` is a usage error (exit 2), and an empty panel is refused even with
  `--allow-correlated`.
- A `:suffix` on a `--models` entry is a thinking pin only when it is a thinking level, so model
  ids containing `:` (`...:free`, `...-v1:0`) can be given.
- Ctrl-C in the interactive picker exits 130, like any other interrupt.
- `council_git` refuses stash, reflog (`@{...}`), `:/` and non-HEAD pseudo-ref revisions, and runs
  with `--no-ext-diff --no-textconv`; `log` defaults to 50 commits.
- Reviewer tool output is capped at 100,000 characters with an explicit truncation marker, grep
  match text at 300 characters per line, and `council_grep` reports when its 5,000-file limit
  was reached.

### Fixed

- Merge ordering no longer follows the locale (`localeCompare`): finding ids and even cluster
  representatives, hence fingerprints, could differ between machines with different `LANG`.
- Finding ids no longer depend on reviewer input order when two clusters tie on every documented
  sort key, and a mixed-category cluster's category no longer depends on reviewer id.
- `./src/a.ts` and `src/a.ts` now cluster together and verify against the snapshot; merged
  findings carry the normalised path.
- Claims with no content words (punctuation or stopwords only) no longer all cluster together.
- `--since` now matches a finding through any cluster member's fingerprint, so an unchanged
  defect whose representative reviewer changed is `still-present`, not resolved plus new.
- A malformed baseline `findings.json` (e.g. `[null]`) is reported as unreadable instead of
  crashing or rendering `undefined:undefined`.
- `REPORT.md` escapes reviewer-supplied text: newlines in one-line fields are collapsed, code
  spans and fences are longer than any backtick run inside them, and a finding's metadata lines
  render as a list.
- Ctrl-C before reviewers launch (during the snapshot, indexing or blast-radius step) no longer
  launches the whole panel anyway; a host that ignores SIGTERM is SIGKILLed after a grace period,
  so the timeout and Ctrl-C are real upper bounds; a huge `--timeout` no longer overflows into an
  immediate timeout.
- The default scope handles non-ASCII and space-padded file names, renames (both paths are
  listed; the old path's deletion is no longer lost), file names with pathspec magic, and very
  large untracked sets (no more `E2BIG`); user git config (`color.ui`, `diff.noprefix`,
  `diff.external`, textconv) no longer leaks into the patch; git no longer rewrites
  `.git/index` or writes objects into the repository while resolving scope; untracked embedded
  repositories are left out; missing-HEAD and unrelated-history errors are descriptive.
- The snapshot build survives unstaged deletions, submodules and embedded repositories, never
  copies a file through a symlinked parent directory (which could reach outside the
  repository), and reads `--staged`/`--range` content through one `git cat-file --batch`
  process instead of one `git show` per file.
- Blast-radius maps each hunk to the symbols its changed lines touch, not the symbol its
  leading context starts in, and parses unquoted paths with spaces, C-quoted paths, and
  rename/copy headers correctly.
- `council_grep` evaluates patterns under a time limit, so a catastrophic regex can no longer
  hang a reviewer; line numbers in `council_read`/`council_grep` now match git's.
- `--pane` falls back to a local run when herdr cannot split or run the pane, instead of exiting
  0 with nothing reviewed; the delegated run no longer re-opens `--pick`, and the user's own
  pane is no longer retitled. herdr commands time out, and `--handoff` no longer holds the CLI
  open until the agent finishes.
- `--pick --json` renders the picker on stderr; the picker exits 2 with a clear message when no
  provider is ready, instead of an internal error.
- A `null` entry in the model catalog is skipped instead of crashing the run; provider auth
  checks run at most four at a time.
- `pi update --self` that times out is killed and reaped before any reviewer launches.
- `gc --keep=` (empty) is rejected instead of pruning every run; `show last` and
  `ignore --run last` work; `status --verify` reports a discovery failure per panel entry.
- Credential-shaped `PI_*` variables (`PI_*_API_KEY`, `*_TOKEN`, `*_SECRET`) no longer reach a
  reviewer through the `PI_` environment prefix.
- The Node version guard runs before the rest of the CLI is loaded, so an old Node gets the
  guard's message rather than a `SyntaxError`.

## [0.2.0] - 2026-09-20

### Added

- Deterministic blast-radius map: each run now traces the changed symbols to their direct
  callers, transitive impact, and affected tests from the snapshot CodeGraph index, and
  embeds the identical map in every reviewer's initial prompt as a starting point to verify,
  not ground truth. Best-effort like indexing — a missing binary, timeout, or unavailable
  index degrades to no (or a partial) block with a machine-readable reason recorded in the
  manifest and a one-line summary in `REPORT.md`; exit codes are unchanged. Removed symbols
  are named explicitly, since the end-state index cannot resolve their references.
- New `codegraph.blastRadius` config object (`enabled`, default `true`; `depth`,
  `maxSymbols`, `maxBlockChars`). Setting `enabled` to `false` restores exactly the
  pre-step behavior.
- The review-depth signal is now split into per-tool grep and codegraph counts, persisted
  in the manifest.
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

[0.2.0]: https://github.com/ad-005/council-review/releases/tag/v0.2.0
[0.1.2]: https://github.com/ad-005/council-review/releases/tag/v0.1.2
[0.1.1]: https://github.com/ad-005/council-review/releases/tag/v0.1.1
[0.1.0]: https://www.npmjs.com/package/council-review/v/0.1.0
