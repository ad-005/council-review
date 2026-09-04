## Purpose

Defines what a run actually reviews: how a scope selector becomes one diff patch plus one file set, and how that scope is materialised as an immutable snapshot of the tree the diff ends at, so reviewers see a single fixed photograph while work continues around them.

## ADDED Requirements

### Requirement: Default scope is the work in this worktree

With no scope selector, the review target SHALL be the whole of the current worktree's divergence from its base branch: from the merge base of `HEAD` and the configured base branch through the current on-disk state, folding committed, staged, unstaged and untracked-but-not-ignored changes into one patch. This matches a one-worktree-per-feature workflow, where "the work" is not confined to what has been committed.

#### Scenario: Committed, staged, unstaged and new files in one patch

- **WHEN** a worktree has commits ahead of its base branch, staged edits, unstaged edits and a brand-new untracked file that is not gitignored
- **THEN** the resulting patch contains all four kinds of change as a single diff

#### Scenario: Ignored files are excluded

- **WHEN** the worktree contains gitignored paths such as dependency directories or environment files
- **THEN** those paths appear in neither the patch nor the reviewed file set

#### Scenario: Base branch comes from configuration

- **WHEN** no base override is given
- **THEN** the configured base branch is used to compute the merge base

#### Scenario: Base branch override

- **WHEN** a base branch is supplied on the command line
- **THEN** the merge base is computed against the supplied branch instead of the configured one

#### Scenario: Unknown base branch

- **WHEN** the configured or supplied base branch does not exist
- **THEN** the tool exits with code 2 naming the branch, and spawns no reviewer

#### Scenario: Empty scope

- **WHEN** the resolved scope produces no changed files
- **THEN** the tool reports that there is nothing to review, spawns no reviewer, and exits with code 0

### Requirement: Scope overrides

The review target SHALL be redirectable to the staged index alone, to an explicit commit range, or to a single revision, and SHALL be narrowable to a set of path globs. Each override MUST produce the same shape of result as the default scope: one patch plus one file set.

#### Scenario: Staged scope

- **WHEN** the staged selector is given
- **THEN** the patch describes exactly the staged changes, and unstaged and untracked changes are excluded

#### Scenario: Range scope

- **WHEN** a commit range is given
- **THEN** the patch describes exactly the difference between the two endpoints of that range

#### Scenario: Single revision scope

- **WHEN** a single revision selector is given
- **THEN** the patch describes exactly that revision's change

#### Scenario: Path narrowing

- **WHEN** one or more path globs are given alongside any scope
- **THEN** the patch and the reviewed file set are restricted to paths matching those globs

#### Scenario: Path narrowing matching nothing

- **WHEN** the supplied globs match no path in the resolved scope
- **THEN** the tool reports that there is nothing to review, spawns no reviewer, and exits with code 0

#### Scenario: Invalid revision

- **WHEN** a range or revision selector names a revision that cannot be resolved
- **THEN** the tool exits with code 2 naming the unresolvable revision

### Requirement: The patch is a run artifact, not snapshot content

The diff patch SHALL be written into the run directory and MUST NOT be written inside the snapshot, so that the snapshot remains an exact depiction of source tree state. Reviewers MUST receive the patch by reference to that run-directory path.

#### Scenario: Snapshot contains no tool-generated files

- **WHEN** a snapshot has been built for any scope
- **THEN** it contains only files that exist in the reviewed source state, and no patch, prompt or manifest written by the tool

#### Scenario: Reviewers receive the patch

- **WHEN** reviewers are launched
- **THEN** each is given the patch by reference to its path in the run directory

### Requirement: Snapshot depicts the state the diff ends at

The snapshot source SHALL follow the resolved scope so that the tree reviewers read is the tree the reviewed diff ends at. Reviewing a historical range against the current worktree would show reviewers code that has since moved, so this correspondence is a correctness requirement rather than a convenience.

#### Scenario: Default scope snapshot

- **WHEN** the default scope is used
- **THEN** the snapshot contains the tracked files plus the untracked-but-not-ignored files as they exist on disk at run start

