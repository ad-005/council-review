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

  it('pins the hash of a known input to its literal expected value', () => {
    // `fingerprint` output is persisted in `.council/ignore.json` (suppression entries) and used
    // to diff findings across runs (`--since` baselines). If the hash key composition ever
    // changed — including, notably, the NUL byte joining file and claim being swapped for some
    // other separator — every previously suppressed finding would silently un-suppress, and
    // every baseline comparison would report every finding as simultaneously resolved and new.
    // These two literal hashes are the regression guard: any change to `fingerprint`'s inputs or
    // separator must fail this test loudly rather than corrupt stored suppressions silently.
    expect(fingerprint('src/handler.ts', 'The response body is logged even when sensitive.')).toBe(
      'ec544bdd632a1194262bbbf9c15802b2228f65f3b3fc3d03fe76f09e2a1404c8',
    );
    expect(fingerprint('src/a.ts', 'User input reaches a SQL query unsanitised.')).toBe(
      '8c010a2a963029705f97ca0ac2eb36102f61d21b5738c59ce8701fda82b9a21c',
    );
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
    // This fixture's pair (a terse claim and a more detailed paraphrase of the same defect)
    // scores 0.667 under the overlap coefficient `claimOverlap` now uses (it scored 0.444 under
    // the old Jaccard measure, which is why these two threshold values changed from 0.6/0.4 to
    // 0.7/0.6 when the metric switched — the fixture and its intent, demonstrating that the
    // threshold is genuinely load-bearing, are unchanged; only the two literal values needed to
    // straddle the new metric's score for this pair).
    const results = loadFixture('tuning-similarity.json');
    const strict = mergeFindings(results, { ...DEFAULT_OPTIONS, claimSimilarity: 0.7 });
    expect(strict.findings).toHaveLength(2);

    const loose = mergeFindings(results, { ...DEFAULT_OPTIONS, claimSimilarity: 0.6 });
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

describe('mergeFindings: cross-model claim paraphrase (live calibration)', () => {
  // `live-token-validation.json` is genuine multi-model output (not a synthetic fixture): three
  // reviewers examined a real two-defect diff and, under the old Jaccard-based similarity, none
  // of the five findings they raised clustered — every one landed as its own 1/3-agreement
  // finding, even though two independent reviewers agreed, in different words, on each of the
  // diff's two actual defects. See the `claimOverlap` and `categoriesCompatible` doc comments in
  // src/merge.ts for the measured scores and the reasoning behind the fix.
  it('clusters the falsy-token-bypass defect (line 2) raised independently by two reviewers', () => {
    const outcome = mergeFindings(loadFixture('live-token-validation.json'), DEFAULT_OPTIONS);
    const cluster = outcome.findings.find((f) => f.line === 2)!;
    expect(cluster).toBeDefined();
    expect(cluster.agreement).toEqual({ raisers: 2, reporting: 3 });
    expect(new Set(cluster.raisedBy)).toEqual(
      new Set(['opencode-go/glm-5.3-flash', 'opencode-go/qwen3.8-flash']),
    );
  });

  it('clusters the strict-vs-loose-equality defect (line 3) despite the two reviewers disagreeing on category', () => {
    const outcome = mergeFindings(loadFixture('live-token-validation.json'), DEFAULT_OPTIONS);
    const lineThreeFindings = outcome.findings.filter((f) => f.line === 3);
    const cluster = lineThreeFindings.find((f) => f.agreement.raisers === 2)!;
    expect(cluster).toBeDefined();
    expect(new Set(cluster.raisedBy)).toEqual(
      new Set(['opencode-go/glm-5.3-flash', 'opencode-go/qwen3.8-flash']),
    );
    // One reviewer called this "security" (glm, severity high), the other "correctness" (qwen,
    // also severity high) — exactly the routine taxonomic disagreement `categoriesCompatible`
    // exists to bridge, rather than block. Both members tie on severity, so category resolution
    // falls to the content-based (not reviewer-id-based) tiebreak: glm's claim's own fingerprint
    // sorts before qwen's, so "security" wins deterministically — not because glm's reviewerId
    // happens to sort first alphabetically (it does, but that is coincidental here; see the
    // "category resolution" tests below for a case where the alphabetically-first reviewer does
    // NOT win, proving the outcome tracks content and not naming).
    expect(cluster.category).toBe('security');
  });

  it("does not force nova's differently-worded line-3 claim into either cluster", () => {
    // nova's claim ('returns true for null, undefined, or an empty token') genuinely describes
    // the same underlying defect as the line-2 falsy-token cluster to a human reader — but its
    // claim-overlap score against that cluster's representative claim is 0.25, and against the
    // line-3 loose-equality cluster's representative claim is 0.125, both well below the 0.6
    // threshold that the other two clusters clear at 0.625 and 0.6 respectively. Forcing this
    // in would mean lowering the threshold far enough to risk merging genuinely distinct
    // findings elsewhere (that is exactly what the negative-case tests above exist to catch), or
    // adding a semantic judgement this deterministic module deliberately does not make. Left
    // alone, nova's finding surfaces as its own honest 1/3-agreement finding, which is what it
    // is: a real defect, independently described in words too different from either cluster's
    // representative for this module to safely say "same claim".
    const outcome = mergeFindings(loadFixture('live-token-validation.json'), DEFAULT_OPTIONS);
    const lone = outcome.findings.find(
      (f) => f.raisedBy.length === 1 && f.raisedBy[0] === 'openrouter/amazon/nova-micro-v1',
    )!;
    expect(lone).toBeDefined();
    expect(lone.agreement).toEqual({ raisers: 1, reporting: 3 });
    expect(outcome.findings).toHaveLength(3);
  });
});

describe('mergeFindings: category compatibility', () => {
  it('merges security and correctness findings on an identical claim (routine taxonomy disagreement)', () => {
    const results: ReviewerFindings[] = [
      {
        reviewerId: 'a',
        findings: [
          finding({
            file: 'src/x.ts',
            line: 5,
            category: 'security',
            claim: 'Loose equality in the token comparison allows a type-coercion bypass.',
          }),
        ],
      },
      {
        reviewerId: 'b',
        findings: [
          finding({
            file: 'src/x.ts',
            line: 5,
            category: 'correctness',
            claim: 'Loose equality in the token comparison allows a type-coercion bypass.',
          }),
        ],
      },
    ];
    const outcome = mergeFindings(results, DEFAULT_OPTIONS);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]!.agreement.raisers).toBe(2);
  });

  it('does not extend compatibility beyond the security/correctness pair', () => {
    const results: ReviewerFindings[] = [
      {
        reviewerId: 'a',
        findings: [
          finding({
            file: 'src/x.ts',
            line: 5,
            category: 'security',
            claim: 'Loose equality in the token comparison allows a type-coercion bypass.',
          }),
        ],
      },
      {
        reviewerId: 'b',
        findings: [
          finding({
            file: 'src/x.ts',
            line: 5,
            category: 'performance',
            claim: 'Loose equality in the token comparison allows a type-coercion bypass.',
          }),
        ],
      },
    ];
    const outcome = mergeFindings(results, DEFAULT_OPTIONS);
    expect(outcome.findings).toHaveLength(2);
  });
});

