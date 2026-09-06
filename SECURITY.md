# Security policy

`council-review` sends the contents of your git worktree to third-party model providers as
reviewers. Its whole premise is a trust boundary — read this file and the README's "The isolation
model and its limits" section before relying on it.

## Supported versions

`0.1.0` is the only version, and the one any security fix would target. There is no older version
receiving security fixes.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository: **Security tab → Report a
vulnerability**. Do **not** open a public issue for a security report — a public issue is visible
to everyone, including anyone who might exploit the report before a fix ships.

## What is in scope

The reviewer isolation model is the security boundary this project claims, and reports against any
part of it are in scope:

- The stripped host tool surface — a reviewer must never gain a shell, a file-write tool, or a
  file-edit tool.
- Path containment: any path given to `council_read`, `council_grep`, `council_list` or
  `council_git` must be realpath-resolved and rejected if it escapes the snapshot root, including
  via a symlink or an intermediate symlinked directory.
- The `council_git` read-only subcommand allowlist (log, show, blame, diff) with structured
  arguments — never a composed command line reaching the real repository.
- The environment allowlist a reviewer process is spawned with — it must keep unrelated secrets
  (credentials for other services, arbitrary variables from the invoking shell) out of a reviewer
  process.
- The guarantee that no artifact this tool writes (`manifest.json`, `REPORT.md`, `HANDOFF.md`,
  findings files, reviewer trace files) contains a token, key or secret.

A working exploit against any of the above — a way to make a reviewer write, execute, reach
arbitrary network egress, escape the snapshot root, read an environment variable outside the
allowlist, or cause a secret to land in a written artifact — is a genuine vulnerability report.

## What is explicitly NOT a vulnerability

The README documents these as deliberate, known design limits of v1, not oversights. Please do not
file these as security reports:

- **This is not container or VM isolation.** There is no sandbox boundary beyond the tool-surface
  removal and path containment described above. A stronger implementation may be added later, but
  its absence in v1 is a stated design decision.
- **`chmod -R a-w` on the snapshot is not a security boundary against a same-user process.** A
  process running as the same user can `chmod` its way back to writable. Freezing the tree exists
  for consistency (so every reviewer and the merge step see the same line numbers), not as the
  source of the read-only guarantee — that guarantee comes entirely from the absence of a write
  tool in the reviewer's callable surface.
- **This is POSIX-only.** The freeze step and the path-containment logic assume POSIX permission
  and symlink semantics. It has not been tested, and is not expected to work, on a non-POSIX
  filesystem.
- **Third-party model providers see your source code.** That is the entire premise of this tool:
  a review requires a model to read the diff and the surrounding repository. Nothing in the
  isolation model prevents a model provider from seeing your code as part of serving the review
  request — it only prevents that model, or the repository it's reviewing, from writing anything,
  executing anything, or reaching the network on its own.

## The host-version caveat

The isolation guarantee rests on flags and an event-stream shape belonging to the `pi` binary
(`@earendil-works/pi-coding-agent`), which this package does not control. See
[`HOST-VERSION.md`](./HOST-VERSION.md) for exactly what has been verified, against which `pi`
version, and the re-verification procedure that must be run after any host upgrade before trusting
the isolation guarantee against a new version.
