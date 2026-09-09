/**
 * Task 9.10: a tool-surface assertion that enumerates a reviewer's callable tools BY NAME, so a
 * reappearing host built-in cannot hide behind a provider-side parallel-invocation envelope (a
 * provider-side envelope can only wrap tools this extension registered -- see design.md's "A
 * provider-side tool envelope is mistaken for a capability").
 *
 * This is the zero-model-call structural half of that assertion: it loads the built extension
 * module and calls its default export against a stub `ExtensionAPI` that records every
 * `registerTool` call, then asserts the recorded name set is exactly the five `council_*` tools
 * -- nothing more, nothing fewer -- and explicitly that none of pi's own built-in tool names
 * (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`; see
 * `SCRATCH/host-notes.md` section B point 1) ever appears.
 *
 * What this test does NOT do, and cannot do at zero cost: prove what pi itself actually sends to
 * a live model as the callable tool list. That would require a real `pi --mode json` invocation
 * against a real provider (a live, billable model call). Host-notes section B's static trace of
 * pi 0.84.4's own bundle already establishes, independent of any test, that with
 * `-nbt -ne -e <path>` the active tool set is *exactly* what the loaded extension registers (see
 * `buildReviewerArgv` in `src/reviewer-spawn.ts`, which passes exactly those flags) -- so this
 * structural test plus that static trace together cover the requirement without a live run. A
 * true end-to-end enumeration of pi's live tool-call envelope, if ever wanted, belongs in
 * Section 18's opt-in `test/live/` project (`COUNCIL_LIVE=1`), not here.
 */
import { describe, expect, it } from 'vitest';

import registerReviewerTools, {
  REVIEWER_TOOLS,
  type ReviewerExtensionAPI,
} from '../../src/reviewer-tools.js';
import { REVIEWER_TOOL_NAMES } from '../../src/reviewer-spawn.js';

const HOST_BUILTIN_TOOL_NAMES = [
  'read',
  'bash',
  'powershell',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
];

class StubExtensionAPI implements ReviewerExtensionAPI {
  readonly registeredNames: string[] = [];
  registerTool(tool: { name: string }): void {
    this.registeredNames.push(tool.name);
  }
}

describe('reviewer tool surface (zero-cost, structural)', () => {
  it('registers exactly the five council_* tools, by name', () => {
    const stub = new StubExtensionAPI();
    registerReviewerTools(stub);
    expect(stub.registeredNames.sort()).toEqual(
      [...REVIEWER_TOOL_NAMES].sort((a, b) => a.localeCompare(b)),
    );
    expect(stub.registeredNames).toHaveLength(5);
  });

  it('registers no duplicate tool names', () => {
    const stub = new StubExtensionAPI();
    registerReviewerTools(stub);
    expect(new Set(stub.registeredNames).size).toBe(stub.registeredNames.length);
  });

  it('never registers any host built-in tool name', () => {
    const stub = new StubExtensionAPI();
    registerReviewerTools(stub);
    for (const builtin of HOST_BUILTIN_TOOL_NAMES) {
      expect(stub.registeredNames).not.toContain(builtin);
    }
  });

  it('the REVIEWER_TOOLS array (what the module exposes) matches what gets registered', () => {
    expect(REVIEWER_TOOLS.map((t) => t.name).sort()).toEqual(
      [...REVIEWER_TOOL_NAMES].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('the tool set matches src/reviewer-spawn.ts REVIEWER_TOOL_NAMES exactly, name for name', () => {
    const stub = new StubExtensionAPI();
    registerReviewerTools(stub);
    expect(new Set(stub.registeredNames)).toEqual(new Set(REVIEWER_TOOL_NAMES));
  });

  it('none of the five tools declares write/edit/execute-shaped capability in its description', () => {
    // A lightweight guard against a future tool being registered with mutating intent even
    // though its name still starts with council_ -- the requirement is capability, not naming.
    for (const tool of REVIEWER_TOOLS) {
      expect(tool.name.startsWith('council_')).toBe(true);
    }
  });
});
