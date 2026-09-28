import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  diffAgainstBaseline,
  findingsWithResolution,
  loadPreviousFindings,
  ResolveError,
} from '../../src/resolve.js';
import type { MergedFinding } from '../../src/merge.js';

function mergedFinding(
  overrides: Partial<MergedFinding> & Pick<MergedFinding, 'id' | 'fingerprint'>,
): MergedFinding {
  return {
    file: 'src/example.ts',
    line: 1,
    endLine: null,
    severity: 'medium',
    category: 'correctness',
    claim: 'placeholder claim',
    impact: 'placeholder impact',
    evidence: [],
    suggestions: [],
    raisedBy: ['openrouter/model-a'],
    perReviewerSeverity: { 'openrouter/model-a': 'medium' },
    sources: [],
    agreement: { raisers: 1, reporting: 1 },
    unverifiable: false,
    memberFingerprints: [overrides.fingerprint],
    ...overrides,
  };
}

let reviewsDir: string;

beforeEach(() => {
  reviewsDir = mkdtempSync(join(tmpdir(), 'council-resolve-'));
});

afterEach(() => {
  rmSync(reviewsDir, { recursive: true, force: true });
});

function writeRun(runId: string, findings: MergedFinding[]): void {
  const dir = join(reviewsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'findings.json'), JSON.stringify(findings), 'utf8');
}

/** `last` is a symlink to the run directory, per CONTRACT.md's pinned run-directory layout —
 * not a text file containing the run id. */
function pointLastAt(runId: string): void {
  symlinkSync(join(reviewsDir, runId), join(reviewsDir, 'last'), 'dir');
}

