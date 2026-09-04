import { describe, expect, it } from 'vitest';
import {
  extractFindings,
  repairInstruction,
  markUnverifiable,
  FINDINGS_BLOCK_INSTRUCTIONS,
  type RawFinding,
} from '../../src/schema.js';

const VALID_FINDING: RawFinding = {
  file: 'src/foo.ts',
  line: 12,
  endLine: 14,
  severity: 'high',
  category: 'correctness',
  claim: 'off-by-one in the loop bound',
  impact: 'the last element is silently skipped',
  evidence: 'the loop uses `< length - 1`',
  suggestion: 'use `< length`',
  confidence: 0.75,
};

function block(body: string, marker = 'council-findings'): string {
  return `Some prose before the block.\n\n\`\`\`${marker}\n${body}\n\`\`\`\n\nSome prose after.`;
}

const REQUIRED_FIELDS: (keyof RawFinding)[] = [
  'file',
  'line',
  'severity',
  'category',
  'claim',
  'impact',
];

describe('extractFindings', () => {
  it('parses a valid block into findings', () => {
    const text = block(JSON.stringify([VALID_FINDING], null, 2));
    const result = extractFindings(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toEqual([VALID_FINDING]);
    }
  });

  it('accepts a valid empty findings list as a successful report', () => {
    const text = block('[]');
    const result = extractFindings(text);
    expect(result).toEqual({ ok: true, findings: [] });
  });

  for (const field of REQUIRED_FIELDS) {
    it(`rejects output missing the required field "${field}"`, () => {
      const finding = { ...VALID_FINDING } as Record<string, unknown>;
      delete finding[field];
      const text = block(JSON.stringify([finding]));
      const result = extractFindings(text);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
        expect(
          result.errors.some((e) => e.includes(`finding[0].${field}`) && e.includes('missing')),
        ).toBe(true);
      }
    });
  }

  it('rejects a severity outside the permitted set', () => {
    const finding = { ...VALID_FINDING, severity: 'informational' };
    const text = block(JSON.stringify([finding]));
    const result = extractFindings(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('finding[0].severity'))).toBe(true);
      expect(result.errors.some((e) => e.includes('critical, high, medium, low'))).toBe(true);
    }
  });

  it('rejects an unrecognised field, naming it', () => {
    const finding = { ...VALID_FINDING, cvss: 9.8 };
    const text = block(JSON.stringify([finding]));
    const result = extractFindings(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('finding[0].cvss'))).toBe(true);
    }
  });

  it('rejects a non-array block body, naming the actual JSON type', () => {
    const text = block(JSON.stringify({ findings: [VALID_FINDING] }));
    const result = extractFindings(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('array');
      expect(result.errors[0]).toContain('object');
    }
  });

  it('rejects malformed JSON with a specific parse error, not a generic message', () => {
    const text = block('[ { "file": "a.ts", ');
    const result = extractFindings(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('not valid JSON');
    }
  });

  it('reports no findings block found when there is no fenced block at all', () => {
    const result = extractFindings('I reviewed the diff and found nothing worth flagging.');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('no findings block found');
    }
  });

  it('reports an unclosed block distinctly from a missing block', () => {
    const text = 'prose\n\n```council-findings\n[]\n';
    const result = extractFindings(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('never closed');
    }
  });

  it('does not mutate, trim or normalise field values on the way through', () => {
    const withWhitespace: RawFinding = {
      ...VALID_FINDING,
      claim: '  leading and trailing spaces preserved  ',
      evidence: 'line one\nline two',
    };
    const text = block(JSON.stringify([withWhitespace]));
    const result = extractFindings(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings[0]?.claim).toBe('  leading and trailing spaces preserved  ');
      expect(result.findings[0]?.evidence).toBe('line one\nline two');
    }
  });

  it('is a pure function: repeated calls on the same invalid input produce identical results', () => {
    const text = block(JSON.stringify([{ ...VALID_FINDING, severity: 'nope' }]));
    const first = extractFindings(text);
    const second = extractFindings(text);
    expect(second).toEqual(first);
  });

  it('tolerates leading and trailing whitespace around the block content', () => {
    const text = `prose\n\n\`\`\`council-findings\n\n   ${JSON.stringify([VALID_FINDING])}   \n\n\`\`\`\n`;
    const result = extractFindings(text);
    expect(result.ok).toBe(true);
  });

  it('tolerates a language tag alongside the marker', () => {
    const text = block(JSON.stringify([VALID_FINDING]), 'json council-findings');
    const result = extractFindings(text);
    expect(result.ok).toBe(true);
  });

  it('tolerates a duplicated opening fence line', () => {
    const text =
      'prose\n\n```council-findings\n```council-findings\n' +
      JSON.stringify([VALID_FINDING]) +
      '\n```\n';
    const result = extractFindings(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toEqual([VALID_FINDING]);
    }
  });

  it('parses a block produced exactly per FINDINGS_BLOCK_INSTRUCTIONS', () => {
    // Pull the example block straight out of the instructions text handed to reviewers and
    // confirm it round-trips: the instructions and the extractor must never drift apart.
    const match = FINDINGS_BLOCK_INSTRUCTIONS.match(/```council-findings\n([\s\S]*?)\n```/);
    expect(match).not.toBeNull();
    const example = JSON.parse(match![1]!);
    expect(Array.isArray(example)).toBe(true);

    const text = block(match![1]!);
    const result = extractFindings(text);
    expect(result.ok).toBe(true);
  });

  it("FINDINGS_BLOCK_INSTRUCTIONS's empty-findings example also parses", () => {
    const text = block('[]');
    const result = extractFindings(text);
    expect(result).toEqual({ ok: true, findings: [] });
    expect(FINDINGS_BLOCK_INSTRUCTIONS).toContain('```council-findings\n[]\n```');
  });
});

