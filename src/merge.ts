/**
 * Merges independent reviewers' findings into one ranked list by deterministic rules only.
 *
 * No model is ever called here, and nothing about the output depends on wall-clock time,
 * randomness or iteration order — see the "Merging is deterministic and model-free" and
 * "Deterministic ordering and identifiers" requirements in
 * `openspec/changes/add-council-review/specs/council-review/findings-merge/spec.md`.
 *
 * This module intentionally does not import from `./runner.js`: its input is the narrow
 * `ReviewerFindings` shape below, not the runner's `ReviewerResult`. Callers (report.ts, cli.ts)
 * adapt `ReviewerResult[]` to `ReviewerFindings[]` at the call site.
 */

import { createHash } from 'node:crypto';

import type { IgnoreFile } from './config.js';
import type { RawFinding, Severity } from './schema.js';

// -------------------------------------------------------------------------------------------
// Public types
// -------------------------------------------------------------------------------------------

/** One reviewer's contribution to a merge. `findings === null` means it never reported (failed,
 * timed out or went over budget) — it counts toward `launched` but not `reporting`. */
export interface ReviewerFindings {
  reviewerId: string; // 'provider/modelId' — stable, used in raisedBy and sources
  findings: RawFinding[] | null;
}

export interface SourceRef {
  reviewer: string;
  findingId: string;
  severity: Severity;
  claim: string;
}

export interface MergedFinding {
  id: string; // assigned AFTER sorting
  fingerprint: string;
  file: string;
  line: number;
  endLine: number | null;
  severity: Severity; // max of members
  category: string;
  claim: string;
  impact: string;
  evidence: string[];
  suggestions: string[];
  raisedBy: string[]; // 'provider/modelId'
  perReviewerSeverity: Record<string, Severity>;
  sources: SourceRef[];
  agreement: { raisers: number; reporting: number };
  unverifiable: boolean;
  memberFingerprints: string[];
}

export interface MergeOptions {
  mergeWindow: number;
  claimSimilarity: number;
  ignore?: IgnoreFile;
  suppress: boolean;
}

export interface MergeOutcome {
  findings: MergedFinding[];
  suppressed: number;
  launched: number;
  reporting: number;
}

// -------------------------------------------------------------------------------------------
// Claim normalisation
//
// Lowercases, strips punctuation (anything that is not a Unicode letter, digit or whitespace),
// collapses whitespace, and drops a small fixed stopword list. This is the normalisation both
// `fingerprint` and clustering's claim-similarity check are built on, so a fingerprint survives
// wording variation (different punctuation, casing or filler words) while still changing for a
// materially different claim.
// -------------------------------------------------------------------------------------------

const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'into', 'onto', 'as',
  'and', 'or', 'but', 'nor', 'not', 'no',
  'it', 'its', 'which', 'who', 'whom', 'whose', 'what', 'when', 'where', 'why', 'how',
  'does', 'do', 'did', 'done', 'has', 'have', 'had', 'having',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'than', 'then', 'there', 'their', 'them', 'they', 'he', 'she', 'his', 'her',
  'you', 'your', 'we', 'our', 'i', 'me', 'my',
  'if', 'so', 'such', 'too', 'very', 'just', 'also', 'about', 'over', 'under',
  'again', 'further', 'once', 'here', 'all', 'any', 'both', 'each', 'few',
  'more', 'most', 'other', 'some', 'only', 'own', 'same', 'out', 'up', 'down', 'off',
]); // prettier-ignore

const PUNCTUATION_RE = /[^\p{L}\p{N}\s]+/gu;
const WHITESPACE_RE = /\s+/g;

/**
 * Lowercases `claim`, strips punctuation, collapses whitespace and removes stopwords, joining
 * the remaining tokens with single spaces. An input with no non-stopword content normalises to
 * the empty string.
 */
