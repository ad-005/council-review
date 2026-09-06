# Contributing

## Setup

```
git clone https://github.com/ad-005/council-review.git
cd council-review
npm install
```

`npm install` runs a `prepare` script that builds the project automatically
(`npm run build`, i.e. `tsc -p tsconfig.json`) — you don't need a separate build step to get a
working `dist/` after cloning.

## Requirements

- Node.js **>= 20** to install, build and run `council-review` itself.
- The `pi` coding-agent CLI (npm package `@earendil-works/pi-coding-agent`) on `PATH`,
  authenticated for at least one provider, to actually run a review. `pi` declares
  `engines: { node: ">=22.19.0" }`, so that version — not `council-review`'s own `>=20` floor — is
  the effective floor for running a review: a Node 20 or 21 install satisfies `council-review`'s
  own guard but leaves every reviewer failing to spawn.

## Checks

All of the following must pass before a change is ready:

```
npm run build     # tsc -p tsconfig.json
npm run lint      # eslint .
npm run format    # prettier --check . (use `npm run format:fix` to auto-fix)
npm test          # vitest run --project unit --project security
```

CI runs these on both Node 20 and Node 22.

## The live test suite — read before running

`npm test` above does **not** run the live suite. A separate command does:

```
npm run test:live   # COUNCIL_LIVE=1 vitest run --project live
```

**This makes real, billable model calls** against whatever credentials the `pi` host on your
machine is authenticated with. It is gated behind the `COUNCIL_LIVE=1` environment variable
specifically so it is never run casually or by accident.

- **Never run it in CI.** It is not part of the standard check list above and must not be added to
  a CI workflow.
- **Never run it just to see it pass.** Each of its test files documents the specific, narrow
  question it settles (see the header comments in `test/live/smoke.test.ts` and
  `test/live/partial-thinking-map.test.ts`) — run it only when that question is actually open
  again, most commonly after a `pi` host upgrade, following the re-verification procedure in
  [`HOST-VERSION.md`](./HOST-VERSION.md).
- **`COUNCIL_PI_BIN`** points `council-review` at a specific `pi` binary instead of whatever is on
  `PATH` or globally installed. Use it to test against a specific host version — e.g. one
  installed into an isolated prefix — without touching your global `pi` install.

## After a `pi` upgrade

Upgrading the `pi` binary on a machine that runs `council-review` requires re-verifying the
isolation guarantee before trusting it against the new version — the guarantee rests on flags and
an event-stream shape belonging to `pi`, which this package does not control. Follow the
re-verification procedure in [`HOST-VERSION.md`](./HOST-VERSION.md), which includes running the
security suite and, deliberately, the live suite once.

## Local tooling that isn't part of the project

`openspec/` and `.claude/` are gitignored local tooling used during development of this repository
itself. They are not part of `council-review` and are not relevant to a contribution.
