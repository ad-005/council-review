## 1. Package scaffolding

- [x] 1.1 Create `package.json` declaring Node >= 20, the `council-review` bin entry, and the `dist/` publish surface
- [x] 1.2 Add TypeScript configuration and a build that emits `dist/reviewer-tools.js` as its own entry point, separate from the CLI entry point
- [x] 1.3 Add Vitest configuration with separate unit, security and opt-in live test projects
- [x] 1.4 Add TypeBox and the runtime dependencies; keep the reviewer extension's dependency footprint minimal since it loads inside a foreign process
- [x] 1.5 Add a lint/format setup and a CI workflow running build, lint, unit tests and security tests
- [x] 1.6 Add a Node-version guard at binary startup that exits 2 with the detected and minimum versions
- [x] 1.7 Add `.gitignore` entries for `dist/`, `node_modules/` and `codegraph`

## 2. Configuration and ignore files

- [x] 2.1 Define the `.council/config.json` TypeBox schema covering every documented key, with the documented defaults for optional keys
- [x] 2.2 Implement config load with validation that reports the offending key path and reason, exiting 2 on type errors, unknown thinking levels and parse errors
- [x] 2.3 Implement the config `version` check that hard-errors on an unrecognised version and states supported versions
- [x] 2.4 Implement config write, used by `init` and `--pick`, preserving unrelated keys on rewrite
- [x] 2.5 Define and implement the `.council/ignore.json` schema, load and append, with idempotent insertion of an already-present fingerprint
- [x] 2.6 Unit tests: valid config round-trip, each rejection path, default fill-in, version mismatch, ignore-file idempotence

## 3. Model discovery and vendor mapping

- [x] 3.1 Implement catalog reading from the host model store, exposing id, name, provider, context window, max tokens, cost rates, reasoning flag and thinking-level map
- [x] 3.2 Skip malformed catalog entries individually, warn with a count, and keep the remainder usable
- [x] 3.3 Implement provider readiness via the host's auth-status interface, parsing only status fields and never credential material
- [x] 3.4 Implement the fallback catalog path via the host's model-listing command, invoked with extension loading disabled, and a hard error when both sources are unavailable
- [x] 3.5 Implement the four-step vendor derivation chain: config override, gateway `vendor/model` leading segment with prefix marker stripped, shipped flat-id prefix table, then `unknown`
- [x] 3.6 Implement the collapsed-vendor grouping report used by the picker and the guard
- [x] 3.7 Add a test asserting no code path in the package opens the host credential store, and that no artifact or log line can carry a token
- [x] 3.8 Unit tests against real catalog fixtures: enumeration, readiness filtering, fallback parsing including extension-banner contamination, and every vendor-derivation branch including `unknown`

## 4. Thinking-level computation

- [x] 4.1 Implement the ordered level list and per-model support computation from the reasoning flag and the tristate thinking-level map, including the whole-map-absent and per-key-absent fallbacks and the unsupported-`off` case
- [x] 4.2 Implement the five-step precedence resolution, keeping "no level at all" as a distinct outcome from any explicit level
- [x] 4.3 Implement clamping to the nearest supported level by ordinal distance, preferring downward on ties, recording requested and effective
- [x] 4.4 Implement the run-time notice printed whenever effective differs from requested
- [x] 4.5 Assert no thinking-budget value ever originates from this tool
- [x] 4.6 Unit tests: support computation per map shape, non-reasoning models, each precedence step, clamping above ceiling, tie-breaking downward, and `off: null`

## 5. Panel specification and the independence guard

- [x] 5.1 Implement `provider/modelId[:level]` entry parsing that splits the pin on the last colon, tolerates slashed ids and a leading prefix marker, and errors with the offending entry
- [x] 5.2 Implement glob expansion against the catalog, propagating a pattern's pin to each expansion, erroring when a pattern matches nothing
- [x] 5.3 Implement the vendor-independence guard: at least three models across at least three distinct vendors, `unknown` distinct, printing the collapsed grouping and exiting 4 on refusal
- [x] 5.4 Wire the guard to run both at the end of selection and immediately before launch
- [x] 5.5 Implement the correlated-panel override, waiving both the vendor count and the three-model minimum, recorded in the manifest even when the panel would have passed
- [x] 5.6 Implement resolution of a saved panel, erroring with code 2 when an entry's model is absent from the catalog or its provider is not ready
- [x] 5.7 Unit tests: entry parsing including slashed and prefix-marked ids with pins, glob expansion and the no-match error, guard pass and both refusal shapes, override behaviour and recording

