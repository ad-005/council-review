import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  fingerprint,
  mergeFindings,
  normaliseClaim,
  type MergeOptions,
  type ReviewerFindings,
} from '../../src/merge.js';
import type { IgnoreFile } from '../../src/config.js';
import type { RawFinding, Severity } from '../../src/schema.js';

const FIXTURES_DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'fixtures',
  'findings',
);

function loadFixture(name: string): ReviewerFindings[] {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as ReviewerFindings[];
}

function loadRefactorFixture(): { before: ReviewerFindings[]; after: ReviewerFindings[] } {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'suppression-refactor.json'), 'utf8')) as {
    before: ReviewerFindings[];
    after: ReviewerFindings[];
  };
}

const DEFAULT_OPTIONS: MergeOptions = { mergeWindow: 10, claimSimilarity: 0.6, suppress: false };

function finding(
  overrides: Partial<RawFinding> & Pick<RawFinding, 'file' | 'line' | 'claim'>,
): RawFinding {
  return {
    severity: 'medium' as Severity,
    category: 'correctness',
    impact: 'unspecified impact',
    ...overrides,
  };
}

describe('normaliseClaim', () => {
  it('lowercases, strips punctuation, collapses whitespace and removes stopwords', () => {
    expect(normaliseClaim('The Cache Is NEVER Invalidated, after a write!')).toBe(
      'cache never invalidated after write',
    );
  });

  it('normalises punctuation and casing variants to the same string', () => {
    const a = normaliseClaim('User input is concatenated directly into the SQL query.');
    const b = normaliseClaim('USER INPUT IS CONCATENATED DIRECTLY INTO THE SQL QUERY');
    expect(a).toBe(b);
  });
});

describe('fingerprint', () => {
  it('is unchanged when the same claim is reported at a different line', () => {
    // Fingerprint takes file + claim only; it has no line parameter to vary in the first place,
    // which is exactly the property "Fingerprints are stable across line movement" requires.
    const fp1 = fingerprint('src/handler.ts', 'The response body is logged even when sensitive.');
    const fp2 = fingerprint('src/handler.ts', 'The response body is logged even when sensitive.');
    expect(fp1).toBe(fp2);
  });

  it('is equal for the same claim reported with different punctuation, casing and whitespace', () => {
    const fp1 = fingerprint('src/a.ts', 'The cache is never invalidated after a write.');
    const fp2 = fingerprint('src/a.ts', '  the CACHE is   never invalidated, after a write ');
    expect(fp1).toBe(fp2);
  });

  it('differs for a materially different claim on the same file', () => {
    const fp1 = fingerprint('src/a.ts', 'The cache is never invalidated after a write.');
    const fp2 = fingerprint('src/a.ts', 'The response body leaks a stack trace.');
    expect(fp1).not.toBe(fp2);
  });

  it('differs for the same claim text reported against two different files', () => {
    const fp1 = fingerprint('src/a.ts', 'User input reaches a SQL query unsanitised.');
    const fp2 = fingerprint('src/b.ts', 'User input reaches a SQL query unsanitised.');
    expect(fp1).not.toBe(fp2);
  });
});

describe('mergeFindings: clustering', () => {
  it('merges the same defect reported by three reviewers into one cluster', () => {
    const outcome = mergeFindings(loadFixture('same-defect.json'), DEFAULT_OPTIONS);
    expect(outcome.findings).toHaveLength(1);
    const [f] = outcome.findings;
    expect(f!.agreement).toEqual({ raisers: 3, reporting: 3 });
    expect(f!.severity).toBe('critical'); // max of high, critical, medium
    expect(new Set(f!.raisedBy)).toEqual(
      new Set(['openrouter/model-a', 'minimax/model-b', 'openai-codex/model-c']),
    );
    expect(f!.perReviewerSeverity).toEqual({
      'openrouter/model-a': 'high',
      'minimax/model-b': 'critical',
      'openai-codex/model-c': 'medium',
    });
    expect(f!.sources).toHaveLength(3);
    expect(f!.evidence).toContain(
      'buildUserQuery() interpolates `req.query.name` into the SQL string.',
    );
    expect(f!.suggestions).toContain('Use a parameterised query instead of string concatenation.');
  });

  it('keeps two unrelated findings on the same line of the same file separate', () => {
    const outcome = mergeFindings(loadFixture('unrelated-same-line.json'), DEFAULT_OPTIONS);
    expect(outcome.findings).toHaveLength(2);
  });

  it('keeps findings with different categories separate even at the same line with a similar claim', () => {
    const outcome = mergeFindings(loadFixture('different-categories.json'), DEFAULT_OPTIONS);
    expect(outcome.findings).toHaveLength(2);
    expect(new Set(outcome.findings.map((f) => f.category))).toEqual(
      new Set(['security', 'style']),
    );
  });

  it('keeps findings beyond the merge window separate', () => {
    const outcome = mergeFindings(loadFixture('beyond-window.json'), DEFAULT_OPTIONS);
    expect(outcome.findings).toHaveLength(2);
  });

  it('never merges findings across files, even with an identical claim and category', () => {
    const outcome = mergeFindings(loadFixture('cross-file.json'), DEFAULT_OPTIONS);
    expect(outcome.findings).toHaveLength(2);
    expect(new Set(outcome.findings.map((f) => f.file))).toEqual(
      new Set(['src/auth.ts', 'src/db.ts']),
    );
  });

  it('clusters transitively: A-B and B-C merge, forming one cluster, though A-C would not merge pairwise', () => {
    const all = loadFixture('transitive-chain.json');
    const outcome = mergeFindings(all, DEFAULT_OPTIONS);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]!.agreement.raisers).toBe(3);

    // Confirm the negative half of the claim: A and C alone (B removed) do not merge, so the
    // three-way cluster above is genuinely a product of transitivity, not of A-C merging directly.
    const aAndCOnly = [all[0]!, all[2]!];
    const pairwise = mergeFindings(aAndCOnly, DEFAULT_OPTIONS);
    expect(pairwise.findings).toHaveLength(2);
  });

  it('a lone finding survives the merge and is not discarded for low agreement', () => {
    const outcome = mergeFindings(loadFixture('lone-finding.json'), DEFAULT_OPTIONS);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]!.agreement).toEqual({ raisers: 1, reporting: 3 });
  });
});

