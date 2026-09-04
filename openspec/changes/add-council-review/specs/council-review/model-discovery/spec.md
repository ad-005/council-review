## Purpose

Defines how the tool learns which models it can actually run, which vendor each model really comes from, and which thinking levels each model supports — without ever touching the credentials that make those models reachable.

## ADDED Requirements

### Requirement: Model catalog enumeration

The tool SHALL enumerate available providers and models from the review agent host's model catalog, exposing per model at least its id, display name, provider, context window, maximum output tokens, input and output cost rates, whether it supports reasoning, and its thinking-level map. Catalog data MUST be read without invoking any model.

#### Scenario: Catalog is read

- **WHEN** the model catalog is present and well-formed
- **THEN** every model it lists is available for selection, annotated with its provider, vendor, context window and input/output cost rates

#### Scenario: Discovery makes no model calls

- **WHEN** discovery runs
- **THEN** no inference request is issued and no cost is incurred

#### Scenario: Malformed catalog entries are skipped, not fatal

- **WHEN** individual catalog entries are missing required fields
- **THEN** those entries are omitted from the selectable set, a warning names how many were skipped, and the remaining entries stay usable

### Requirement: Provider readiness

The tool SHALL determine per provider whether it is ready to be used, and SHALL present only ready providers as selectable. Readiness MUST be established through the host's own authentication status interface, whose response contains no credential material.

#### Scenario: Ready providers are offered

- **WHEN** readiness is queried and a provider reports ready
- **THEN** that provider is offered for selection, annotated with its authentication type and the number of models it exposes

#### Scenario: Unready providers are excluded

- **WHEN** a provider reports any state other than ready
- **THEN** it is not offered for selection and the reason is available in the tool's diagnostic output

#### Scenario: A configured model belongs to an unready provider

- **WHEN** a run starts with a configured panel that names a provider which is no longer ready
- **THEN** the run exits with code 2, names the provider and the affected panel entry, and spawns no reviewer

### Requirement: Credential files are never accessed

No code path SHALL open, read, copy or log the host's credential store, which holds live access and refresh tokens. No credential material SHALL be printed to any stream, written into any run artifact, or included in any error message.

#### Scenario: Credential store is untouched

- **WHEN** any command in the tool runs to completion, including discovery, selection and a full review
- **THEN** the host credential store file is never opened by the tool's own process

#### Scenario: Reports are credential-free

- **WHEN** a run completes and all its artifacts are written
- **THEN** no artifact contains a token, key or secret value

### Requirement: Fallback catalog path

When the model catalog is unavailable, the tool SHALL fall back to the host's model listing command, invoked so that host extensions are disabled and cannot contaminate the listing output.

#### Scenario: Catalog missing

- **WHEN** the model catalog file does not exist and the host's listing command succeeds
- **THEN** models are enumerated from the listing output and selection proceeds

#### Scenario: Extension output cannot corrupt the listing

- **WHEN** the fallback listing is used on a host that has extensions installed which print banner output
- **THEN** the listing is invoked with extension loading disabled so that no banner line is parsed as a model

#### Scenario: Both catalog sources unavailable

- **WHEN** the catalog file is missing and the listing command fails or is absent
- **THEN** the tool exits with code 2 stating that no models could be discovered

### Requirement: Vendor derivation

Because the host's notion of a provider is a gateway rather than a model vendor, the tool SHALL derive a vendor per model so that several selections routed through one gateway are not mistaken for independent reviewers. Vendor resolution MUST apply, in order: an exact `provider/model` entry in the configured vendor overrides; for gateways whose model ids are themselves `vendor/model`, the leading segment with any prefix marker stripped; a shipped prefix table for flat-id gateways; and otherwise `unknown`.

#### Scenario: Configured override wins

- **WHEN** a model has an exact `provider/model` entry in the configured vendor overrides
- **THEN** that vendor is used regardless of what any other rule would derive

#### Scenario: Gateway id carries the vendor

- **WHEN** a model id has the form `vendor/model`, optionally carrying a prefix marker
- **THEN** the leading segment with the marker stripped is used as the vendor

#### Scenario: Flat gateway id matches the prefix table

- **WHEN** a model id is flat and matches a known vendor prefix in the shipped table
- **THEN** the table's vendor is used

#### Scenario: Unrecognised model

- **WHEN** no rule resolves a vendor for a model
- **THEN** its vendor is `unknown`, it is treated as its own distinct vendor for independence purposes, and the fact is surfaced during selection and recorded in the run manifest

#### Scenario: Collapsed vendors are visible before launch

- **WHEN** several selected models resolve to the same vendor
- **THEN** the collapsed grouping is shown to the user, naming which selections share a vendor

### Requirement: Thinking-level support computation

The tool SHALL compute, per model, which of the host's ordered thinking levels — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — that model supports, using the model's reasoning flag and its tristate thinking-level map. A model whose reasoning flag is falsy MUST be treated as not supporting thinking at all, and no thinking selection is sent for it. Within the map, a string value means the level is supported, an explicit null means it is unsupported, and an absent key means the level falls back to the provider's default mapping — supported for `off` through `high`, unsupported for `xhigh` and `max`.

#### Scenario: Non-reasoning model

- **WHEN** a model's reasoning flag is falsy
- **THEN** it is reported as supporting no thinking levels and is presented as "no thinking" during selection

#### Scenario: Explicitly supported level

- **WHEN** a model's thinking-level map holds a string value for a level
- **THEN** that level is reported as supported

#### Scenario: Explicitly unsupported level

- **WHEN** a model's thinking-level map holds an explicit null for a level
- **THEN** that level is reported as unsupported

#### Scenario: Whole map absent

- **WHEN** a reasoning model has no thinking-level map at all
- **THEN** `off` through `high` are reported as supported and `xhigh` and `max` as unsupported

#### Scenario: Level absent from a partially specified map

- **WHEN** a reasoning model has a thinking-level map that specifies some levels and omits others
- **THEN** each omitted level is resolved by the same absent-key fallback as a wholly absent map, so omitted levels from `off` through `high` are supported and omitted `xhigh` and `max` are not

#### Scenario: Thinking cannot be disabled

- **WHEN** a model's map marks `off` as unsupported
- **THEN** `off` is reported as unsupported for that model and any request to disable thinking for it is resolved by the clamping rules rather than being sent as-is

### Requirement: Model listing command

`council-review models` SHALL print the discovered, ready models with the information needed to choose between them, without entering interactive selection and without making any model call.

#### Scenario: Listing content

- **WHEN** `council-review models` is run
- **THEN** each listed model shows its provider, model id, derived vendor, context window, input and output cost rates, and its supported thinking levels

#### Scenario: Listing is non-interactive

- **WHEN** `council-review models` is run without a terminal attached
- **THEN** it prints the listing as plain lines and exits with code 0 without prompting
