import { defineConfig } from 'vitest/config';

// The live project is opt-in: it must never run as a side effect of a bare `vitest run` or of
// CI's unit/security invocations. Gating its `include` glob on the env flag (rather than just
// relying on callers to pass `--project live`) means a bare, project-less `vitest run` still
// collects zero live tests unless COUNCIL_LIVE=1 is set.
const liveEnabled = process.env.COUNCIL_LIVE === '1';

// Several suites (scope.test.ts, providers.test.ts, and others) build real temporary git
// repositories and shell out to real `git`/host-stub subprocesses rather than mocking them —
// that's real, honest subprocess overhead, not a defect. Vitest's 5000ms default is tuned for
// in-process unit tests and starts intermittently timing out that kind of test under contention
// (a loaded CI runner or dev machine), even though every one of them passes comfortably in
// isolation. 30s gives real subprocess work honest headroom without masking an actual hang — a
// test that genuinely never resolves still fails, just not at the mercy of whatever else the
// machine happens to be doing. A test that needs more than this (e.g. herdr.test.ts's explicit
// 20s for a real 3s stub delay) sets its own timeout on top.
//
// This has to be repeated into every project's own `test` block rather than set once at the
// root: verified empirically (a minimal repro outside this repo) that a root-level `testTimeout`
// is silently ignored by projects declared via `test.projects` — each project resolves its own
// config independently, so only a per-project `testTimeout` actually takes effect. (This is the
// mirror image of `passWithNoTests` below, which works only at the root and is a no-op per
// project — the two options do not cascade the same way.)
const TEST_TIMEOUT_MS = 30000;

export default defineConfig({
  test: {
    // `passWithNoTests` is only a root `test`-level option, not a per-project one — it does not
    // exist on `ProjectConfig`. Setting it here means an empty project (e.g. security, before
    // Section 9 lands its tests) still exits 0 rather than failing the build.
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          testTimeout: TEST_TIMEOUT_MS,
        },
      },
      {
        test: {
          name: 'security',
          include: ['test/security/**/*.test.ts'],
          testTimeout: TEST_TIMEOUT_MS,
        },
      },
      {
        test: {
          name: 'live',
          include: liveEnabled ? ['test/live/**/*.test.ts'] : [],
          testTimeout: TEST_TIMEOUT_MS,
        },
      },
    ],
  },
});
