## Purpose

Defines everything a run leaves behind: the layout of its run directory, the manifest that makes the run reproducible and auditable, the human report, the handoff prompt written for a coding agent, and the commands that read and prune past runs.

## ADDED Requirements

### Requirement: Run directory layout

Every run SHALL write its outputs into a uniquely named, timestamped directory beneath the project's review output location, containing the manifest, the diff patch, the per-reviewer raw artifacts, the merged findings, the human report and the handoff prompt. A pointer to the most recent run MUST be maintained so it can be referenced without knowing its identifier.

#### Scenario: Directory is created per run

- **WHEN** a run starts
- **THEN** a new run directory named by its timestamp is created and every artifact for that run is written inside it

#### Scenario: Expected artifacts are present

- **WHEN** a run completes
- **THEN** its directory contains the manifest, the diff patch, the merged findings, the human report, the handoff prompt, and a raw artifact set per reviewer

#### Scenario: Most-recent pointer

- **WHEN** a run completes
- **THEN** the most-recent-run pointer resolves to that run's directory

#### Scenario: Pointer is updated even by a degraded run

- **WHEN** a run completes with a degraded panel and a partial report
- **THEN** the most-recent-run pointer still resolves to that run

#### Scenario: Run outputs are not committed

- **WHEN** a run completes in an initialized repository
- **THEN** the run directory is excluded from version control by the entry written at initialization

### Requirement: Per-reviewer raw artifacts are preserved verbatim

For each reviewer the run SHALL write three artifacts: its parsed findings, its verbatim final text, and its trace of tool calls and usage. Filenames MUST identify the provider and model, with characters unsafe in a filename replaced deterministically. Nothing a reviewer produced is discarded, including the output of a reviewer that failed validation.

#### Scenario: Three artifacts per reviewer

- **WHEN** a run completes with three reviewers
- **THEN** three artifacts — parsed findings, verbatim text and trace — exist for each of them

#### Scenario: Failed reviewer output is kept

- **WHEN** a reviewer's output could not be validated even after its repair attempt
- **THEN** its verbatim text is still written and its trace is still written

#### Scenario: Filenames identify provider and model

- **WHEN** a reviewer's model identifier contains characters unsafe in a filename, such as a slash
- **THEN** its artifact filenames deterministically encode the provider and model without those characters, and two different models never collide on one filename

### Requirement: Manifest contract

The manifest SHALL record everything needed to explain and reproduce a run: the reviewed commit, dirty flag and tree content hash; the resolved scope and its selectors; each panel member's provider, model, derived vendor, and requested and effective thinking levels; per-reviewer state, timings, token usage, cost and review-depth signal; the launched and reporting reviewer counts; the run total cost; and whether the correlated-panel override, context-file inclusion or suppression bypass were in effect.

#### Scenario: Reviewed state is recorded

- **WHEN** a run completes
- **THEN** its manifest records the reviewed commit, whether the worktree was dirty, and the tree content hash

#### Scenario: Panel is recorded with resolved thinking levels

- **WHEN** a run completes
- **THEN** its manifest records for each reviewer the provider, model, vendor, requested thinking level and effective thinking level

#### Scenario: Degradation is recorded

- **WHEN** a reviewer timed out, exceeded its budget or failed validation
- **THEN** its state is recorded in the manifest and the manifest marks the run degraded

#### Scenario: Overrides are recorded

- **WHEN** a run used the correlated-panel override, included agent context files, or bypassed suppression
- **THEN** each of those facts is recorded in the manifest

#### Scenario: Manifest carries no credentials

- **WHEN** a manifest is written
- **THEN** it contains no token, key or secret value

### Requirement: Human report content

The human report SHALL lead with the panel — each reviewer's model, vendor, effective thinking level, cost and review-depth signal — then present the findings ordered by agreement, then state the suppressed and degraded counts. When resolution diffing was requested it MUST open with the resolution summary.

#### Scenario: Panel leads the report

- **WHEN** the report is written
- **THEN** its first section lists each reviewer with its model, vendor, effective thinking level, cost and review depth

