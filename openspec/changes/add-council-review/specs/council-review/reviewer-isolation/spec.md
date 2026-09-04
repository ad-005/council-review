## Purpose

Defines the read-only guarantee that lets third-party models read a repository's source: reviewers are made incapable of writing, executing or reaching the network, rather than merely instructed not to, and the guarantee is layered so that no single mistake removes it.

## ADDED Requirements

### Requirement: Reviewers have no built-in capabilities

Every built-in tool of the review agent host SHALL be removed from a reviewer's tool surface. In particular, no reviewer SHALL have a shell, file-write or file-edit capability available to call.

#### Scenario: Built-ins are absent

- **WHEN** a reviewer process is launched and its available tool surface is inspected
- **THEN** no host built-in is present, and specifically no shell, write or edit capability exists

#### Scenario: Launch arguments are asserted

- **WHEN** a reviewer is launched
- **THEN** the launch arguments include the flag that removes host built-ins, and include no argument that would re-enable one

#### Scenario: Provider-side tool envelopes add nothing

- **WHEN** a provider exposes a parallel-invocation envelope around tool calls
- **THEN** that envelope can only wrap tools this tool registered, and grants a reviewer no capability beyond them

### Requirement: The reviewed repository cannot supply executable resources

A reviewer SHALL be launched with discovery of repository-supplied extensions, skills, prompt templates and project trust all disabled, so that a repository under review cannot cause its own code or instructions to be loaded into the process that reviews it.

#### Scenario: Repository extensions are not loaded

- **WHEN** the reviewed repository contains host extension files
- **THEN** none of them is loaded or executed in any reviewer process

#### Scenario: Repository skills and prompts are not loaded

- **WHEN** the reviewed repository contains host skill or prompt-template files
- **THEN** none of them is loaded into any reviewer process

#### Scenario: Project trust is not consulted

- **WHEN** the reviewed repository carries host project-trust state
- **THEN** that state grants a reviewer no additional capability

### Requirement: Agent context files are excluded by default

Because agent context files are loaded by the host regardless of trust, they represent an instruction-injection surface and SHALL be excluded from reviewer processes by default. Inclusion MUST be possible only through explicit project configuration, and the choice MUST be recorded in the run manifest.

#### Scenario: Context files excluded by default

- **WHEN** the reviewed repository contains agent context files and configuration does not opt in
- **THEN** those files are not loaded into any reviewer process

#### Scenario: Explicit opt-in

- **WHEN** the configuration opts into including context files
- **THEN** they are loaded, and the manifest records that context files were included for this run

### Requirement: Reviewers have exactly four read-only tools

The only tools available to a reviewer SHALL be a file-read tool, a content-search tool, a directory-listing tool and a repository-history tool, named `council_read`, `council_grep`, `council_list` and `council_git`. None of them SHALL be capable of modifying anything.

#### Scenario: Tool surface is exactly the four tools

- **WHEN** a reviewer's available tool surface is inspected
- **THEN** it consists of exactly `council_read`, `council_grep`, `council_list` and `council_git`

#### Scenario: No tool can mutate state

- **WHEN** any of the four tools is called with any arguments
- **THEN** no file, directory or repository state is created, modified or deleted

#### Scenario: The reviewer extension never runs in the tool's own process

- **WHEN** any command of this tool executes
- **THEN** the reviewer tool implementation is loaded only inside reviewer processes and is never imported by the tool's own process

### Requirement: Every tool path is contained within the snapshot

Every path a reviewer supplies to any of its tools SHALL be resolved to a real filesystem path and rejected if the resolved path lies outside the snapshot root. Rejection MUST apply to relative traversal, to absolute paths and to symbolic links whose target escapes the root.

#### Scenario: Relative traversal is rejected

- **WHEN** a reviewer supplies a path containing parent-directory traversal that resolves outside the snapshot root
- **THEN** the tool call fails with an error and no content from outside the root is returned

#### Scenario: Absolute path outside the root is rejected

- **WHEN** a reviewer supplies an absolute path outside the snapshot root
- **THEN** the tool call fails with an error and no content is returned

#### Scenario: Escaping symlink is rejected

- **WHEN** a reviewer supplies a path inside the snapshot that is a symbolic link whose target resolves outside the snapshot root
- **THEN** the tool call fails with an error and the link target's content is not returned

#### Scenario: Symlink escape via an intermediate directory is rejected

- **WHEN** a reviewer supplies a path whose intermediate directory component is a symbolic link resolving outside the snapshot root
- **THEN** the tool call fails with an error and no content is returned

#### Scenario: Containment applies to every tool

- **WHEN** an escaping path is supplied to any of the four reviewer tools, including as a search root or a listing target
- **THEN** each of them rejects it

#### Scenario: In-root paths succeed

- **WHEN** a reviewer supplies a path that resolves inside the snapshot root
- **THEN** the tool call succeeds

### Requirement: Repository history is reachable only through an allowlist

Because the snapshot has no repository metadata, history SHALL be made available through the history tool, which executes against the real repository using a fixed allowlist of read-only subcommands — log, show, blame and diff. The reviewer SHALL supply structured arguments only and MUST NOT be able to compose a command line.

#### Scenario: Allowlisted history query succeeds

- **WHEN** a reviewer requests one of the allowlisted read-only history operations
- **THEN** the result is returned from the real repository

#### Scenario: Non-allowlisted subcommand is refused

- **WHEN** a reviewer requests any history operation outside the allowlist
- **THEN** the call fails with an error and nothing is executed

#### Scenario: Command composition is impossible

- **WHEN** a reviewer supplies argument values containing shell metacharacters, option-like tokens or additional subcommands
- **THEN** they are passed as literal argument values or rejected, and never interpreted as part of a command line

#### Scenario: History access cannot mutate the repository

- **WHEN** any history call is made
- **THEN** the real repository's state, index and working tree are unchanged

### Requirement: Reviewers have no network egress of their own

Removing the shell capability removes a reviewer's only path to arbitrary network access, and the tool SHALL NOT reintroduce one. A reviewer's only outbound traffic is the host's own model API call.

#### Scenario: No egress capability exists

- **WHEN** a reviewer's tool surface is inspected
- **THEN** no tool can issue an arbitrary network request, and no shell exists through which one could be issued

### Requirement: Reviewers produce text, not files

A reviewer SHALL communicate its result only as text on its own output stream. All file writing for a run SHALL be performed by the tool's own process.

#### Scenario: Only the tool writes run artifacts

- **WHEN** a run completes
- **THEN** every file in the run directory was written by the tool's own process and none by a reviewer

### Requirement: Reviewer transcripts are not persisted by the host

Reviewers SHALL be launched with host session persistence disabled, so that reviewer conversations — which contain repository source — are not written into the host's session store.

#### Scenario: No session file is created

- **WHEN** a run completes
- **THEN** no new entry for any reviewer appears in the host's session store

### Requirement: Reviewer process environment is allowlisted

Each reviewer process SHALL receive only an allowlisted environment: the executable search path, the home directory required for the host to find its credentials, and the host's own variable namespace. Every other variable from the invoking environment MUST be dropped, so that no unrelated secret enters a reviewer process.

#### Scenario: Allowlisted variables are passed

- **WHEN** a reviewer is launched
- **THEN** its environment contains the executable search path, the home directory and the host's own variables

#### Scenario: Unrelated variables are dropped

- **WHEN** the invoking environment contains unrelated variables, including credentials for other services
- **THEN** none of them is present in any reviewer process environment

#### Scenario: Working directory is the snapshot

- **WHEN** a reviewer is launched
- **THEN** its working directory is the frozen snapshot root and not the real repository
