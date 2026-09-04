// Provenance tool for the fake-host fixture streams in this directory. The committed .jsonl
// files ARE the fixtures — the stub replays recorded data, not code that synthesises events at
// test time — this script exists only so the exact construction of that recorded data is
// auditable and reproducible; it is not run by any test or build step. Re-run with
// `node test/fixtures/streams/generate.mjs` to regenerate the .jsonl files in place after
// editing this script. Fidelity target: the verified `--mode json` event catalog in
// SCRATCH/host-notes.md section A (pi 0.84.4).
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
const FENCE = 'council-findings';

// ---- Usage helper -----------------------------------------------------------------------------
// Mirrors the real `Usage` shape verified in host-notes section A: input/output/cacheRead/
// cacheWrite/totalTokens plus a per-category cost breakdown. Cumulative across the whole
// conversation captured in each fixture, growing turn over turn — matches "message_end.usage is
// the authoritative cumulative total for that message", not a delta.
const RATE_IN = 3; // fake USD/MTok, plausible mid-tier reasoning model
const RATE_OUT = 15;
function usage(input, output, cacheRead = 0, cacheWrite = 0, reasoning) {
  const u = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: round((input * RATE_IN) / 1e6),
      output: round((output * RATE_OUT) / 1e6),
      cacheRead: round((cacheRead * RATE_IN * 0.1) / 1e6),
      cacheWrite: round((cacheWrite * RATE_IN * 1.25) / 1e6),
      total: round(
        (input * RATE_IN +
          output * RATE_OUT +
          cacheRead * RATE_IN * 0.1 +
          cacheWrite * RATE_IN * 1.25) /
          1e6,
      ),
    },
  };
  if (reasoning !== undefined) u.reasoning = reasoning;
  return u;
}
function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

function line(obj) {
  return JSON.stringify(obj);
}

// ---- Findings blocks ----------------------------------------------------------------------------
const VALID_FINDINGS = JSON.stringify(
  [
    {
      file: 'src/foo.ts',
      line: 42,
      endLine: 47,
      severity: 'high',
      category: 'correctness',
      claim: 'off-by-one when slicing the trailing chunk',
      impact: 'the last byte of the buffer is silently dropped on every call',
      evidence: 'slice(0, len - 1) should be slice(0, len)',
      suggestion: 'drop the "- 1"',
      confidence: 0.82,
    },
  ],
  null,
  2,
);
function findingsBlock(json) {
  return ['```' + FENCE, json, '```'].join('\n');
}

const INVALID_FINDINGS_JSON = JSON.stringify(
  [
    {
      file: 'src/foo.ts',
      line: 42,
      severity: 'severe', // not one of critical|high|medium|low
      category: 'correctness',
      claim: 'off-by-one when slicing the trailing chunk',
      // impact is missing — required field
    },
  ],
  null,
  2,
);

