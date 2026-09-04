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
 * contract), not one run's own directory.
 *
 * This module never calls a model, never touches the network, and never reads the wall clock —
 * a diff is a pure function of the two finding sets it is given.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { MergedFinding } from './merge.js';

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

function lastPointerFile(reviewsDir: string): string {
  return path.join(reviewsDir, 'last');
}

/**
 * Resolves the `last` symlink to the run id it points at. `fs.realpathSync` both follows the
 * symlink and fails exactly when it should be treated as absent: a missing `last` entry and a
 * `last` that points at a run directory that no longer exists (e.g. one `gc` has since removed)
 * both raise ENOENT here, and both collapse to the same "no baseline available" outcome via the
 * `null` return — deliberately not distinguished, per the findings-merge spec's requirement that
 * the no-previous-run case proceed rather than error.
 */
function resolveLastPointer(reviewsDir: string): string | null {
  let resolved: string;
  try {
    resolved = fs.realpathSync(lastPointerFile(reviewsDir));
  } catch {
    return null;
  }
  return path.basename(resolved);
}

/** Reads and parses `file` as a JSON array of `MergedFinding`. Returns `null` on any failure —
 * missing file, unreadable file, invalid JSON, or JSON that is not an array — rather than
 * throwing, so callers can decide what a given failure means for their `ref`. */
function readFindingsFile(file: string): MergedFinding[] | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? (parsed as MergedFinding[]) : null;
}

/**
 * Resolves `ref` to a previous run's merged findings.
 *
 * - `ref === 'last'`: resolves the `last` symlink and loads that run's findings. Any failure
 *   along this path — no `last` symlink, because no run has ever completed; a dangling `last`
 *   pointing at a run directory that no longer exists; or a resolved run whose findings file is
 *   missing or unreadable — is treated as "no previous run exists" and returns `null`. This is
 *   not an error: it is the "No previous run exists" scenario, and the caller proceeds without
 *   resolution marking.
 * - `ref` is a specific run id: that run is expected to exist and be readable. Any failure is
 *   the "Unknown or unreadable previous run" scenario and throws `ResolveError` naming the run.
 */
export function loadPreviousFindings(
  reviewsDir: string,
  ref: 'last' | string,
): { runId: string; findings: MergedFinding[] } | null {
  if (ref === 'last') {
    const runId = resolveLastPointer(reviewsDir);
    if (runId === null) return null;

    const findings = readFindingsFile(findingsFile(reviewsDir, runId));
    if (findings === null) return null;
    return { runId, findings };
  }

  const findings = readFindingsFile(findingsFile(reviewsDir, ref));
  if (findings === null) {
    throw new ResolveError(
      `Cannot diff against previous run "${ref}": its merged findings could not be found or ` +
        `read at ${findingsFile(reviewsDir, ref)}.`,
    );
  }
  return { runId: ref, findings };
}

/**
 * Marks each of `current`'s findings `still-present` or `new` against `baseline`, and collects
 * every baseline finding absent from `current` as `resolved`. Matching is by fingerprint only —
 * never by id, which is reassigned on every merge, and never by line, which fingerprints
 * deliberately exclude so a suppression or a match survives a refactor. The accepted trade-off:
 * a reviewer that rewords a claim substantially between runs presents as one `resolved` plus
 * one `new`, because its fingerprint genuinely changed.
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

  const baselineFingerprints = new Set(baseline.findings.map((f) => f.fingerprint));
  const currentFingerprints = new Set(current.map((f) => f.fingerprint));

  const markedCurrent: MarkedFinding[] = current.map((f) => ({
    ...f,
    resolution: baselineFingerprints.has(f.fingerprint) ? 'still-present' : 'new',
  }));

  const resolved: MarkedFinding[] = baseline.findings
    .filter((f) => !currentFingerprints.has(f.fingerprint))
    .map((f) => ({ ...f, resolution: 'resolved' }));

  const counts = {
    resolved: resolved.length,
    stillPresent: markedCurrent.filter((f) => f.resolution === 'still-present').length,
    new: markedCurrent.filter((f) => f.resolution === 'new').length,
  };

  return { baselineRunId: baseline.runId, current: markedCurrent, resolved, counts };
}
