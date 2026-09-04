## Purpose

Defines the `council-review` command-line surface: how a project is bootstrapped, what the committed configuration files mean, which subcommands and flags exist, and what each exit code tells a caller or a CI job.

## ADDED Requirements

### Requirement: Single binary distributed as a global package

The tool SHALL be distributed as one npm package exposing exactly one executable, `council-review`, that runs on Node 20 or later. The package MUST be usable after a single global install, with no per-project dependency and no registration step in any other tool.

#### Scenario: Global install exposes the binary

- **WHEN** the package is installed globally and `council-review --version` is run from any directory
- **THEN** the binary resolves and prints its own version, without requiring a project-local install

#### Scenario: Unsupported Node version is rejected clearly

- **WHEN** the binary is started on a Node runtime older than 20
- **THEN** it exits with code 2 and a message naming the detected version and the minimum supported version

#### Scenario: No external tool registration is required

- **WHEN** a user installs the package and immediately runs a review in a configured project
- **THEN** the run succeeds without the user having installed, registered or synchronised any package, extension or plugin inside the review agent host

### Requirement: Project initialization writes committed configuration

`council-review init` SHALL bootstrap the current repository by running panel selection and then writing `.council/config.json` and `.council/ignore.json`, and by ensuring `.gitignore` excludes `.council/reviews/`. Configuration files are intended to be committed; run outputs are not.

#### Scenario: Fresh initialization

- **WHEN** `council-review init` is run in a git repository with no `.council/` directory and the user completes selection
- **THEN** `.council/config.json` is written containing the selected panel and resolved thinking levels, `.council/ignore.json` is written as an empty suppression list, and `.gitignore` contains an entry excluding `.council/reviews/`

#### Scenario: Re-initialization preserves suppressions

- **WHEN** `council-review init` is run in a repository that already has a `.council/ignore.json` containing entries
- **THEN** the existing suppression entries are preserved unchanged and only the panel-related configuration is rewritten

#### Scenario: Gitignore entry is not duplicated

- **WHEN** `council-review init` is run in a repository whose `.gitignore` already excludes `.council/reviews/`
- **THEN** no duplicate entry is appended

#### Scenario: Initialization outside a git repository

- **WHEN** `council-review init` is run in a directory that is not inside a git repository
- **THEN** it exits with code 2 and a message stating that a git repository is required

#### Scenario: Re-running the picker later

- **WHEN** `council-review init --pick` is run in an already-initialized repository
- **THEN** panel selection is presented again and the resulting panel replaces the configured one

### Requirement: Configuration file contract

`.council/config.json` SHALL be a versioned JSON document carrying the project's panel, thinking-level settings, scope defaults, budgets and merge tuning. The tool MUST validate it on load and MUST reject an invalid document rather than silently substituting defaults for malformed values.

The document supports at least: `version`, `baseBranch`, `panel` (an ordered list of `provider` plus `model` entries), `defaultThinkingLevel`, `modelThinkingLevels` keyed by `"provider/modelId"`, `includeContextFiles`, `timeoutSeconds`, `maxOutputTokens`, `mergeWindow`, `claimSimilarity`, `failOn`, `snapshot.include` and `vendorOverrides`.

#### Scenario: Absent optional keys fall back to documented defaults

- **WHEN** a configuration document omits `mergeWindow`, `claimSimilarity`, `timeoutSeconds`, `maxOutputTokens` or `failOn`
- **THEN** the run proceeds using the documented default for each omitted key

#### Scenario: Malformed configuration is rejected

- **WHEN** a configuration document contains a value of the wrong type or an unknown thinking level
- **THEN** the tool exits with code 2 and reports the offending key path and the reason, and performs no model calls

#### Scenario: Unreadable JSON is rejected

- **WHEN** `.council/config.json` is not valid JSON
- **THEN** the tool exits with code 2 naming the file and the parse error

#### Scenario: Unknown configuration version is rejected

- **WHEN** the configuration declares a `version` the running tool does not support
- **THEN** the tool exits with code 2 and states which versions it supports

#### Scenario: Review without configuration

