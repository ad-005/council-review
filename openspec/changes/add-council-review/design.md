## Context

See `proposal.md` — Why for motivation, and `docs/superpowers/specs/2026-09-03-council-review-design.md` for the approved design this elaborates. Requirements live in `specs/council-review/*/spec.md`; this document explains how they are met and why the chosen mechanisms were preferred to the alternatives.

Three constraints shape everything below.

**The reviewers are third-party models reading source.** Three vendors' models are given a repository to read. The isolation model is therefore load-bearing, not a quality attribute — a defect there is a data-exfiltration bug, not a rough edge.

**The review agent host provides no sandbox.** The host's own security documentation states there is no built-in sandbox and that real isolation must come from the OS. So the guarantee cannot be "the reviewer was told not to write". It has to be capability removal, verified empirically against a pinned host version.

**Worktree lifecycle is not ours to consume.** The user's global instruction requires every worktree checkout to be herdr-managed. An ephemeral review tree that exists for ninety seconds must not enter that lifecycle, which rules out `git worktree add` as the mechanism for materialising a review target.

Empirical baseline: verified against host version 0.84.4. With extension discovery disabled, built-in tools removed, and one extension loaded by path, a reviewer's only callable tool is the one that extension registered — no shell, no write, no edit. A provider-side parallel-invocation envelope may additionally appear on OpenAI-family providers; it can only wrap registered tools and therefore adds no capability.

## Goals / Non-Goals

**Goals:**

- A read-only guarantee that survives one mistake, because it is layered across the tool surface, resource discovery, the filesystem, the network path and the process environment.
- Reviewer independence that is structural rather than promised: separate processes, no shared state, no reviewer ever shown another's output.
- A merge step that is auditable end to end — every merged finding traceable to the verbatim text that produced it.
- Determinism where it is cheap: identical input yields identical merged output, identical finding identifiers, identical ordering.
- Testability without model calls. The runner, merge, scope, snapshot, thinking and vendor logic must all be exercisable at zero cost and in CI.
- One binary that behaves identically in a herdr pane, a plain shell and a CI job.

**Non-Goals:**

- Container or VM isolation in this change. Capability removal plus a frozen snapshot is the v1 boundary; see Decisions for why a container mode can be added later without changing any spec.
- Cross-platform support beyond POSIX filesystems. The freeze step and path-containment tests assume POSIX permission and symlink semantics.
- Any model in the merge path, now or later. This is a product decision, not a staging decision.
- Reviewing anything that is not local git state — no pull-request ingestion, no remote fetching.
- Tiered review, where a cheap model triages before a deep one reviews. Reviewers are agentic from the start.

## Decisions

### Spawn the host CLI headless per reviewer, rather than calling vendor APIs directly

Each reviewer is one headless host process emitting a structured event stream. The alternative — calling each vendor's SDK directly — was rejected because it would mean reimplementing authentication for every gateway the user already has configured, reimplementing the agentic tool loop, and maintaining a model catalog with context windows and price rates. The host already owns all three, and its catalog is the same one the user picks models from interactively.

The cost of this decision is a hard dependency on one external CLI's flag surface and stream format. That is mitigated, not avoided: the pinned verified version is recorded, the spawn argument vector is asserted in tests, and a fake host binary replaying recorded streams is the backbone of the runner test suite.

### Pass the reviewer toolset by path at spawn; never install it into the host

The reviewer extension is shipped inside this package and handed to each reviewer process as a path. The alternative — installing it as a host package — was rejected because it creates global state that must be kept in version-sync with the CLI, adds an install step to onboarding, and would leave a stale extension behind on uninstall. Passing a path makes the toolset a function of the installed binary, which is exactly what the read-only guarantee should depend on.

The extension module is built to its own output file and is **never** imported by the CLI process. Keeping that separation structural, rather than by convention, means the security-critical code has one execution context and one test context.

### Capability removal plus a frozen snapshot, not a container

Isolation is layered:

| Layer | Mechanism |
|---|---|
| Tool surface | Host built-ins removed wholesale; only the four `council_*` tools exist |
| Repo resources | Extension discovery, skills, prompt templates and project trust all disabled, so a reviewed repo cannot get its own code executed by the process reviewing it |
| Injection surface | Agent context files dropped by default, because the host loads them regardless of trust; opt-in via config, recorded in the manifest |
| Filesystem | Reviewers run in a snapshot made non-writable; every tool path is realpath-resolved and rejected if it escapes the root |
| Network | Removing the shell removes the reviewers' only arbitrary-egress path |
| Writes | Reviewers return text on stdout; only the tool's own process writes files |
| Sessions | Host session persistence disabled, so reviewer transcripts containing source are not written to the host's session store |
| Environment | Allowlisted variables only, so no unrelated secret enters a reviewer |