describe('repair retry', () => {
  it('repair succeeds: invalid then valid output is used', () => {
    const badText = block(JSON.stringify([{ ...VALID_FINDING, severity: 'nope' }]));
    const first = extractFindings(badText);
    expect(first.ok).toBe(false);
    if (first.ok) return;

    const instruction = repairInstruction(first.errors);
    expect(instruction).toContain(first.errors[0]);

    const repairedText = block(JSON.stringify([VALID_FINDING]));
    const second = extractFindings(repairedText);
    expect(second.ok).toBe(true);
  });

  it('repair fails: invalid then still-invalid output stays invalid', () => {
    const badText = block(JSON.stringify([{ ...VALID_FINDING, severity: 'nope' }]));
    const first = extractFindings(badText);
    expect(first.ok).toBe(false);

    const stillBadText = block(JSON.stringify([{ ...VALID_FINDING, line: 'twelve' }]));
    const second = extractFindings(stillBadText);
    expect(second.ok).toBe(false);
    // Nothing about having already failed once changes how the second attempt is evaluated —
    // there is no hidden retry counter in this module for a caller to exhaust or corrupt. The
    // "no third attempt" rule is enforced by the runner's call count, not by state in here.
    if (!second.ok) {
      expect(second.errors.some((e) => e.includes('finding[0].line'))).toBe(true);
    }
  });

  it('a repair payload contains only the given validation errors, nothing from elsewhere', () => {
    const errorsA = ['finding[0].file is required but missing'];
    const errorsB = ['finding[2].severity must be one of critical, high, medium, low (got "meh")'];

    const instructionA = repairInstruction(errorsA);
    const instructionB = repairInstruction(errorsB);

    expect(instructionA).toContain(errorsA[0]);
    expect(instructionA).not.toContain(errorsB[0]);
    expect(instructionB).toContain(errorsB[0]);
    expect(instructionB).not.toContain(errorsA[0]);

    // repairInstruction's signature is (errors: readonly string[]) => string — there is no
    // parameter through which another reviewer's text or another run's state could enter.
  });
});

describe('markUnverifiable', () => {
  it('leaves findings whose file is present in the snapshot marked verifiable', () => {
    const [marked] = markUnverifiable([VALID_FINDING], ['src/foo.ts', 'src/bar.ts']);
    expect(marked?.unverifiable).toBe(false);
  });

  it('flags a finding whose file is absent from the snapshot, without dropping it', () => {
    const [marked] = markUnverifiable([VALID_FINDING], ['src/other.ts']);
    expect(marked?.unverifiable).toBe(true);
    expect(marked?.file).toBe(VALID_FINDING.file);
    expect(marked?.claim).toBe(VALID_FINDING.claim);
  });

  it('retains every finding, preserving order, regardless of verifiability', () => {
    const a: RawFinding = { ...VALID_FINDING, file: 'present.ts' };
    const b: RawFinding = { ...VALID_FINDING, file: 'absent.ts' };
    const marked = markUnverifiable([a, b], ['present.ts']);
    expect(marked).toHaveLength(2);
    expect(marked[0]?.file).toBe('present.ts');
    expect(marked[0]?.unverifiable).toBe(false);
    expect(marked[1]?.file).toBe('absent.ts');
    expect(marked[1]?.unverifiable).toBe(true);
  });

  it('does not mutate the input findings array', () => {
    const original: RawFinding = { ...VALID_FINDING };
    const frozen = Object.freeze({ ...original });
    expect(() => markUnverifiable([frozen], [])).not.toThrow();
    expect(frozen.unverifiable).toBeUndefined();
  });
});
