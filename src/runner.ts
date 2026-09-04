/**
 * Spawns the reviewer panel: one independent host process per reviewer, launched in parallel and
 * in ignorance of each other, and turns each one's `--mode json` event stream into a
 * `ReviewerResult` — final text, usage, cost, tool calls, the review-depth signal, and (when its
 * output fails the findings schema) exactly one repair attempt. See
 * `openspec/changes/add-council-review/specs/council-review/review-execution/spec.md` for the
 * requirements this implements, and `SCRATCH/host-notes.md` section A for the exact event shapes
 * this module parses.
 *
 * This module never validates the findings schema itself (`schema.ts` owns that) and never
 * decides isolation flags or the child's environment allowlist (`reviewer-spawn.ts` owns that,
 * Section 9, security-critical); it only orchestrates process lifecycle and stream parsing.
 */
import * as childProcessModule from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  buildReviewerArgv,
  buildReviewerEnv,
  resolveHostBin,
  reviewerCwd,
} from './reviewer-spawn.js';
import type { Reviewer } from './panel.js';
import {
  extractFindings,
  markUnverifiable,
  repairInstruction,
  FINDINGS_BLOCK_INSTRUCTIONS,
  type RawFinding,
} from './schema.js';
import type { Snapshot } from './snapshot.js';

// -------------------------------------------------------------------------------------------
// Public shapes (pinned in SCRATCH/CONTRACT.md — Sections 15 and 16 are written against these)
// -------------------------------------------------------------------------------------------

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /** Milliseconds elapsed since the attempt that made this call was spawned. */
  at: number;
}

export type ReviewerState = 'ok' | 'failed' | 'timeout' | 'over-budget';

export interface ReviewerResult {
  reviewer: Reviewer;
  state: ReviewerState;
  findings: RawFinding[] | null; // null when it never produced a valid block
  finalText: string; // verbatim terminal text (or partial) of the FIRST attempt
  repairText: string | null; // verbatim second attempt, when one was made
  usage: { inputTokens: number; outputTokens: number };
  cost: number | null; // null === unknown (no catalog rates)
  depth: { filesOpened: string[]; searches: number };
  toolCalls: ToolCall[];
  rawTrace: string[]; // every stream line, including unparseable ones
  startedAt: number;
  endedAt: number;
  error?: string;
}

/**
 * The minimal surface `ProgressReporter` needs from an output destination -- deliberately not the
 * full `NodeJS.WritableStream` interface, so a test double can be a two-line object literal rather
 * than a real stream. `process.stdout` satisfies this structurally, `isTTY` included.
 */
export interface ProgressSink {
  write(chunk: string): unknown;
  readonly isTTY?: boolean;
}

export interface RunPanelOptions {
  reviewers: readonly Reviewer[];
  snapshot: Snapshot;
  repoRoot: string;
  patchPath: string; // path in the RUN dir; never inside the snapshot
  prompt: string;
  extensionPath: string;
  includeContextFiles: boolean;
  timeoutSeconds: number;
  maxOutputTokens: number;
  onProgress?: (r: ReviewerResult[]) => void;
  signal?: AbortSignal;
  /** Where the live/plain progress lines (task 11.7) are written. Defaults to `process.stdout`.
   *  Injectable so a caller that needs its own stdout kept clean (e.g. `--json` output) can
   *  redirect this instead of monkey-patching the global stream, and so it's testable without one. */
  progressStream?: ProgressSink;
}

export interface RunPanelOutcome {
  results: ReviewerResult[];
  launched: number;
  reporting: number; // results whose findings !== null
  degraded: boolean;
  totalCost: number | null;
  costIncomplete: boolean;
}

// -------------------------------------------------------------------------------------------
// Prompt assembly
// -------------------------------------------------------------------------------------------

/**
 * Builds the one prompt text handed to every reviewer's first attempt: the shared task prompt,
 * the patch itself (read once from `patchPath`, never from inside the snapshot), and the
 * findings-block emission instructions, embedded verbatim. Computed once per run and passed
 * unchanged to every reviewer — this identical-input property is what "no cross-contamination"
 * rests on structurally, not on a runtime check.
 */
