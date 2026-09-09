# council-review — design

Date: 2026-09-03
Status: approved for planning

## Purpose

Get three or more genuinely independent code reviews of the work in a git
worktree, each from a different model vendor, and emit a structured report a
coding agent can verify and act on.

The tool runs Pi headless once per reviewer. Reviewers are strictly read-only.
Nothing in the report is filtered by a model — merging is done in code.

## Constraints

- Reviewers must be deterministically read-only. Not "instructed to be" —
  incapable of writing.
- Reviewers must not see each other's output. Independence is the product.
- Output must be machine-readable and traceable back to which model said what.
- Must run in a herdr pane beside a coding agent, and must also work in a plain
  shell and in CI.
- No git worktrees are created by this tool. An ephemeral review snapshot that
  exists for seconds should not enter a managed worktree lifecycle, so the
  design copies into scratch instead of running `git worktree add`.

## Shape

TypeScript, Node >= 22.19.0, one npm package, one binary: `council-review`.

Install once with `npm i -g council-review`. Load into a project with
`council-review init`, which runs the picker and writes:

- `.council/config.json` — panel, thinking levels, scope defaults, budgets. Committed.
- `.council/ignore.json` — suppressed findings. Committed.
- `.gitignore` += `.council/reviews/` — reports are not committed.

Deliberately not a Pi package. The only thing Pi must load is the reviewer
toolset, passed as `-e <path-inside-this-package>` at spawn time. No
`pi install`, no global Pi state to keep in sync.

## Modules

Each unit has one purpose and is testable alone.

| Module | Responsibility |
|---|---|
| `cli.ts` | Argument parsing, subcommand dispatch, exit codes |
| `config.ts` | Load, validate and write `.council/config.json` and `ignore.json` |
| `providers.ts` | Enumerate Pi providers and models; readiness; vendor mapping |
| `thinking.ts` | Supported-level computation, precedence resolution, clamping |
| `picker.ts` | Three-stage interactive selection; vendor-independence guard |
| `scope.ts` | Resolve review target to a single diff patch and file set |
| `snapshot.ts` | Build and freeze the review root; clean up |
| `runner.ts` | Spawn N Pi processes, parse the JSON event stream, timeouts |
| `schema.ts` | Findings schema, validation, one repair retry |
| `merge.ts` | Fingerprints, clustering, agreement scoring, suppression |
| `resolve.ts` | `--since` diffing against a previous run |
| `report.ts` | Write manifest, raw, findings, REPORT.md, HANDOFF.md |
| `herdr.ts` | Pane split/run, title, notification, agent handoff |
| `reviewer-tools.ts` | The Pi extension loaded into each reviewer. Security-critical. |

`reviewer-tools.ts` ships built to `dist/reviewer-tools.js` and is never
imported by the CLI process — it only ever runs inside a reviewer's Pi process.

## Isolation model

The read-only guarantee is layered so that no single mistake removes it.

| Layer | Mechanism |
|---|---|
| Tool surface | `-nbt` removes every Pi built-in. Only `council_read`, `council_grep`, `council_list`, `council_git`, `council_codegraph` exist. |
| Repo resources | `-ne -ns -np -na` — no extension discovery, no skills, no prompt templates, no project trust. A reviewed repo cannot get its own `.pi/extensions` executed. |
| Injection surface | `-nc` drops `AGENTS.md`/`CLAUDE.md`, which Pi loads regardless of trust. Opt back in with config `includeContextFiles: true`. |
| Filesystem | Reviewers run in a frozen snapshot, `chmod -R a-w`. Every tool path is realpath-resolved and rejected if it escapes the snapshot root, symlinks included. Exception: the per-run `.codegraph/` index dir stays writable (SQLite needs write access even for reads — see "Review root"); reviewers still have no write tool. |
| Network | Removing `bash` removes the reviewers' only egress path. This matters: three third-party models are reading source. |
| Writes | Reviewers return text on stdout. Only the runner writes files. |
| Sessions | `--no-session` keeps reviewer transcripts out of `~/.pi/agent/sessions`. |