A container was considered and deferred. It would harden the filesystem and network layers but adds a runtime dependency on a container engine, a large image-build cost per run, and a mount story for the snapshot — for a marginal gain over a tree that has no writable path and a process that has no shell. Because the boundary is expressed entirely in the reviewer-isolation spec's observable requirements, a container mode can be added later as a stronger implementation of the same requirements, changing no spec text.

Note honestly what freezing the tree does and does not buy: `chmod a-w` is not a security boundary against a process running as the same user. Its purpose is consistency — one immutable photograph, so line numbers mean the same thing to every reviewer and to the merge step. The read-only *guarantee* comes from the absence of a write tool, not from the permission bits. Both are wanted, for different reasons.

### A copied snapshot, not a git worktree and not the live tree

Reviewing the live worktree was rejected: the coding agent in the adjacent pane keeps editing, so reviewers would disagree about what the file says and reported line numbers would drift out from under the merge step's line-proximity clustering.

A `git worktree` was rejected for the lifecycle reason in Context, and because it would give reviewers a full `.git` directory — more surface for no benefit.

So: a plain copy into a scratch directory, then freeze. The snapshot source follows the resolved scope, because the snapshot must depict the state the reviewed diff *ends at*:

| Scope | Snapshot source |
|---|---|
| default (worktree work) | copy of the tracked files plus untracked-not-ignored files, as listed by git |
| staged | the index, materialised exactly |
| range or single revision | the tree at the range's end revision |

Reviewing a historical range against the current worktree would show reviewers code that has since moved, so this is a correctness requirement rather than a nicety.

Deriving the default file set from git's own listing of tracked-plus-untracked-not-ignored files is what makes exclusion structural: dependency directories and environment files are absent by construction, rather than by a deny rule the four reviewer tools would each have to remember to apply.

Scratch location is the OS temporary directory, under a fixed name prefix, so the garbage collector can identify orphans left by a run that died before cleanup. Cleanup restores write bits before removal, and is wired to both normal exit and signal paths.

### History reaches reviewers through an allowlist, not through a copied `.git`

The snapshot has no repository metadata, so blame and log would be unavailable. Rather than copy `.git` — expensive, and a large surface — the history tool executes against the *real* repository from tool code, with a fixed allowlist of read-only subcommands and arguments passed as literal argument values. The model supplies structured fields and never composes a command line, so there is no shell-metacharacter path and no way to reach a mutating subcommand.

### Merging is deterministic code, and its heuristics are treated as heuristics

A synthesis model was rejected outright: it would reintroduce one model's judgement as a filter over three independent verdicts, which is the exact failure the tool exists to avoid.

Clustering is union-find within a single file, merging two findings only when line ranges are within the merge window, categories are equal, **and** claim token similarity meets the threshold. The third condition is what stops two unrelated findings on one line from collapsing into one — the conjunction is the whole point, and the negative case is a required test.

Because this is a heuristic, the design refuses to hide it: raw per-reviewer output is kept verbatim, every merged finding lists the source finding identifiers it was built from, and both tuning constants are configurable. A consumer can always check the merge.

Fingerprints hash the normalised path and the normalised claim, deliberately **excluding** line numbers. That is what lets a suppression survive a refactor that moves the code, and what lets resolution diffing match across two runs of a tree that has changed. The trade-off is accepted and stated: a reviewer that rewords a claim substantially between runs will present as one `resolved` plus one `new` rather than as `still-present`.

Agreement's denominator is the number of reviewers that returned schema-valid findings, not the number launched. A panel of three where one timed out yields agreement out of two. Using the launched count would silently deflate every score in a degraded run, making a two-of-two consensus look like weak evidence.

Identifiers are assigned after sorting, so they are a function of the input rather than of iteration order.

### Vendor is derived, and `unknown` is not treated as benign