function buildInitialPrompt(taskPrompt: string, patchContent: string): string {
  return [
    taskPrompt.trim(),
    '',
    'The patch under review (unified diff):',
    '```diff',
    patchContent,
    '```',
    '',
    FINDINGS_BLOCK_INSTRUCTIONS,
  ].join('\n');
}

/**
 * Builds the repair prompt for a reviewer's second attempt. Per the findings-contract spec's
 * "Repair does not leak other reviewers" scenario, this contains ONLY the validation errors and
 * that reviewer's own prior output — `repairInstruction`'s signature already makes it structurally
 * incapable of carrying anything else, and this function adds nothing beyond a plain heading that
 * introduces the reviewer's own text back to it.
 */
function buildRepairPrompt(errors: readonly string[], priorText: string): string {
  return [repairInstruction(errors), '', 'Your previous response:', '', priorText].join('\n');
}

// -------------------------------------------------------------------------------------------
// Cost conversion
// -------------------------------------------------------------------------------------------

/** Catalog rates are USD per million tokens; absent rates record unknown, never zero. */
function computeCost(
  usage: { input: number; output: number },
  inputCostPerMTok: number | null,
  outputCostPerMTok: number | null,
): number | null {
  if (inputCostPerMTok === null || outputCostPerMTok === null) return null;
  return (
    (usage.input / 1_000_000) * inputCostPerMTok + (usage.output / 1_000_000) * outputCostPerMTok
  );
}

// -------------------------------------------------------------------------------------------
// Review-depth signal
// -------------------------------------------------------------------------------------------

/**
 * Derives the depth signal from recorded tool calls: which files were opened (`council_read`,
 * `args.path`) and how many searches were run (`council_grep` call count). Other tool calls
 * (`council_list`, `council_git`) are still recorded in `toolCalls` but do not contribute here —
 * the spec names files-opened and searches-run as the minimum signal.
 */
function computeDepth(toolCalls: readonly ToolCall[]): { filesOpened: string[]; searches: number } {
  const files = new Set<string>();
  let searches = 0;
  for (const call of toolCalls) {
    if (call.name === 'council_read' && typeof call.args.path === 'string') {
      files.add(call.args.path);
    } else if (call.name === 'council_grep') {
      searches += 1;
    }
  }
  return { filesOpened: [...files].sort(), searches };
}

// -------------------------------------------------------------------------------------------
// Event-stream parsing
// -------------------------------------------------------------------------------------------

interface Usage {
  input: number;
  output: number;
}

function parseUsage(v: unknown): Usage | null {
  if (typeof v !== 'object' || v === null) return null;
  const input = (v as Record<string, unknown>).input;
  const output = (v as Record<string, unknown>).output;
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  return { input, output };
}

function isAssistantMessage(v: unknown): v is { role: string; content?: unknown; usage?: unknown } {
  return typeof v === 'object' && v !== null && (v as { role?: unknown }).role === 'assistant';
}

function isTextDeltaEvent(v: unknown): v is { type: 'text_delta'; delta: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { type?: unknown }).type === 'text_delta' &&
    typeof (v as { delta?: unknown }).delta === 'string'
  );
}

/** Concatenates every `type: "text"` content block, in order. Skips thinking/toolCall blocks. */
function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      out += (block as { text: string }).text;
    }
  }
  return out;
}

type KillReason = 'timeout' | 'over-budget' | 'interrupted';

/** Mutable per-attempt parse state, threaded through as stream lines arrive. */
interface AttemptState {
  readonly startedAt: number;
  readonly maxOutputTokens: number;
  toolCalls: ToolCall[];
  rawTrace: string[];
  usageTotal: Usage;
  /** Usage of the assistant message currently being streamed, not yet folded into `usageTotal`
   *  because its `message_end` has not (yet) arrived. Reset on every assistant `message_start`. */
  pendingTurnUsage: Usage | null;
  hasOpenAssistantMessage: boolean;
  everCompletedAssistant: boolean;
  partialText: string;
  completedFinalText: string | null;
  killReason: KillReason | null;
  kill: () => void;
  /** Notified with the running cumulative usage-so-far on every usage-bearing event, so progress
   *  reporting (task 11.7) can show live token counts rather than only a start/end snapshot. */
  onUsage: ((usage: Usage) => void) | undefined;
}

