/** The hint ladder. Parents choose the highest rung each kid's tutor may reach. */
export const HINT_LEVELS = [
  { level: 1, name: "Clarify", short: "Help them understand what the question is asking." },
  { level: 2, name: "Concept", short: "Name the idea or rule that applies, and remind them how it works." },
  { level: 3, name: "First step", short: "Show the first step of their problem, then hand it back." },
  { level: 4, name: "Similar example", short: "Work a similar problem start to finish (different numbers), never theirs." },
  { level: 5, name: "Walk through theirs", short: "Walk through their actual problem, step by step, including the answer." },
] as const;

export const MIN_HINT = 1;
export const MAX_HINT = 5;
export const DEFAULT_HINT_CEILING = 4;

export function clampHint(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_HINT_CEILING;
  return Math.min(MAX_HINT, Math.max(MIN_HINT, Math.round(n)));
}

export function hintName(level: number): string {
  return HINT_LEVELS.find((h) => h.level === level)?.name ?? "Conversation";
}
