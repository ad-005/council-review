## Purpose

Defines how independent reviewers' findings become one ranked list: fingerprinted for stability across refactors, clustered per file, scored by how many reviewers actually agreed, filtered against the project's suppressions, and diffed against a previous run.

## ADDED Requirements

### Requirement: Merging is deterministic and model-free

Findings SHALL be merged by deterministic rules only. No model SHALL be used to summarise, rank, filter or rewrite findings, because doing so would reintroduce a single model's judgement as a filter over the panel's independent verdicts.

#### Scenario: No model call during merge

- **WHEN** the merge step runs
- **THEN** no inference request is issued and no additional cost is incurred

#### Scenario: Merge is reproducible

- **WHEN** the same set of reviewer findings is merged twice with the same configuration
- **THEN** the two merged outputs are identical, including every finding id

#### Scenario: Reviewer wording is not rewritten

- **WHEN** a merged finding is produced from several reviewers' findings
- **THEN** each contributing reviewer's own claim text remains available unrewritten in the run's raw artifacts

### Requirement: Fingerprints are stable across line movement

Every finding SHALL carry a fingerprint derived from its normalised file path and its normalised claim text, where normalisation lowercases, strips punctuation, and collapses whitespace and stopwords. A fingerprint MUST NOT depend on line numbers, so that a suppression survives a refactor that moves the code.

#### Scenario: Line movement preserves the fingerprint

- **WHEN** the same claim is reported against the same file at a different line in a later run
- **THEN** its fingerprint is unchanged

#### Scenario: Wording variation preserves the fingerprint

- **WHEN** two reviewers state the same claim about the same file with different punctuation, casing, whitespace or stopwords
- **THEN** their fingerprints are equal

#### Scenario: A different claim yields a different fingerprint

- **WHEN** two findings on the same file make materially different claims
- **THEN** their fingerprints differ

#### Scenario: A different file yields a different fingerprint

- **WHEN** the same claim text is reported against two different files
- **THEN** the two fingerprints differ

### Requirement: Clustering conditions

Findings SHALL be clustered within a single file only, and two findings SHALL be merged only when all three of the following hold: their line ranges overlap or lie within the configured merge window of one another; their categories are equal; and their claim token similarity meets the configured similarity threshold. Clustering MUST be transitive within a file, so that a chain of pairwise merges forms one cluster.

#### Scenario: Same defect reported by several reviewers

- **WHEN** three reviewers report the same category of problem at nearby lines in one file with similar claims
- **THEN** they merge into one cluster

#### Scenario: Unrelated findings on the same line do not merge

- **WHEN** two findings sit on the same line of the same file with the same category but dissimilar claims
- **THEN** they remain two separate findings

#### Scenario: Different categories do not merge

- **WHEN** two findings sit at the same line with similar claims but different categories
- **THEN** they remain two separate findings

#### Scenario: Distant findings do not merge

- **WHEN** two findings in one file share a category and a similar claim but their line ranges lie further apart than the merge window
- **THEN** they remain two separate findings

#### Scenario: Findings in different files never merge

- **WHEN** two findings make an identical claim in the same category in two different files
- **THEN** they remain two separate findings

#### Scenario: Transitive clustering

- **WHEN** finding A merges with B and B merges with C, while A and C would not merge pairwise
- **THEN** A, B and C form a single cluster

#### Scenario: Tuning is configurable

- **WHEN** the merge window or the similarity threshold is changed in configuration
- **THEN** clustering reflects the changed values

### Requirement: Agreement is scored over reviewers that reported

Each merged finding SHALL carry the number of reviewers that raised it and the number of reviewers that returned schema-valid findings for the run. The denominator MUST be the reporting count, not the launched count, so that a reviewer that never reported cannot silently deflate every agreement score. The launched and reporting counts MUST both be recorded for the run.

#### Scenario: Full agreement

- **WHEN** all three reviewers of a three-reviewer panel report and all three raise a finding
- **THEN** that finding records three raisers out of three

#### Scenario: Denominator excludes a reviewer that never reported

- **WHEN** three reviewers are launched, one times out, and both remaining reviewers raise a finding
- **THEN** that finding records two raisers out of two, not two out of three

#### Scenario: Launched and reporting counts are both visible

- **WHEN** a run's panel was partially degraded
- **THEN** the run records both how many reviewers were launched and how many reported