/** Usage folded so far, plus whatever the still-open (not yet `message_end`'d) turn last reported. */
function computeCurrentUsage(state: AttemptState): Usage {
  return {
    input: state.usageTotal.input + (state.pendingTurnUsage?.input ?? 0),
    output: state.usageTotal.output + (state.pendingTurnUsage?.output ?? 0),
  };
}

function checkBudget(state: AttemptState): void {
  if (state.killReason) return;
  const currentOutput = computeCurrentUsage(state).output;
  if (currentOutput > state.maxOutputTokens) {
    state.killReason = 'over-budget';
    state.kill();
  }
}

function handleLine(raw: string, state: AttemptState): void {
  state.rawTrace.push(raw);

  // Once a budget has been breached (or the attempt aborted/timed out), freeze interpretation of
  // the stream at that point, even though the OS-level kill signal hasn't necessarily reached the
  // child yet. Without this guard, a fast, unpaced fixture (or a fast real reviewer) can have its
  // *entire* remaining output already sitting in the same already-received stdout chunk, which
  // this line reader would otherwise keep folding into partial text and usage after the point the
  // reviewer was conceptually terminated -- the line is still recorded above for the raw trace,
  // just no longer interpreted.
  if (state.killReason) return;

  let evt: unknown;
  try {
    evt = JSON.parse(raw);
  } catch {
    // Unparseable line: preserved above in rawTrace, tolerated here per the "Unparseable stream
    // lines" scenario — extraction of the surrounding valid events must not abort.
    return;
  }
  if (typeof evt !== 'object' || evt === null || !('type' in evt)) return;
  const type = (evt as { type: unknown }).type;

  if (type === 'message_start') {
    const message = (evt as { message?: unknown }).message;
    if (isAssistantMessage(message)) {
      state.hasOpenAssistantMessage = true;
      state.partialText = '';
      state.pendingTurnUsage = parseUsage((message as { usage?: unknown }).usage);
    }
    return;
  }

  if (type === 'message_update') {
    const usage = parseUsage((evt as { usage?: unknown }).usage);
    if (usage) state.pendingTurnUsage = usage;
    const ame = (evt as { assistantMessageEvent?: unknown }).assistantMessageEvent;
    if (isTextDeltaEvent(ame)) {
      state.partialText += ame.delta;
    }
    checkBudget(state);
    state.onUsage?.(computeCurrentUsage(state));
    return;
  }

  if (type === 'message_end') {
    const message = (evt as { message?: unknown }).message;
    if (isAssistantMessage(message)) {
      state.everCompletedAssistant = true;
      state.hasOpenAssistantMessage = false;
      state.completedFinalText = extractAssistantText((message as { content?: unknown }).content);
      const usage = parseUsage((message as { usage?: unknown }).usage);
      if (usage) {
        state.usageTotal = {
          input: state.usageTotal.input + usage.input,
          output: state.usageTotal.output + usage.output,
        };
      }
      state.pendingTurnUsage = null;
      checkBudget(state);
      state.onUsage?.(computeCurrentUsage(state));
    }
    return;
  }

  if (type === 'tool_execution_start') {
    const toolName = (evt as { toolName?: unknown }).toolName;
    const args = (evt as { args?: unknown }).args;
    if (typeof toolName === 'string') {
      state.toolCalls.push({
        name: toolName,
        args:
          typeof args === 'object' && args !== null && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
        at: Date.now() - state.startedAt,
      });
    }
    return;
  }
}

// -------------------------------------------------------------------------------------------
// Single process attempt
// -------------------------------------------------------------------------------------------

type AttemptOutcome =
  'completed' | 'timeout' | 'over-budget' | 'truncated' | 'interrupted' | 'spawn-error';

interface AttemptResult {
  text: string;
  usage: Usage;
  toolCalls: ToolCall[];
  rawTrace: string[];
  outcome: AttemptOutcome;
  errorMessage: string | undefined;
  startedAt: number;
  endedAt: number;
}

