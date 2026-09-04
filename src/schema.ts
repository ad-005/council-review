/**
 * The findings contract: the fixed schema every reviewer's structured output is held to, plus
 * extraction of that structured block out of a reviewer's free-form terminal text, and the
 * single repair instruction issued when extraction fails.
 *
 * Extraction is read-only. It locates the block, parses it, and validates it against the
 * schema below — it never trims, normalises or re-wraps any string a reviewer produced. The
 * caller (the runner) is responsible for preserving both attempts' verbatim text regardless of
 * outcome; this module never sees or needs the full verbatim text after it has located the
 * block within it.
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value, ValueErrorType, type ValueError } from '@sinclair/typebox/value';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface RawFinding {
  file: string;
  line: number;
  endLine?: number;
  severity: Severity;
  category: string;
  claim: string;
  impact: string; // "a description of the failure it would cause"
  evidence?: string;
  suggestion?: string;
  confidence?: number;
  unverifiable?: boolean; // set by the runner when `file` is absent from the snapshot
}

export type ExtractResult = { ok: true; findings: RawFinding[] } | { ok: false; errors: string[] };

// --- The schema reviewer output is validated against -----------------------------------------
//
// `additionalProperties: false` is deliberate: an unrecognised field is exactly the kind of
// mistake a repair attempt can fix, so it must surface as a validation error rather than be
// silently dropped. `unverifiable` is not part of this schema — a reviewer never emits it; it is
// attached afterwards by `markUnverifiable` once findings are checked against the snapshot.

const FindingSchema = Type.Object(
  {
    file: Type.String({ minLength: 1 }),
    line: Type.Integer({ minimum: 1 }),
    endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    severity: Type.Union([
      Type.Literal('critical'),
      Type.Literal('high'),
      Type.Literal('medium'),
      Type.Literal('low'),
    ]),
    category: Type.String({ minLength: 1 }),
    claim: Type.String({ minLength: 1 }),
    impact: Type.String({ minLength: 1 }),
    evidence: Type.Optional(Type.String()),
    suggestion: Type.Optional(Type.String()),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

const FindingsSchema = Type.Array(FindingSchema);

// Structural self-check: RawFinding (minus the runner-attached `unverifiable`) must be
// assignable to and from the TypeBox-inferred static type, so the hand-written interface above
// and the schema below cannot silently drift apart.
type _SchemaMatchesRawFinding =
  Static<typeof FindingSchema> extends Omit<RawFinding, 'unverifiable'>
    ? Omit<RawFinding, 'unverifiable'> extends Static<typeof FindingSchema>
      ? true
      : never
    : never;
const _schemaMatchesRawFinding: _SchemaMatchesRawFinding = true;
void _schemaMatchesRawFinding;

// --- Block location ----------------------------------------------------------------------------
//
// A reviewer emits prose plus one structured block, fenced with a stable marker so it can be
// found regardless of what surrounds it. See `FINDINGS_BLOCK_INSTRUCTIONS` for the exact format
// handed to reviewers; the two are tested against each other below.

const FENCE_MARKER = 'council-findings';

// A "fence line" is a line that is, once trimmed of leading whitespace, three-or-more backticks
// followed by an optional info string (a language tag, the marker, or both, in either order).
const FENCE_LINE_RE = /^[ \t]*`{3,}[ \t]*(.*?)[ \t]*$/;

function tokenize(infoString: string): string[] {
  return infoString
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);
}

interface LocateResult {
  content: string | null;
  error: string | null;
}

/**
 * Scans `text` line by line for the findings block. Reviewers occasionally duplicate the
 * opening fence line (retrying mid-stream) or add a stray language tag alongside the marker;
 * both are tolerated. The first line that opens a block wins; a repeated opening-marker line
 * found before a real close is treated as noise, not the close, so a genuinely duplicated
 * opening fence does not truncate the captured content to nothing.
 */
