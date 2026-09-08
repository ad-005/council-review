# Model picker readability — preview

Change: `src/picker.ts` (model stage of `pickPanel`: one checkbox prompt per provider group).

What changed and why:

- Each provider group gets its own prompt, and the group header (`opencode-go (25 models)`) is the prompt message — inquirer renders the message above the paginated list and never scrolls it, so the header stays pinned at the top no matter how far the rows scroll underneath.
- The header is visually distinct (prompt-message styling with the `?` prefix) and distanced (a blank spacer row follows it before the first model row).
- Rows scroll in a circle within their group (`loop: true`); blank spacers and headers can't trap the cursor — all navigation keys skip them.
- One short row per model: identity first, then `vendor · context · costs · thinking`, with the identity and vendor columns padded (measured within the group) so rows start in line instead of blurring together.
- A blank line before every row. Larger square checkboxes (`☐`/`☑`) instead of the small circles (`○`/`◉`); checked keeps the default green. Applied to the provider stage too so both stages match.
- Full exact figures (token counts, max output) on the highlighted row's detail line under the list — inquirer only renders the active choice's description there.
- Unknown figures render as `?` without dropping the column; non-reasoning models are tagged `no thinking` (they skip the thinking prompt).
- Column widths are capped, so one very long model id cannot push the rest of the list off-screen.
- Each group prompt uses page size 12 (default 7), since spacer rows roughly double list height.
- Confirming every group prompt empty re-runs the model stage with a "select at least one model" note (per-group `required` can't express this); Ctrl+C still cancels from any prompt without writing anything.

## Before (previous label format, same 7 models)

```text
◯ minimax/MiniMax-M2.7  —  vendor: minimax, context: 204.8K, in: $0.3/Mtok, out: $1.2/Mtok
◯ minimax/MiniMax-M2.7-highspeed  —  vendor: minimax, context: 204.8K, in: $0.3/Mtok, out: $1.2/Mtok
◯ openai-codex/gpt-5.4  —  vendor: openai, context: 272.0K, in: $2/Mtok, out: $8/Mtok
◯ opencode-go/deepseek-v4-flash  —  vendor: deepseek, context: 1.0M, in: $0.5/Mtok, out: $2/Mtok
◯ opencode-go/glm-5.2  —  vendor: zhipu, context: 1.0M, in: $1/Mtok, out: $2/Mtok
◯ opencode-go/kimi-k2.6  —  vendor: moonshot, context: 262.1K, in: $1.5/Mtok, out: $3/Mtok
◯ openrouter/auto  —  vendor: unknown, context: 2.0M, in: ?/Mtok, out: ?/Mtok
```

## After — one group's rows (exact strings from the new code, checkbox chrome omitted)

Each provider group is its own prompt headed by its message; shown here is the `opencode-go` group as its choice list is built (a blank spacer precedes every row, including the first, which distances the rows from the header message).

```text
(blank spacer)
☐ opencode-go/deepseek-v4-flash  deepseek  ·  1.0M ctx  ·  $0.5 in / $2 out /Mtok  ·  thinking
(blank spacer)
☐ opencode-go/glm-5.2            zhipu     ·  1.0M ctx  ·  $1 in / $2 out /Mtok  ·  thinking
(blank spacer)
☐ opencode-go/kimi-k2.6          moonshot  ·  262.1K ctx  ·  $1.5 in / $3 out /Mtok  ·  no thinking
```

## After — actual terminal capture (100-column scripted run, first page)

Captured by driving the real `pickPanel` through a scripted input stream at 100 columns, snapshotting the model stage, then cancelling. ANSI escapes stripped; nothing else edited.

```text
? Select models for the panel — opencode-go (3 models):

❯☐ opencode-go/deepseek-v4-flash  deepseek  ·  1.0M ctx  ·  $0.5 in / $2 out /Mtok  ·  thinking

 ☐ opencode-go/glm-5.2            zhipu     ·  1.0M ctx  ·  $1 in / $2 out /Mtok  ·  thinking

 ☐ opencode-go/kimi-k2.6          moonshot  ·  262.1K ctx  ·  $1.5 in / $3 out /Mtok  ·  no thinking

opencode-go/deepseek-v4-flash  —  vendor deepseek, context 1000000 tokens, max output 384000 tokens,
 $0.5 in / $2 out /Mtok, supports thinking levels
↑↓ navigate • space select • a all • i invert • ⏎ submit
```

(The header is the `?`-prefixed message line — rendered above the paginated list, never scrolled — followed by a blank spacer before the rows.)

(The highlighted row's exact-figures line renders under the list and follows the cursor as you move; that is inquirer behaviour, not custom drawing.)

## Verification

- `npm test`: 23 files, 683 tests passed (includes grouping/header/row-builder tests plus scripted multi-group, reselect-loop, and circular-nav tests in `test/unit/picker.test.ts`).
- `eslint` clean; `prettier --check` clean after `--write`.
- Selection values are unchanged (JSON-encoded `[provider, id]`), so existing picker flows, keyboard shortcuts, and cancellation behaviour are untouched.