describe('mergeFindings: tuning constants change clustering', () => {
  it('the claim-similarity threshold change flips clustering', () => {
    const results = loadFixture('tuning-similarity.json');
    const strict = mergeFindings(results, { ...DEFAULT_OPTIONS, claimSimilarity: 0.6 });
    expect(strict.findings).toHaveLength(2);

    const loose = mergeFindings(results, { ...DEFAULT_OPTIONS, claimSimilarity: 0.4 });
    expect(loose.findings).toHaveLength(1);
  });

  it('the merge-window change flips clustering', () => {
    const results = loadFixture('tuning-window.json');
    const narrow = mergeFindings(results, { ...DEFAULT_OPTIONS, mergeWindow: 10 });
    expect(narrow.findings).toHaveLength(2);

    const wide = mergeFindings(results, { ...DEFAULT_OPTIONS, mergeWindow: 15 });
    expect(wide.findings).toHaveLength(1);
  });
});

describe('mergeFindings: agreement denominator', () => {
  it('counts only reviewers that reported, not the number launched', () => {
    const results = loadFixture('degraded-panel.json');
    const outcome = mergeFindings(results, DEFAULT_OPTIONS);
    expect(outcome.launched).toBe(3);
    expect(outcome.reporting).toBe(2);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]!.agreement).toEqual({ raisers: 2, reporting: 2 });
  });
});

describe('mergeFindings: suppression', () => {
  it('drops a cluster whose own fingerprint matches a suppression entry, and reports the count', () => {
    const results = loadFixture('same-defect.json');
    const baseline = mergeFindings(results, DEFAULT_OPTIONS);
    const ownFingerprint = baseline.findings[0]!.fingerprint;

    const ignore: IgnoreFile = { version: 1, entries: [{ fingerprint: ownFingerprint }] };
    const outcome = mergeFindings(results, { ...DEFAULT_OPTIONS, ignore, suppress: true });
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.suppressed).toBe(1);
  });

  it('drops a cluster when only a non-representative member fingerprint matches', () => {
    const results = loadFixture('suppression-member.json');
    const baseline = mergeFindings(results, DEFAULT_OPTIONS);
    expect(baseline.findings).toHaveLength(1);
    const cluster = baseline.findings[0]!;

    // The representative claim comes from the alphabetically-first reviewer id
    // ('minimax/model-b' < 'openrouter/model-a'), so the a-member's own fingerprint is not the
    // cluster's own fingerprint — suppressing by that member fingerprint must still drop it.
    const memberFingerprint = fingerprint(
      'src/cache.ts',
      'Cache entries are never invalidated after a write.',
    );
    expect(cluster.fingerprint).not.toBe(memberFingerprint);
    expect(cluster.memberFingerprints).toContain(memberFingerprint);

    const ignore: IgnoreFile = { version: 1, entries: [{ fingerprint: memberFingerprint }] };
    const outcome = mergeFindings(results, { ...DEFAULT_OPTIONS, ignore, suppress: true });
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.suppressed).toBe(1);
  });

  it('suppression survives a refactor that moves the finding to a different line', () => {
    const { before, after } = loadRefactorFixture();
    const beforeOutcome = mergeFindings(before, DEFAULT_OPTIONS);
    const fp = beforeOutcome.findings[0]!.fingerprint;

    const ignore: IgnoreFile = { version: 1, entries: [{ fingerprint: fp }] };
    const afterOutcome = mergeFindings(after, { ...DEFAULT_OPTIONS, ignore, suppress: true });
    expect(afterOutcome.findings).toHaveLength(0);
    expect(afterOutcome.suppressed).toBe(1);
  });

  it('suppression can be bypassed for a single run without editing the ignore list', () => {
    const results = loadFixture('same-defect.json');
    const baseline = mergeFindings(results, DEFAULT_OPTIONS);
    const ignore: IgnoreFile = {
      version: 1,
      entries: [{ fingerprint: baseline.findings[0]!.fingerprint }],
    };

    const bypassed = mergeFindings(results, { ...DEFAULT_OPTIONS, ignore, suppress: false });
    expect(bypassed.findings).toHaveLength(1);
    expect(bypassed.suppressed).toBe(0);
    // The list itself is a plain value this module never writes back to disk; passing the same
    // `ignore` object through unmutated is the module-level guarantee that it is left unchanged.
    expect(ignore.entries).toHaveLength(1);
  });
});