Verified empirically against Pi 0.84.4: with `-ne -nbt -e <ext>`, a reviewer's
only callable tool is the one the extension registered. `bash`, `write` and
`edit` are absent. `multi_tool_use.parallel` may appear on OpenAI-family
providers; it is a provider-side envelope that can only wrap registered tools
and adds no capability.

Pi's own security doc states there is no built-in sandbox and that real
isolation must come from the OS. This design therefore relies on capability
removal, not on instructions to the model.

## Review root — frozen photograph

At t=0 the runner builds a snapshot in scratch and runs `chmod -R a-w` on it.

Before the freeze, the CLI builds a CodeGraph index of the snapshot
(`codegraph init <snap>`, unless config `codegraph.enabled` is false), so the
index covers exactly the tree reviewers read and symbol positions match the
frozen files. After the freeze, write bits are restored on `<snap>/.codegraph`
only: the SQLite index requires write access even for reads — verified by probe
(2026-09-09, real binary), where `query`/`explore` on a fully frozen tree fail
with `attempt to write a readonly database` (exit 1). Index files never enter
the file list or tree hash, and reviewers still have no write tool (the new
`council_codegraph` tool runs a read-only subcommand allowlist), so the
read-only guarantee is unchanged; freezing was never a same-user security
boundary. Indexing never fails a run: a missing, slow, or broken binary degrades
to grep/read, and the manifest records `codegraph: { available, reason? }`.

The snapshot must depict the state the reviewed diff *ends at*, so its source
follows the scope. Three builders, one selected per run:

| Scope | Snapshot source |
|---|---|
| default (worktree work) | copy of `git ls-files --cached --others --exclude-standard -z` |
| `--staged` | `git checkout-index -a --prefix=<snap>/` — the index exactly |
| `--range A..B`, `--rev` | `git archive <B> \| tar -x -C <snap>` |

Reviewing a historical range against the current worktree would show reviewers
code that has since moved, so this mapping is a correctness requirement, not a
convenience.

For the default scope, that set is exactly "everything worth reviewing":
tracked files plus untracked files that are not gitignored, so a brand-new
unstaged file is reviewed, while `node_modules` and `.env` are excluded by
construction rather than by a deny rule the tools must remember to apply.

Consequences:

- Reviewers see one immutable tree fixed at t=0. On the default scope that is
  the working tree as it was when the run started, so the coding agent in the
  adjacent pane can keep editing with no effect on the run.
- Line numbers in findings stay valid relative to a single tree, so the merge
  step's line-proximity clustering compares like with like.
- The manifest records HEAD sha, dirty flag, and a tree-hash (sha256 over
  sorted path + blob-hash pairs), giving `--since` a real anchor.

History still reaches reviewers: `council_git` shells out from tool code as
`git -C <real repo> <subcommand>` with an allowlist of `log`, `show`, `blame`,
`diff`. The model never composes a git command line.

Cleanup restores write bits and removes the directory on exit; `council-review
gc` sweeps orphans. For a monorepo where copying the whole tracked tree is too
slow, `--paths` and config `snapshot.include` narrow the copy.

## Scope

Default scope is the work in this worktree: `merge-base(HEAD, baseBranch)` to
the current on-disk state, folding committed, staged, unstaged and
untracked-new changes into one patch. This matches one-worktree-per-feature.

Overrides: `--staged`, `--range A..B`, `--paths <glob>...`, `--base <branch>`.

The patch is written to the run directory, not into the snapshot, so the
snapshot stays an exact copy of the source tree. Reviewers receive it as
`@<rundir>/diff.patch`.

## Discovery

`providers.ts` reads `~/.pi/agent/models-store.json` for the catalog, which
gives per model: `id`, `name`, `provider`, `contextWindow`, `maxTokens`,
`cost`, `reasoning`, `thinkingLevelMap`, `api`, `baseUrl`. Readiness comes from
`pi auth check --provider <p> --json`, which returns
`{"status":"ready","provider":...,"authType":...}` and contains no credential.

`~/.pi/agent/auth.json` is never read. It holds live OAuth access and refresh
tokens. No code path in this tool opens it, and no credential is ever logged,
printed, or written to a report.

Fallback if the store is missing: parse `pi --list-models`, invoked with
`--no-extensions` so extension banner lines do not corrupt the table.

