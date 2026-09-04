/**
 * The shared thinking-level vocabulary. Mirrors the review agent host's own level names, so
 * there is exactly one vocabulary to learn across this tool and the host it spawns.
 */

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Ordered from lowest to highest. Ordinal distance in this array drives clamping. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === 'string' && THINKING_LEVEL_SET.has(v);
}