## 6. Interactive picker

- [x] 6.1 Implement the provider stage listing ready providers with auth type and model count
- [x] 6.2 Implement the multi-select model stage scoped to chosen providers, showing vendor, context window and input/output cost rates
- [x] 6.3 Implement the per-model thinking stage offering only supported levels and skipping non-reasoning models as "no thinking"
- [x] 6.4 Implement cancellation at any stage, writing no configuration and exiting 2
- [x] 6.5 Implement the non-interactive refusal: entering selection without a terminal exits 2 directing the user to configuration or `--models`
- [x] 6.6 Tests driving the picker over a scripted input stream against catalog fixtures

## 7. Scope resolution

- [x] 7.1 Implement default scope: merge base of `HEAD` and the base branch through current on-disk state, folding committed, staged, unstaged and untracked-not-ignored changes into one patch
- [x] 7.2 Implement the staged, range and single-revision scopes, each producing one patch plus one file set
- [x] 7.3 Implement path-glob narrowing applied to any scope
- [x] 7.4 Implement base-branch override and the code-2 error for an unknown base or unresolvable revision
- [x] 7.5 Implement conflicting-scope-selector detection, exiting 2 before any snapshot or model work
- [x] 7.6 Implement the empty-scope outcome: report nothing to review, spawn no reviewer, exit 0
- [x] 7.7 Unit tests against temporary git repositories covering every scope mode, the four-change-kind fold, gitignore exclusion, glob narrowing, empty scope and each error path

## 8. Snapshot construction

- [x] 8.1 Implement the three snapshot builders, selected by resolved scope, so the snapshot depicts the tree the diff ends at
- [x] 8.2 Implement the freeze step making every file and directory in the snapshot non-writable before any launch
- [x] 8.3 Implement snapshot narrowing by path globs and the configured include list, with the invariant that every file in the patch is present
- [x] 8.4 Write the diff patch into the run directory and assert it is never written inside the snapshot
- [x] 8.5 Compute the snapshot identity: `HEAD` commit, dirty flag, and a content hash over sorted path and content-hash pairs
- [x] 8.6 Implement cleanup restoring write bits and removing the directory, wired to normal exit, failure and signal paths
- [x] 8.7 Implement the scratch naming convention that lets orphans be identified, and the abort-before-launch path when build or freeze fails
- [x] 8.8 Add a test asserting the repository's registered git worktree set is unchanged across a full run
- [x] 8.9 Unit tests: each builder against a temporary repository, freeze verification, narrowing invariant, identity stability and sensitivity, cleanup on failure

## 9. Reviewer toolset and isolation

- [x] 9.1 Implement the reviewer extension entry point registering exactly `council_read`, `council_grep`, `council_list` and `council_git`, importable only by a reviewer process
- [x] 9.2 Implement the shared path-containment helper: realpath-resolve, reject escapes via parent traversal, absolute paths, escaping symlinks and escaping intermediate symlinked directories, and operate on the resolved path thereafter
- [x] 9.3 Implement `council_read`, `council_grep` and `council_list` over the snapshot root using that helper for every path argument, including search roots and listing targets
- [x] 9.4 Implement `council_git` against the real repository with a fixed read-only subcommand allowlist and structured arguments passed as literal values, refusing anything outside the allowlist
- [x] 9.5 Compose the reviewer spawn argument vector removing host built-ins, extension discovery, skills, prompt templates, project trust and session persistence, and loading only the shipped extension by path
- [x] 9.6 Implement the context-file exclusion default with the config opt-in, recorded in the manifest
- [x] 9.7 Implement the process environment allowlist and set each reviewer's working directory to the snapshot root
- [x] 9.8 Security tests: path-escape rejection for all four tools across all four escape shapes; in-root success; non-allowlisted history subcommand refusal; argument values containing shell metacharacters, option-like tokens and extra subcommands treated as literals or rejected; history calls leaving the real repository unchanged
- [x] 9.9 Security tests: the spawn argument vector removes built-ins and contains nothing that would re-enable one; an injected foreign secret is absent from the reviewer environment; the reviewer extension is never imported by the CLI process
- [x] 9.10 Add a tool-surface assertion that enumerates a reviewer's callable tools by name, so a reappearing built-in cannot hide behind a provider-side parallel-invocation envelope

## 10. Fake host binary