function locateFindingsBlock(text: string): LocateResult {
  const lines = text.split(/\r\n|\r|\n/);

  let openIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = FENCE_LINE_RE.exec(line);
    if (m && tokenize(m[1] ?? '').includes(FENCE_MARKER)) {
      openIndex = i;
      break;
    }
  }
  if (openIndex === -1) {
    return {
      content: null,
      error:
        'no findings block found: expected a fenced code block whose opening line is three ' +
        `backticks followed by "${FENCE_MARKER}" (e.g. \`\`\`${FENCE_MARKER})`,
    };
  }

  let closeIndex = -1;
  const strayFenceLines = new Set<number>();
  for (let i = openIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = FENCE_LINE_RE.exec(line);
    if (!m) continue;
    // A repeated opening-marker line is stray noise, not the close: keep looking, and drop it
    // from the captured content below rather than letting it leak in as JSON text.
    if (tokenize(m[1] ?? '').includes(FENCE_MARKER)) {
      strayFenceLines.add(i);
      continue;
    }
    closeIndex = i;
    break;
  }
  if (closeIndex === -1) {
    return {
      content: null,
      error:
        `the findings block opened at line ${openIndex + 1} is never closed with a bare ` +
        '```` ``` ```` line',
    };
  }

  const content = lines
    .slice(openIndex + 1, closeIndex)
    .filter((_, offset) => !strayFenceLines.has(openIndex + 1 + offset))
    .join('\n')
    .trim();
  return { content, error: null };
}

function describeJsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

interface ParseResult {
  value: unknown;
  error: string | null;
}

