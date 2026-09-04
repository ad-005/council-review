## Purpose

Defines how a panel is actually run: reviewers launched in parallel and in isolation from one another, their event streams accounted for cost and review depth, their budgets enforced, and their output held to a machine-readable findings contract with one chance to repair it.

## ADDED Requirements

### Requirement: Reviewers run in parallel and in ignorance of each other

Every reviewer in the panel SHALL be launched in parallel as an independent process, each receiving the same task, the same review prompt and the same patch reference. No reviewer SHALL receive any other reviewer's output, partial output, or the fact of any other reviewer's existence. Independence is the product being sold.

#### Scenario: All reviewers launch concurrently

- **WHEN** a panel of three reviewers is run
- **THEN** all three processes are started without waiting for any of them to finish

#### Scenario: No cross-contamination

- **WHEN** any reviewer is inspected for the inputs it received
- **THEN** its inputs contain the task, the review prompt and the patch, and nothing produced by another reviewer

#### Scenario: One reviewer's failure does not abort the others

- **WHEN** one reviewer exits with an error early in the run
- **THEN** the remaining reviewers continue to completion

### Requirement: Result extraction from the reviewer event stream

For each reviewer the tool SHALL consume a structured event stream and extract the reviewer's final assistant text, its cumulative token usage, and a record of every tool call it made. Extraction MUST tolerate interleaved streaming events and MUST take the final text from the reviewer's terminal message.

#### Scenario: Final text is captured

- **WHEN** a reviewer's stream completes normally
- **THEN** the text of its terminal assistant message is captured verbatim

#### Scenario: Usage is captured

- **WHEN** a reviewer's stream completes
- **THEN** its cumulative input and output token counts are recorded

#### Scenario: Truncated stream

- **WHEN** a reviewer's stream ends without a terminal message
- **THEN** whatever text was received is preserved verbatim, the reviewer is marked failed, and the run continues

#### Scenario: Unparseable stream lines

- **WHEN** the stream contains lines that are not valid structured events
- **THEN** those lines are preserved in the reviewer's raw trace and do not abort parsing of the remaining events

### Requirement: Cost accounting

The tool SHALL convert each reviewer's token usage to a monetary cost using the input and output rates recorded in the model catalog, and SHALL report both a per-reviewer and a run-total cost.

#### Scenario: Per-reviewer cost is computed

- **WHEN** a reviewer reports token usage and its catalog entry carries cost rates
- **THEN** a cost for that reviewer is computed from its usage and those rates and recorded

#### Scenario: Run total

- **WHEN** a run completes
- **THEN** the sum of the per-reviewer costs is recorded as the run total

#### Scenario: Missing cost rates

- **WHEN** a model's catalog entry carries no cost rates
- **THEN** that reviewer's cost is recorded as unknown rather than as zero, and the run total states that it is incomplete

### Requirement: Review depth is measured, not assumed

The tool SHALL derive a review-depth signal per reviewer from its recorded tool calls — at minimum which files it opened and how many searches it ran — and SHALL surface that signal in the run's outputs. A reviewer that never opened a file must be visibly not equal to one that read twelve.

#### Scenario: Files opened are recorded

- **WHEN** a reviewer reads files through its read tool
- **THEN** the set of paths it opened is recorded for that reviewer

#### Scenario: Search count is recorded

- **WHEN** a reviewer runs content searches
- **THEN** the number of searches it ran is recorded for that reviewer

#### Scenario: A shallow reviewer is visible

- **WHEN** one reviewer made no tool calls and another opened many files
- **THEN** the difference is visible in both the manifest and the human report

### Requirement: Per-reviewer budgets

Each reviewer SHALL be bounded by a wall-clock timeout and by an output-token ceiling, both defaulting from configuration and overridable per run. Breaching either MUST terminate only that reviewer, mark it `timeout` or `over-budget`, and leave the run to continue with the report marked degraded.

#### Scenario: Timeout breach

- **WHEN** a reviewer exceeds its wall-clock timeout
- **THEN** that reviewer's process is terminated, it is marked `timeout`, the other reviewers continue, and the report is marked degraded

#### Scenario: Output ceiling breach

- **WHEN** a reviewer exceeds its output-token ceiling
- **THEN** that reviewer is marked `over-budget`, the other reviewers continue, and the report is marked degraded

#### Scenario: Partial output from a breached reviewer is preserved

- **WHEN** a reviewer is terminated for breaching a budget after producing some text
- **THEN** its partial text is preserved verbatim in the run's raw artifacts

#### Scenario: Command-line overrides

- **WHEN** a timeout or output ceiling is supplied on the command line
- **THEN** it overrides the configured value for that run

#### Scenario: Whole panel breaches

- **WHEN** every reviewer in the panel breaches a budget or fails
- **THEN** a degraded report containing no findings is still written and the tool exits with code 3

### Requirement: Progress reporting

While a run is in progress the tool SHALL report per-reviewer state, elapsed time and token usage. Output MUST remain usable without a terminal, degrading to plain appended lines rather than requiring cursor control.

#### Scenario: Interactive progress

- **WHEN** a run is executed with a terminal attached
- **THEN** one live line per reviewer shows its state, elapsed time and token usage

#### Scenario: Non-interactive progress

- **WHEN** a run is executed without a terminal attached, such as in CI
- **THEN** progress is emitted as plain appended lines containing the same information and no cursor-control sequences

#### Scenario: Interruption

- **WHEN** the run is interrupted by the user
- **THEN** reviewer processes are terminated, the snapshot is cleaned up, and the interruption is reported

### Requirement: Findings contract

Each reviewer SHALL be required to emit its findings as a single structured block validated against a fixed schema. Each finding carries a file path, a line, an optional end line, a severity from `critical`, `high`, `medium` or `low`, a category, a claim, a description of the failure it would cause, and optional evidence, suggestion and confidence.

#### Scenario: Valid output is accepted

- **WHEN** a reviewer emits a structured block conforming to the schema
- **THEN** its findings are parsed and carried into the merge step

#### Scenario: Required fields are enforced

- **WHEN** a reviewer's output omits a required field or uses a severity outside the permitted set
- **THEN** the output is treated as invalid

#### Scenario: A reviewer reporting nothing

- **WHEN** a reviewer emits a valid block containing an empty findings list
- **THEN** it counts as a reviewer that reported successfully, contributing zero findings

#### Scenario: Findings outside the reviewed file set

- **WHEN** a reviewer reports a finding against a path that is not in the snapshot
- **THEN** the finding is retained but flagged as unverifiable against the reviewed tree

### Requirement: Exactly one repair retry

Invalid reviewer output SHALL be given exactly one repair attempt, in which the validation errors are returned to that same reviewer. If the second attempt is still invalid the reviewer SHALL be marked `failed`. Nothing is ever discarded: the reviewer's verbatim text MUST be preserved in the run's raw artifacts either way.

#### Scenario: Repair succeeds

- **WHEN** a reviewer's first output is invalid and its repaired output is valid
- **THEN** the repaired findings are used and the reviewer counts as having reported

#### Scenario: Repair fails

- **WHEN** a reviewer's repaired output is still invalid
- **THEN** the reviewer is marked `failed`, the run continues, the report is marked degraded, and both outputs are preserved verbatim

#### Scenario: No second retry

- **WHEN** a reviewer has already been given one repair attempt
- **THEN** no further attempt is made for that reviewer in that run

#### Scenario: Repair does not leak other reviewers

- **WHEN** a repair attempt is issued
- **THEN** it contains only the validation errors and that reviewer's own prior output
