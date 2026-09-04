## Purpose

Defines how the set of reviewers for a run is assembled — interactively, from configuration, or from the command line — how each reviewer's effective thinking level is decided, and the independence guard that refuses a panel whose members would fail in correlated ways.

## ADDED Requirements

### Requirement: Staged interactive selection

Because hundreds of models can be visible on one machine, interactive selection SHALL be staged rather than presented as one flat list: first the ready providers, then the models scoped to the chosen providers, then a thinking level per selected model. Each stage MUST show the information needed to decide at that stage.

#### Scenario: Provider stage

- **WHEN** interactive selection begins
- **THEN** only ready providers are listed, each annotated with its authentication type and the number of models it exposes

#### Scenario: Model stage is scoped to chosen providers

- **WHEN** one or more providers have been chosen and the model stage opens
- **THEN** only models belonging to those providers are offered, each showing its derived vendor, context window and input/output cost rates, and multiple models may be selected before continuing

#### Scenario: Thinking stage offers only supported levels

- **WHEN** the thinking stage opens for a selected reasoning model
- **THEN** only the levels that model supports are offered

#### Scenario: Non-reasoning models skip the thinking stage

- **WHEN** a selected model does not support thinking
- **THEN** it is shown as "no thinking" and no level is requested for it

#### Scenario: Selection is abandoned

- **WHEN** the user cancels at any stage
- **THEN** no configuration file is written or modified and the tool exits with code 2

#### Scenario: Interactive selection requires a terminal

- **WHEN** interactive selection would be entered without a terminal attached
- **THEN** the tool exits with code 2 explaining that a panel must be supplied by configuration or by flag in a non-interactive environment

### Requirement: Panel persistence and reuse

The result of selection SHALL be saved as the project's panel so that selection is normally a one-time act. Subsequent runs MUST reuse the saved panel without prompting, and MUST offer an explicit way to re-open selection or to bypass it entirely for one run.

#### Scenario: Saved panel is reused silently

- **WHEN** a review run starts in a project whose configuration holds a panel and no panel flag is given
- **THEN** the saved panel and its saved thinking levels are used without any prompt

#### Scenario: Re-opening selection

- **WHEN** a review run is started with the re-pick flag
- **THEN** selection is presented, the run proceeds with the new panel, and the new panel replaces the saved one

#### Scenario: Bypassing selection for one run

- **WHEN** a review run is started with an explicit model specification
- **THEN** that specification defines the panel for this run only and the saved panel is left unchanged

#### Scenario: A saved panel entry no longer exists

- **WHEN** a saved panel names a model that is absent from the current catalog
- **THEN** the run exits with code 2 naming the missing entry and suggesting re-selection, and spawns no reviewer

### Requirement: Command-line panel specification

A panel SHALL be specifiable non-interactively as a comma-separated list of entries using the host's own grammar, `provider/modelId` with an optional trailing `:level` pin. Parsing MUST split the thinking pin on the **last** colon, MUST tolerate model ids that themselves contain slashes, MUST tolerate a leading prefix marker on a model id, and MUST accept glob patterns expanded against the catalog.

#### Scenario: Plain entries

- **WHEN** a specification lists `provider/modelId` entries with no pins
- **THEN** each named model joins the panel with its thinking level resolved by the precedence rules

#### Scenario: Per-model thinking pin

- **WHEN** an entry carries a trailing `:level`
- **THEN** that level is the requested level for that model only

#### Scenario: Model id containing slashes

- **WHEN** an entry names a gateway model whose id contains one or more slashes and carries a trailing pin
- **THEN** the pin is taken from after the final colon and the entire remainder is treated as `provider/modelId`

#### Scenario: Model id carrying a prefix marker

- **WHEN** an entry names a model id that carries a leading prefix marker
- **THEN** the entry resolves to the same catalog model as the unmarked id

#### Scenario: Glob expansion

- **WHEN** an entry contains a glob pattern
- **THEN** it expands to every matching catalog model, and each expanded model inherits any pin given on the pattern

#### Scenario: Glob matching nothing

- **WHEN** a glob pattern matches no catalog model
- **THEN** the tool exits with code 2 naming the pattern that matched nothing

#### Scenario: Unparseable entry

- **WHEN** an entry cannot be parsed, or names an unknown provider or model
- **THEN** the tool exits with code 2 naming the offending entry, and spawns no reviewer