- [x] 10.1 Build a stub host binary that replays recorded event streams selected by argument or environment
- [x] 10.2 Record fixture streams covering: a clean reviewer run with tool calls, a reviewer emitting invalid findings then valid on repair, a reviewer invalid twice, a truncated stream with no terminal message, a stream containing unparseable lines, and a stream that never ends so a timeout can be exercised
- [x] 10.3 Wire the test harness so the runner resolves the stub instead of the real host, with no model calls in unit or security tests

## 11. Runner

- [x] 11.1 Implement parallel reviewer launch, each process receiving the same task, prompt and patch reference and nothing produced by another reviewer
- [x] 11.2 Implement event-stream parsing extracting the terminal assistant text, cumulative usage and every tool call, tolerating interleaved and unparseable lines
- [x] 11.3 Implement cost conversion from usage and catalog rates, per reviewer and as a run total, recording unknown rather than zero when rates are absent
- [x] 11.4 Implement the review-depth signal: the set of files opened and the number of searches run per reviewer
- [x] 11.5 Implement the per-reviewer wall-clock timeout and output-token ceiling, marking `timeout` or `over-budget`, terminating only that reviewer, preserving its partial text, and marking the run degraded
- [x] 11.6 Implement command-line overrides for timeout and output ceiling, and the all-reviewers-failed path that still writes a degraded report and exits 3
- [x] 11.7 Implement progress reporting: one live line per reviewer with state, elapsed and tokens under a terminal, degrading to plain appended lines otherwise
- [x] 11.8 Implement interruption handling that terminates reviewer processes, cleans up the snapshot and reports the interruption
- [x] 11.9 Runner tests against the fake host: fan-out, stream parsing, usage and cost, depth extraction, timeout, ceiling breach, truncated stream, unparseable lines, one reviewer failing without aborting the others, and the no-cross-contamination assertion

## 12. Findings contract

- [x] 12.1 Define the findings TypeBox schema with the documented per-finding fields and the constrained severity set
- [x] 12.2 Implement extraction and validation of a reviewer's structured findings block, accepting a valid empty list as a successful report
- [x] 12.3 Implement the single repair retry returning validation errors to that same reviewer only, marking `failed` after a second invalid attempt and never attempting a third
- [x] 12.4 Preserve both attempts' verbatim text regardless of outcome
- [x] 12.5 Flag findings whose path is absent from the snapshot as unverifiable against the reviewed tree while retaining them
- [x] 12.6 Unit tests: valid parse, each required-field and severity rejection, empty list, repair success, repair failure, no-third-attempt, repair payload containing no other reviewer's output

## 13. Merge

- [x] 13.1 Implement claim normalisation and the path-plus-claim fingerprint that excludes line numbers
- [x] 13.2 Implement per-file union-find clustering under the conjunction of line-window proximity, category equality and claim-similarity threshold, transitive within a file
- [x] 13.3 Implement agreement scoring whose denominator is the reviewers that returned schema-valid findings, and record launched and reporting counts for the run
- [x] 13.4 Implement merged-finding assembly: maximum severity with the per-reviewer spread retained, accumulated evidence, raising reviewers, and the source finding identifiers
- [x] 13.5 Implement the documented sort order and post-sort identifier assignment
- [x] 13.6 Implement suppression by cluster or member fingerprint, the suppressed count, and the single-run suppression bypass
- [x] 13.7 Add a determinism test asserting two merges of identical input produce byte-identical output including identifiers
- [x] 13.8 Unit tests on fixture findings: same-defect merge, two unrelated findings on one line staying separate, different categories staying separate, beyond-window staying separate, cross-file never merging, transitive chain, tuning-constant effect, suppression by member fingerprint, suppression surviving a line move, lone finding retained, and the degraded-panel denominator

## 14. Resolution tracking

- [x] 14.1 Implement loading a previous run's merged findings by identifier or by the most-recent pointer
- [x] 14.2 Implement fingerprint-based diffing marking each finding `resolved`, `still-present` or `new`
- [x] 14.3 Implement the resolution summary that leads the report, and the no-baseline-available path that proceeds without marking
- [x] 14.4 Implement the code-2 error for a named previous run that is missing or unreadable
- [x] 14.5 Unit tests: each of the three markings, most-recent resolution, no baseline, unknown run

## 15. Run outputs