export function normaliseClaim(claim: string): string {
  const collapsed = claim
    .toLowerCase()
    .replace(PUNCTUATION_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim();
  if (collapsed === '') return '';
  return collapsed
    .split(' ')
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
    .join(' ');
}

function claimTokens(claim: string): Set<string> {
  const normalised = normaliseClaim(claim);
  return normalised === '' ? new Set() : new Set(normalised.split(' '));
}

/**
 * Overlap coefficient over normalised claim tokens: |intersection| / min(|A|, |B|). Two claims
 * that both normalise to nothing are treated as identical (similarity 1), matching the
 * fingerprint behaviour for the same case.
 *
 * This used to be a plain Jaccard index (|intersection| / |union|), which punishes asymmetric
 * verbosity: one reviewer writes a terse claim, another a detailed one covering the same
 * defect, and the union balloons with the longer claim's extra words while the intersection
 * stays fixed — driving the score down even though every one of the terse claim's tokens is
 * present in the detailed one. Measured against real multi-model output (three models
 * reviewing the same two-line diff), independent models' paraphrases of one defect landed at
 * Jaccard 0.37-0.42 — below any threshold that would not also merge genuinely distinct
 * findings elsewhere — which meant a defect every reviewer agreed on was never clustering, and
 * shipped downstream as several separate low-agreement, "treat with skepticism" findings
 * instead of one high-agreement one. The overlap coefficient is insensitive to one side simply
 * being longer: it only asks whether the *shorter* claim's tokens are (mostly) a subset of the
 * longer one's, which is exactly the "same defect, different verbosity" shape this needed to
 * detect. It was checked against every existing clustering fixture before adopting it (see
 * `test/unit/merge.test.ts`): it does not flip any should-not-merge case into a merge.
 */
function claimOverlap(a: string, b: string): number {
  const ta = claimTokens(a);
  const tb = claimTokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0; // one side has no content-bearing tokens at all
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection++;
  return intersection / Math.min(ta.size, tb.size);
}

/**
 * A lighter normalisation for file paths: lowercased, backslashes folded to forward slashes, a
 * leading "./" dropped, repeated slashes collapsed, and a trailing slash trimmed. Path
 * separators and extensions are structural, not punctuation to strip — unlike claim text,
 * stopword removal does not apply here.
 */
function normaliseFilePath(file: string): string {
  return file
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

/**
 * Fingerprints `file` + `claim`, deliberately excluding line numbers — that is what lets a
 * suppression or a resolution match survive a refactor that moves the code. SHA-256 over the
 * two normalised strings, joined by a NUL byte so no legal path/claim combination can collide
 * across the join point: a normalised file path can contain any printable character (including
 * a literal space, which is why the separator is not one) but never embeds a NUL, and neither
 * does a normalised claim, so `\0` is the one byte that is unambiguously never part of either
 * side. Do not "simplify" this to a space, comma or other visible separator — that would
 * reopen the collision `fingerprint('a/b.ts', 'c')` vs `fingerprint('a', 'b.ts c')` that the
 * NUL join specifically closes.
 *
 * NOTE: this must stay the `\0` escape sequence, not a raw embedded NUL byte — the two are
 * byte-identical once the template literal is evaluated (both are U+0000 in the UTF-8 output
 * fed to the hash), but a literal NUL in the source file itself makes git treat merge.ts as
 * binary (no diffs, no blame, no line-level PR review) for no benefit. The escape sequence is
 * the same fingerprint, in a source file git can still read as text.
 */
export function fingerprint(file: string, claim: string): string {
  const key = `${normaliseFilePath(file)}\0${normaliseClaim(claim)}`;
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

// -------------------------------------------------------------------------------------------
// Clustering
// -------------------------------------------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

interface FlatFinding {
  reviewerId: string;
  findingIndex: number; // index within that reviewer's own findings array
  finding: RawFinding;
}

function lineRange(f: RawFinding): readonly [number, number] {
  return [f.line, f.endLine ?? f.line];
}

/** 0 when the ranges overlap; otherwise the number of lines strictly between them. */
function rangeGap(a: readonly [number, number], b: readonly [number, number]): number {
  if (a[1] < b[0]) return b[0] - a[1];
  if (b[1] < a[0]) return a[0] - b[1];
  return 0;
}

/**
 * Categories that are treated as interchangeable for clustering purposes, beyond plain
 * equality. "security" and "correctness" are the one pair listed here: whether a loose-equality
 * credential check, say, is a security defect or a correctness defect is routine taxonomic
 * disagreement between independent reviewers describing the *same* bug, not a sign they are
 * looking at different problems — measured live, two models raising the identical `==` vs
 * `===` defect on the same line split exactly along this line (one called it "security", the
 * other "correctness"), and a hard category-equality requirement kept them from ever
 * clustering. No other pair is added deliberately: a "security" vs "style" split on an
 * identical claim (see `different-categories.json`) is a much stronger signal of two reviewers
 * flagging genuinely different concerns on the same line (e.g. an injection risk versus a
 * naming nit) than of taxonomic disagreement about one concern, and merging those would hide a
 * real defect inside a cosmetic one — worse than leaving a duplicate category label in the
 * findings list.
 */
const COMPATIBLE_CATEGORIES: ReadonlySet<string> = new Set(['security', 'correctness']);

function categoriesCompatible(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na === nb) return true;
  return COMPATIBLE_CATEGORIES.has(na) && COMPATIBLE_CATEGORIES.has(nb);
}

/** The conjunction that decides whether two findings in the same file belong to one cluster:
 * proximate-or-overlapping lines, AND compatible categories, AND similar-enough claims. Each
 * condition alone is not enough — that is the point of the negative-case scenarios. */
function shouldMerge(a: RawFinding, b: RawFinding, o: MergeOptions): boolean {
  if (rangeGap(lineRange(a), lineRange(b)) > o.mergeWindow) return false;
  if (!categoriesCompatible(a.category, b.category)) return false;
  return claimOverlap(a.claim, b.claim) >= o.claimSimilarity;
}

/**
 * Per-file union-find over `flat`. Findings are grouped by their exact `file` string first, so
 * two findings in different files are never even compared, let alone unioned — clustering
 * cannot cross a file boundary. Within a file, clustering is transitive: unioning is pairwise,
 * but the resulting connected components let a chain of pairwise merges form one cluster even
 * where the endpoints would not merge directly.
 */
function clusterFlatFindings(flat: readonly FlatFinding[], o: MergeOptions): number[][] {
  const byFile = new Map<string, number[]>();
  flat.forEach((f, i) => {
    const list = byFile.get(f.finding.file);
    if (list) list.push(i);
    else byFile.set(f.finding.file, [i]);
  });

  const parent = flat.map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (const indices of byFile.values()) {
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        const a = flat[indices[i]!]!;
        const b = flat[indices[j]!]!;
        if (shouldMerge(a.finding, b.finding, o)) union(indices[i]!, indices[j]!);
      }
    }
  }

  const groups = new Map<number, number[]>();
  flat.forEach((_, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  });
  return Array.from(groups.values());
}