### Vendor mapping

Pi's `provider` is the gateway, not the vendor. Three picks through OpenRouter
can be three Anthropic models — correlated failure modes at triple the price.

Vendor is derived in this order:

1. `provider/model` exact match in config `vendorOverrides`.
2. For gateway providers whose ids are `vendor/model` (OpenRouter), the leading
   segment, after stripping a `~` prefix.
3. A shipped prefix table for flat-id gateways (`kimi-*` → moonshot,
   `glm-*` → z-ai, `deepseek-*` → deepseek, `qwen*` → alibaba,
   `grok-*` → x-ai, `gpt-*` → openai, `minimax-*` → minimax, and so on).
4. Otherwise `unknown`, which counts as its own distinct vendor and is flagged
   in the picker and the manifest.

### Vendor-independence guard

At the end of selection and again immediately before launch, the panel must
contain at least 3 models resolving to at least 3 distinct vendors. Otherwise
the run refuses with exit 4 and prints the collapsed grouping.
`--allow-correlated` overrides both the vendor count and the 3-model minimum,
and the manifest records that it was used.

## Picker

404 models are visible on the reference machine, so selection is staged:

1. **Providers** — the ready providers, annotated with auth type and model count.
2. **Models** — scoped to the chosen providers, showing vendor, context window
   and input/output $/Mtok from the catalog. Multi-select; `continue` to move on.
3. **Thinking level** — per selected model, offering only the levels that model
   supports. Non-reasoning models are shown as "no thinking" and skipped.

The result saves to config as the project's panel, so `init` is normally the
only time the picker appears. `--pick` reopens it; `--models` bypasses it.

## Thinking level

Pi's levels, in order: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

Support is computed per model from `reasoning` and the tristate
`thinkingLevelMap`:

- `reasoning` falsy → thinking not applicable; the `--thinking` flag is omitted.
- map value is a string → level supported.
- map value is `null` → level unsupported.
- key absent, or whole map absent → `off` through `high` are supported via the
  provider's default mapping; `xhigh` and `max` are unsupported.

A model may set `off: null`, meaning thinking cannot be disabled.

*Assumption to verify during implementation:* that the absent-key rule applies
per key within a partially specified map, and not only to a wholly absent map.
The docs describe holes as legal but state the fallback only for the
whole-map case. A smoke test against a model with a partial map settles it.

### Surfaces

- `--thinking <level>` — panel-wide.
- Per-model pin inside `--models`, using Pi's own grammar
  `provider/modelId[:thinking]`, e.g.
  `--models 'openai-codex/gpt-5.6-sol:xhigh,openrouter/anthropic/claude-opus-latest:high'`.
  Parsing splits on the **last** colon; OpenRouter ids contain `/` and may
  carry a `~` prefix. Globs are accepted and expanded against the catalog.
- Config, reusing Pi's exact key names: `defaultThinkingLevel` and
  `modelThinkingLevels` keyed `"provider/modelId"`.

### Precedence

Most specific first:

1. CLI per-model `:level`
2. CLI `--thinking`
3. config `modelThinkingLevels["provider/modelId"]`
4. config `defaultThinkingLevel`
5. flag omitted — the user's Pi `defaultThinkingLevel` applies

If a resolved level is unsupported for that model, clamp to the nearest
supported level by ordinal distance, preferring downward on a tie. Both
`requested` and `effective` are recorded per reviewer in the manifest, so a
shallow review is explainable.

`thinkingBudgets` is a Pi-level setting and is never overridden here.

## Runner

Each reviewer is spawned in parallel with cwd set to the snapshot:

```
pi -p --mode json \
   -ne -nbt -ns -np -nc -na --no-session \
   -e <pkg>/dist/reviewer-tools.js \
   --provider <provider> --model <modelId> [--thinking <effective>] \
   --system-prompt <reviewer prompt> \
   @<rundir>/diff.patch  "<task>"
```

Environment is passed through an allowlist: `PATH`, `HOME`, `PI_*`. `HOME` is
required for Pi to find credentials. Everything else is dropped so no stray
token enters a reviewer process.

From the JSON stream the runner keeps:

