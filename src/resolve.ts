/**
 * Diffs one run's merged findings against a previous run's, by fingerprint, so resolution
 * tracking ("did this finding go away?") survives a merge that reassigns ids and reorders
 * output between runs.
 *
 * File layout this module reads — pinned in CONTRACT.md "PINNED: run-directory layout and the
 * most-recent pointer", binding on Sections 14, 15 and 16 alike:
 *
 *   <reviewsDir>/<runId>/findings.json   a top-level JSON array of `MergedFinding`, exactly the
 *                                        shape `mergeFindings` produced for that run.
 *   <reviewsDir>/last                    a SYMLINK to the most recent run's directory, not a
 *                                        text file. The run id is the resolved link's basename.
 *
 * `reviewsDir` is the container directory for all runs (`RunDir.reviewsDir` in the report.ts
 * contract), not one run's own directory. report.ts owns that layout, so every read of it here
 * goes through report.ts's `listRunIds`, `resolveLastRunId` and `readRunFindings`.
 *
 * This module never calls a model, never touches the network, and never reads the wall clock —
 * a diff is a pure function of the two finding sets it is given.
 */
import path from 'node:path';

import type { MergedFinding } from './merge.js';
import { listRunIds, readRunFindings, resolveLastRunId } from './report.js';

export type ResolutionState = 'resolved' | 'still-present' | 'new';

export interface MarkedFinding extends MergedFinding {
  resolution: ResolutionState | null; // null when there is no baseline to compare against
}

export interface ResolutionOutcome {
  baselineRunId: string | null; // null when no baseline was available
  current: MarkedFinding[];
  resolved: MarkedFinding[]; // present before, absent now
  counts: { resolved: number; stillPresent: number; new: number };
}

/** Thrown for a named previous run that is missing or unreadable. Never thrown for the
 * "no previous run exists at all" case, which is not an error — see `loadPreviousFindings`. */
export class ResolveError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = 'ResolveError';
    Object.setPrototypeOf(this, ResolveError.prototype);
  }
}

function findingsFile(reviewsDir: string, runId: string): string {
  return path.join(reviewsDir, runId, 'findings.json');
}

/**
 * Resolves `ref` to a previous run's merged findings. Reads only the previous run, never the
 * current one, so the CLI calls it before creating the new run directory or launching any
 * reviewer: a bad `--since` then fails fast instead of after a paid panel has run, and the
 * loaded baseline is handed to `diffAgainstBaseline` once merging is done.
 *
 * - `ref === 'last'`: resolves the `last` symlink and loads that run's findings. Any failure
 *   along this path — no `last` symlink, because no run has ever completed; a dangling `last`
 *   pointing at a run directory that no longer exists; a `last` that is not a symlink at all; or
 *   a resolved run whose findings file is missing, unreadable or malformed — is treated as "no previous run exists" and returns `null`. This is
 *   not an error: it is the "No previous run exists" scenario, and the caller proceeds without
 *   resolution marking.
 * - `ref` is a specific run id: it must be one of the run ids `listRunIds` lists (so `.`, `..`,
 *   a nested path or any other string that is not a run directory's own name is rejected before
 *   anything is read), and that run must be readable. Any failure is the "Unknown or unreadable
 *   previous run" scenario and throws `ResolveError` naming the run.
 */
export function loadPreviousFindings(
  reviewsDir: string,
  ref: 'last' | string,
): { runId: string; findings: MergedFinding[] } | null {
  if (ref === 'last') {
    const runId = resolveLastRunId(reviewsDir);
    if (runId === null) return null;

    const findings = readRunFindings(reviewsDir, runId);
    if (findings === null) return null;
    return { runId, findings };
  }

  if (!listRunIds(reviewsDir).includes(ref)) {
    throw new ResolveError(
      `Cannot diff against previous run "${ref}": no such run under ${reviewsDir} ` +
        '(expected "last" or the id of a run directory there).',
    );
  }
  const findings = readRunFindings(reviewsDir, ref);
  if (findings === null) {
    throw new ResolveError(
      `Cannot diff against previous run "${ref}": its merged findings could not be found or ` +
        `read at ${findingsFile(reviewsDir, ref)}.`,
    );
  }
  return { runId: ref, findings };
}