// ============================================================================================
// Fixture: clean-with-tools — a clean run, two tool-using turns (council_read, council_grep),
// then a final turn with a valid findings block. Exercises the depth signal (files opened,
// searches run) as well as the happy path.
// ============================================================================================
{
  const lines = [];
  const REVIEW_PROMPT =
    'You are reviewing a patch for correctness and security issues. Read the affected files and ' +
    'report findings as instructed.';

  lines.push(line({ type: 'agent_start' }));

  // --- Turn 1: council_read -------------------------------------------------------------------
  lines.push(line({ type: 'turn_start' }));
  lines.push(
    line({
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: REVIEW_PROMPT }] },
    }),
  );
  lines.push(
    line({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: REVIEW_PROMPT }] },
    }),
  );

  const u0 = usage(0, 0);
  lines.push(
    line({
      type: 'message_start',
      message: { role: 'assistant', stopReason: 'pending', content: [], usage: u0 },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(812, 4),
      assistantMessageEvent: { type: 'start' },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(812, 6),
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    }),
  );
  for (const [i, delta] of [
    "I'll start by ",
    'reading the changed file ',
    'to understand the context.',
  ].entries()) {
    lines.push(
      line({
        type: 'message_update',
        usage: usage(812, 10 + i * 6),
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
      }),
    );
  }
  lines.push(
    line({
      type: 'message_update',
      usage: usage(812, 28),
      assistantMessageEvent: {
        type: 'text_end',
        contentIndex: 0,
        content: "I'll start by reading the changed file to understand the context.",
      },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(812, 30),
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 1,
        id: 'call_1',
        toolName: 'council_read',
      },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(812, 36),
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 1,
        delta: '{"path":"src/foo.ts"}',
      },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(812, 38),
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: {
          type: 'toolCall',
          id: 'call_1',
          name: 'council_read',
          arguments: { path: 'src/foo.ts' },
        },
      },
    }),
  );
  const turn1AssistantContent = [
    { type: 'text', text: "I'll start by reading the changed file to understand the context." },
    { type: 'toolCall', id: 'call_1', name: 'council_read', arguments: { path: 'src/foo.ts' } },
  ];
  const turn1Usage = usage(812, 38);
  lines.push(
    line({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: turn1AssistantContent,
        usage: turn1Usage,
      },
    }),
  );
  lines.push(
    line({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'council_read',
      args: { path: 'src/foo.ts' },
    }),
  );
  const readResult = {
    content: [
      {
        type: 'text',
        text: '1\texport function foo(buf: Buffer, len: number) {\n2\t  return buf.slice(0, len - 1);\n3\t}\n',
      },
    ],
    details: { path: 'src/foo.ts', lines: 3 },
  };
  lines.push(
    line({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'council_read',
      result: readResult,
      isError: false,
    }),
  );
  const toolResultMessage1 = {
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: 'council_read',
    content: readResult.content,
    isError: false,
    timestamp: '2026-08-30T10:00:01.000Z',
  };
  lines.push(line({ type: 'message_start', message: toolResultMessage1 }));
  lines.push(line({ type: 'message_end', message: toolResultMessage1 }));
  lines.push(
    line({
      type: 'turn_end',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: turn1AssistantContent,
        usage: turn1Usage,
      },
      toolResults: [toolResultMessage1],
    }),
  );

  // --- Turn 2: council_grep ---------------------------------------------------------------------
  lines.push(line({ type: 'agent_start' }));
  lines.push(line({ type: 'turn_start' }));
  lines.push(
    line({
      type: 'message_start',
      message: { role: 'assistant', stopReason: 'pending', content: [], usage: usage(940, 0) },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(940, 4),
      assistantMessageEvent: { type: 'start' },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(940, 6),
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(940, 14),
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: "Now I'll check for similar patterns elsewhere.",
      },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(940, 16),
      assistantMessageEvent: {
        type: 'text_end',
        contentIndex: 0,
        content: "Now I'll check for similar patterns elsewhere.",
      },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(940, 18),
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 1,
        id: 'call_2',
        toolName: 'council_grep',
      },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(940, 26),
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 1,
        delta: '{"pattern":"slice(0, len - 1)","path":"src"}',
      },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(940, 28),
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: {
          type: 'toolCall',
          id: 'call_2',
          name: 'council_grep',
          arguments: { pattern: 'slice(0, len - 1)', path: 'src' },
        },
      },
    }),
  );
  const turn2AssistantContent = [
    { type: 'text', text: "Now I'll check for similar patterns elsewhere." },
    {
      type: 'toolCall',
      id: 'call_2',
      name: 'council_grep',
      arguments: { pattern: 'slice(0, len - 1)', path: 'src' },
    },
  ];
  const turn2Usage = usage(940, 28);
  lines.push(
    line({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: turn2AssistantContent,
        usage: turn2Usage,
      },
    }),
  );
  lines.push(
    line({
      type: 'tool_execution_start',
      toolCallId: 'call_2',
      toolName: 'council_grep',
      args: { pattern: 'slice(0, len - 1)', path: 'src' },
    }),
  );
  const grepResult = {
    content: [{ type: 'text', text: 'src/foo.ts:2:  return buf.slice(0, len - 1);\n' }],
    details: { matches: 1 },
  };
  lines.push(
    line({
      type: 'tool_execution_end',
      toolCallId: 'call_2',
      toolName: 'council_grep',
      result: grepResult,
      isError: false,
    }),
  );
  const toolResultMessage2 = {
    role: 'toolResult',
    toolCallId: 'call_2',
    toolName: 'council_grep',
    content: grepResult.content,
    isError: false,
    timestamp: '2026-08-30T10:00:02.000Z',
  };
  lines.push(line({ type: 'message_start', message: toolResultMessage2 }));
  lines.push(line({ type: 'message_end', message: toolResultMessage2 }));
  lines.push(
    line({
      type: 'turn_end',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: turn2AssistantContent,
        usage: turn2Usage,
      },
      toolResults: [toolResultMessage2],
    }),
  );

  // --- Turn 3: final answer with findings block -------------------------------------------------
  lines.push(line({ type: 'agent_start' }));
  lines.push(line({ type: 'turn_start' }));
  lines.push(
    line({
      type: 'message_start',
      message: { role: 'assistant', stopReason: 'pending', content: [], usage: usage(1080, 0) },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(1080, 4),
      assistantMessageEvent: { type: 'start' },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(1080, 6),
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    }),
  );
  const finalText =
    'Found one issue: the buffer slice drops the last byte.\n\n' + findingsBlock(VALID_FINDINGS);
  const chunks = [
    'Found one issue: ',
    'the buffer slice drops the last byte.\n\n',
    '```' + FENCE + '\n',
    VALID_FINDINGS + '\n',
    '```',
  ];
  let outTok = 8;
  for (const c of chunks) {
    outTok += Math.max(4, Math.round(c.length / 4));
    lines.push(
      line({
        type: 'message_update',
        usage: usage(1080, outTok),
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: c },
      }),
    );
  }
  lines.push(
    line({
      type: 'message_update',
      usage: usage(1080, outTok + 2),
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: finalText },
    }),
  );
  const finalUsage = usage(1080, outTok + 2);
  const finalContent = [{ type: 'text', text: finalText }];
  lines.push(
    line({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: finalContent, usage: finalUsage },
    }),
  );
  lines.push(
    line({
      type: 'turn_end',
      message: { role: 'assistant', stopReason: 'stop', content: finalContent, usage: finalUsage },
      toolResults: [],
    }),
  );
  lines.push(
    line({
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          stopReason: 'toolUse',
          content: turn1AssistantContent,
          usage: turn1Usage,
        },
        toolResultMessage1,
        {
          role: 'assistant',
          stopReason: 'toolUse',
          content: turn2AssistantContent,
          usage: turn2Usage,
        },
        toolResultMessage2,
        { role: 'assistant', stopReason: 'stop', content: finalContent, usage: finalUsage },
      ],
      willRetry: false,
    }),
  );

  writeFileSync(`${OUT}/clean-with-tools.jsonl`, lines.join('\n') + '\n');
}