interface AttemptOptions {
  reviewer: Reviewer;
  promptText: string;
  extensionPath: string;
  includeContextFiles: boolean;
  snapshotRoot: string;
  repoRoot: string;
  timeoutSeconds: number;
  maxOutputTokens: number;
  hostBin: string;
  signal: AbortSignal | undefined;
  onUsage: ((usage: Usage) => void) | undefined;
}

/**
 * Builds the child's environment: exactly `reviewer-spawn.ts`'s security allowlist, plus the two
 * roots the extension needs. No exception is carved out here for anything test-only -- the fake
 * host used throughout this suite selects its fixture from an argument baked into the binary path
 * `COUNCIL_PI_BIN` resolves to (see `test/helpers/fake-host.ts`), precisely so that this function
 * never has to know the fake host exists. The child's environment is always, exactly,
 * `buildReviewerEnv`'s output.
 */
function buildAttemptEnv(snapshotRoot: string, repoRoot: string): NodeJS.ProcessEnv {
  return buildReviewerEnv({
    ...process.env,
    COUNCIL_SNAPSHOT_ROOT: snapshotRoot,
    COUNCIL_REPO_ROOT: repoRoot,
  });
}

/**
 * Spawns one reviewer host process, parses its `--mode json` stream, and resolves once the
 * process's stdout has fully drained and the process itself has exited (or been killed). Never
 * rejects: spawn failures, timeouts, budget breaches and truncation are all reported through
 * `AttemptResult.outcome`, so the caller never has to distinguish a thrown error from a reported
 * failure mode.
 *
 * The argv and env are built and `spawn()` is called synchronously, before any `await` — this
 * keeps the launch order of concurrently-started attempts equal to the order their callers invoke
 * this function in, which is what makes a shared `sequenceEnv` selector (see
 * `test/helpers/fake-host.ts`) deterministic across parallel reviewers.
 */
