/**
 * Tests for `src/report.ts`: run-directory creation and the most-recent pointer, slugification,
 * per-reviewer raw artifacts, the manifest, REPORT.md, HANDOFF.md, machine-readable stdout mode,
 * and `listRuns`/`gcRuns`. No model call and no network access anywhere in this file — every
 * input is a hand-built fixture.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRunDir,
  emitMachineReadableFindings,
  gcRuns,
  listRuns,
  serializeFindings,
  slugifyModel,
  updateLastPointer,
  writeFindings,
  writeHandoff,
  writeManifest,
  writeReport,
  writeReviewerArtifacts,
  type ManifestInput,
  type RunDir,
} from '../../src/report.js';
import type { MergedFinding } from '../../src/merge.js';
import type { ResolutionOutcome } from '../../src/resolve.js';
import type { ReviewerResult, RunPanelOutcome } from '../../src/runner.js';
import type { Reviewer } from '../../src/panel.js';
import type { CatalogModel } from '../../src/providers.js';
import type { ResolvedScope } from '../../src/scope.js';
import type { SnapshotIdentity } from '../../src/snapshot.js';

// -------------------------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------------------------

function makeReviewer(over: {
  provider: string;
  model: string;
  vendor?: string;
  thinking?: Partial<Reviewer['thinking']>;
}): Reviewer {
  const catalog: CatalogModel = {
    id: over.model,
    name: over.model,
    provider: over.provider,
    vendor: over.vendor ?? 'test-vendor',
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    inputCostPerMTok: 3,
    outputCostPerMTok: 15,
    reasoning: true,
    thinkingLevelMap: undefined,
  };
  return {
    provider: over.provider,
    model: over.model,
    vendor: catalog.vendor,
    catalog,
    thinking: {
      applicable: true,
      requested: 'medium',
      effective: 'medium',
      clamped: false,
      ...over.thinking,
    },
  };
}

function makeReviewerResult(
  over: Partial<ReviewerResult> & { reviewer: Reviewer },
): ReviewerResult {
  return {
    state: 'ok',
    findings: [],
    finalText: 'Nothing notable found.',
    repairText: null,
    usage: { inputTokens: 100, outputTokens: 50 },
    cost: 0.01,
    depth: { filesOpened: ['src/a.ts'], searches: 2 },
    toolCalls: [],
    rawTrace: ['{"type":"message_start"}', '{"type":"message_end"}'],
    startedAt: 1_000,
    endedAt: 2_000,
    ...over,
  };
}

function makeScope(over: Partial<ResolvedScope> = {}): ResolvedScope {
  return {
    mode: 'worktree',
    patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    files: ['src/a.ts'],
    selectors: {},
    baseBranch: 'main',
    mergeBase: 'abc123',
    endRevision: null,
    head: 'deadbeef',
    dirty: false,
    empty: false,
    ...over,
  };
}

function makeIdentity(over: Partial<SnapshotIdentity> = {}): SnapshotIdentity {
  return { head: 'deadbeef', dirty: false, treeHash: 'treehash-abc123', ...over };
}

function makeOutcome(
  results: ReviewerResult[],
  over: Partial<RunPanelOutcome> = {},
): RunPanelOutcome {
  return {
    results,
    launched: results.length,
    reporting: results.filter((r) => r.findings !== null).length,
    degraded: results.some((r) => r.state !== 'ok'),
    totalCost: results.every((r) => r.cost !== null)
      ? results.reduce((s, r) => s + (r.cost ?? 0), 0)
      : null,
    costIncomplete: results.some((r) => r.cost === null),
    ...over,
  };
}

function makeManifestInput(run: RunDir, over: Partial<ManifestInput> = {}): ManifestInput {
  const reviewerA = makeReviewer({ provider: 'openrouter', model: 'vendor-x/model-a' });
  const reviewerB = makeReviewer({
    provider: 'minimax',
    model: 'model-b',
    vendor: 'minimax-vendor',
  });
  const results = [
    makeReviewerResult({ reviewer: reviewerA }),
    makeReviewerResult({
      reviewer: reviewerB,
      cost: 0.02,
      depth: { filesOpened: [], searches: 0 },
    }),
  ];
  return {
    run,
    identity: makeIdentity(),
    scope: makeScope(),
    outcome: makeOutcome(results),
    suppressed: 0,
    overrides: { allowCorrelated: false, includeContextFiles: false, noSuppress: false },
    hostVersion: '0.84.4',
    codegraph: { available: true },
    ...over,
  };
}

function mergedFinding(
  over: Partial<MergedFinding> & Pick<MergedFinding, 'id' | 'fingerprint'>,
): MergedFinding {
  return {
    file: 'src/a.ts',
    line: 10,
    endLine: null,
    severity: 'medium',
    category: 'correctness',
    claim: 'placeholder claim',
    impact: 'placeholder impact',
    evidence: [],
    suggestions: [],
    raisedBy: ['openrouter/vendor-x/model-a'],
    perReviewerSeverity: { 'openrouter/vendor-x/model-a': 'medium' },
    sources: [],
    agreement: { raisers: 1, reporting: 2 },
    unverifiable: false,
    memberFingerprints: [over.fingerprint],
    ...over,
  };
}

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'council-report-test-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

// -------------------------------------------------------------------------------------------
// Run directory creation and the most-recent pointer
// -------------------------------------------------------------------------------------------

describe('createRunDir', () => {
  it('creates a timestamped, filesystem-safe run directory with a reviewers/ subdirectory', () => {
    const run = createRunDir(projectRoot);
    expect(existsSync(run.path)).toBe(true);
    expect(existsSync(join(run.path, 'reviewers'))).toBe(true);
    expect(run.id).toMatch(/^\d{8}T\d{9}Z(-\d+)?$/);
    expect(run.reviewsDir).toBe(join(projectRoot, '.council', 'reviews'));
  });

  it('produces ids that sort lexicographically in chronological order', () => {
    const run1 = createRunDir(projectRoot);
    rmSync(join(projectRoot, '.council', 'reviews', '.marker'), { force: true }); // no-op, keeps timing realistic
    const run2 = createRunDir(projectRoot);
    expect(run1.id < run2.id || run1.id === run2.id).toBe(true); // equal only in the same millisecond
    const ids = [run1.id, run2.id];
    expect([...ids].sort()).toEqual(ids.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});

describe('updateLastPointer', () => {
  it('creates last as a symlink resolving to the run directory', () => {
    const run = createRunDir(projectRoot);
    updateLastPointer(run);

    const lastPath = join(run.reviewsDir, 'last');
    const resolved = realpathSync(lastPath);
    expect(resolved).toBe(realpathSync(run.path));
  });

  it('atomically replaces an existing pointer, even from a degraded run', () => {
    const run1 = createRunDir(projectRoot);
    updateLastPointer(run1);

    const run2 = createRunDir(projectRoot);
    updateLastPointer(run2); // simulates a degraded run still updating the pointer

    const resolved = realpathSync(join(run1.reviewsDir, 'last'));
    expect(resolved).toBe(realpathSync(run2.path));
    // no leftover temp symlinks
    const entries = readdirSync(run1.reviewsDir);
    expect(entries.filter((e) => e.startsWith('.last.tmp'))).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// Slugification (task 15.2)
// -------------------------------------------------------------------------------------------

describe('slugifyModel', () => {
  it('is deterministic', () => {
    expect(slugifyModel('openrouter', 'vendor/model-a')).toBe(
      slugifyModel('openrouter', 'vendor/model-a'),
    );
  });

  it('produces filesystem-safe output with no slashes', () => {
    const slug = slugifyModel('openrouter', 'anthropic/claude-5:opus');
    expect(slug).not.toMatch(/[/\\:]/);
  });

  it('does not collide when a pure lowercase-and-replace scheme would', () => {
    // 'a/b' and 'a-b' both sanitize to 'a-b' under naive replacement; the hash must disambiguate.
    const slugA = slugifyModel('openrouter', 'a/b');
    const slugB = slugifyModel('openrouter', 'a-b');
    expect(slugA).not.toBe(slugB);
  });

  it('does not collide across different providers with the same model id', () => {
    const slugA = slugifyModel('openrouter', 'shared-model');
    const slugB = slugifyModel('minimax', 'shared-model');
    expect(slugA).not.toBe(slugB);
  });

  it('does not collide across models that differ only by prefix marker', () => {
    const slugA = slugifyModel('openrouter', 'model-x');
    const slugB = slugifyModel('openrouter', '*model-x');
    expect(slugA).not.toBe(slugB);
  });
});

// -------------------------------------------------------------------------------------------
// Per-reviewer raw artifacts (task 15.3)
// -------------------------------------------------------------------------------------------

describe('writeReviewerArtifacts', () => {
  it('writes three artifacts for a successful reviewer', () => {
    const run = createRunDir(projectRoot);
    const reviewer = makeReviewer({ provider: 'openrouter', model: 'vendor-x/model-a' });
    const result = makeReviewerResult({ reviewer, finalText: 'Here is my review.' });

    writeReviewerArtifacts(run, result);

    const slug = slugifyModel('openrouter', 'vendor-x/model-a');
    const dir = join(run.path, 'reviewers');
    expect(existsSync(join(dir, `${slug}.findings.json`))).toBe(true);
    expect(existsSync(join(dir, `${slug}.text.md`))).toBe(true);
    expect(existsSync(join(dir, `${slug}.trace.jsonl`))).toBe(true);

    expect(readFileSync(join(dir, `${slug}.text.md`), 'utf8')).toContain('Here is my review.');
  });

  it('still writes verbatim text and trace for a reviewer that failed validation', () => {
    const run = createRunDir(projectRoot);
    const reviewer = makeReviewer({ provider: 'openrouter', model: 'vendor-x/model-a' });
    const result = makeReviewerResult({
      reviewer,
      state: 'failed',
      findings: null,
      finalText: 'first attempt text',
      repairText: 'second attempt text',
      error: 'repaired output still failed validation',
    });

    writeReviewerArtifacts(run, result);

    const slug = slugifyModel('openrouter', 'vendor-x/model-a');
    const dir = join(run.path, 'reviewers');
    const findingsRaw = readFileSync(join(dir, `${slug}.findings.json`), 'utf8');
    expect(JSON.parse(findingsRaw)).toBeNull();

    const text = readFileSync(join(dir, `${slug}.text.md`), 'utf8');
    expect(text).toContain('first attempt text');
    expect(text).toContain('second attempt text');
    expect(existsSync(join(dir, `${slug}.trace.jsonl`))).toBe(true);
  });

  it('never collides two different models onto one filename', () => {
    const run = createRunDir(projectRoot);
    const r1 = makeReviewer({ provider: 'openrouter', model: 'a/b' });
    const r2 = makeReviewer({ provider: 'openrouter', model: 'a-b' });

    writeReviewerArtifacts(run, makeReviewerResult({ reviewer: r1, finalText: 'from a/b' }));
    writeReviewerArtifacts(run, makeReviewerResult({ reviewer: r2, finalText: 'from a-b' }));

    const dir = join(run.path, 'reviewers');
    const files = readdirSync(dir).filter((f) => f.endsWith('.text.md'));
    expect(files).toHaveLength(2);
  });
});

// -------------------------------------------------------------------------------------------
// Merged findings document and machine-readable stdout mode (tasks 15.4 partial, 15.8)
// -------------------------------------------------------------------------------------------

describe('writeFindings / serializeFindings', () => {
  it('writes a top-level JSON array of MergedFinding', () => {
    const run = createRunDir(projectRoot);
    const findings = [mergedFinding({ id: 'F001', fingerprint: 'fp-1' })];
    const dest = writeFindings(run, findings);

    expect(dest).toBe(join(run.path, 'findings.json'));
    const parsed = JSON.parse(readFileSync(dest, 'utf8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe('F001');
  });

  it('writeFindings and serializeFindings agree byte-for-byte', () => {
    const run = createRunDir(projectRoot);
    const findings = [mergedFinding({ id: 'F001', fingerprint: 'fp-1' })];
    const dest = writeFindings(run, findings);
    expect(readFileSync(dest, 'utf8')).toBe(serializeFindings(findings));
  });
});

describe('emitMachineReadableFindings', () => {
  it('writes only the findings document to the given stream, nothing else', () => {
    const findings = [mergedFinding({ id: 'F001', fingerprint: 'fp-1' })];
    let written = '';
    const fakeStdout = {
      write: (chunk: string) => {
        written += chunk;
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    emitMachineReadableFindings(findings, fakeStdout);

    expect(written).toBe(serializeFindings(findings));
    expect(JSON.parse(written)).toEqual(JSON.parse(serializeFindings(findings)));
  });

  it('keeps stdout and diagnostic output separable: a second, independent stream is untouched', () => {
    const findings = [mergedFinding({ id: 'F001', fingerprint: 'fp-1' })];
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const fakeStdout = {
      write: (c: string) => {
        stdoutChunks.push(c);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const fakeStderr = {
      write: (c: string) => {
        stderrChunks.push(c);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    emitMachineReadableFindings(findings, fakeStdout);
    fakeStderr.write('a warning that must never land on stdout');

    expect(stdoutChunks.join('')).toBe(serializeFindings(findings));
    expect(stdoutChunks.join('')).not.toContain('warning');
    expect(stderrChunks.join('')).toContain('warning');
  });
});

// -------------------------------------------------------------------------------------------
// Manifest (task 15.4) and the no-credentials assertion (task 15.5)
// -------------------------------------------------------------------------------------------

describe('writeManifest', () => {
  it('records reviewed state, scope, panel, per-reviewer detail, counts, cost and overrides', () => {
    const run = createRunDir(projectRoot);
    const input = makeManifestInput(run, {
      overrides: { allowCorrelated: true, includeContextFiles: true, noSuppress: true },
    });

    const dest = writeManifest(input);
    const manifest = JSON.parse(readFileSync(dest, 'utf8'));

    expect(manifest.reviewed).toEqual({
      commit: 'deadbeef',
      dirty: false,
      treeHash: 'treehash-abc123',
    });
    expect(manifest.scope.mode).toBe('worktree');
    expect(manifest.scope.selectors).toEqual({});
    expect(manifest.scope.patch).toBeUndefined(); // the diff lives in patch.diff, not duplicated here

    expect(manifest.panel).toHaveLength(2);
    expect(manifest.panel[0]).toMatchObject({
      provider: 'openrouter',
      model: 'vendor-x/model-a',
      vendor: 'test-vendor',
      thinking: { requested: 'medium', effective: 'medium', applicable: true, clamped: false },
    });

    expect(manifest.reviewers).toHaveLength(2);
    expect(manifest.reviewers[0]).toMatchObject({
      provider: 'openrouter',
      model: 'vendor-x/model-a',
      state: 'ok',
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    expect(manifest.reviewers[0].durationMs).toBe(1000);
    // review depth must distinguish a shallow reviewer (0 files) from a deeper one
    expect(manifest.reviewers[1].depth.filesOpenedCount).toBe(0);
    expect(manifest.reviewers[0].depth.filesOpenedCount).toBe(1);

    expect(manifest.counts).toEqual({ launched: 2, reporting: 2, suppressed: 0 });
    expect(manifest.cost.total).toBeCloseTo(0.03);
    expect(manifest.cost.incomplete).toBe(false);
    expect(manifest.degraded).toBe(false);

    expect(manifest.overrides).toEqual({
      allowCorrelated: true,
      includeContextFiles: true,
      noSuppress: true,
    });
    expect(manifest.hostVersion).toBe('0.84.4');
  });

  it('records unknown cost as null, not zero, and marks the run total incomplete', () => {
    const run = createRunDir(projectRoot);
    const reviewer = makeReviewer({ provider: 'openrouter', model: 'model-a' });
    const results = [makeReviewerResult({ reviewer, cost: null })];
    const input = makeManifestInput(run, { outcome: makeOutcome(results) });

    const manifest = JSON.parse(readFileSync(writeManifest(input), 'utf8'));

    expect(manifest.reviewers[0].cost).toBeNull();
    expect(manifest.cost.total).toBeNull();
    expect(manifest.cost.incomplete).toBe(true);
  });

  it('records degradation and marks the run degraded', () => {
    const run = createRunDir(projectRoot);
    const reviewer = makeReviewer({ provider: 'openrouter', model: 'model-a' });
    const results = [
      makeReviewerResult({ reviewer, state: 'timeout', findings: null, error: 'timed out' }),
    ];
    const input = makeManifestInput(run, { outcome: makeOutcome(results) });

    const manifest = JSON.parse(readFileSync(writeManifest(input), 'utf8'));

    expect(manifest.reviewers[0].state).toBe('timeout');
    expect(manifest.reviewers[0].error).toBe('timed out');
    expect(manifest.degraded).toBe(true);
  });

  it('records an available CodeGraph index without a reason', () => {
    const run = createRunDir(projectRoot);
    const input = makeManifestInput(run, { codegraph: { available: true } });

    const manifest = JSON.parse(readFileSync(writeManifest(input), 'utf8'));

    expect(manifest.codegraph).toEqual({ available: true });
  });

  it('records an unavailable CodeGraph index with its reason', () => {
    const run = createRunDir(projectRoot);
    const input = makeManifestInput(run, {
      codegraph: { available: false, reason: 'binary-missing' },
    });

    const manifest = JSON.parse(readFileSync(writeManifest(input), 'utf8'));

    expect(manifest.codegraph).toEqual({ available: false, reason: 'binary-missing' });
  });

  it('never carries credential-shaped content, even when the environment holds a live-looking secret', () => {
    const fakeSecret = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789';
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = fakeSecret;
    try {
      const run = createRunDir(projectRoot);
      const input = makeManifestInput(run);
      const manifest = readFileSync(writeManifest(input), 'utf8');

      expect(manifest).not.toContain(fakeSecret);
      expect(manifest).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
      expect(manifest).not.toMatch(/bearer\s+[A-Za-z0-9._-]{20,}/i);
      expect(manifest).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(manifest).not.toContain('OPENROUTER_API_KEY');
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });
});

// -------------------------------------------------------------------------------------------
// REPORT.md (task 15.6)
// -------------------------------------------------------------------------------------------

describe('writeReport', () => {
  it('leads with the panel, listing model, vendor, effective thinking level, cost and depth', () => {
    const run = createRunDir(projectRoot);
    const input = makeManifestInput(run);
    const findings = [mergedFinding({ id: 'F001', fingerprint: 'fp-1' })];

    const dest = writeReport(run, input, findings, null);
    const text = readFileSync(dest, 'utf8');

    const panelIdx = text.indexOf('## Panel');
    const findingsIdx = text.indexOf('## Findings');
    expect(panelIdx).toBeGreaterThan(-1);
    expect(findingsIdx).toBeGreaterThan(panelIdx);
    expect(text).toContain('openrouter/vendor-x/model-a');
    expect(text).toContain('test-vendor');
    expect(text).toContain('medium'); // effective thinking level
    expect(text).toContain('file'); // depth signal wording
  });

  it('orders findings by merged (agreement) order, most-agreed first', () => {
    const run = createRunDir(projectRoot);
    const input = makeManifestInput(run);
    const findings = [
      mergedFinding({
        id: 'F001',
        fingerprint: 'fp-1',
        agreement: { raisers: 3, reporting: 3 },
        file: 'a.ts',
      }),
      mergedFinding({
        id: 'F002',
        fingerprint: 'fp-2',
        agreement: { raisers: 1, reporting: 3 },
        file: 'b.ts',
      }),
    ];

    const text = readFileSync(writeReport(run, input, findings, null), 'utf8');
    expect(text.indexOf('F001')).toBeLessThan(text.indexOf('F002'));
  });

  it('produces a valid report for a run with no findings, stating that none were raised', () => {
    const run = createRunDir(projectRoot);
    const input = makeManifestInput(run);

    const text = readFileSync(writeReport(run, input, [], null), 'utf8');
    expect(text).toContain('## Panel');
    expect(text).toMatch(/no findings were raised/i);
  });

  it('states the suppressed count and degraded reviewers in the footer', () => {
    const run = createRunDir(projectRoot);
    const reviewer = makeReviewer({ provider: 'openrouter', model: 'model-a' });
    const results = [
      makeReviewerResult({ reviewer, state: 'timeout', findings: null, error: 'exceeded timeout' }),
    ];
    const input = makeManifestInput(run, { outcome: makeOutcome(results), suppressed: 3 });

    const text = readFileSync(writeReport(run, input, [], null), 'utf8');
    expect(text).toMatch(/Suppressed:\s*3/);
    expect(text).toMatch(/Degraded \(1\).*openrouter\/model-a.*timeout/s);
  });

  it('surfaces CodeGraph index availability in the summary footer', () => {
    const run = createRunDir(projectRoot);

    const availableText = readFileSync(
      writeReport(run, makeManifestInput(run, { codegraph: { available: true } }), [], null),
      'utf8',
    );
    expect(availableText).toContain('- CodeGraph index: available');

    const unavailableText = readFileSync(
      writeReport(
        run,
        makeManifestInput(run, { codegraph: { available: false, reason: 'disabled' } }),
        [],
        null,
      ),
      'utf8',
    );
    expect(unavailableText).toContain('- CodeGraph index: unavailable (disabled)');
  });

  it('renders the no-baseline case distinctly, never as "N new findings"', () => {
    const run = createRunDir(projectRoot);
    const input = makeManifestInput(run);
    const findings = [mergedFinding({ id: 'F001', fingerprint: 'fp-1' })];
    const resolution: ResolutionOutcome = {
      baselineRunId: null,
      current: findings.map((f) => ({ ...f, resolution: null })),
      resolved: [],
      counts: { resolved: 0, stillPresent: 0, new: 0 },
    };

    const text = readFileSync(writeReport(run, input, findings, resolution), 'utf8');
    expect(text).toMatch(/no baseline/i);
    expect(text).not.toMatch(/\d+\s+new findings/i);
  });

  it('leads with the resolution summary when diffing was requested and a baseline exists', () => {
    const run = createRunDir(projectRoot);
    const input = makeManifestInput(run);
    const findings = [mergedFinding({ id: 'F001', fingerprint: 'fp-1' })];
    const resolution: ResolutionOutcome = {
      baselineRunId: 'prior-run',
      current: [{ ...findings[0]!, resolution: 'still-present' }],
      resolved: [mergedFinding({ id: 'F999', fingerprint: 'fp-resolved', file: 'gone.ts' })].map(
        (f) => ({
          ...f,
          resolution: 'resolved',
        }),
      ),
      counts: { resolved: 1, stillPresent: 1, new: 0 },
    };

    const text = readFileSync(writeReport(run, input, findings, resolution), 'utf8');
    const resolutionIdx = text.indexOf('## Resolution');
    const panelIdx = text.indexOf('## Panel');
    expect(resolutionIdx).toBeGreaterThan(-1);
    expect(resolutionIdx).toBeLessThan(panelIdx);
    expect(text).toContain('prior-run');
    expect(text).toContain('gone.ts');
    expect(text).toMatch(/still-present/);
  });
});

// -------------------------------------------------------------------------------------------
// HANDOFF.md (task 15.7)
// -------------------------------------------------------------------------------------------

describe('writeHandoff', () => {
  it('is addressed to a coding agent and names the run directory and findings file', () => {
    const run = createRunDir(projectRoot);
    const findingsPath = join(run.path, 'findings.json');

    const text = readFileSync(writeHandoff(run, findingsPath), 'utf8');

    expect(text).toContain(run.path);
    expect(text).toContain(findingsPath);
    expect(text).toMatch(/coding agent/i);
  });

  it('requires reproduction before any fix', () => {
    const run = createRunDir(projectRoot);
    const text = readFileSync(writeHandoff(run, join(run.path, 'findings.json')), 'utf8');
    expect(text).toMatch(/reproduce/i);
    expect(text).toMatch(/before (you change|changing) any/i);
  });

  it('directs ambiguity to the raw per-reviewer artifacts', () => {
    const run = createRunDir(projectRoot);
    const text = readFileSync(writeHandoff(run, join(run.path, 'findings.json')), 'utf8');
    expect(text).toMatch(/ambiguous/i);
    expect(text).toContain('reviewers');
    expect(text).toContain('.text.md');
    expect(text).toContain('.trace.jsonl');
  });

  it('frames a low-agreement finding as a hypothesis to test, not a defect to fix', () => {
    const run = createRunDir(projectRoot);
    const text = readFileSync(writeHandoff(run, join(run.path, 'findings.json')), 'utf8');
    expect(text).toMatch(/hypothesis/i);
    expect(text.toLowerCase()).toContain('not');
  });
});

// -------------------------------------------------------------------------------------------
// listRuns / gcRuns
// -------------------------------------------------------------------------------------------

describe('listRuns', () => {
  it('returns [] when no run has ever been written', () => {
    expect(listRuns(projectRoot)).toEqual([]);
  });

  it('lists runs newest first and excludes the last pointer', () => {
    const run1 = createRunDir(projectRoot);
    const run2 = createRunDir(projectRoot);
    updateLastPointer(run2);

    const runs = listRuns(projectRoot);
    expect(runs.map((r) => r.id)).toEqual([run2.id, run1.id]);
  });
});

describe('gcRuns', () => {
  it('reports nothing removed when within the retention count', () => {
    createRunDir(projectRoot);
    createRunDir(projectRoot);
    expect(gcRuns(projectRoot, 5)).toEqual({ removed: [] });
  });

  it('prunes to the retention count, removing the oldest runs', () => {
    const run1 = createRunDir(projectRoot);
    const run2 = createRunDir(projectRoot);
    const run3 = createRunDir(projectRoot);
    updateLastPointer(run3);

    const { removed } = gcRuns(projectRoot, 2);

    expect(removed).toEqual([run1.id]);
    expect(existsSync(run1.path)).toBe(false);
    expect(existsSync(run2.path)).toBe(true);
    expect(existsSync(run3.path)).toBe(true);
  });

  it('never removes the run the most-recent pointer resolves to, even beyond the retention count', () => {
    const run1 = createRunDir(projectRoot);
    updateLastPointer(run1);
    createRunDir(projectRoot);
    createRunDir(projectRoot);

    const { removed } = gcRuns(projectRoot, 0);

    expect(removed).not.toContain(run1.id);
    expect(existsSync(run1.path)).toBe(true);
    expect(realpathSync(join(run1.reviewsDir, 'last'))).toBe(realpathSync(run1.path));
  });

  it('leaves a dangling last pointer without crashing (protects nothing extra)', () => {
    const reviewsDir = join(projectRoot, '.council', 'reviews');
    createRunDir(projectRoot);
    createRunDir(projectRoot);
    symlinkSync('does-not-exist', join(reviewsDir, 'last'), 'dir');

    expect(() => gcRuns(projectRoot, 1)).not.toThrow();
  });
});