describe('mergeFindings: category resolution for mixed-category clusters', () => {
  it('resolves a tied severity by content, not by reviewer-id sort order: renaming reviewers does not change the merged category', () => {
    // Real paraphrase pair from `live-token-validation.json` (F003/F004): its claim-overlap
    // score is exactly 0.6, clearing the default threshold, while the two claims are worded
    // differently enough to have distinct fingerprints — needed so this test actually exercises
    // the tiebreak rather than two identical strings (which would trivially tie the tiebreak
    // too, masking the bug this test guards against).
    const securityClaim =
      'Strict equality was replaced with loose `==`, introducing type-coercion weaknesses in token comparison.';
    const correctnessClaim =
      'The token comparison was changed from strict equality (`===`) to loose equality (`==`), allowing type-coerced matches in a credential check.';

    function build(securityReviewerId: string, correctnessReviewerId: string): ReviewerFindings[] {
      return [
        {
          reviewerId: securityReviewerId,
          findings: [
            finding({
              file: 'src/x.ts',
              line: 5,
              category: 'security',
              severity: 'high',
              claim: securityClaim,
            }),
          ],
        },
        {
          reviewerId: correctnessReviewerId,
          findings: [
            finding({
              file: 'src/x.ts',
              line: 5,
              category: 'correctness',
              severity: 'high',
              claim: correctnessClaim,
            }),
          ],
        },
      ];
    }

    // Case A: the security-labelled finding's reviewerId sorts first alphabetically.
    const caseA = mergeFindings(build('aaa-security-model', 'zzz-correctness-model'), DEFAULT_OPTIONS);
    // Case B: the identical pair of findings — only the reviewer NAMES are renamed, so the
    // CORRECTNESS-labelled finding's reviewerId now sorts first instead.
    const caseB = mergeFindings(build('zzz-security-model', 'aaa-correctness-model'), DEFAULT_OPTIONS);

    expect(caseA.findings).toHaveLength(1);
    expect(caseB.findings).toHaveLength(1);
    expect(caseA.findings[0]!.severity).toBe('high');
    expect(caseB.findings[0]!.severity).toBe('high');
    // If category resolution depended on reviewerId order (the bug this fixes), case A and case
    // B would disagree here purely because of the rename. A tiebreak on each member's own
    // fingerprint (file + claim, never reviewerId) instead guarantees they cannot.
    expect(caseA.findings[0]!.category).toBe(caseB.findings[0]!.category);
  });

  it('takes the category of the highest-severity member when severities differ, even when that member is not the alphabetically-first reviewer', () => {
    const results: ReviewerFindings[] = [
      {
        reviewerId: 'aaa-model', // sorts first — would have supplied the category under the old rule
        findings: [
          finding({
            file: 'src/x.ts',
            line: 5,
            category: 'correctness',
            severity: 'low',
            claim:
              'The token comparison was changed from strict equality (`===`) to loose equality (`==`), allowing type-coerced matches in a credential check.',
          }),
        ],
      },
      {
        reviewerId: 'zzz-model',
        findings: [
          finding({
            file: 'src/x.ts',
            line: 5,
            category: 'security',
            severity: 'critical',
            claim:
              'Strict equality was replaced with loose `==`, introducing type-coercion weaknesses in token comparison.',
          }),
        ],
      },
    ];
    const outcome = mergeFindings(results, DEFAULT_OPTIONS);
    expect(outcome.findings).toHaveLength(1);
    const [f] = outcome.findings;
    // Severity correctly escalates to the critical member's value; category must tell the same
    // story rather than dilute to the low-severity, alphabetically-first reviewer's label.
    expect(f!.severity).toBe('critical');
    expect(f!.category).toBe('security');
  });
});

