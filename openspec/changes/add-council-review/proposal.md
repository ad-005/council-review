## Why

A single model reviewing code has blind spots that correlate with its own training, and a coding agent reviewing its own work shares the author's priors exactly. The only way to break that correlation is to ask several genuinely independent models — different vendors, not different gateways — and to merge their verdicts in code rather than through a model that would reintroduce one judgement as a filter over the panel.

Nothing today does this: existing review tooling is single-model, trusts the reviewer with write access to the repository it is reviewing, and emits prose that an agent cannot verify claim by claim. This change introduces `council-review`, a CLI that runs a read-only, multi-vendor review panel over the work in a git worktree and emits a structured, traceable report a coding agent can act on. The approved design lives at `docs/superpowers/specs/2026-09-03-council-review-design.md`.

## What Changes

- **New npm package and binary.** A TypeScript package (Node >= 20) publishing one binary, `council-review`, installed globally and loaded into a project with `council-review init`.
- **Project-local configuration.** `init` runs an interactive picker and writes committed `.council/config.json` (panel, thinking levels, scope defaults, budgets) and `.council/ignore.json` (suppressed findings), and appends `.council/reviews/` to `.gitignore`.
- **Model discovery over the Pi catalog.** Providers and models are enumerated from `~/.pi/agent/models-store.json` with readiness from `pi auth check --json`, and a vendor is derived per model so that three picks through one gateway cannot silently be three models from the same vendor. `~/.pi/agent/auth.json` is never opened by any code path.
- **A vendor-independence guard.** A run refuses unless the panel holds at least three models resolving to at least three distinct vendors, overridable only by an explicit `--allow-correlated` that is recorded in the manifest.
- **Thinking-level resolution.** Per-model supported levels are computed from the catalog's `reasoning` flag and tristate `thinkingLevelMap`; a five-tier precedence chain resolves a requested level and clamps it to the nearest supported one, recording both `requested` and `effective`.
- **Scope resolution into a single patch.** Default scope is the whole of this worktree's work — `merge-base(HEAD, baseBranch)` through the current on-disk state, folding committed, staged, unstaged and untracked-new changes into one patch — with `--staged`, `--range`, `--paths` and `--base` overrides.
- **A frozen review snapshot.** Every run builds an immutable, `chmod -R a-w` snapshot in scratch whose source follows the scope, so reviewers see one photograph fixed at t=0 while the coding agent in the adjacent pane keeps editing. No git worktree is created: the user's global instruction that all worktree checkouts be herdr-managed means an ephemeral review tree must not consume that lifecycle.
- **Deterministically read-only reviewers.** Reviewers are *incapable* of writing, not instructed not to: every Pi built-in is removed (`-nbt`), repo-supplied extensions, skills, prompts, trust and context files are disabled, and the only tools that exist are four `council_*` read tools whose every path is realpath-checked against the snapshot root. Removing `bash` also removes the reviewers' only network egress — which matters when three third-party models are reading source.
- **A parallel runner with a machine-readable contract.** N Pi processes are spawned in parallel under an environment allowlist; the JSON event stream yields the final text, cumulative usage converted to cost, and every tool call — giving a per-reviewer *review-depth* signal, so a reviewer that never opened a file is visibly not equal to one that read twelve. Findings are validated against a schema with exactly one repair retry; a reviewer that still fails is marked `failed` and its verbatim text is preserved.
- **Deterministic merge, not synthesis.** Findings are fingerprinted, clustered per file by union-find under line-proximity, category equality and claim similarity, scored by agreement over the reviewers that actually *reported*, and filtered against the ignore list. Every merged finding lists the source findings it was built from so the merge itself can be audited.
- **Resolution tracking.** `--since last|<run-id>` diffs a run against a previous one by fingerprint, marking each finding `resolved`, `still-present` or `new` — turning the panel into a fix-then-recheck loop.
- **Traceable outputs.** A timestamped run directory holds the manifest, the patch, per-reviewer raw findings/text/trace, the merged `findings.json`, a human `REPORT.md` and a `HANDOFF.md` prompt addressed to a coding agent; distinct exit codes separate "findings at or above threshold" from "a reviewer failed" and from "the guard refused the panel".
- **Optional herdr integration.** Active only under `HERDR_ENV=1`: pane split and titling, completion notification, and `--handoff <agent>` to hand `findings.json` to a coding agent. Every call degrades to a no-op with one printed notice so the tool works unchanged in a plain shell and in CI.