function runAttempt(o: AttemptOptions): Promise<AttemptResult> {
  const startedAt = Date.now();

  const argv = buildReviewerArgv({
    extensionPath: o.extensionPath,
    provider: o.reviewer.provider,
    model: o.reviewer.model,
    thinking: o.reviewer.thinking.effective,
    includeContextFiles: o.includeContextFiles,
    prompt: o.promptText,
  });
  const env = buildAttemptEnv(o.snapshotRoot, o.repoRoot);
  const cwd = reviewerCwd(o.snapshotRoot);

  let child: childProcessModule.ChildProcessWithoutNullStreams;
  try {
    child = childProcessModule.spawn(o.hostBin, argv, { cwd, env });
  } catch (err) {
    const endedAt = Date.now();
    return Promise.resolve({
      text: '',
      usage: { input: 0, output: 0 },
      toolCalls: [],
      rawTrace: [],
      outcome: 'spawn-error',
      errorMessage: err instanceof Error ? err.message : String(err),
      startedAt,
      endedAt,
    });
  }

  try {
    child.stdin.end();
  } catch {
    // Best-effort: nothing is ever written to stdin.
  }
  child.stderr.resume(); // drain so a chatty stderr never applies backpressure to the process

  const state: AttemptState = {
    startedAt,
    maxOutputTokens: o.maxOutputTokens,
    toolCalls: [],
    rawTrace: [],
    usageTotal: { input: 0, output: 0 },
    pendingTurnUsage: null,
    hasOpenAssistantMessage: false,
    everCompletedAssistant: false,
    partialText: '',
    completedFinalText: null,
    killReason: null,
    kill: () => child.kill('SIGTERM'),
    onUsage: o.onUsage,
  };

  return new Promise<AttemptResult>((resolve) => {
    let settled = false;
    let rlClosed = false;
    let childClosed = false;
    let spawnErrored = false;
    let spawnErrorMessage: string | undefined;

    const timeoutTimer = setTimeout(() => {
      if (state.killReason) return;
      state.killReason = 'timeout';
      state.kill();
    }, o.timeoutSeconds * 1000);

    const onAbort = () => {
      if (state.killReason) return;
      state.killReason = 'interrupted';
      state.kill();
    };
    o.signal?.addEventListener('abort', onAbort);

    const lines = createLineReader(child.stdout);
    lines.on('line', (line: string) => handleLine(line, state));
    lines.on('close', () => {
      rlClosed = true;
      finalize();
    });

    child.on('error', (err) => {
      spawnErrored = true;
      spawnErrorMessage = err.message;
      childClosed = true;
      finalize();
    });

    child.on('close', () => {
      childClosed = true;
      finalize();
    });

    function finalize(): void {
      if (settled) return;
      if (!rlClosed || !childClosed) return;
      settled = true;
      clearTimeout(timeoutTimer);
      o.signal?.removeEventListener('abort', onAbort);

      const endedAt = Date.now();

      if (spawnErrored) {
        resolve({
          text: '',
          usage: state.usageTotal,
          toolCalls: state.toolCalls,
          rawTrace: state.rawTrace,
          outcome: 'spawn-error',
          errorMessage: spawnErrorMessage,
          startedAt,
          endedAt,
        });
        return;
      }

      // Fold in whatever the still-open (never message_end'd) turn last reported, exactly once.
      let usage = state.usageTotal;
      if (state.hasOpenAssistantMessage && state.pendingTurnUsage) {
        usage = {
          input: usage.input + state.pendingTurnUsage.input,
          output: usage.output + state.pendingTurnUsage.output,
        };
      }

      let outcome: AttemptOutcome;
      let text: string;
      if (state.killReason === 'timeout') {
        outcome = 'timeout';
        text = state.hasOpenAssistantMessage ? state.partialText : (state.completedFinalText ?? '');
      } else if (state.killReason === 'over-budget') {
        outcome = 'over-budget';
        text = state.hasOpenAssistantMessage ? state.partialText : (state.completedFinalText ?? '');
      } else if (state.killReason === 'interrupted') {
        outcome = 'interrupted';
        text = state.hasOpenAssistantMessage ? state.partialText : (state.completedFinalText ?? '');
      } else if (state.hasOpenAssistantMessage || !state.everCompletedAssistant) {
        outcome = 'truncated';
        text = state.partialText;
      } else {
        outcome = 'completed';
        text = state.completedFinalText ?? '';
      }

      resolve({
        text,
        usage,
        toolCalls: state.toolCalls,
        rawTrace: state.rawTrace,
        outcome,
        errorMessage: undefined,
        startedAt,
        endedAt,
      });
    }
  });
}

/** Minimal newline-delimited reader over a Readable stream. Avoids pulling in `node:readline`
 *  purely for line-splitting; buffers across chunk boundaries, including a final unterminated
 *  line flushed on stream end (matches the truncated fixture, whose last written line has no
 *  trailing newline). */
function createLineReader(stream: NodeJS.ReadableStream): {
  on(event: 'line', cb: (line: string) => void): void;
  on(event: 'close', cb: () => void): void;
} {
  const lineListeners: Array<(line: string) => void> = [];
  const closeListeners: Array<() => void> = [];
  let buffer = '';

  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) for (const cb of lineListeners) cb(line);
    }
  });
  stream.on('end', () => {
    if (buffer.length > 0) {
      const line = buffer.replace(/\r$/, '');
      buffer = '';
      if (line.length > 0) for (const cb of lineListeners) cb(line);
    }
    for (const cb of closeListeners) cb();
  });
  stream.on('error', () => {
    for (const cb of closeListeners) cb();
  });

  return {
    on(event: 'line' | 'close', cb: ((line: string) => void) | (() => void)): void {
      if (event === 'line') lineListeners.push(cb as (line: string) => void);
      else closeListeners.push(cb as () => void);
    },
  };
}

// -------------------------------------------------------------------------------------------
// Per-reviewer orchestration: first attempt, then (only for invalid output) exactly one repair
// -------------------------------------------------------------------------------------------

interface ReviewerRunOptions {
  reviewer: Reviewer;
  initialPrompt: string;
  extensionPath: string;
  includeContextFiles: boolean;
  snapshot: Snapshot;
  repoRoot: string;
  timeoutSeconds: number;
  maxOutputTokens: number;
  hostBin: string;
  signal: AbortSignal | undefined;
  onUsage: ((usage: Usage) => void) | undefined;
}