- [x] 15.1 Implement run-directory creation with a timestamped identifier and the most-recent pointer, updated even by a degraded run
- [x] 15.2 Implement provider/model filename slugification that is deterministic and collision-free across distinct models
- [x] 15.3 Write the three per-reviewer raw artifacts — parsed findings, verbatim text, trace — including for a reviewer that failed validation
- [x] 15.4 Implement the manifest covering reviewed state, resolved scope and selectors, panel with vendors and requested/effective levels, per-reviewer state, timings, usage, cost and depth, launched and reporting counts, run total, and the override flags in effect
- [x] 15.5 Add a test asserting no artifact contains credential-shaped content
- [x] 15.6 Implement `REPORT.md`: panel first with model, vendor, effective level, cost and depth; findings in merged order; suppressed and degraded counts in the footer; resolution summary first when diffing; and a valid report when there are no findings
- [x] 15.7 Implement `HANDOFF.md` as a prompt to a coding agent naming the run directory and findings file, requiring reproduction before any fix, directing ambiguity to the raw artifacts, and framing low agreement as a hypothesis
- [x] 15.8 Implement machine-readable output mode writing only the merged findings to standard output, with diagnostics on the diagnostic stream, artifacts still written and exit codes unchanged
- [x] 15.9 Unit tests over fixture runs: artifact presence, slugification collisions, manifest completeness, report ordering and footers, handoff content assertions, and stream separation in machine-readable mode

## 16. CLI surface

- [x] 16.1 Implement argument parsing and subcommand dispatch, treating a bare invocation as a review run and erroring with usage on an unknown flag or subcommand
- [x] 16.2 Implement per-subcommand help exiting 0
- [x] 16.3 Implement `init`, running selection and writing config, the ignore file and the non-duplicated `.gitignore` entry, preserving existing suppressions, and erroring outside a git repository
- [x] 16.4 Implement `init --pick` and the review-time `--pick` and `--models` panel paths, with the missing-configuration error directing the user to `init`
- [x] 16.5 Implement `models`, printing provider, model, vendor, context window, cost rates and supported thinking levels without prompting and without model calls
- [x] 16.6 Implement `show` for the most recent and for a named run, with no model calls and a code-2 error for an unknown run
- [x] 16.7 Implement `ignore` resolving a finding identifier from the referenced run to a fingerprint, appending with an optional reason, erroring on an unknown identifier without modifying the file
- [x] 16.8 Implement `gc` pruning to a retention count, reporting removals, never removing the most-recent run, sweeping orphaned snapshots, and leaving an in-progress run's snapshot intact
- [x] 16.9 Implement the exit-code taxonomy including `failOn` threshold evaluation, `failOn: none`, and code 3 outranking code 1
- [x] 16.10 CLI tests over each subcommand and each exit code, including the guard refusal path and the degraded-plus-threshold precedence case

## 17. herdr integration

- [x] 17.1 Implement the environment gate: every herdr interaction attempted only under the herdr marker, otherwise a single no-op notice regardless of how many herdr flags were supplied
- [x] 17.2 Implement pane split in the requested or default direction with the current working directory, focus retained, and the delegated review run in the new pane without recursive splitting
- [x] 17.3 Implement pane titling identifying the run as a review with its panel size
- [x] 17.4 Implement the completion notification with its suppression flag, raised also after a degraded run
- [x] 17.5 Implement agent handoff delivering the handoff prompt to a named agent without awaiting delivery, warning on an unknown agent, and always writing the handoff prompt regardless
- [x] 17.6 Ensure a failing or absent herdr command degrades to a warning without altering the review's outcome or exit code
- [x] 17.7 Tests with the herdr marker set and unset, asserting no herdr command is invoked outside a herdr environment and that exit codes and artifacts are identical either way

## 18. Verification and release

- [x] 18.1 Add the opt-in live smoke test behind an environment flag running a single cheap model end to end against the real host (authored and ready; NOT executed — see team lead's instructions)
- [x] 18.2 Add the live check for a model with a partially specified thinking-level map, settling the per-key fallback question; if it contradicts the specified behaviour, amend the `model-discovery` scenario and the support computation (authored and ready; NOT executed — the spec's current reading stands until evidence overturns it)
- [x] 18.3 Record the verified host version in the repository and add the re-verification note that a host upgrade requires re-running the tool-surface assertion
- [x] 18.4 Write the README covering install, `init`, the scope and panel flags, the exit codes, and an explicit statement of the isolation model and its limits
- [x] 18.5 Run the full suite — build, lint, unit, security — and confirm every specified scenario has a corresponding test or a recorded reason it is covered by the live smoke test
- [x] 18.6 Verify the published package contents include the built reviewer extension and exclude test fixtures and recorded streams