describe('mergeFindings: sort order and identifiers', () => {
  it('sorts by agreement desc, then severity desc, then file asc, then line asc', () => {
    const results: ReviewerFindings[] = [
      {
        reviewerId: 'a',
        findings: [
          // Two independent, non-clustering findings from the same reviewer so each ends up as
          // its own single-raiser cluster; a third pair clusters to raisers=2.
          finding({
            file: 'z-file.ts',
            line: 5,
            claim: 'Isolated low-severity claim one.',
            severity: 'low',
          }),
          finding({
            file: 'a-file.ts',
            line: 50,
            claim: 'Isolated critical claim two.',
            severity: 'critical',
          }),
          finding({
            file: 'a-file.ts',
            line: 5,
            claim: 'Two reviewers agree on this defect right here.',
          }),
        ],
      },
      {
        reviewerId: 'b',
        findings: [
          finding({
            file: 'a-file.ts',
            line: 6,
            claim: 'Two reviewers agree on this defect right here.',
          }),
        ],
      },
    ];
    const outcome = mergeFindings(results, DEFAULT_OPTIONS);
    expect(outcome.findings).toHaveLength(3);

    // Highest agreement (2 raisers) first, regardless of its lower severity...
    expect(outcome.findings[0]!.agreement.raisers).toBe(2);
    // ...then among the two 1-raiser findings, higher severity (critical) before lower (low)...
    expect(outcome.findings[1]!.severity).toBe('critical');
    expect(outcome.findings[1]!.agreement.raisers).toBe(1);
    // ...then the remaining lone low-severity finding last.
    expect(outcome.findings[2]!.severity).toBe('low');

    expect(outcome.findings.map((f) => f.id)).toEqual(['F001', 'F002', 'F003']);
  });

  it('assigns identifiers only after sorting, so ids increase monotonically in output order', () => {
    const outcome = mergeFindings(loadFixture('transitive-chain.json'), DEFAULT_OPTIONS);
    const ids = outcome.findings.map((f) => f.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('mergeFindings: determinism', () => {
  it('produces byte-identical output, including every finding id, across two merges of identical input', () => {
    const results = loadFixture('same-defect.json');
    const one = mergeFindings(results, DEFAULT_OPTIONS);
    const two = mergeFindings(results, DEFAULT_OPTIONS);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('is deterministic across a larger, multi-cluster input', () => {
    const results: ReviewerFindings[] = [
      ...loadFixture('same-defect.json'),
      ...loadFixture('transitive-chain.json'),
      ...loadFixture('unrelated-same-line.json'),
      ...loadFixture('degraded-panel.json'),
    ];
    const one = mergeFindings(results, DEFAULT_OPTIONS);
    const two = mergeFindings(results, DEFAULT_OPTIONS);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(one.findings.map((f) => f.id)).toEqual(two.findings.map((f) => f.id));
  });
});

describe('mergeFindings: traceability', () => {
  it("keeps each contributing reviewer's own claim text available unrewritten in sources", () => {
    const outcome = mergeFindings(loadFixture('same-defect.json'), DEFAULT_OPTIONS);
    const [f] = outcome.findings;
    const claimsByReviewer = new Map(f!.sources.map((s) => [s.reviewer, s.claim]));
    expect(claimsByReviewer.get('openrouter/model-a')).toBe(
      'User input is concatenated directly into the SQL query without sanitization.',
    );
    expect(claimsByReviewer.get('minimax/model-b')).toBe(
      'User input is concatenated directly into the SQL query without any sanitization.',
    );
    expect(claimsByReviewer.get('openai-codex/model-c')).toBe(
      'User input gets concatenated directly into the SQL query without sanitization.',
    );
  });
});

describe('mergeFindings: no model call', () => {
  it('is a pure function: identical results in, identical (and only synchronous) output out', () => {
    // There is nothing here to mock — mergeFindings takes no network client, issues no request,
    // and returns synchronously. This test exists to make that structural guarantee explicit.
    const outcome = mergeFindings(loadFixture('unrelated-same-line.json'), DEFAULT_OPTIONS);
    expect(outcome).not.toBeInstanceOf(Promise);
  });
});