/** Every fingerprint a finding can be matched on: its own plus each cluster member's. A
 * baseline written before `memberFingerprints` existed (or a malformed one) contributes only its
 * own fingerprint. */
function matchKeys(f: MergedFinding): string[] {
  const members: unknown = (f as Partial<MergedFinding>).memberFingerprints;
  const extra = Array.isArray(members)
    ? members.filter((m): m is string => typeof m === 'string')
    : [];
  return [f.fingerprint, ...extra];
}

/**
 * Marks each of `current`'s findings `still-present` or `new` against `baseline`, and collects
 * every baseline finding absent from `current` as `resolved`. Two findings match when their
 * fingerprint sets — each one's own fingerprint plus its `memberFingerprints` — intersect,
 * mirroring how suppression matches (merge.ts `isSuppressed`): a cluster's own fingerprint is
 * its representative member's, and the representative can change between runs (e.g. the
 * reviewer whose wording was chosen fails next time) without the defect changing. Matching is
 * never by id, which is reassigned on every merge, and never by line, which fingerprints
 * deliberately exclude so a suppression or a match survives a refactor. The accepted trade-off:
 * a defect whose every reviewer rewords its claim substantially between runs presents as one
 * `resolved` plus one `new`, because no fingerprint survived.
 *
 * When `baseline` is `null` there is nothing to compare against, and the run proceeds *without*
 * resolution marking — not with every finding marked `'new'`, which would itself be a marking,
 * and a false one: a report leading with "N new findings" on a project's first-ever run would
 * assert a comparison that never happened. Every current finding instead carries
 * `resolution: null`, `resolved` is empty, `baselineRunId` is `null`, and every count is 0 —
 * `null` makes the no-baseline case structurally distinct so a consumer cannot accidentally
 * render it as a diff.
 */
export function diffAgainstBaseline(
  current: readonly MergedFinding[],
  baseline: { runId: string; findings: MergedFinding[] } | null,
): ResolutionOutcome {
  if (baseline === null) {
    const marked: MarkedFinding[] = current.map((f) => ({ ...f, resolution: null }));
    return {
      baselineRunId: null,
      current: marked,
      resolved: [],
      counts: { resolved: 0, stillPresent: 0, new: 0 },
    };
  }

  const baselineKeys = new Set(baseline.findings.flatMap(matchKeys));
  const currentKeys = new Set(current.flatMap(matchKeys));

  const markedCurrent: MarkedFinding[] = current.map((f) => ({
    ...f,
    resolution: matchKeys(f).some((k) => baselineKeys.has(k)) ? 'still-present' : 'new',
  }));

  const resolved: MarkedFinding[] = baseline.findings
    .filter((f) => !matchKeys(f).some((k) => currentKeys.has(k)))
    .map((f) => ({ ...f, resolution: 'resolved' }));

  const counts = {
    resolved: resolved.length,
    stillPresent: markedCurrent.filter((f) => f.resolution === 'still-present').length,
    new: markedCurrent.filter((f) => f.resolution === 'new').length,
  };

  return { baselineRunId: baseline.runId, current: markedCurrent, resolved, counts };
}

/**
 * The findings document to persist (`findings.json`) and emit (`--json`) for a run: the merged
 * findings as-is when no diff was requested (`resolution === null`), and otherwise the same
 * findings, in the same order, each carrying its `resolution` field (`null` throughout when
 * `--since` found no baseline). Resolved findings — absent from this run by definition — are
 * never included: they belong to the report and the manifest, and a later `--since` reading this
 * file must not see them as present.
 */
export function findingsWithResolution(
  findings: readonly MergedFinding[],
  resolution: null,
): readonly MergedFinding[];
export function findingsWithResolution(
  findings: readonly MergedFinding[],
  resolution: ResolutionOutcome,
): MarkedFinding[];
export function findingsWithResolution(
  findings: readonly MergedFinding[],
  resolution: ResolutionOutcome | null,
): readonly MergedFinding[];
export function findingsWithResolution(
  findings: readonly MergedFinding[],
  resolution: ResolutionOutcome | null,
): readonly MergedFinding[] | MarkedFinding[] {
  if (resolution === null) return findings;
  const byId = new Map(resolution.current.map((f) => [f.id, f.resolution]));
  return findings.map((f) => ({ ...f, resolution: byId.get(f.id) ?? null }));
}