- the final assistant text, from the last `message_end` / `agent_end`;
- cumulative `usage`, converted to cost using the catalog's `cost` rates;
- every `tool_execution_end`, which yields **which files the reviewer actually
  opened and how many greps it ran**. This review-depth signal goes in the
  manifest, so a reviewer that never opened a file is visibly not equal to one
  that read twelve.

Per-reviewer timeout (default 600s) and an output-token ceiling. Breaching
either marks that reviewer `timeout` or `over-budget`; the run continues and
the report is marked degraded.

Progress is one line per reviewer with state, elapsed and tokens; non-TTY
output degrades to plain appended lines.

## Findings contract

Each reviewer emits a single fenced JSON block validated against a typebox
schema. Per finding: `file`, `line`, `endLine?`, `severity`
(`critical|high|medium|low`), `category`, `claim`, `failure`, `evidence?`,
`suggestion?`, `confidence?`.

Invalid output gets exactly one repair retry with the validation errors
appended to the conversation. Still invalid and the reviewer is marked
`failed`, with its verbatim text preserved in `raw/*.txt`. Nothing is discarded.

## Merge

Fingerprint: `sha256(normalizedPath + "\0" + normalizeClaim(claim))`, where
normalization lowercases, strips punctuation and collapses whitespace and
stopwords. Stable across line moves, which is what lets suppression survive a
refactor.

Clustering is union-find within a file. Two findings merge when all three hold:

1. line ranges overlap or lie within `mergeWindow` (default 8) lines;
2. categories are equal;
3. claim token Jaccard similarity >= `claimSimilarity` (default 0.45).

Condition 3 is what prevents two unrelated findings on the same line from
collapsing into one.

This is a heuristic, and the design treats it as one: `raw/` is kept verbatim,
and every merged finding lists the source finding ids it was built from, so the
consuming agent can always check the merge.

Merged finding fields: `id`, `file`, `line`, `severity` (max of members),
`severities` (per model), `category`, `claim`, `failure`, `raised_by`,
`agreement`, `of`, `evidence[]`, `sources[]`, `fingerprint`.

`of` is the number of reviewers that returned schema-valid findings, not the
number launched. A panel of three where one timed out yields `of: 2`, so an
agreement score is never silently deflated by a reviewer that never reported.
The manifest carries the launched-versus-reported counts.

Sort by agreement desc, severity desc, path asc, line asc. Ids `F01…` are
assigned after sorting so they are stable for a given input.

Suppression: a cluster is dropped if its fingerprint, or any member's, matches
`.council/ignore.json`. The count appears in the report footer.
`--no-suppress` disables it for one run.

## Resolution tracking

`--since last|<run-id>` loads the prior `findings.json` and matches by
fingerprint:

- present before, absent now → `resolved`
- present before and now → `still-present`
- absent before, present now → `new`

Each finding carries a `resolution` field and the report leads with a summary
line. This is what turns the council into a fix-then-recheck loop.

## Outputs

```
.council/reviews/2026-09-03-142211/
  manifest.json     commit, tree-hash, scope, models, vendors, thinking
                    (requested/effective), timings, usage, cost, review depth
  diff.patch
  raw/openai-codex__gpt-5.6-sol.json          parsed findings
  raw/openai-codex__gpt-5.6-sol.txt           verbatim final text
  raw/openai-codex__gpt-5.6-sol.trace.json    tool calls and usage
  raw/openrouter__anthropic-claude-opus.{json,txt,trace.json}
  raw/opencode-go__kimi-k3.{json,txt,trace.json}
  findings.json     merged, agreement-scored, suppressions applied
  REPORT.md         human view for the pane
  HANDOFF.md        prompt keyed to findings.json
.council/reviews/last -> 2026-09-03-142211
```

Provider and model are slugified for filenames; `/` becomes `-`.

`REPORT.md` leads with the panel (model, vendor, effective thinking level,
cost, review depth), then findings ordered by agreement, then the suppressed
and degraded counts. `HANDOFF.md` is a prompt addressed to a coding agent: the
run directory path, the rule that no finding is to be fixed before it is
reproduced, the instruction to check merged findings against `raw/` when the
claim is ambiguous, and the note that a low-agreement finding is a hypothesis
rather than a defect. `--json` writes `findings.json` to stdout instead of
printing the report path, for CI and for piping.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Completed, nothing at or above `failOn` |
| 1 | Findings at or above `failOn` |
| 2 | Config or usage error |
| 3 | One or more reviewers failed; partial report written |
| 4 | Vendor-independence guard refused the panel |

