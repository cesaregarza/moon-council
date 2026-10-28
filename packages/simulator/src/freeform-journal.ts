import type { PlayerContextV2, PrivateJournalV2 } from "@werewolf/contracts";
import { estimatedTokens } from "./request-v2";

/** Existing records remain readable without making storage metadata part of memory. */
export function journalText(journal: PrivateJournalV2): string {
  if (journal.text !== undefined) return journal.text;
  return [
    ...journal.beliefs.map(
      (b) => `${b.playerId}: wolf probability ${b.probability}; ${b.basis}. ${b.note}`,
    ),
    ...journal.hypotheses.map((h) => `Hypothesis (confidence ${h.confidence}): ${h.statement}`),
    journal.strategy,
    ...journal.goals.map((s) => `Goal: ${s}`),
    ...journal.unresolvedQuestions.map((s) => `Open question: ${s}`),
    ...(journal.attentionNotes ?? []).map((n) => `Listening to ${n.playerId}: ${n.note}`),
    ...(journal.deceptionPlan === null ? [] : [`Private deception plan: ${journal.deceptionPlan}`]),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Stands in for the oldest journal entries a request left out to fit its context (CES-1584). */
export const JOURNAL_OMITTED_MARKER = "[earlier notes omitted to fit the context limit]";

/** A prose journal's entries: each appended note starts with its "Day N, phase:" line. */
export function journalEntries(text: string): string[] {
  return text ? text.split(/\n\n(?=Day \d+, [a-z_]+:\n)/) : [];
}

/**
 * The journal a request delivers: the stored journal, less its oldest
 * `rules.journalEntriesOmitted` entries behind the marker. Updates apply to the stored journal.
 */
export function deliveredJournalText(packet: PlayerContextV2): string {
  const text = journalText(packet.journal);
  const omitted = Number(packet.rules.journalEntriesOmitted ?? 0);
  if (!omitted) return text;
  return [JOURNAL_OMITTED_MARKER, ...journalEntries(text).slice(omitted)].join("\n\n");
}

/** Same conservative estimator as context budgets, charging prose rather than JSON. */
export function journalTokens(journal: PrivateJournalV2): number {
  return journal.text === undefined
    ? estimatedTokens(journal)
    : Math.ceil(Buffer.byteLength(journal.text, "utf8") / 3) + decisionBriefTokens(journal);
}

export function decisionBriefTokens(journal: PrivateJournalV2): number {
  return journal.decisionBrief ? estimatedTokens(journal.decisionBrief) : 0;
}