#### Scenario: A lone finding is still reported

- **WHEN** only one reviewer of three raises a finding
- **THEN** the finding survives the merge with one raiser out of three and is not discarded for low agreement

### Requirement: Merged findings remain traceable to their sources

Every merged finding SHALL carry, in addition to its own fields, the identifiers of the source findings it was built from, the reviewers that raised it, and the per-reviewer severities. Because clustering is a heuristic, a consumer MUST always be able to check the merge against the reviewers' verbatim output.

#### Scenario: Source identifiers are present

- **WHEN** a merged finding was built from several reviewers' findings
- **THEN** it lists the identifiers of each source finding and the reviewer that produced it

#### Scenario: Severity is the maximum with the spread retained

- **WHEN** reviewers assign different severities to a merged finding
- **THEN** the finding's severity is the highest of them and the individual per-reviewer severities are also recorded

#### Scenario: Evidence is accumulated

- **WHEN** several reviewers supply evidence for a merged finding
- **THEN** all of their evidence is retained on the merged finding

#### Scenario: Verbatim output is always available

- **WHEN** a merged finding's claim is ambiguous
- **THEN** the contributing reviewers' verbatim text remains available in the run's raw artifacts

### Requirement: Deterministic ordering and identifiers

Merged findings SHALL be sorted by agreement descending, then severity descending, then file path ascending, then line ascending. Identifiers SHALL be assigned only after sorting, so that identical input always yields identical identifiers.

#### Scenario: Sort order

- **WHEN** merged findings are written out
- **THEN** they appear ordered by agreement, then severity, then path, then line

#### Scenario: Identifiers are stable for identical input

- **WHEN** the same input is merged twice
- **THEN** each finding receives the same identifier both times

#### Scenario: Identifiers are assigned post-sort

- **WHEN** findings are written out
- **THEN** identifiers increase monotonically in the sorted order

### Requirement: Suppression against the project ignore list

A cluster SHALL be dropped if its own fingerprint or the fingerprint of any of its members matches an entry in the project's suppression list. The number of suppressed clusters MUST be reported, and suppression MUST be disableable for a single run without editing the list.

#### Scenario: Suppressed cluster is dropped

- **WHEN** a cluster's fingerprint matches a suppression entry
- **THEN** the cluster does not appear in the merged findings and the suppressed count is incremented

#### Scenario: Suppression by a member fingerprint

- **WHEN** a cluster's own fingerprint does not match but one of its member findings' fingerprints does
- **THEN** the cluster is dropped

#### Scenario: Suppressed count is reported

- **WHEN** a run suppresses one or more clusters
- **THEN** the number suppressed is stated in the run's report

#### Scenario: Suppression disabled for one run

- **WHEN** a run is executed with suppression disabled
- **THEN** every cluster appears regardless of the suppression list, and the list itself is unchanged

#### Scenario: Suppression survives a refactor

- **WHEN** a suppressed finding is reported again after the code it concerns has moved to a different line
- **THEN** it is still suppressed

### Requirement: Resolution diffing against a previous run

A run SHALL be able to diff its findings against a named previous run or the most recent one, matching by fingerprint, and SHALL mark each finding as `resolved` when it was present before and is absent now, `still-present` when present in both, and `new` when absent before and present now. The report MUST lead with a summary of those counts.

#### Scenario: Resolved finding

- **WHEN** a finding present in the previous run is absent from the current one
- **THEN** it is reported as `resolved`

#### Scenario: Still-present finding

- **WHEN** a finding is present in both runs
- **THEN** it is marked `still-present`

#### Scenario: New finding

- **WHEN** a finding is absent from the previous run and present in the current one
- **THEN** it is marked `new`

#### Scenario: Summary leads the report

- **WHEN** a run is diffed against a previous one
- **THEN** its report opens with the counts of resolved, still-present and new findings

#### Scenario: Referencing the most recent run

- **WHEN** the diff target is given as the most recent run
- **THEN** the immediately preceding run's merged findings are used

#### Scenario: Unknown or unreadable previous run

- **WHEN** the named previous run does not exist or its merged findings cannot be read
- **THEN** the tool exits with code 2 naming the run, and no review is launched

#### Scenario: No previous run exists

- **WHEN** a diff against the most recent run is requested and no previous run exists
- **THEN** the run proceeds without resolution marking and states that no baseline was available