#### Scenario: Findings ordered by agreement

- **WHEN** findings are rendered
- **THEN** they appear in the merged ordering, so that the findings the most reviewers agreed on come first

#### Scenario: Footer counts

- **WHEN** a run suppressed findings or had a degraded panel
- **THEN** the report states the suppressed count and the degraded reviewers

#### Scenario: Report for a run with no findings

- **WHEN** every reviewer reported and none raised a finding
- **THEN** the report is still written, showing the panel and stating that no findings were raised

### Requirement: Handoff prompt content

The handoff artifact SHALL be a prompt addressed to a coding agent rather than a document addressed to a person. It MUST name the run directory and the merged findings file, state that no finding is to be fixed before it has been reproduced, instruct the agent to check a merged finding against the reviewers' raw output when its claim is ambiguous, and state that a low-agreement finding is a hypothesis rather than an established defect.

#### Scenario: Handoff names its inputs

- **WHEN** the handoff prompt is written
- **THEN** it names the run directory path and the merged findings file

#### Scenario: Reproduce-before-fix instruction

- **WHEN** the handoff prompt is written
- **THEN** it instructs the agent to reproduce each finding before changing any code

#### Scenario: Ambiguity instruction

- **WHEN** the handoff prompt is written
- **THEN** it instructs the agent to consult the reviewers' verbatim raw output when a merged claim is ambiguous

#### Scenario: Low agreement is framed as a hypothesis

- **WHEN** the handoff prompt is written
- **THEN** it states that a finding raised by few reviewers is a hypothesis to test rather than a defect to fix

### Requirement: Machine-readable output mode

A run SHALL be able to emit the merged findings to standard output instead of printing a report path, so that it can be consumed by CI or piped into another process. In that mode nothing but the findings document may be written to standard output.

#### Scenario: Findings on standard output

- **WHEN** a run is executed in machine-readable output mode
- **THEN** the merged findings document is written to standard output and no report path or progress text contaminates that stream

#### Scenario: Artifacts are still written

- **WHEN** a run is executed in machine-readable output mode
- **THEN** the run directory and all of its artifacts are written as usual

#### Scenario: Diagnostics remain separable

- **WHEN** a run in machine-readable output mode emits warnings or progress
- **THEN** those go to the diagnostic stream, leaving standard output parseable

#### Scenario: Exit codes are unaffected

- **WHEN** a run in machine-readable output mode encounters findings above the threshold or a failed reviewer
- **THEN** the same exit code applies as in the default output mode

### Requirement: Reading a past run

`council-review show` SHALL render a stored run's report, defaulting to the most recent run and accepting an explicit run identifier. It MUST NOT re-run any reviewer or incur any cost.

#### Scenario: Show the most recent run

- **WHEN** `council-review show` is run with no argument
- **THEN** the most recent run's report is rendered

#### Scenario: Show a named run

- **WHEN** `council-review show <run-id>` is run
- **THEN** that run's report is rendered

#### Scenario: Show makes no model calls

- **WHEN** any form of `council-review show` is run
- **THEN** no reviewer is launched and no cost is incurred

#### Scenario: Unknown run

- **WHEN** `council-review show` is given a run identifier that does not exist
- **THEN** the tool exits with code 2 naming the identifier

### Requirement: Run retention

`council-review gc` SHALL prune stored runs, retaining a configurable number of the most recent ones, and SHALL report what it removed. It MUST never remove the run the most-recent pointer resolves to.

#### Scenario: Pruning to a retention count

- **WHEN** `council-review gc --keep <n>` is run and more than `n` runs are stored
- **THEN** all but the `n` most recent runs are removed and the number removed is reported

#### Scenario: Most-recent run is protected

- **WHEN** pruning would remove the run the most-recent pointer resolves to
- **THEN** that run is retained and the pointer remains valid

#### Scenario: Nothing to prune

- **WHEN** `council-review gc` is run and the stored run count is within the retention count
- **THEN** nothing is removed and the command exits with code 0