Nothing is being removed or altered — the repository currently contains only the design document — so there are no breaking changes.

## Capabilities

### New Capabilities

- `council-review/cli`: The `council-review` binary surface — subcommand dispatch, flag parsing, `init` and project bootstrap, the `.council/config.json` and `.council/ignore.json` contracts, and the exit-code taxonomy.
- `council-review/model-discovery`: Enumerating Pi providers and models from the catalog, provider readiness, credential non-access, the fallback catalog path, vendor derivation, and per-model thinking-level support computation.
- `council-review/panel-selection`: Three-stage interactive picking, panel persistence and reuse, non-interactive `--models` specification including per-model thinking pins, thinking-level precedence and clamping, and the vendor-independence guard.
- `council-review/review-target`: Resolving a review target to one diff patch and file set across all scope modes, and building, freezing, cleaning up and garbage-collecting the review snapshot.
- `council-review/reviewer-isolation`: The layered read-only guarantee — Pi capability removal, the four `council_*` reviewer tools, snapshot path containment including symlinks, the allowlisted `council_git` history access, and the process environment allowlist.
- `council-review/review-execution`: Spawning the panel in parallel, parsing the Pi JSON event stream into final text, usage, cost and review depth, per-reviewer timeout and output-token ceilings, progress reporting, and the findings schema with its single repair retry.
- `council-review/findings-merge`: Fingerprinting, per-file clustering, agreement scoring over reporting reviewers, deterministic ordering and id assignment, suppression against the ignore list, and resolution diffing against a previous run.
- `council-review/reporting`: The run-directory layout and manifest contract, `REPORT.md` and `HANDOFF.md` generation, `--json` output, and the `show`, `ignore` and `gc` read/maintenance commands.
- `council-review/herdr-integration`: herdr-gated pane split and titling, completion notification, and agent handoff, each a no-op with one notice outside a herdr environment.

### Modified Capabilities

None — this is the project's first capability set.

## Impact

- **New code.** The whole package: `src/{cli,config,providers,thinking,picker,scope,snapshot,runner,schema,merge,resolve,report,herdr}.ts` plus `src/reviewer-tools.ts`, which ships built to `dist/reviewer-tools.js` and is never imported by the CLI process — it only ever executes inside a reviewer's Pi process.
- **New repository scaffolding.** `package.json` with a `council-review` bin entry, TypeScript config, build and test configuration, and CI.
- **Runtime dependencies on the host.** The `pi` binary (verified against 0.84.4) must be on `PATH` and authenticated; `git` must be on `PATH`; `chmod` semantics assume a POSIX filesystem. `herdr` is optional and only consulted under `HERDR_ENV=1`.
- **Files the tool reads outside the project.** `~/.pi/agent/models-store.json` (read) and `pi auth check` output. `~/.pi/agent/auth.json` is explicitly never read, and no credential is logged, printed or written into a report.
- **Files the tool writes inside the project.** `.council/config.json`, `.council/ignore.json`, `.council/reviews/<run-id>/…`, the `.council/reviews/last` symlink, and one appended line in `.gitignore`.
- **Security surface.** Third-party models read repository source under this tool. The isolation model is a hard requirement of the change, not a quality attribute, and carries its own dedicated test suite.
- **Recorded assumptions.** Tests run under Vitest; the findings schema is expressed with TypeBox (as named in the design); the published package name is `council-review`. The design's open question — whether the absent-key thinking-level fallback applies per key inside a partially specified map — is carried forward as an implementation-time verification task rather than an assumption baked into behaviour.
