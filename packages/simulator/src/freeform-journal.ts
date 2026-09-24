import type { PrivateJournalV2 } from "@werewolf/contracts";
import { estimatedTokens } from "./request-v2";

/** Existing records remain readable without making storage metadata part of memory. */
export function journalText(journal: PrivateJournalV2): string {
  if (journal.text !== undefined) return journal.text;
  return [
    ...journal.beliefs.map(b => `${b.playerId}: wolf probability ${b.probability}; ${b.basis}. ${b.note}`),
    ...journal.hypotheses.map(h => `Hypothesis (confidence ${h.confidence}): ${h.statement}`),
    journal.strategy,
    ...journal.goals.map(s => `Goal: ${s}`),
    ...journal.unresolvedQuestions.map(s => `Open question: ${s}`),
    ...(journal.attentionNotes ?? []).map(n => `Listening to ${n.playerId}: ${n.note}`),
    ...(journal.deceptionPlan === null ? [] : [`Private deception plan: ${journal.deceptionPlan}`]),
  ].filter(Boolean).join("\n");
}

/** Same conservative estimator as context budgets, charging prose rather than JSON. */
export function journalTokens(journal: PrivateJournalV2): number {
  return journal.text === undefined ? estimatedTokens(journal) : Math.ceil(Buffer.byteLength(journal.text, "utf8") / 3) + decisionBriefTokens(journal);
}

export function decisionBriefTokens(journal:PrivateJournalV2):number {
  return journal.decisionBrief ? estimatedTokens(journal.decisionBrief) : 0;
}