### Requirement: Thinking-level precedence

Each reviewer's requested thinking level SHALL be resolved from the most specific source available, in this order: a command-line per-model pin; a panel-wide command-line level; a configured per-model level keyed `"provider/modelId"`; a configured default level; and otherwise nothing at all, in which case no thinking selection is sent and the host's own default applies.

#### Scenario: Per-model pin beats panel-wide flag

- **WHEN** a model carries a command-line pin and a panel-wide level is also given
- **THEN** the pin is that model's requested level and the panel-wide level applies to the other models

#### Scenario: Panel-wide flag beats configuration

- **WHEN** a panel-wide level is given and the configuration also holds per-model and default levels
- **THEN** the panel-wide level is the requested level for every model

#### Scenario: Configured per-model beats configured default

- **WHEN** no command-line level is given and the configuration holds both a per-model entry for a model and a default level
- **THEN** the per-model entry is that model's requested level

#### Scenario: Nothing configured

- **WHEN** no level is available from any source for a reasoning model
- **THEN** no thinking selection is sent for that reviewer and the host's own default level governs

#### Scenario: Non-reasoning model ignores every source

- **WHEN** a level is requested for a model that does not support thinking
- **THEN** no thinking selection is sent for that reviewer and the manifest records that thinking was not applicable

### Requirement: Clamping an unsupported level

When a resolved level is not supported by the model it was resolved for, the tool SHALL clamp it to the nearest supported level measured by ordinal distance along the ordered level list, preferring the lower level on a tie. The run MUST continue rather than fail, and both the requested and the effective level MUST be recorded per reviewer so that an unexpectedly shallow review is explainable after the fact.

#### Scenario: Requested level above the model's ceiling

- **WHEN** `max` is requested for a model whose highest supported level is `high`
- **THEN** the effective level is `high`, the run proceeds, and the manifest records `max` as requested and `high` as effective

#### Scenario: Tie prefers the lower level

- **WHEN** a requested level is equidistant from a supported level above and a supported level below
- **THEN** the lower level is chosen

#### Scenario: Disabling thinking on a model that cannot disable it

- **WHEN** `off` is requested for a model that marks `off` unsupported
- **THEN** the level is clamped to the nearest supported level and both values are recorded

#### Scenario: Clamping is visible in progress output

- **WHEN** any reviewer's effective level differs from its requested level
- **THEN** the difference is reported in the run's own output as well as in the manifest

### Requirement: Host thinking budgets are never overridden

The host's own thinking-budget settings SHALL be left untouched. The tool MUST NOT write, override or pass through any budget value in place of the user's host-level configuration.

#### Scenario: Budgets are not passed

- **WHEN** any reviewer is launched at any thinking level
- **THEN** no thinking-budget value originates from this tool, and the user's host-level budget configuration governs

### Requirement: Vendor-independence guard

A panel SHALL be admitted only if it contains at least three models resolving to at least three distinct vendors, where `unknown` counts as its own distinct vendor. The guard MUST be evaluated at the end of selection and again immediately before launch, so that a panel edited by hand into configuration is checked too. On refusal the tool MUST print the collapsed vendor grouping and exit with code 4 without spawning any reviewer.

#### Scenario: Independent panel is admitted

- **WHEN** a panel holds three models resolving to three distinct vendors
- **THEN** the guard passes and the run proceeds

#### Scenario: Too few vendors

- **WHEN** a panel holds three models but two of them resolve to the same vendor
- **THEN** the tool prints the collapsed grouping, spawns no reviewer, and exits with code 4

#### Scenario: Too few models

- **WHEN** a panel holds fewer than three models
- **THEN** the tool spawns no reviewer and exits with code 4

#### Scenario: Guard runs again before launch

- **WHEN** a configured panel that was never produced by the picker fails the guard
- **THEN** the refusal happens before any reviewer is spawned

#### Scenario: Explicit override

- **WHEN** the correlated-panel override flag is given for a panel that would otherwise be refused
- **THEN** both the distinct-vendor requirement and the three-model minimum are waived, the run proceeds, and the manifest records that the override was used

#### Scenario: Override is recorded even when unnecessary

- **WHEN** the override flag is given for a panel that would have passed anyway
- **THEN** the run proceeds and the manifest still records that the flag was supplied
