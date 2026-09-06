# council-review

A read-only, multi-vendor code review panel over local git state.

`council-review` sends the work in your git worktree to several independent models from
**different vendors** — not just different gateways — and merges their findings in deterministic
code, never through another model. Reviewers cannot write to anything: every host built-in is
removed, the repository under review cannot load its own extensions or skills into the process
reviewing it, and the only tools a reviewer has are four read-only ones scoped to a frozen,
non-writable snapshot of your tree.

Every run produces a timestamped directory holding a machine-readable manifest, each reviewer's
raw output, the merged findings, a human report, and a handoff prompt addressed to a coding agent.

## Install

This package is not yet published to npm, so the recommended install is directly from GitHub.

### From GitHub (recommended)

```
npm install -g github:ad-005/council-review
```

This installs and builds straight from the repository and works today.

### From npm

```
npm install -g council-review
```

This will be the install once the package is published to npm. It is not published yet, so this
command currently fails — the GitHub install above is the one that works.

### From source (development)

```
git clone https://github.com/ad-005/council-review.git
cd council-review
npm install
npm run build
npm link
```

Use this if you're contributing to `council-review` itself. `npm link` makes the `council-review`
command available globally from your checkout; alternatively, run it directly with
`node dist/bin.js`.

Requires Node.js 20 or later to install and run `council-review` itself, plus the
[`pi`](#the-pi-host-dependency) coding-agent CLI on `PATH`, authenticated for at least one
provider. `pi` itself requires Node.js **>= 22.19.0**, which is the effective floor for actually
running a review — a Node 20 or 21 install satisfies `council-review`'s own guard but leaves every
reviewer failing to spawn.

## Quick start

```
cd your-project
council-review init      # pick a panel interactively; writes .council/config.json
council-review           # review the current worktree's work against its base branch
```

`init` runs a three-stage picker — providers, then models, then a thinking level per reasoning
model — and requires at least three models resolving to at least three distinct vendors before it
will save a panel (the vendor-independence guard; see below). The saved panel is committed
(`.council/config.json` is meant to be checked in) so the rest of the team reuses it without
re-picking.

Bare `council-review` reviews **the whole of the current worktree's divergence from its base
branch** — committed, staged, unstaged and untracked-but-not-gitignored changes, folded into one
patch — not just what's staged. Use the scope flags below to narrow that.

## Scope flags

| Flag                         | Meaning                                          |
| ---------------------------- | ------------------------------------------------ |
| `--staged`                   | Review the staged index only                     |
| `--range <A..B>`             | Review a commit range                            |
| `--revision <rev>`           | Review a single revision's own change            |
| `--paths <glob>[,<glob>...]` | Narrow to matching paths (repeatable)            |
| `--base <branch>`            | Override the configured base branch for this run |

`--staged`, `--range` and `--revision` are mutually exclusive. An empty resolved scope (nothing to
review) is not an error: the tool reports that and exits `0` without spawning a reviewer.

## Panel flags

| Flag                 | Meaning                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--models <spec>`    | One-off panel for this run only: comma-separated `provider/modelId[:level]` entries or globs. Does not touch the saved panel. |
| `--pick`             | Re-open interactive selection; the result **replaces** the saved panel                                                        |
| `--thinking <level>` | Panel-wide thinking level (one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`)                                  |
| `--allow-correlated` | Waive the vendor-independence guard for this run (recorded in the manifest even when it wasn't needed)                        |

`council-review models` lists every discovered, ready model with its provider, derived vendor,
context window, cost rates and supported thinking levels — no prompt, no model call, works without
a terminal.

### The vendor-independence guard

A panel is admitted only with **at least three models resolving to at least three distinct
vendors** (`unknown` counts as its own distinct vendor, so three unrecognised models still pass).
This is checked at the end of selection and again immediately before every launch, so a
hand-edited config is checked too. On refusal, nothing is spawned and the tool exits `4`. Pass
`--allow-correlated` to waive both the vendor-count and the three-model minimum deliberately.

## Run flags

| Flag                      | Meaning                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--timeout <seconds>`     | Per-reviewer wall-clock timeout (overrides configured `timeoutSeconds`)                                                                       |
| `--max-tokens <n>`        | Per-reviewer output-token ceiling (overrides configured `maxOutputTokens`); with neither the flag nor the config key set, there is no ceiling |
| `--since <last\|run-id>`  | Diff this run's findings against a previous one: `resolved` / `still-present` / `new`                                                         |
| `--fail-on <level\|none>` | Severity threshold for exit code `1` (`critical`, `high`, `medium`, `low`, or `none` to disable)                                              |
| `--no-suppress`           | Ignore `.council/ignore.json` for this run only; the file itself is untouched                                                                 |
| `--json`                  | Emit only the merged findings document on stdout; everything else (progress, diagnostics) goes to stderr                                      |

## Environment (herdr) flags

Only meaningful inside a [herdr](https://herdr.dev) pane (an agent multiplexer some users run
coding agents under, detected via an environment marker). herdr is an optional integration —
install it with `brew install herdr` if you want it — and every one of these flags is gated on
that marker: outside that environment each degrades to exactly one printed notice, and the review
itself proceeds and completes identically to how it would with none of these flags supplied — same
artifacts, same exit code. A failing or unavailable herdr command is likewise reported as a warning
only; it never changes the review's own outcome.

| Flag                                 | Meaning                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--pane`                             | Run the review in a new herdr pane (default direction: horizontal), current working directory carried over, focus left where it was                          |
| `--direction <horizontal\|vertical>` | Direction for `--pane`                                                                                                                                       |
| `--no-pane`                          | Do not delegate to a new pane even if `--pane` is set                                                                                                        |
| `--handoff <agent>`                  | Deliver the written handoff prompt to a herdr-managed agent by name; delivery is not awaited, so the review command's own exit code reflects the review only |
| `--no-notify`                        | Suppress the herdr completion notification (still raised, conveying completion, after a degraded run)                                                        |

## Subcommands

- **`init [--pick]`** — bootstrap the current repository: run panel selection, write
  `.council/config.json` and `.council/ignore.json`, and ensure `.gitignore` excludes
  `.council/reviews/`. Safe to re-run: existing suppressions are preserved. Must be run inside a
  git repository.
- **`models`** — list discovered, ready models. No prompt, no model call.
- **`show [run-id]`** — render a stored run's `REPORT.md`. Defaults to the most recent run. No
  model call.
- **`ignore <finding-id> [--reason <text>] [--run <run-id>]`** — resolve a finding id from a run's
  merged findings to its fingerprint and append it to `.council/ignore.json`. Idempotent.
- **`gc [--keep <n>]`** — prune stored runs under `.council/reviews/`, keeping the `<n>` most
  recent (default: the configured `retain`, or 20). Never removes the run the `last` pointer
  resolves to. Also sweeps snapshot directories orphaned by a run that couldn't clean up after
  itself.
- **`status [--json] [--verify]`** — report whether this project is configured, plus the resolved
  panel, independence-guard verdict, settings, suppression count, stored runs and
  gitignore/herdr state. This is the intended entry point for a coding agent to check in
  milliseconds whether it can run a review here at all, before doing anything else. Exits `0`
  when configured, `2` when not — including outside a git repository, or with an invalid
  `.council/config.json` (the offending key is named in the report) — and never anything else.
  The default form makes no host call and no model call: it reads only files already on disk
  (plus the single `git rev-parse` used to find the repository root). `--verify` additionally
  discovers the model catalog and reports each panel entry's real readiness and effective
  thinking level — a stale panel entry (a model no longer in the catalog) is reported as not
  ready rather than causing the command to fail. `--json` emits the full report as JSON on
  stdout instead of the human-readable form, e.g.:
  ```json
  {
    "version": "0.1.0",
    "configured": true,
    "repoRoot": "/path/to/project",
    "config": {
      "path": "/path/to/project/.council/config.json",
      "present": true,
      "valid": true,
      "version": 1,
      "error": null,
      "errorKeyPath": null
    },
    "panel": [
      {
        "provider": "anthropic",
        "model": "claude-opus-4",
        "vendor": "anthropic",
        "thinking": "high",
        "effectiveThinking": null,
        "clamped": null,
        "ready": null,
        "readyReason": null
      }
    ],
    "independence": {
      "ok": true,
      "modelCount": 3,
      "vendorCount": 3,
      "vendors": { "anthropic": ["anthropic/claude-opus-4"] },
      "reason": null
    },
    "settings": {
      "baseBranch": "main",
      "failOn": "high",
      "timeoutSeconds": 600,
      "maxOutputTokens": null,
      "mergeWindow": 10,
      "claimSimilarity": 0.6,
      "includeContextFiles": false,
      "retain": 20
    },
    "suppressions": {
      "path": "/path/to/project/.council/ignore.json",
      "present": true,
      "count": 4
    },
    "runs": {
      "count": 12,
      "last": {
        "id": "20260904T153012123Z",
        "path": "...",
        "reportPath": "...",
        "findingsPath": "..."
      }
    },
    "gitignore": { "excludesReviews": true },
    "herdr": { "detected": false },
    "verified": false
  }
  ```

Run `council-review <subcommand> --help` for a subcommand's own usage, or `council-review --help`
for the full flag surface.

## Exit codes

| Code  | Meaning                                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`   | Clean: nothing at or above the `failOn` threshold                                                                                                                                                                                    |
| `1`   | Findings at or above the `failOn` threshold                                                                                                                                                                                          |
| `2`   | Configuration or usage error                                                                                                                                                                                                         |
| `3`   | Degraded: one or more reviewers timed out, exceeded budget, or failed validation — a partial report was still written. **Outranks `1`**, so a CI job checking for "findings" never mistakes a partial panel for a clean measurement. |
| `4`   | The vendor-independence guard refused the panel; no reviewer was spawned                                                                                                                                                             |
| `130` | Interrupted (SIGINT/SIGTERM)                                                                                                                                                                                                         |

## What a run leaves behind

Every run writes a timestamped directory under `.council/reviews/` (excluded from version control
by an entry `init` adds to `.gitignore` — only the configuration in `.council/config.json` and
`.council/ignore.json` is meant to be committed):

```
.council/reviews/<run-id>/
  manifest.json          reviewed state, resolved scope, panel + vendors + thinking levels,
                          per-reviewer state/timings/usage/cost/depth, overrides in effect
  patch.diff              the diff patch — never inside the snapshot
  findings.json            the merged findings, as a JSON array
  REPORT.md                human-readable report
  HANDOFF.md                a prompt addressed to a coding agent, not a person
  reviewers/<slug>.findings.json | .text.md | .trace.jsonl
.council/reviews/last -> <run-id>   symlink to the most recent run
```

`HANDOFF.md` instructs the consuming agent to reproduce each finding before fixing it, to check a
merged finding against the reviewers' verbatim raw output when its claim is ambiguous, and frames
a low-agreement finding as a hypothesis to test, not an established defect.

## The isolation model and its limits

Three third-party models read your repository's source under this tool. That is a real trust
boundary, and this section describes it plainly rather than reassuringly. See
[`docs/design/council-review-design.md`](./docs/design/council-review-design.md)'s
"Decisions" and "Risks / Trade-offs" sections for the full reasoning; this is the summary a user
needs before relying on it.

**What the isolation actually is**, layered so that no single mistake removes it:

- Every host built-in tool is removed (`-nbt`) — specifically no shell, no file-write, no
  file-edit capability exists for a reviewer to call.
- Resource discovery from the reviewed repository is disabled wholesale: no repo-supplied
  extensions, no skills, no prompt templates, and project trust state grants no extra capability
  — so a repository under review cannot get its own code or instructions loaded into the process
  reviewing it.
- Agent context files (e.g. project-level agent instructions) are **excluded by default**, because
  the host loads them regardless of trust and they are therefore an instruction-injection surface.
  Opt in only via `includeContextFiles` in `.council/config.json`; the choice is recorded in every
  run's manifest.
- A reviewer's entire tool surface is exactly four read-only tools — `council_read`,
  `council_grep`, `council_list`, `council_git` — loaded from one file this package ships, never
  installed into the host. Every path any of them is given is realpath-resolved and rejected if it
  escapes the snapshot root, including via a symlink or an intermediate symlinked directory.
  `council_git` reaches the _real_ repository, but only through a fixed allowlist of read-only
  subcommands (log, show, blame, diff) with structured arguments — never a composed command line.
- Reviewers run against a **frozen snapshot**, not your live worktree: a plain copy into scratch,
  made non-writable (`chmod -R a-w`) before any reviewer launches, so every reviewer reads the same
  photograph and your ongoing edits in the meantime have no effect on the run.
- Removing the shell removes a reviewer's only path to arbitrary network egress. Its only outbound
  traffic is the host's own model API call.
- Host session persistence is disabled (`--no-session`), so a reviewer's transcript — which
  contains your repository's source — is never written into the host's own session store.
- Each reviewer process gets an **allowlisted** environment, not a denylisted one: the executable
  search path, the home directory (so the host can find its own config/credentials), the two roots
  the reviewer tools need, and the host's own `PI_*` variables. Every other variable from the
  invoking environment is dropped, so no unrelated secret — including credentials for other
  services — ever reaches a reviewer process.
- No code path in this package ever opens the host's credential store
  (`~/.pi/agent/auth.json`). No artifact this tool writes can contain a token, key or secret.

**What it is not:**

- **Not container or VM isolation.** There is no sandbox boundary beyond what's described above.
  This is a deliberate v1 choice (see the design doc's "Decisions"), not an oversight, and a stronger
  implementation can be added later without changing what this tool guarantees observably.
- **`chmod -R a-w` on the snapshot is not a security boundary against a process running as the
  same user.** A same-user process can `chmod` its way back to writable. Freezing the tree exists
  for _consistency_ — so line numbers mean the same thing to every reviewer and to the merge step
  — not as the source of the read-only guarantee. That guarantee comes entirely from the absence
  of a write tool in the reviewer's callable surface.
- **POSIX-only.** The freeze step and the path-containment logic assume POSIX permission and
  symlink semantics. This has not been tested, and is not expected to work, on a non-POSIX
  filesystem.
- **Verified empirically against one pinned host version.** The whole guarantee rests on flags and
  an event-stream shape belonging to the `pi` binary, which this package does not control. See
  [`HOST-VERSION.md`](./HOST-VERSION.md) for exactly what was verified and how, and re-verify
  after any host upgrade before trusting the isolation guarantee against the new version.
- **A provider whose API key exists only as a shell environment variable will not authenticate
  inside a reviewer.** The environment allowlist above is intentionally tight and does not pass
  through any `*_API_KEY`-shaped variable — this was a deliberate, verified decision (a scrubbed
  environment containing only `PATH`/`HOME` was confirmed to authenticate correctly for providers
  whose credentials live in the host's own store), not an oversight. A provider only ever
  authenticates inside a reviewer through the host's own credential store under `HOME`. **Remedy:**
  authenticate that provider through the host itself (e.g. `pi auth login`) so its credential is
  saved into the host's store, rather than relying on an environment variable your shell happens
  to export. If a provider's credential exists only as a shell variable and was never run through
  the host's own auth flow, reviewers using that provider will fail to authenticate — this is the
  environment allowlist working as designed, not a bug to route around by widening it.
- **Third-party models read your repository's source.** That is the whole premise of this tool.
  Nothing above prevents a model provider from seeing your code as part of serving the review
  request; it only prevents that model, or the repository it's reviewing, from writing anything,
  executing anything, or reaching the network on its own.

### The `pi` host dependency

`council-review` spawns the `pi` coding-agent CLI (npm package `@earendil-works/pi-coding-agent`)
headlessly per reviewer rather than calling each vendor's API directly, so it can reuse the
authentication, model catalog and agentic tool loop you already have configured for it. `pi`
declares `engines: { node: ">=22.19.0" }`, so that version — not `council-review`'s own `>=20`
floor — is what actually determines whether a review can run. See
[`HOST-VERSION.md`](./HOST-VERSION.md) for the exact verified version and the re-verification
procedure after a host upgrade.

## Configuration reference (`.council/config.json`)

Written by `init`, hand-editable afterward. An unrecognised `version` is a hard error, so a future
schema change has a defined migration point.

| Key                    | Meaning                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `version`              | Config schema version                                                                              |
| `baseBranch`           | Default base branch for scope resolution                                                           |
| `panel`                | Ordered list of `{ provider, model, thinking? }`                                                   |
| `defaultThinkingLevel` | Fallback thinking level when nothing more specific applies                                         |
| `modelThinkingLevels`  | Per-model thinking level, keyed `"provider/modelId"` — what the picker actually writes             |
| `includeContextFiles`  | Opt into loading agent context files into reviewers (default: excluded)                            |
| `timeoutSeconds`       | Per-reviewer wall-clock timeout                                                                    |
| `maxOutputTokens`      | Per-reviewer output-token ceiling (default: none — reviewers are bounded by `timeoutSeconds` only) |
| `mergeWindow`          | Line-proximity window for clustering findings                                                      |
| `claimSimilarity`      | Claim-token-similarity threshold for clustering                                                    |
| `failOn`               | Default severity threshold for exit code `1` (`critical`\|`high`\|`medium`\|`low`\|`none`)         |
| `snapshot.include`     | Path globs narrowing what's copied into the snapshot (large repos)                                 |
| `vendorOverrides`      | Exact `"provider/modelId"` → vendor overrides for vendor derivation                                |
| `retain`               | Default number of runs `gc` keeps                                                                  |

`.council/ignore.json` holds suppressed findings by fingerprint (stable across line movement —
see the design doc's fingerprinting rationale), each optionally carrying a human-supplied `reason`.
Managed through `council-review ignore`, not normally hand-edited.

## License

MIT