The host's provider is a gateway, not a vendor: three picks through one gateway can be three models from the same vendor, which buys correlated blind spots at triple the price. Vendor resolution is a four-step chain — explicit override, then the leading segment of a `vendor/model` gateway id with any prefix marker stripped, then a shipped prefix table for flat-id gateways, then `unknown`.

`unknown` counts as its own distinct vendor rather than being rejected, because refusing unrecognised models would make the tool break every time a gateway adds a model family. It is surfaced during selection and recorded in the manifest, so the user can see that independence rests on an unverified assumption and can pin it with an override. `vendorOverrides` is the single user-facing extension point; the shipped prefix table is not user-editable, so there is one place to look.

The guard is evaluated twice — after selection and again immediately before launch — because a panel can reach configuration by hand-editing, never having passed through the picker.

### Thinking levels are clamped, not rejected

A requested level that a model does not support clamps to the nearest supported level by ordinal distance, preferring downward on a tie, and the run proceeds. Failing instead was rejected because the panel is heterogeneous by construction: a single panel-wide `--thinking high` would otherwise fail whenever one member's ceiling is lower, which is the common case.

The price of clamping is silent shallowness, so both `requested` and `effective` are recorded per reviewer and any divergence is printed during the run. An unexpectedly thin review is then explainable after the fact rather than mysterious.

Precedence runs most-specific-first — per-model CLI pin, panel-wide CLI flag, configured per-model entry, configured default, then nothing at all. The fifth case matters: omitting the flag entirely is a distinct outcome from sending a level, because it lets the user's own host-level default govern. Configuration reuses the host's exact key names so there is one vocabulary to learn, and the host's thinking-budget settings are never touched.

Command-line entry parsing splits the thinking pin on the **last** colon, because gateway model ids contain slashes and may carry a prefix marker. Naive first-colon splitting corrupts exactly the ids most likely to be used.

### Exit code 3 outranks exit code 1

When a reviewer failed *and* a surviving finding meets the threshold, the run exits 3. A degraded panel must never be reported as a clean measurement against the threshold — a CI job that treats 1 as "real findings" and 0 as "clean" would otherwise silently accept a run where two thirds of the panel never reported.

### Review depth is measured from the event stream

Every tool call is recorded, yielding which files a reviewer opened and how many searches it ran. This is cheap — the data is already in the stream — and it converts an unanswerable question into a visible number: a reviewer that reported three findings without opening a file is not equal to one that read twelve files first, and the report says so.

### Module boundaries

Each unit has one purpose and is testable alone.

| Module | Responsibility |
|---|---|
| `cli.ts` | Argument parsing, subcommand dispatch, exit codes |
| `config.ts` | Load, validate and write the config and ignore files |
| `providers.ts` | Enumerate providers and models; readiness; vendor mapping |
| `thinking.ts` | Supported-level computation, precedence resolution, clamping |
| `picker.ts` | Three-stage interactive selection; vendor-independence guard |
| `scope.ts` | Resolve the review target to one diff patch and file set |
| `snapshot.ts` | Build and freeze the review root; cleanup |
| `runner.ts` | Spawn N reviewer processes, parse the event stream, budgets |
| `schema.ts` | Findings schema, validation, one repair retry |
| `merge.ts` | Fingerprints, clustering, agreement scoring, suppression |
| `resolve.ts` | Diffing against a previous run |
| `report.ts` | Write manifest, raw artifacts, findings, report, handoff |
| `herdr.ts` | Pane split and run, title, notification, agent handoff |
| `reviewer-tools.ts` | The extension loaded into each reviewer. Security-critical. |

Findings validation uses TypeBox, as named in the approved design. Tests run under Vitest.

### Testing strategy: a fake host binary is the backbone

A stub binary replaying recorded event streams covers fan-out, stream parsing, usage accounting, depth extraction, timeout, output-ceiling breach, malformed-output repair and reviewer failure — all with zero model calls, so the runner's behaviour is pinned in CI at no cost.

Around it: unit tests against real catalog fixtures for thinking-level support and clamping, precedence, entry parsing including slashed and prefix-marked ids, fingerprint stability under line movement, clustering including the negative case, suppression, resolution diffing, vendor mapping and the guard, and scope and snapshot construction against temporary git repositories.

The security tests are separate and non-negotiable: path-escape rejection in all four reviewer tools for parent traversal, absolute paths, escaping symlinks and escaping intermediate symlinked directories; refusal of non-allowlisted history subcommands and of argument values that attempt command composition; assertion that the spawn argument vector removes built-ins and contains nothing that would re-enable one; and assertion that the environment allowlist drops an injected foreign secret.