// ============================================================================================
// Fixture: invalid-findings — single turn, no tool calls, final answer's findings block fails
// schema validation (bad severity value, missing required "impact"). Reused verbatim for both
// "invalid then valid on repair" (paired with valid-findings.jsonl) and "invalid twice" (played
// for both attempts) — see test/helpers/fake-host.ts.
// ============================================================================================
function singleTurnFixture(filename, { promptTail, finalProse, findingsJson }) {
  const lines = [];
  const REVIEW_PROMPT = `You are reviewing a patch for correctness and security issues. ${promptTail}`;
  lines.push(line({ type: 'agent_start' }));
  lines.push(line({ type: 'turn_start' }));
  lines.push(
    line({
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: REVIEW_PROMPT }] },
    }),
  );
  lines.push(
    line({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: REVIEW_PROMPT }] },
    }),
  );
  lines.push(
    line({
      type: 'message_start',
      message: { role: 'assistant', stopReason: 'pending', content: [], usage: usage(430, 0) },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(430, 4),
      assistantMessageEvent: { type: 'start' },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(430, 6),
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    }),
  );
  const finalText = finalProse + '\n\n' + findingsBlock(findingsJson);
  const chunks = [finalProse + '\n\n', '```' + FENCE + '\n', findingsJson + '\n', '```'];
  let outTok = 8;
  for (const c of chunks) {
    outTok += Math.max(4, Math.round(c.length / 4));
    lines.push(
      line({
        type: 'message_update',
        usage: usage(430, outTok),
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: c },
      }),
    );
  }
  lines.push(
    line({
      type: 'message_update',
      usage: usage(430, outTok + 2),
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: finalText },
    }),
  );
  const finalUsage = usage(430, outTok + 2);
  const finalContent = [{ type: 'text', text: finalText }];
  lines.push(
    line({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: finalContent, usage: finalUsage },
    }),
  );
  lines.push(
    line({
      type: 'turn_end',
      message: { role: 'assistant', stopReason: 'stop', content: finalContent, usage: finalUsage },
      toolResults: [],
    }),
  );
  lines.push(
    line({
      type: 'agent_end',
      messages: [
        { role: 'assistant', stopReason: 'stop', content: finalContent, usage: finalUsage },
      ],
      willRetry: false,
    }),
  );
  writeFileSync(`${OUT}/${filename}`, lines.join('\n') + '\n');
}

singleTurnFixture('invalid-findings.jsonl', {
  promptTail: 'Report findings as instructed.',
  finalProse: 'Found one issue: the buffer slice drops the last byte.',
  findingsJson: INVALID_FINDINGS_JSON,
});

singleTurnFixture('valid-findings.jsonl', {
  promptTail:
    'Your previous findings block could not be validated. Fix the listed problems and re-emit your ' +
    'complete findings as a single corrected block.',
  finalProse: 'Apologies — corrected below.',
  findingsJson: VALID_FINDINGS,
});