// -------------------------------------------------------------------------------------------
// Free-text deduplication (evidence and suggestions)
//
// When several reviewers independently spot the same defect, it is common — and gets more
// likely as the panel grows, not less — for their `evidence` or `suggestion` strings to be
// near-identical: the clearer and more obvious a defect is, the more likely independent models
// are to describe it in the same words. Concatenating those verbatim, as `assembleCluster` did
// before this normalisation existed, repeated the same line once per agreeing reviewer in both
// the stored `findings.json` and the rendered report — noise that scaled with agreement instead
// of shrinking it, landing hardest on exactly the findings a reader should trust most.
//
// The normalisation below is deliberately much lighter than `normaliseClaim` above. Claim text
// is prose meant to be compared semantically, so stripping all punctuation and stopwords is
// safe. Evidence and suggestion strings routinely quote source code (backticks, operators,
// decimal points, string literals) where punctuation is load-bearing — `normaliseClaim`'s
// blanket strip could equate two genuinely different code snippets. So only the two variations
// reviewers reliably introduce on an otherwise-identical sentence are folded away: casing, and a
// single trailing punctuation mark. Anything else — including internal punctuation, or two
// strings that merely overlap in wording — is left as a distinct entry. Over-merging here would
// silently discard evidence that could matter; under-merging only costs the reader a redundant
// line, so the conservative failure mode is the one this function is biased toward.
// -------------------------------------------------------------------------------------------

function normaliseFreeText(text: string): string {
  return text
    .trim()
    .replace(WHITESPACE_RE, ' ')
    .replace(/[.,;:!?]$/, '')
    .toLowerCase();
}

/** Deduplicates `items` by the normalised key above, keeping the first-seen original string
 * (unmodified) for each distinct key. Order is preserved so the result stays a function of
 * cluster-member order, not of which duplicate happened to be dropped — the same determinism
 * guarantee the rest of this module relies on. */