describe('mergeFindings: evidence and suggestion deduplication', () => {
  it('collapses an exact-duplicate and a case/trailing-punctuation near-duplicate to one entry, keeping the first-seen wording', () => {
    const outcome = mergeFindings(loadFixture('duplicate-evidence.json'), DEFAULT_OPTIONS);
    expect(outcome.findings).toHaveLength(1);
    const [f] = outcome.findings;

    // Three reviewers contributed evidence/suggestion text: model-a and model-b are byte-identical,
    // model-c differs only in leading capitalisation and a trailing period. All three should
    // collapse to the single first-seen string in cluster-member order (sorted by reviewerId,
    // so 'minimax/model-b' is seen first) — which happens to be byte-identical to model-a's text
    // anyway, so the surviving string is unambiguous either way.
    expect(f!.evidence).toEqual(['slice(0, len - 1) should be slice(0, len)']);
    expect(f!.suggestions).toEqual(['drop the "- 1"']);
  });

  it('does not merge two genuinely different evidence strings that happen to share a cluster', () => {
    const results: ReviewerFindings[] = [
      {
        reviewerId: 'a',
        findings: [
          finding({
            file: 'src/x.ts',
            line: 1,
            claim: 'The loop off-by-one skips the last element.',
            evidence: 'The loop condition uses < instead of <=.',
          }),
        ],
      },
      {
        reviewerId: 'b',
        findings: [
          finding({
            file: 'src/x.ts',
            line: 1,
            claim: 'The loop off-by-one skips the last element.',
            evidence: 'The upper bound is computed as length - 1, dropping the final index.',
          }),
        ],
      },
    ];
    const outcome = mergeFindings(results, DEFAULT_OPTIONS);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]!.evidence).toHaveLength(2);
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