## herdr integration

Active only when `HERDR_ENV=1`; otherwise every call below is a no-op with one
printed notice, and the tool works normally in a plain shell and in CI.

- `--pane [right|down]` reads `$HERDR_PANE_ID`, runs
  `herdr pane split --current --direction <dir> --cwd "$PWD" --no-focus`, takes
  the new id from `.result.pane.pane_id`, then
  `herdr pane run <id> council-review --no-pane …`, and titles it with
  `herdr pane report-metadata --title "council · N models"`. Focus stays where
  the user left it.
- On completion, `herdr notification show` unless `--no-notify`.
- `--handoff <agent>` writes HANDOFF.md, then `herdr agent prompt <agent>` with
  a prompt naming `findings.json` and instructing the agent to reproduce each
  finding before fixing it. Delivery is not awaited.

## Config

`.council/config.json`:

```json
{
  "version": 1,
  "baseBranch": "main",
  "panel": [
    { "provider": "openai-codex", "model": "gpt-5.6-sol" },
    { "provider": "openrouter", "model": "anthropic/claude-opus-latest" },
    { "provider": "opencode-go", "model": "kimi-k3" }
  ],
  "defaultThinkingLevel": "high",
  "modelThinkingLevels": {
    "openai-codex/gpt-5.6-sol": "xhigh"
  },
  "includeContextFiles": false,
  "timeoutSeconds": 600,
  "maxOutputTokens": 32000,
  "mergeWindow": 8,
  "claimSimilarity": 0.45,
  "failOn": "none",
  "snapshot": { "include": [] },
  "codegraph": { "enabled": true, "indexTimeoutSeconds": 300 },
  "vendorOverrides": {}
}
```

## CLI surface

```
council-review [scope] [panel] [run] [herdr]
council-review init [--pick]
council-review models
council-review show [<run-id>|last]
council-review ignore <finding-id> [--reason <text>] [--run <run-id>]
council-review gc [--keep <n>]

Scope   --staged  --range <A..B>  --paths <glob>...  --base <branch>
Panel   --models <spec>[,…]  --pick  --thinking <level>  --allow-correlated
Run     --timeout <s>  --max-tokens <n>  --since <last|run-id>
        --fail-on <severity|none>  --no-suppress  --json
herdr   --pane [right|down]  --no-pane  --handoff <agent>  --no-notify
```

## Testing

- **Fake `pi`.** A stub binary replaying recorded `--mode json` streams. Covers
  fan-out, stream parsing, usage accounting, depth extraction, timeout,
  malformed-JSON repair and reviewer failure with zero model calls. This is the
  backbone of the runner tests.
- **Unit.** Thinking-level support computation and clamping against real
  catalog fixtures; precedence resolution; `provider/id:level` parsing
  including OpenRouter slashes and `~` prefixes; fingerprint stability under
  line moves; clustering on fixture findings, including the negative case of
  two unrelated findings on one line; suppression matching; resolution
  diffing; vendor mapping and the independence guard; scope resolution and
  snapshot building against temp git repos.
- **Security.** Path-escape rejection in all four reviewer tools: `..`
  traversal, absolute paths, and symlinks pointing out of the snapshot. Plus a
  test asserting the spawn argv contains `-nbt` and no path that would
  re-enable a built-in.
- **Live smoke.** One opt-in test behind `COUNCIL_LIVE=1` running a single
  cheap model end to end, plus the partial-`thinkingLevelMap` check noted above.

## Out of scope

- No synthesis model. Merging is deterministic code; a model pass would
  reintroduce one model's judgement as a filter over the panel.
- No tiered cheap-then-deep review. Reviewers are agentic from the start.
- No container isolation in v1. Capability removal plus a frozen snapshot is
  the boundary; a Docker mode can be added later without changing the contract.
- No PR ingestion. Scope is local git state.