function dedupeFreeText(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = normaliseFreeText(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

// -------------------------------------------------------------------------------------------
// Cluster assembly
// -------------------------------------------------------------------------------------------

type UnidentifiedFinding = Omit<MergedFinding, 'id'>;

/**
 * Builds one merged finding from a cluster of flat indices. Members are sorted by
 * (reviewerId, findingIndex) first so that every choice made from "the members" — the
 * representative claim/impact/category, fingerprint, evidence and suggestion order — is a
 * function of finding content and reviewer id, never of clustering iteration order.
 */
function assembleCluster(
  indices: readonly number[],
  flat: readonly FlatFinding[],
  reporting: number,
): UnidentifiedFinding {
  const members = indices
    .map((i) => flat[i]!)
    .sort((x, y) => x.reviewerId.localeCompare(y.reviewerId) || x.findingIndex - y.findingIndex);

  // All members share a file (clustering never crosses files); every pair of members has at
  // least *compatible* categories (see `categoriesCompatible`) for any two to have merged in the
  // first place — but compatible is not necessarily equal, so members of one cluster can
  // legitimately disagree on category text (e.g. one reviewer's "security" next to another's
  // "correctness" for the same defect). The representative — the first member in the
  // deterministic order above — supplies the merged finding's own claim and impact text, so the
  // displayed wording is always one reviewer's real, unrewritten sentence rather than a
  // synthesis of several. Category is deliberately NOT taken from the representative — see
  // `category` below — because "first by reviewerId" is alphabetical order of provider/model
  // strings, which has no bearing on which category is the more meaningful one to show.
  const representative = members[0]!;
  const file = representative.finding.file;

  const line = Math.min(...members.map((m) => m.finding.line));
  const maxEndLine = Math.max(...members.map((m) => m.finding.endLine ?? m.finding.line));
  const endLine = maxEndLine > line ? maxEndLine : null;

  const severity = members.reduce<Severity>(
    (max, m) => (SEVERITY_RANK[m.finding.severity] > SEVERITY_RANK[max] ? m.finding.severity : max),
    members[0]!.finding.severity,
  );

  // Category follows the same escalate-don't-dilute principle `SEVERITY_RANK` already applies to
  // severity above. A cluster's members are only guaranteed *compatible* categories, not equal
  // ones, so when they disagree, resolving to "first member by reviewerId" would make the
  // displayed category depend on the alphabetical order of the panel's model names — rename a
  // model and a security finding could silently render as a correctness finding. Taking the
  // category of whichever member holds the cluster's own (already-escalated) severity instead
  // keeps severity and category telling one consistent story: a defect one reviewer flagged as
  // critical/security is never diluted to "correctness" just because a differently-named
  // reviewer's finding happened to sort first. This needs no new ranking table — it reuses
  // `SEVERITY_RANK`, which already exists for severity — unlike a hand-maintained category
  // precedence list, which would need its own justification for every future pair added to
  // `COMPATIBLE_CATEGORIES`.
  //
  // Two members can still tie on severity while disagreeing on category. That tie must NOT be
  // broken by reviewerId (i.e. by `representative`/member order): reviewerId is exactly the
  // arbitrary, renameable input this whole fix exists to stop depending on, and using it here
  // would silently reintroduce the bug for every tied pair. Instead the tie is broken on the
  // same kind of content-derived key `compareMergedFindings` already uses as its own final,
  // never-arbitrary tiebreaker: each tied member's own fingerprint (file + its claim text),
  // ascending. Fingerprint depends only on `file` and `claim`, never on which reviewer said it,
  // so renaming a reviewer changes nothing about which member wins a tie.
  const categoryHolder = members.reduce((best, m) => {
    const bestRank = SEVERITY_RANK[best.finding.severity];
    const mRank = SEVERITY_RANK[m.finding.severity];
    if (mRank !== bestRank) return mRank > bestRank ? m : best;
    return fingerprint(file, m.finding.claim).localeCompare(fingerprint(file, best.finding.claim)) <
      0
      ? m
      : best;
  }, members[0]!);
  const category = categoryHolder.finding.category;

  const perReviewerSeverity: Record<string, Severity> = {};
  for (const m of members) {
    const current = perReviewerSeverity[m.reviewerId];
    if (current === undefined || SEVERITY_RANK[m.finding.severity] > SEVERITY_RANK[current]) {
      perReviewerSeverity[m.reviewerId] = m.finding.severity;
    }
  }

  const raisedBy = Array.from(new Set(members.map((m) => m.reviewerId))).sort();

  const evidence = dedupeFreeText(
    members.map((m) => m.finding.evidence).filter((e): e is string => !!e),
  );
  const suggestions = dedupeFreeText(
    members.map((m) => m.finding.suggestion).filter((s): s is string => !!s),
  );

  const sources: SourceRef[] = members.map((m) => ({
    reviewer: m.reviewerId,
    findingId: String(m.findingIndex),
    severity: m.finding.severity,
    claim: m.finding.claim,
  }));

  const fp = fingerprint(file, representative.finding.claim);
  const memberFingerprints = Array.from(
    new Set(members.map((m) => fingerprint(file, m.finding.claim))),
  );

  return {
    fingerprint: fp,
    file,
    line,
    endLine,
    severity,
    category,
    claim: representative.finding.claim,
    impact: representative.finding.impact,
    evidence,
    suggestions,
    raisedBy,
    perReviewerSeverity,
    sources,
    agreement: { raisers: raisedBy.length, reporting },
    unverifiable: representative.finding.unverifiable ?? false,
    memberFingerprints,
  };
}

// -------------------------------------------------------------------------------------------
// Suppression
// -------------------------------------------------------------------------------------------

/** A cluster is suppressed if its own fingerprint, or any member's fingerprint, matches an
 * ignore-list entry. Checking members too is what lets one reviewer's suppressed claim keep a
 * cluster suppressed even when the merge's representative-choice (see `assembleCluster`) picks
 * a different member as the cluster's own fingerprint on a later run. */
function isSuppressed(cluster: UnidentifiedFinding, ignore: IgnoreFile | undefined): boolean {
  if (!ignore || ignore.entries.length === 0) return false;
  const suppressedFingerprints = new Set(ignore.entries.map((e) => e.fingerprint));
  if (suppressedFingerprints.has(cluster.fingerprint)) return true;
  return cluster.memberFingerprints.some((fp) => suppressedFingerprints.has(fp));
}

// -------------------------------------------------------------------------------------------
// Sorting and identifier assignment
// -------------------------------------------------------------------------------------------

/**
 * Total order: agreement (raisers) descending, severity descending, file path ascending, line
 * ascending, then fingerprint ascending as a final deterministic tiebreaker so no two distinct
 * findings can ever compare equal — without it, findings tied on all four documented keys would
 * fall back to array order, which is not itself guaranteed stable across environments.
 *
 * Sorting by raisers (rather than a raisers/reporting ratio) is equivalent to sorting by
 * agreement ratio here: `reporting` is the same constant for every finding produced by one
 * `mergeFindings` call, so the two orderings never disagree.
 */
function compareMergedFindings(a: UnidentifiedFinding, b: UnidentifiedFinding): number {
  return (
    b.agreement.raisers - a.agreement.raisers ||
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.fingerprint.localeCompare(b.fingerprint)
  );
}

/** Zero-padded, 1-based, assigned strictly after sorting so that identical input always
 * produces identical ids, and ids increase monotonically in the sorted (i.e. written) order. */
function assignId(index: number): string {
  return `F${String(index + 1).padStart(3, '0')}`;
}

// -------------------------------------------------------------------------------------------
// Entry point
// -------------------------------------------------------------------------------------------

/**
 * Merges `results` into one deterministic, ranked findings list. Pure function of its inputs:
 * no model call, no network access, no randomness, no reliance on the wall clock.
 */
export function mergeFindings(results: readonly ReviewerFindings[], o: MergeOptions): MergeOutcome {
  const launched = results.length;
  const reportingResults = results.filter((r) => r.findings !== null);
  const reporting = reportingResults.length;

  const flat: FlatFinding[] = [];
  for (const r of reportingResults) {
    r.findings!.forEach((finding, findingIndex) => {
      flat.push({ reviewerId: r.reviewerId, findingIndex, finding });
    });
  }

  const clusters = clusterFlatFindings(flat, o);
  const assembled = clusters.map((indices) => assembleCluster(indices, flat, reporting));

  let suppressed = 0;
  const kept: UnidentifiedFinding[] = [];
  for (const cluster of assembled) {
    if (o.suppress && isSuppressed(cluster, o.ignore)) {
      suppressed++;
      continue;
    }
    kept.push(cluster);
  }

  const sorted = [...kept].sort(compareMergedFindings);
  const findings: MergedFinding[] = sorted.map((c, i) => ({ id: assignId(i), ...c }));

  return { findings, suppressed, launched, reporting };
}