One opt-in live smoke test behind an environment flag runs a single cheap model end to end and settles the partial-map question below.

## Risks / Trade-offs

- **The host CLI's flags or stream format change under us, and the isolation flags silently stop meaning what they meant.** → Pin and record the verified version; assert the spawn argument vector in tests; keep one live smoke test that fails loudly on a flag rename rather than degrading quietly. Treat a host upgrade as requiring re-verification of the tool-surface assertion.
- **A provider-side tool envelope is mistaken for a capability.** → It can only wrap tools this tool registered. The tool-surface assertion enumerates callable tools rather than counting them, so an envelope appearing does not mask a real built-in reappearing.
- **The absent-key thinking-level fallback may not apply per key inside a partially specified map.** The host's documentation describes holes as legal but states the fallback only for the wholly-absent-map case. The specs assert the per-key reading. → A live smoke test against a model with a partial map settles it before release. If the empirical answer contradicts the spec, one scenario in `model-discovery` is amended and clamping absorbs the difference at runtime — no other spec, and no module boundary, is affected.
- **Clustering merges two findings that are genuinely distinct, or splits one that is not.** → Raw output kept verbatim; source identifiers on every merged finding; both constants configurable; the negative case is a required test. The report frames low-agreement findings as hypotheses, and the handoff prompt instructs the consuming agent to reproduce before fixing.
- **Fingerprint matching marks a reworded finding as `resolved` plus `new`.** → Accepted and documented. Line-independent fingerprints are what make suppression survive refactors; that is the more valuable property.
- **The default snapshot copies every untracked-not-ignored file, which in a large or badly-ignored repository is slow or large.** → Path globs and a configured include list narrow the copy, with the invariant that every file in the patch is nonetheless present. A repository that leaves build output untracked and unignored will be slow; that is a repository problem the include list solves.
- **Freezing the tree is not a security boundary against a same-user process.** → Stated plainly above. The guarantee is the absent write tool; the freeze is for consistency and defence in depth.
- **Path containment is a resolve-then-check, which invites time-of-check/time-of-use reasoning.** → Operate on the resolved path rather than re-resolving, and note that the snapshot's non-writability removes the attacker-controlled step that a TOCTOU swap would need.
- **Three third-party models read repository source, and a run costs real money.** → No egress path, no credential access, allowlisted environment, no session persistence. Cost is bounded per reviewer by a timeout and an output ceiling, computed from catalog rates, and reported per reviewer and in total.
- **POSIX-only.** → The freeze step and the containment tests assume POSIX semantics. Non-POSIX support is a non-goal for this change and would need its own change if wanted.
- **Interactive selection cannot run in CI.** → A panel must come from configuration or from the command line there; the failure is an explicit usage error rather than a hang.

## Migration Plan

Greenfield — the repository currently contains only the design document, so there is nothing to migrate and no rollback path beyond not installing the package.

Two sequencing constraints matter for implementation order:

1. Discovery, thinking-level computation and vendor mapping are pure functions over catalog fixtures. They come first, because the picker and the guard are meaningless without them and because they are the cheapest things to get right.
2. The fake host binary lands before the runner. Building the runner against a real host would make its tests expensive and flaky, which is how stream-parsing bugs survive.

Configuration carries an explicit `version`, and an unrecognised version is a hard error rather than a best-effort parse, so a future schema change has a defined migration point.

Release order within the change: pure logic, then scope and snapshot, then the isolation layer with its security tests, then the runner against the fake host, then merge and reporting, then the herdr layer, which is last because everything before it must work identically without herdr present.

## Open Questions

These are deferrable: none of them changes a spec, the chosen approach or the task breakdown.

- The exact wording of the reviewer system prompt and task prompt. It will need tuning against real reviewer output, and tuning it does not change the findings contract the output is validated against.
- Whether the shipped vendor prefix table should be refreshed on a schedule as gateways add model families, or only when a user reports an `unknown`. `vendorOverrides` covers the gap either way.
- Whether the default retention count for run pruning should be higher than the initial choice. Runs are small; this is a comfort setting.
- Whether additional reviewer tools — a symbol-level lookup, for instance — would improve review depth enough to justify enlarging the audited tool surface. Deliberately deferred until the four-tool surface has been used in anger.