function attemptErrorMessage(
  outcome: AttemptOutcome,
  o: ReviewerRunOptions,
  attempt: AttemptResult,
): string | undefined {
  switch (outcome) {
    case 'timeout':
      return `reviewer exceeded its ${o.timeoutSeconds}s timeout`;
    case 'over-budget':
      return `reviewer exceeded its ${o.maxOutputTokens}-token output ceiling`;
    case 'interrupted':
      return 'run was interrupted';
    case 'truncated':
      return 'stream ended without a terminal assistant message';
    case 'spawn-error':
      return attempt.errorMessage ?? 'failed to spawn the reviewer process';
    default:
      return undefined;
  }
}

async function runReviewer(o: ReviewerRunOptions): Promise<ReviewerResult> {
  const attempt1 = await runAttempt({
    reviewer: o.reviewer,
    promptText: o.initialPrompt,
    extensionPath: o.extensionPath,
    includeContextFiles: o.includeContextFiles,
    snapshotRoot: o.snapshot.root,
    repoRoot: o.repoRoot,
    timeoutSeconds: o.timeoutSeconds,
    maxOutputTokens: o.maxOutputTokens,
    hostBin: o.hostBin,
    signal: o.signal,
    onUsage: o.onUsage,
  });

  const budgetOrTimeoutOrInterrupt: ReviewerState | null =
    attempt1.outcome === 'timeout'
      ? 'timeout'
      : attempt1.outcome === 'over-budget'
        ? 'over-budget'
        : null;

  // A budget/timeout breach or an interruption on the first attempt ends the reviewer's run
  // there: no repair attempt is spawned for a process we deliberately killed, or that was killed
  // out from under it by the user interrupting the whole run.
  if (budgetOrTimeoutOrInterrupt || attempt1.outcome === 'interrupted') {
    const state: ReviewerState = budgetOrTimeoutOrInterrupt ?? 'failed';
    return buildResult(
      o.reviewer,
      state,
      null,
      attempt1,
      null,
      attemptErrorMessage(attempt1.outcome, o, attempt1),
    );
  }

  if (attempt1.outcome === 'truncated' || attempt1.outcome === 'spawn-error') {
    // "Truncated stream" scenario: marked failed directly, no repair attempt for a process that
    // never produced a terminal message to validate in the first place.
    return buildResult(
      o.reviewer,
      'failed',
      null,
      attempt1,
      null,
      attemptErrorMessage(attempt1.outcome, o, attempt1),
    );
  }

  // attempt1.outcome === 'completed'
  const extracted1 = extractFindings(attempt1.text);
  if (extracted1.ok) {
    const findings = markUnverifiable(extracted1.findings, o.snapshot.files);
    return buildResult(o.reviewer, 'ok', findings, attempt1, null, undefined);
  }

  if (o.signal?.aborted) {
    return buildResult(
      o.reviewer,
      'failed',
      null,
      attempt1,
      null,
      'run was interrupted before repair could be attempted',
    );
  }

  // Exactly one repair attempt: a second, independent process spawn, given only the validation
  // errors and this reviewer's own prior output.
  const attempt2 = await runAttempt({
    reviewer: o.reviewer,
    promptText: buildRepairPrompt(extracted1.errors, attempt1.text),
    extensionPath: o.extensionPath,
    includeContextFiles: o.includeContextFiles,
    snapshotRoot: o.snapshot.root,
    repoRoot: o.repoRoot,
    timeoutSeconds: o.timeoutSeconds,
    maxOutputTokens: o.maxOutputTokens,
    hostBin: o.hostBin,
    signal: o.signal,
    onUsage: o.onUsage,
  });

  if (attempt2.outcome === 'timeout') {
    return buildResult(
      o.reviewer,
      'timeout',
      null,
      attempt1,
      attempt2,
      attemptErrorMessage('timeout', o, attempt2),
    );
  }
  if (attempt2.outcome === 'over-budget') {
    return buildResult(
      o.reviewer,
      'over-budget',
      null,
      attempt1,
      attempt2,
      attemptErrorMessage('over-budget', o, attempt2),
    );
  }
  if (
    attempt2.outcome === 'truncated' ||
    attempt2.outcome === 'spawn-error' ||
    attempt2.outcome === 'interrupted'
  ) {
    return buildResult(
      o.reviewer,
      'failed',
      null,
      attempt1,
      attempt2,
      attemptErrorMessage(attempt2.outcome, o, attempt2),
    );
  }

  const extracted2 = extractFindings(attempt2.text);
  if (extracted2.ok) {
    const findings = markUnverifiable(extracted2.findings, o.snapshot.files);
    return buildResult(o.reviewer, 'ok', findings, attempt1, attempt2, undefined);
  }

  // "Repair fails": marked failed, both attempts preserved verbatim.
  return buildResult(
    o.reviewer,
    'failed',
    null,
    attempt1,
    attempt2,
    `repaired output still failed validation: ${extracted2.errors.join('; ')}`,
  );
}

