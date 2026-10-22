import type { JevResponse } from "@werewolf/llm";

/** journal_v4: probability on urge level 0 ("No useful contribution now") at which a seat declines. */
export const DECLINE_THRESHOLD = 0.5;

/**
 * Scripted auction controls keep every seat willing on purpose, so their comparisons isolate
 * scheduling from the decline rule.
 */
export const CONTROL_ALWAYS_WILLING = true;

/** A seat whose urgency answer says it has nothing useful to add declines the floor. */
export function declinesFloor(answer: JevResponse["answers"][string]): boolean {
  return answer.type === "score" && (answer.probabilities["0"] ?? 0) >= DECLINE_THRESHOLD;
}