#### Scenario: Staged scope snapshot

- **WHEN** the staged selector is used
- **THEN** the snapshot contains the contents of the index exactly, not the working-tree contents

#### Scenario: Range scope snapshot

- **WHEN** a commit range or a single revision is reviewed
- **THEN** the snapshot contains the tree at the range's end revision, not the current worktree

#### Scenario: Line numbers correspond to the snapshot

- **WHEN** a reviewer reports a finding with a line number
- **THEN** that line number refers to the file as it exists in the snapshot, and every reviewer's line numbers therefore refer to the same tree

### Requirement: The snapshot is frozen for the duration of the run

The snapshot SHALL be built in a scratch location at run start and made non-writable for every user before any reviewer is launched. Reviewers therefore see one immutable tree fixed at run start, and concurrent edits to the real worktree MUST have no effect on the run.

#### Scenario: Snapshot is read-only

- **WHEN** the snapshot has been built and reviewers are about to launch
- **THEN** no file or directory within it is writable

#### Scenario: Concurrent editing does not disturb the run

- **WHEN** the real worktree is edited while a run is in progress
- **THEN** the reviewers continue to read the tree as it was at run start and the run's results are unaffected

#### Scenario: Snapshot build failure aborts before launch

- **WHEN** the snapshot cannot be built or cannot be made read-only
- **THEN** no reviewer is launched, any partial snapshot is removed, and the tool exits with a non-zero code explaining the failure

### Requirement: No git worktree is created

The tool SHALL NOT create, register or remove a git worktree for any purpose. An ephemeral review tree must not consume the project's worktree lifecycle, which is managed elsewhere.

#### Scenario: Worktree list is unchanged

- **WHEN** a run completes, whether successfully or with failures
- **THEN** the repository's set of registered git worktrees is identical to what it was before the run

### Requirement: Snapshot identity is recorded

Every run SHALL record an identity for the tree it reviewed: the `HEAD` commit, whether the worktree was dirty, and a content hash computed over the sorted set of reviewed path and content-hash pairs. This identity is what lets a later run be diffed against this one with confidence.

#### Scenario: Identity fields are recorded

- **WHEN** a run completes
- **THEN** its manifest records the `HEAD` commit, the dirty flag and the tree content hash

#### Scenario: Identical trees hash identically

- **WHEN** two runs review byte-identical file sets
- **THEN** their recorded tree content hashes are equal

#### Scenario: A changed file changes the hash

- **WHEN** any reviewed file's content differs between two runs
- **THEN** their recorded tree content hashes differ

### Requirement: Snapshot narrowing for large repositories

Where copying the whole reviewed tree would be prohibitively slow, the snapshot SHALL be narrowable both by the scope's path globs and by a configured include list, while still containing every file the patch touches.

#### Scenario: Configured include list narrows the copy

- **WHEN** the configuration supplies a snapshot include list
- **THEN** only matching paths are copied into the snapshot

#### Scenario: Narrowing never omits a changed file

- **WHEN** narrowing is in effect
- **THEN** every file appearing in the resolved patch is nonetheless present in the snapshot

### Requirement: Snapshot cleanup and orphan collection

The tool SHALL restore write permissions and remove the snapshot when a run ends, including when it ends by failure or interruption, and SHALL provide a command that sweeps snapshots orphaned by a run that could not clean up after itself.

#### Scenario: Cleanup on success

- **WHEN** a run completes normally
- **THEN** its snapshot directory no longer exists

#### Scenario: Cleanup on failure or interruption

- **WHEN** a run fails or is interrupted after the snapshot was frozen
- **THEN** write permissions are restored and the snapshot directory is removed

#### Scenario: Orphan sweep

- **WHEN** the garbage-collection command is run and orphaned snapshots from earlier runs exist
- **THEN** they are removed and the number removed is reported

#### Scenario: Sweep does not touch a live run

- **WHEN** the garbage-collection command is run while another run is in progress
- **THEN** the in-progress run's snapshot is left intact
