# council-review

A read-only, multi-vendor code review panel over local git state.

`council-review` sends the work in your git worktree to several models from **different vendors**
and merges their findings in deterministic code, never through another model. Reviewers cannot
write anything: every host built-in is removed, the repository under review cannot load its own
extensions, skills or context files into the process reviewing it, and a reviewer's whole tool
surface is four read-only tools scoped to a frozen, non-writable copy of your tree. That is not
container or VM isolation, and third-party models do read your source — see
[`HOST-VERSION.md`](./HOST-VERSION.md) and the
[design doc](./docs/design/council-review-design.md) for what was actually verified, and re-verify
after a host upgrade. Every run writes a timestamped directory under `.council/reviews/` holding a
manifest, each reviewer's raw output, the merged findings, a human report (`REPORT.md`) and a
handoff prompt addressed to a coding agent (`HANDOFF.md`).

## Install

```
npm install -g council-review
```

For unreleased changes from `main`, build from a clone:

```
git clone https://github.com/ad-005/council-review
cd council-review
npm install
npm pack
npm install -g ./council-review-*.tgz
```

Installing straight from the git URL is unreliable across npm versions: on the npm bundled with
Node 22 (10.x) `npm install -g github:ad-005/council-review` fails, because npm installs no
dependencies into its temporary clone and the `prepare` build cannot run; npm 12 fixed that but
disables git fetching by default, so it needs `--allow-git=all`. `npx github:ad-005/council-review`
works on npm 10, and needs `--allow-git=all` on npm 12.

Requires the `pi` coding-agent CLI (`@earendil-works/pi-coding-agent`) on `PATH`, authenticated
for at least one provider through `pi`'s own credential store — a key that exists only as a shell
variable never reaches a reviewer, because reviewer processes get a tight environment allowlist.
Both `council-review` and `pi` need Node **>= 22.19.0**.

## Use

```
cd your-project
council-review init      # pick a panel; writes .council/config.json (commit it)
council-review           # review this worktree against its base branch
```

A bare `council-review` reviews the whole divergence from the base branch — committed, staged,
unstaged and untracked changes folded into one patch — not just the index; narrow it with
`--staged`, `--range`, `--revision`, `--paths` or `--base`. A panel is admitted only with at least
three models resolving to at least three distinct vendors, checked when it is saved and again
before every launch, so a hand-edited config is checked too (`--allow-correlated` waives it). The
other subcommands are `models`, `status` (a millisecond, no-model check of whether a review can run
here at all — the intended entry point for a coding agent), `show`, `ignore` and `gc`; run
`council-review --help` for the full flag surface, and see the design doc for every
`.council/config.json` key.

## Exit codes

| Code  | Meaning                                                                     |
| ----- | --------------------------------------------------------------------------- |
| `0`   | Clean: nothing at or above the `failOn` threshold                           |
| `1`   | Findings at or above the threshold                                          |
| `2`   | Configuration or usage error                                                |
| `3`   | Degraded: a reviewer failed and a partial report was written. Outranks `1`. |
| `4`   | The vendor-independence guard refused the panel; nothing was spawned        |
| `130` | Interrupted (SIGINT/SIGTERM)                                                |

## License

MIT