function buildResult(
  reviewer: Reviewer,
  state: ReviewerState,
  findings: RawFinding[] | null,
  attempt1: AttemptResult,
  attempt2: AttemptResult | null,
  error: string | undefined,
): ReviewerResult {
  const usage = attempt2
    ? {
        input: attempt1.usage.input + attempt2.usage.input,
        output: attempt1.usage.output + attempt2.usage.output,
      }
    : attempt1.usage;
  const toolCalls = attempt2 ? [...attempt1.toolCalls, ...attempt2.toolCalls] : attempt1.toolCalls;
  const rawTrace = attempt2 ? [...attempt1.rawTrace, ...attempt2.rawTrace] : attempt1.rawTrace;

  return {
    reviewer,
    state,
    findings,
    finalText: attempt1.text,
    repairText: attempt2 ? attempt2.text : null,
    usage: { inputTokens: usage.input, outputTokens: usage.output },
    cost: computeCost(usage, reviewer.catalog.inputCostPerMTok, reviewer.catalog.outputCostPerMTok),
    depth: computeDepth(toolCalls),
    toolCalls,
    rawTrace,
    startedAt: attempt1.startedAt,
    endedAt: (attempt2 ?? attempt1).endedAt,
    ...(error !== undefined ? { error } : {}),
  };
}

// -------------------------------------------------------------------------------------------
// Progress reporting (task 11.7)
// -------------------------------------------------------------------------------------------

interface ProgressEntry {
  key: string;
  state: 'running' | ReviewerState;
  startedAt: number;
  tokens: { input: number; output: number };
}

/**
 * Renders one live line per reviewer under a terminal (redrawn in place with ANSI cursor
 * movement), degrading to plain appended lines -- one per state transition, never a cursor-control
 * sequence -- otherwise. This is direct terminal rendering, independent of `onProgress`: the
 * public `onProgress` callback (typed `ReviewerResult[]`) can only ever carry genuinely complete
 * results (there is no "running" member of `ReviewerState` to fabricate one from), so it is fed
 * separately, by `runPanel`, only as reviewers actually finish.
 */
class ProgressReporter {
  private readonly entries: ProgressEntry[];
  private readonly isTTY: boolean;
  private readonly out: ProgressSink;
  private lastRenderAt = 0;

  constructor(reviewers: readonly Reviewer[], out: ProgressSink = process.stdout) {
    this.out = out;
    const now = Date.now();
    this.entries = reviewers.map((r) => ({
      key: `${r.provider}/${r.model}`,
      state: 'running',
      startedAt: now,
      tokens: { input: 0, output: 0 },
    }));
    this.isTTY = Boolean(out.isTTY);
    if (this.isTTY) {
      for (const e of this.entries) this.out.write(this.line(e) + '\n');
    }
  }

  private line(e: ProgressEntry): string {
    const elapsedS = ((Date.now() - e.startedAt) / 1000).toFixed(1);
    return `${e.key}: ${e.state} elapsed=${elapsedS}s tokens=${e.tokens.input}/${e.tokens.output}`;
  }

