## Purpose

Defines how the tool cooperates with the herdr pane environment when it is present — running beside a coding agent, announcing completion, and handing findings over — while remaining fully functional in a plain shell and in CI.

## ADDED Requirements

### Requirement: Integration is gated on the herdr environment

Every herdr interaction SHALL be attempted only when the herdr environment marker is present. Outside that environment each such interaction MUST degrade to a no-op accompanied by exactly one printed notice, and the run itself MUST otherwise behave identically.

#### Scenario: Inside a herdr environment

- **WHEN** a run is executed with the herdr environment marker set and a herdr flag supplied
- **THEN** the corresponding herdr interaction is attempted

#### Scenario: Outside a herdr environment

- **WHEN** a run is executed without the herdr environment marker and a herdr flag is supplied
- **THEN** the interaction is skipped, one notice explains that herdr was not detected, and the review proceeds and completes normally

#### Scenario: Notice is printed once

- **WHEN** several herdr flags are supplied outside a herdr environment
- **THEN** one notice is printed rather than one per flag

#### Scenario: Plain shell and CI are unaffected

- **WHEN** a run is executed in a plain shell or in CI with no herdr flags
- **THEN** no herdr command is invoked and the exit code and artifacts are exactly as they would be otherwise

#### Scenario: A failing herdr command does not fail the run

- **WHEN** a herdr interaction is attempted and the herdr command fails or is unavailable
- **THEN** the failure is reported as a warning and the run's own outcome and exit code are unaffected

### Requirement: Running the review in a split pane

The tool SHALL be able to run the review in a new pane split from the current one, in a requested direction, with the new pane taking the current working directory. Focus MUST remain where the user left it, and the new pane MUST be titled so that it is identifiable as a review in progress.

#### Scenario: Pane split and delegated run

- **WHEN** a run is requested in a new pane
- **THEN** a pane is split in the requested direction with the current working directory, and the review is run in that pane

#### Scenario: Focus is not stolen

- **WHEN** a pane is split for a review
- **THEN** input focus remains on the pane the user was using

#### Scenario: Pane is titled

- **WHEN** a review runs in a split pane
- **THEN** the pane's title identifies it as a review and states how many models are in the panel

#### Scenario: No recursive splitting

- **WHEN** the review is started in the pane that was just created for it
- **THEN** it runs the review directly and does not split another pane

#### Scenario: Split direction

- **WHEN** a direction is supplied with the pane request
- **THEN** the pane is split in that direction, and a default direction is used when none is supplied

### Requirement: Completion notification

On completion the tool SHALL raise a herdr notification, so that a long review does not require the user to watch the pane. Notification MUST be suppressible.

#### Scenario: Notification on completion

- **WHEN** a run completes inside a herdr environment and notification is not suppressed
- **THEN** a notification is raised

#### Scenario: Notification is suppressed

- **WHEN** notification is suppressed for a run
- **THEN** no notification is raised

#### Scenario: Notification after a degraded run

- **WHEN** a run completes with a degraded panel
- **THEN** a notification is still raised and conveys that the run completed

### Requirement: Handing findings to a coding agent

The tool SHALL be able to write the handoff prompt and then deliver it to a named herdr-managed coding agent, referencing the merged findings file and instructing the agent to reproduce each finding before fixing it. Delivery MUST NOT be awaited: the review command's own completion cannot depend on an agent's response.

#### Scenario: Handoff is delivered

- **WHEN** a run completes with a handoff target named
- **THEN** the handoff prompt is written and delivered to that agent, naming the merged findings file

#### Scenario: Delivery is not awaited

- **WHEN** a handoff is delivered
- **THEN** the review command completes without waiting for the agent to respond, and its exit code reflects the review outcome only

#### Scenario: Unknown agent

- **WHEN** the named handoff target does not exist
- **THEN** the failure is reported as a warning, the handoff prompt remains written in the run directory, and the review's own exit code is unaffected

#### Scenario: Handoff prompt is always written

- **WHEN** a run completes with no handoff target named
- **THEN** the handoff prompt is still written into the run directory for manual use