function parseBlockJson(content: string): ParseResult {
  if (content.length === 0) {
    return {
      value: undefined,
      error: 'the findings block is empty; it must contain a JSON array, e.g. [] for no findings',
    };
  }
  try {
    return { value: JSON.parse(content), error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { value: undefined, error: `the findings block is not valid JSON: ${message}` };
  }
}

// --- Validation error formatting ----------------------------------------------------------------
//
// Errors must be specific enough for a model to repair from: which finding (by index), which
// field, and what was wrong with it — never just "invalid".

function pathParts(path: string): { index: string; field: string | null } {
  const segments = path.split('/').filter(Boolean);
  const index = segments[0] ?? '?';
  const rest = segments.slice(1);
  return { index, field: rest.length > 0 ? rest.join('.') : null };
}

function locationOf(err: ValueError): string {
  const { index, field } = pathParts(err.path);
  return field ? `finding[${index}].${field}` : `finding[${index}]`;
}

function describeValueError(err: ValueError): string {
  const loc = locationOf(err);
  const got = () => `(got ${JSON.stringify(err.value)})`;
  switch (err.type) {
    case ValueErrorType.ObjectRequiredProperty:
      return `${loc} is required but missing`;
    case ValueErrorType.ObjectAdditionalProperties:
      return `${loc} is not a recognised field; remove it`;
    case ValueErrorType.Union:
      return `${loc} must be one of critical, high, medium, low ${got()}`;
    case ValueErrorType.StringMinLength:
      return `${loc} must not be empty`;
    case ValueErrorType.String:
      return `${loc} must be a string ${got()}`;
    case ValueErrorType.Integer:
    case ValueErrorType.IntegerMinimum:
      return `${loc} must be an integer >= 1 ${got()}`;
    case ValueErrorType.Number:
      return `${loc} must be a number between 0 and 1 ${got()}`;
    case ValueErrorType.NumberMinimum:
    case ValueErrorType.NumberMaximum:
      return `${loc} must be a number between 0 and 1 ${got()}`;
    case ValueErrorType.Array:
      return `${loc} must be an array`;
    case ValueErrorType.Object:
      return `${loc} must be an object`;
    default:
      return `${loc}: ${err.message} ${got()}`;
  }
}

/**
 * Converts TypeBox's raw error stream into specific, repair-actionable messages. A missing
 * required property is reported as exactly that — TypeBox also emits a redundant type-mismatch
 * error at the same path (since `undefined` fails the field's own type check too); that
 * redundant error is dropped in favour of the clearer "required but missing" message.
 */
function formatValidationErrors(rawErrors: Iterable<ValueError>): string[] {
  const all = Array.from(rawErrors);
  const requiredPaths = new Set(
    all.filter((e) => e.type === ValueErrorType.ObjectRequiredProperty).map((e) => e.path),
  );
  const kept = all.filter(
    (e) => e.type === ValueErrorType.ObjectRequiredProperty || !requiredPaths.has(e.path),
  );
  const messages = kept.map(describeValueError);
  return Array.from(new Set(messages));
}

/**
 * Locates a reviewer's findings block within its final text, parses it, and validates it
 * against the findings schema. A valid, empty findings list (`[]`) is a successful report, not
 * a failure. Never throws: invalid model output is reported through the `ok: false` branch.
 *
 * This function only reads `text`; it never mutates, trims, normalises or re-wraps any string
 * value found inside the block. The strings on returned findings are exactly what `JSON.parse`
 * produced from the reviewer's own bytes.
 */
export function extractFindings(text: string): ExtractResult {
  const located = locateFindingsBlock(text);
  if (located.content === null) {
    return { ok: false, errors: [located.error ?? 'no findings block found'] };
  }

  const parsed = parseBlockJson(located.content);
  if (parsed.error !== null) {
    return { ok: false, errors: [parsed.error] };
  }

  if (!Array.isArray(parsed.value)) {
    return {
      ok: false,
      errors: [
        `the findings block must contain a JSON array of finding objects, got ${describeJsonType(parsed.value)}`,
      ],
    };
  }

  if (!Value.Check(FindingsSchema, parsed.value)) {
    return {
      ok: false,
      errors: formatValidationErrors(Value.Errors(FindingsSchema, parsed.value)),
    };
  }

  return { ok: true, findings: parsed.value as RawFinding[] };
}

/**
 * Builds the repair message returned to the same reviewer whose output failed validation. Its
 * signature accepts only the validation errors, so it is structurally incapable of carrying any
 * other reviewer's output or prior text — there is nothing else in scope to leak.
 */
export function repairInstruction(errors: readonly string[]): string {
  const list = errors.map((e) => `- ${e}`).join('\n');
  return [
    'Your findings block could not be validated against the required schema. Fix these problems:',
    '',
    list,
    '',
    'Re-emit your complete findings as a single corrected block in the exact format given ' +
      'earlier (a fenced ```council-findings block containing a JSON array). Include every ' +
      'finding you still stand behind, not only the ones that had errors. Do not comment on ' +
      'this correction outside the block.',
  ].join('\n');
}

/**
 * The emit-format instructions given to a reviewer, telling it exactly how to produce the block
 * `extractFindings` parses. Kept deliberately unambiguous rather than tuned: a fenced block with
 * a stable marker, a closing line that cannot be confused with anything else, and an explicit
 * field list.
 */
export const FINDINGS_BLOCK_INSTRUCTIONS = `
When you have finished reviewing, report your findings as a single fenced code block. After any
prose you want to include, emit exactly one block in this form:

\`\`\`${FENCE_MARKER}
[
  {
    "file": "path/relative/to/repo/root.ts",
    "line": 42,
    "endLine": 47,
    "severity": "high",
    "category": "correctness",
    "claim": "one sentence stating what is wrong",
    "impact": "the failure this would cause if not fixed",
    "evidence": "optional: the specific detail that supports the claim",
    "suggestion": "optional: how to fix it",
    "confidence": 0.8
  }
]
\`\`\`

Rules for this block:
- The opening line must be exactly three backticks immediately followed by "${FENCE_MARKER}",
  with nothing else on that line.
- The closing line must be exactly three backticks alone, with nothing else on that line.
- Emit exactly one such block, after all of your prose. Do not wrap it in another code block
  and do not repeat it.
- The block's content must be a single JSON array and nothing else. If you found nothing, emit
  an empty array: \`\`\`${FENCE_MARKER}
[]
\`\`\`
- Every finding requires: "file" (path relative to the repository root), "line" (integer,
  1-based), "severity" (one of "critical", "high", "medium", "low"), "category", "claim", and
  "impact".
- "endLine" (integer), "evidence" (string), "suggestion" (string) and "confidence" (a number
  between 0 and 1) are optional. Do not include any field not listed here.
`.trim();

// --- Snapshot verification (task 12.5) ----------------------------------------------------------

/**
 * Flags findings whose `file` is absent from the reviewed snapshot's file list as unverifiable
 * against the reviewed tree. Findings are never dropped — every input finding appears exactly
 * once in the output, in the same order, with `unverifiable` set to an explicit boolean (never
 * left `undefined`) rather than mutated in place.
 */
export function markUnverifiable(
  findings: readonly RawFinding[],
  snapshotFiles: readonly string[],
): RawFinding[] {
  const present = new Set(snapshotFiles);
  return findings.map((finding) => ({
    ...finding,
    unverifiable: !present.has(finding.file),
  }));
}