- **WHEN** a review is requested in a repository that has no `.council/config.json` and no panel is given on the command line
- **THEN** the tool exits with code 2 and directs the user to run `council-review init`

### Requirement: Suppression file contract

`.council/ignore.json` SHALL hold the project's suppressed findings, identified by finding fingerprint, and MAY carry a human-supplied reason per entry. The tool MUST be able to append to it through a command rather than requiring hand-editing.

#### Scenario: Suppressing a finding from a run

- **WHEN** `council-review ignore <finding-id> --reason <text>` is run against the most recent run
- **THEN** the fingerprint of that finding is appended to `.council/ignore.json` together with the reason, and the file remains valid JSON

#### Scenario: Suppressing from a named earlier run

- **WHEN** `council-review ignore <finding-id> --run <run-id>` is run
- **THEN** the fingerprint is taken from that run's merged findings rather than from the most recent run

#### Scenario: Suppressing an unknown finding id

- **WHEN** `council-review ignore` is given a finding id that does not exist in the referenced run
- **THEN** the tool exits with code 2 and leaves `.council/ignore.json` unchanged

#### Scenario: Suppressing an already-suppressed finding

- **WHEN** `council-review ignore` is given a finding whose fingerprint is already present
- **THEN** the file is left with exactly one entry for that fingerprint and the command succeeds

### Requirement: Command and flag surface

The binary SHALL dispatch the subcommands `init`, `models`, `show`, `ignore` and `gc`, and SHALL treat an invocation with no subcommand as a review run. A review run MUST accept scope flags (`--staged`, `--range`, `--paths`, `--base`), panel flags (`--models`, `--pick`, `--thinking`, `--allow-correlated`), run flags (`--timeout`, `--max-tokens`, `--since`, `--fail-on`, `--no-suppress`, `--json`) and environment flags (`--pane`, `--no-pane`, `--handoff`, `--no-notify`).

#### Scenario: Bare invocation runs a review

- **WHEN** `council-review` is run with no subcommand in an initialized repository
- **THEN** a review run starts using the configured panel and the default scope

#### Scenario: Unknown flag or subcommand

- **WHEN** an unrecognised flag or subcommand is supplied
- **THEN** the tool exits with code 2, names the unrecognised token, and prints usage

#### Scenario: Mutually exclusive scope flags

- **WHEN** two conflicting scope selectors are supplied in one invocation, such as `--staged` together with `--range`
- **THEN** the tool exits with code 2 explaining that the scope selectors conflict, and performs no model calls

#### Scenario: Help is available per subcommand

- **WHEN** `--help` is passed with or without a subcommand
- **THEN** usage covering that subcommand's flags is printed and the tool exits with code 0

### Requirement: Exit-code taxonomy

The tool SHALL distinguish outcomes by exit code so that a CI job or a calling agent can branch on them: `0` completed with nothing at or above the configured `failOn` threshold; `1` completed with findings at or above that threshold; `2` a configuration or usage error; `3` one or more reviewers failed but a partial report was written; `4` the vendor-independence guard refused the panel.

#### Scenario: Clean run

- **WHEN** all reviewers report and no surviving finding meets the `failOn` threshold
- **THEN** the tool exits with code 0

#### Scenario: Threshold breached

- **WHEN** at least one surviving finding has a severity at or above `failOn`
- **THEN** the tool exits with code 1 and the report is still written

#### Scenario: Threshold disabled

- **WHEN** `failOn` is `none` and findings of every severity are present
- **THEN** the tool exits with code 0

#### Scenario: Partial panel

- **WHEN** at least one reviewer times out, exceeds its budget or fails validation while at least one other reports successfully
- **THEN** a report is written from the reviewers that reported, the report is marked degraded, and the tool exits with code 3

#### Scenario: Failure outranks threshold

- **WHEN** a reviewer failed and a surviving finding also meets the `failOn` threshold
- **THEN** the tool exits with code 3, so that a degraded panel is never mistaken for a clean measurement against the threshold

#### Scenario: Guard refusal

- **WHEN** the assembled panel does not satisfy the vendor-independence guard and the override flag was not given
- **THEN** no reviewer is spawned and the tool exits with code 4