// ============================================================================================
// Fixture: truncated — stream is cut off mid-response: partial text deltas, no message_end, no
// turn_end, no agent_end. The stub exits(1) right after the last written line, simulating a
// crashed/killed host process with no clean shutdown line (matches host-notes: no closing event
// is ever written on either graceful or forced termination).
// ============================================================================================
{
  const lines = [];
  const REVIEW_PROMPT =
    'You are reviewing a patch for correctness and security issues. Report findings as instructed.';
  lines.push(line({ type: 'agent_start' }));
  lines.push(line({ type: 'turn_start' }));
  lines.push(
    line({
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: REVIEW_PROMPT }] },
    }),
  );
  lines.push(
    line({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: REVIEW_PROMPT }] },
    }),
  );
  lines.push(
    line({
      type: 'message_start',
      message: { role: 'assistant', stopReason: 'pending', content: [], usage: usage(390, 0) },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(390, 4),
      assistantMessageEvent: { type: 'start' },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(390, 6),
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    }),
  );
  for (const [i, delta] of [
    'Looking at the diff, ',
    'the change to the buffer handling ',
    'in src/foo.ts appears to intro',
  ].entries()) {
    lines.push(
      line({
        type: 'message_update',
        usage: usage(390, 10 + i * 5),
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
      }),
    );
  }
  // Stream cuts off here — no text_end, no message_end, no turn_end, no agent_end. Partial text
  // reconstructable only from the concatenated text_delta values above:
  // "Looking at the diff, the change to the buffer handling in src/foo.ts appears to intro"
  writeFileSync(`${OUT}/truncated.jsonl`, lines.join('\n') + '\n');
}

// ============================================================================================
// Fixture: unparseable-lines — a normal short clean run (no tool calls) with garbage lines
// interleaved at three points: before any real event, mid-stream between valid events, and
// between the final message_end and agent_end. The runner must preserve these in the raw trace
// without aborting parsing of the surrounding valid events.
// ============================================================================================
{
  const lines = [];
  const REVIEW_PROMPT =
    'You are reviewing a patch for correctness and security issues. Report findings as instructed.';

  lines.push('>>> connection reset by peer <<<'); // garbage before anything else
  lines.push(line({ type: 'agent_start' }));
  lines.push(line({ type: 'turn_start' }));
  lines.push(
    line({
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: REVIEW_PROMPT }] },
    }),
  );
  lines.push(
    line({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: REVIEW_PROMPT }] },
    }),
  );
  lines.push(
    line({
      type: 'message_start',
      message: { role: 'assistant', stopReason: 'pending', content: [], usage: usage(410, 0) },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(410, 4),
      assistantMessageEvent: { type: 'start' },
    }),
  );
  lines.push(
    '{"type":"message_update","usage":{"input":410,"output":5,"cacheRead":0,"cacheWrite":0',
  ); // truncated JSON, mid-stream
  lines.push(
    line({
      type: 'message_update',
      usage: usage(410, 6),
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    }),
  );
  const finalProse = 'No issues found in the reviewed range.';
  const emptyFindings = '[]';
  const finalText = finalProse + '\n\n' + findingsBlock(emptyFindings);
  const chunks = [finalProse + '\n\n', '```' + FENCE + '\n', emptyFindings + '\n', '```'];
  let outTok = 8;
  for (const c of chunks) {
    outTok += Math.max(4, Math.round(c.length / 4));
    lines.push(
      line({
        type: 'message_update',
        usage: usage(410, outTok),
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: c },
      }),
    );
  }
  lines.push(
    line({
      type: 'message_update',
      usage: usage(410, outTok + 2),
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: finalText },
    }),
  );
  const finalUsage = usage(410, outTok + 2);
  const finalContent = [{ type: 'text', text: finalText }];
  lines.push(
    line({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: finalContent, usage: finalUsage },
    }),
  );
  lines.push('not json at all {{{'); // garbage between message_end and turn_end/agent_end
  lines.push(
    line({
      type: 'turn_end',
      message: { role: 'assistant', stopReason: 'stop', content: finalContent, usage: finalUsage },
      toolResults: [],
    }),
  );
  lines.push(
    line({
      type: 'agent_end',
      messages: [
        { role: 'assistant', stopReason: 'stop', content: finalContent, usage: finalUsage },
      ],
      willRetry: false,
    }),
  );
  writeFileSync(`${OUT}/unparseable-lines.jsonl`, lines.join('\n') + '\n');
}

// ============================================================================================
// Fixture: never-ends — a small set of "still thinking" lines the stub loops forever (with a
// delay between each) so a runner timeout has something to kill. No message_end/agent_end ever
// appears among these base lines by design.
// ============================================================================================
{
  const lines = [];
  lines.push(line({ type: 'agent_start' }));
  lines.push(line({ type: 'turn_start' }));
  lines.push(
    line({
      type: 'message_start',
      message: { role: 'assistant', stopReason: 'pending', content: [], usage: usage(500, 0) },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(500, 4),
      assistantMessageEvent: { type: 'start' },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(500, 6),
      assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
    }),
  );
  lines.push(
    line({
      type: 'message_update',
      usage: usage(500, 12),
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'Still working through the diff... ',
      },
    }),
  );
  writeFileSync(`${OUT}/never-ends.jsonl`, lines.join('\n') + '\n');
}

console.log('Fixtures written to', OUT);