  private redraw(): void {
    if (!this.isTTY || this.entries.length === 0) return;
    this.out.write(`\x1b[${this.entries.length}A`);
    for (const e of this.entries) this.out.write('\x1b[2K' + this.line(e) + '\n');
  }

  tick(idx: number, tokens: { input: number; output: number }): void {
    const e = this.entries[idx];
    if (!e) return;
    e.tokens = tokens;
    if (!this.isTTY) return;
    const now = Date.now();
    if (now - this.lastRenderAt < 100) return; // throttle redraws
    this.lastRenderAt = now;
    this.redraw();
  }

  complete(idx: number, result: ReviewerResult): void {
    const e = this.entries[idx];
    if (!e) return;
    e.state = result.state;
    e.tokens = { input: result.usage.inputTokens, output: result.usage.outputTokens };
    if (this.isTTY) {
      this.redraw();
    } else {
      // Non-interactive: one appended plain line per reviewer, at the point it finishes, no
      // cursor-control sequences.
      this.out.write(this.line(e) + '\n');
    }
  }
}

// -------------------------------------------------------------------------------------------
// runPanel
// -------------------------------------------------------------------------------------------

/**
 * Runs the whole panel: every reviewer launched in parallel, none waiting on another, each
 * receiving the same task/prompt/patch and nothing produced by any other reviewer.
 *
 * Interruption (`o.signal` firing) terminates every in-flight reviewer process, cleans up the
 * snapshot, and rejects with an `AbortError`-named `Error` -- the standard shape for an aborted
 * operation -- rather than resolving with a partial `RunPanelOutcome`. A run that completed
 * without every reviewer succeeding, including one where every reviewer failed, still resolves
 * normally: the caller (Section 16) maps `reporting === 0` to exit code 3.
 */
export async function runPanel(o: RunPanelOptions): Promise<RunPanelOutcome> {
  const hostBin = resolveHostBin(process.env);
  const patchContent = readFileSync(o.patchPath, 'utf8');
  const initialPrompt = buildInitialPrompt(o.prompt, patchContent);

  const progress = new ProgressReporter(o.reviewers, o.progressStream);
  const results: Array<ReviewerResult | undefined> = new Array(o.reviewers.length);

  const runOne = async (reviewer: Reviewer, idx: number): Promise<void> => {
    const result = await runReviewer({
      reviewer,
      initialPrompt,
      extensionPath: o.extensionPath,
      includeContextFiles: o.includeContextFiles,
      snapshot: o.snapshot,
      repoRoot: o.repoRoot,
      timeoutSeconds: o.timeoutSeconds,
      maxOutputTokens: o.maxOutputTokens,
      hostBin,
      signal: o.signal,
      onUsage: (usage) => progress.tick(idx, usage),
    });
    results[idx] = result;
    progress.complete(idx, result);
    o.onProgress?.(results.filter((r): r is ReviewerResult => r !== undefined));
  };

  // Every reviewer is started here, in the same synchronous pass, before any of them is awaited
  // -- this is the parallel launch the spec requires, and array order determines spawn order
  // (see `runAttempt`'s own note on why that matters for tests).
  await Promise.all(o.reviewers.map((reviewer, idx) => runOne(reviewer, idx)));

  if (o.signal?.aborted) {
    o.snapshot.cleanup();
    const err = new Error('council-review run interrupted');
    err.name = 'AbortError';
    throw err;
  }

  const finished = results as ReviewerResult[]; // every slot is filled: Promise.all resolved above

  const reporting = finished.filter((r) => r.findings !== null).length;
  const degraded = finished.some((r) => r.state !== 'ok');

  let totalCost = 0;
  let anyKnownCost = false;
  let anyUnknownCost = false;
  for (const r of finished) {
    if (r.cost === null) {
      anyUnknownCost = true;
    } else {
      totalCost += r.cost;
      anyKnownCost = true;
    }
  }

  return {
    results: finished,
    launched: o.reviewers.length,
    reporting,
    degraded,
    totalCost: anyKnownCost ? totalCost : null,
    costIncomplete: anyUnknownCost,
  };
}