describe('loadPreviousFindings', () => {
  it('loads a named run by id', () => {
    const findings = [mergedFinding({ id: 'F001', fingerprint: 'fp-a' })];
    writeRun('run-1', findings);

    const result = loadPreviousFindings(reviewsDir, 'run-1');
    expect(result).toEqual({ runId: 'run-1', findings });
  });

  it('loads the most recently completed run by resolving the "last" symlink', () => {
    const findings = [mergedFinding({ id: 'F001', fingerprint: 'fp-b' })];
    writeRun('run-2', findings);
    pointLastAt('run-2');

    const result = loadPreviousFindings(reviewsDir, 'last');
    expect(result).toEqual({ runId: 'run-2', findings });
  });

  it('derives the run id from the resolved symlink basename, not from any stored text', () => {
    // Two different run directories exist; `last` is retargeted from one to the other, proving
    // the run id genuinely comes from resolving the link each time rather than from a cached id.
    writeRun('run-old', [mergedFinding({ id: 'F001', fingerprint: 'fp-old' })]);
    const newFindings = [mergedFinding({ id: 'F001', fingerprint: 'fp-new' })];
    writeRun('run-new', newFindings);

    pointLastAt('run-old');
    rmSync(join(reviewsDir, 'last'));
    pointLastAt('run-new');

    const result = loadPreviousFindings(reviewsDir, 'last');
    expect(result).toEqual({ runId: 'run-new', findings: newFindings });
  });

  it('returns null for "last" when no run has ever completed (no symlink at all)', () => {
    const result = loadPreviousFindings(reviewsDir, 'last');
    expect(result).toBeNull();
  });

  it('treats a dangling "last" symlink (its target run has been gc-ed) as no baseline available', () => {
    // Point at a run directory that was never created, simulating a run `gc` has since removed.
    pointLastAt('removed-run');
    const result = loadPreviousFindings(reviewsDir, 'last');
    expect(result).toBeNull();
  });

  it('returns null for "last" when the resolved run exists but its findings.json is unreadable', () => {
    mkdirSync(join(reviewsDir, 'run-no-findings'), { recursive: true });
    pointLastAt('run-no-findings');
    const result = loadPreviousFindings(reviewsDir, 'last');
    expect(result).toBeNull();
  });

  it('throws ResolveError with exit code 2 for a named run that does not exist', () => {
    expect(() => loadPreviousFindings(reviewsDir, 'no-such-run')).toThrow(ResolveError);
    try {
      loadPreviousFindings(reviewsDir, 'no-such-run');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ResolveError);
      expect((err as ResolveError).exitCode).toBe(2);
      expect((err as ResolveError).message).toContain('no-such-run');
    }
  });

  it('throws ResolveError for a named run whose findings.json is not valid JSON', () => {
    const dir = join(reviewsDir, 'broken-run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'findings.json'), '{ not valid json', 'utf8');

    expect(() => loadPreviousFindings(reviewsDir, 'broken-run')).toThrow(ResolveError);
  });

  it('rejects a ref that is not a listed run id, even when it names a readable findings.json', () => {
    // `--since .` / `--since ..` / a nested path would otherwise read a findings.json outside
    // the run directories (here: one planted directly in the reviews directory itself).
    writeFileSync(join(reviewsDir, 'findings.json'), '[]', 'utf8');
    mkdirSync(join(reviewsDir, 'run-1', 'nested'), { recursive: true });
    writeFileSync(join(reviewsDir, 'run-1', 'nested', 'findings.json'), '[]', 'utf8');
    writeFileSync(join(reviewsDir, 'run-1', 'findings.json'), '[]', 'utf8');

    for (const ref of ['.', '..', 'run-1/nested', '../' + 'x', '', '.hidden']) {
      expect(() => loadPreviousFindings(reviewsDir, ref), ref).toThrow(ResolveError);
    }
    expect(loadPreviousFindings(reviewsDir, 'run-1')).toEqual({ runId: 'run-1', findings: [] });
  });

  it('throws ResolveError (exit 2), not a TypeError, for a named run whose array holds non-findings', () => {
    for (const [i, body] of ['[null]', '[{}]', '[1, "x"]', '[{"fingerprint": 7}]'].entries()) {
      const runId = `bad-${i}`;
      mkdirSync(join(reviewsDir, runId), { recursive: true });
      writeFileSync(join(reviewsDir, runId, 'findings.json'), body, 'utf8');
      expect(() => loadPreviousFindings(reviewsDir, runId), body).toThrow(ResolveError);
    }
  });

  it('treats a "last" run whose array holds non-findings as no baseline available', () => {
    mkdirSync(join(reviewsDir, 'run-bad'), { recursive: true });
    writeFileSync(join(reviewsDir, 'run-bad', 'findings.json'), '[null]', 'utf8');
    pointLastAt('run-bad');
    expect(loadPreviousFindings(reviewsDir, 'last')).toBeNull();
  });

  it('does not follow a "last" that is a real directory rather than a symlink', () => {
    writeRun('last', [mergedFinding({ id: 'F001', fingerprint: 'fp-a' })]);
    expect(loadPreviousFindings(reviewsDir, 'last')).toBeNull();
  });
});

describe('diffAgainstBaseline: representative changes between runs', () => {
  it('matches a cluster whose representative fingerprint changed through its member fingerprints', () => {
    // Run 1: two reviewers raised the defect; the representative was reviewer A's wording.
    const before = mergedFinding({
      id: 'F001',
      fingerprint: 'fp-a',
      memberFingerprints: ['fp-a', 'fp-b'],
    });
    // Run 2: reviewer A failed, so reviewer B's wording is now the representative.
    const after = mergedFinding({ id: 'F001', fingerprint: 'fp-b', memberFingerprints: ['fp-b'] });

    const outcome = diffAgainstBaseline([after], { runId: 'prev', findings: [before] });
    expect(outcome.counts).toEqual({ resolved: 0, stillPresent: 1, new: 0 });
    expect(outcome.current[0]!.resolution).toBe('still-present');
    expect(outcome.resolved).toEqual([]);

    // And the reverse direction: the current cluster gained a member whose wording was the old
    // representative's.
    const reverse = diffAgainstBaseline([before], { runId: 'prev', findings: [after] });
    expect(reverse.counts).toEqual({ resolved: 0, stillPresent: 1, new: 0 });
  });

  it('falls back to the fingerprint alone for a baseline written before memberFingerprints existed', () => {
    const legacy = mergedFinding({ id: 'F001', fingerprint: 'fp-a' }) as Partial<MergedFinding>;
    delete legacy.memberFingerprints;
    const current = mergedFinding({
      id: 'F001',
      fingerprint: 'fp-b',
      memberFingerprints: ['fp-b', 'fp-a'],
    });

    const outcome = diffAgainstBaseline([current], {
      runId: 'prev',
      findings: [legacy as MergedFinding],
    });
    expect(outcome.counts).toEqual({ resolved: 0, stillPresent: 1, new: 0 });
  });

  it('loads a legacy baseline file that lacks memberFingerprints', () => {
    const legacy = mergedFinding({ id: 'F001', fingerprint: 'fp-a' }) as Partial<MergedFinding>;
    delete legacy.memberFingerprints;
    writeRun('run-legacy', [legacy as MergedFinding]);
    const baseline = loadPreviousFindings(reviewsDir, 'run-legacy');
    expect(baseline?.findings).toHaveLength(1);
  });
});

describe('findingsWithResolution', () => {
  it('returns the merged findings unchanged when no diff was requested', () => {
    const findings = [mergedFinding({ id: 'F001', fingerprint: 'fp-a' })];
    expect(findingsWithResolution(findings, null)).toBe(findings);
  });

  it('annotates every finding with its resolution, in merged order, when a diff was requested', () => {
    const a = mergedFinding({ id: 'F001', fingerprint: 'fp-a' });
    const b = mergedFinding({ id: 'F002', fingerprint: 'fp-b' });
    const outcome = diffAgainstBaseline([a, b], { runId: 'prev', findings: [b] });
    expect(findingsWithResolution([a, b], outcome).map((f) => [f.id, f.resolution])).toEqual([
      ['F001', 'new'],
      ['F002', 'still-present'],
    ]);

    const none = diffAgainstBaseline([a], null);
    expect(findingsWithResolution([a], none)).toEqual([{ ...a, resolution: null }]);
  });
});

describe('diffAgainstBaseline', () => {
  it('marks a finding present in both runs as still-present', () => {
    const shared = mergedFinding({ id: 'F001', fingerprint: 'fp-shared' });
    const outcome = diffAgainstBaseline([shared], { runId: 'prev', findings: [shared] });

    expect(outcome.current).toHaveLength(1);
    expect(outcome.current[0]!.resolution).toBe('still-present');
    expect(outcome.counts).toEqual({ resolved: 0, stillPresent: 1, new: 0 });
    expect(outcome.resolved).toHaveLength(0);
    expect(outcome.baselineRunId).toBe('prev');
  });

  it('marks a finding present before but absent now as resolved', () => {
    const gone = mergedFinding({ id: 'F001', fingerprint: 'fp-gone' });
    const outcome = diffAgainstBaseline([], { runId: 'prev', findings: [gone] });

    expect(outcome.current).toHaveLength(0);
    expect(outcome.resolved).toHaveLength(1);
    expect(outcome.resolved[0]!.resolution).toBe('resolved');
    expect(outcome.resolved[0]!.fingerprint).toBe('fp-gone');
    expect(outcome.counts).toEqual({ resolved: 1, stillPresent: 0, new: 0 });
  });

  it('marks a finding absent before but present now as new', () => {
    const fresh = mergedFinding({ id: 'F001', fingerprint: 'fp-fresh' });
    const outcome = diffAgainstBaseline([fresh], { runId: 'prev', findings: [] });

    expect(outcome.current).toHaveLength(1);
    expect(outcome.current[0]!.resolution).toBe('new');
    expect(outcome.counts).toEqual({ resolved: 0, stillPresent: 0, new: 1 });
  });

  it('resolves against the most recent run when loaded via "last"', () => {
    const previous = [mergedFinding({ id: 'F001', fingerprint: 'fp-a' })];
    writeRun('run-1', previous);
    pointLastAt('run-1');

    const baseline = loadPreviousFindings(reviewsDir, 'last');
    const current = [mergedFinding({ id: 'F001', fingerprint: 'fp-a' })];
    const outcome = diffAgainstBaseline(current, baseline);

    expect(outcome.baselineRunId).toBe('run-1');
    expect(outcome.current[0]!.resolution).toBe('still-present');
  });

  it('proceeds without resolution marking when no baseline is available, rather than marking everything new', () => {
    const current = [
      mergedFinding({ id: 'F001', fingerprint: 'fp-1' }),
      mergedFinding({ id: 'F002', fingerprint: 'fp-2' }),
    ];
    const outcome = diffAgainstBaseline(current, null);

    expect(outcome.baselineRunId).toBeNull();
    expect(outcome.resolved).toHaveLength(0);
    expect(outcome.current).toHaveLength(2);
    // Every finding is unmarked (`null`), not `'new'` — a report on a project's first-ever run
    // must not assert a comparison, resolved/new/still-present, that never happened.
    expect(outcome.current.every((f) => f.resolution === null)).toBe(true);
    expect(outcome.counts).toEqual({ resolved: 0, stillPresent: 0, new: 0 });
  });

  it('handles a full run with resolved, still-present and new findings together', () => {
    const stillPresent = mergedFinding({ id: 'F001', fingerprint: 'fp-still' });
    const willResolve = mergedFinding({ id: 'F002', fingerprint: 'fp-resolved' });
    const isNew = mergedFinding({ id: 'F001', fingerprint: 'fp-new' });

    const baseline = { runId: 'prev', findings: [stillPresent, willResolve] };
    const current = [stillPresent, isNew];

    const outcome = diffAgainstBaseline(current, baseline);
    expect(outcome.counts).toEqual({ resolved: 1, stillPresent: 1, new: 1 });
    expect(outcome.resolved.map((f) => f.fingerprint)).toEqual(['fp-resolved']);
  });
});
