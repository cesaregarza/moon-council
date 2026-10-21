export const JOURNAL_POLICIES = ["legacy", "memory-v2"] as const;
export type JournalPolicy = (typeof JOURNAL_POLICIES)[number];

const LEGACY =
  "Update your private journal in free prose, preferably under 600 words. Preserve your evidence, current answer and uncertainty, what changed, any useful contribution you could make, and whom you want to hear next and why. Evaluate the latest speech's relevance and novelty without assuming that verbosity or silence implies correctness. Distinguish agreement, credibility, and desire for an answer. Output only the journal field.";

/** A memory policy, not a desired bid, speaker, answer, or experiment outcome. */
export const MEMORY_GUIDANCE = [
  "Keep an accurate current working memory, in free prose rather than embedded JSON. Preserve useful reasoning, uncertainty, alternatives, and your private objective.",
  "Distinguish personally received records, attributed public claims, inference, and scheduled-but-not-delivered evidence. A future delivery is not an observation. Publicly reported evidence can support a provisional conclusion without becoming your own authenticated record.",
  "Remember what the group has already heard, what is provisionally settled, and what remains disputed. A repeated fact is not new evidence. An independent confirmation can still matter: say what uncertainty it would actually reduce. Do not demand unavailable verification as though the discussion provided an inspection action.",
  "Retain explicit limits on a person's current contribution: no additional evidence, not possessing the requested record, inability to answer, or refusal. Attribute these statements and their timing; do not turn them into permanent incompetence or dishonesty. Reopen the assessment if new information arrives.",
  "Maintain the status of consequential questions: unanswered, answered, declined, or superseded. If an answered question remains important, explain the remaining discrepancy and how resolving it would affect your objective. Agreement, trust, and wanting an explanation are different things.",
  "For your own next contribution and each peer you want to hear, explain what another turn could add now: a missing fact, a meaningful correction, an answer, a genuinely useful confirmation, or a strategic effect. If you see no useful addition, retain that fact. Do not invent a contribution just to fill a section or keep the conversation moving.",
  "Keep actual beliefs separate from public deception and strategy. A private objective may favor withholding or obstruction; accurate memory must not silently replace it with cooperation. Do not assign numeric bids, pick the next speaker, or prescribe the eventual speech. Short prose labels are optional, not a required schema.",
].join("\n");

export function journalInstructions(policy: JournalPolicy = "legacy"): string {
  if (policy === "legacy") return LEGACY;
  return [
    "Update your private journal in free prose, preferably under 600 words.",
    MEMORY_GUIDANCE,
    "Output only the journal field.",
  ].join("\n");
}
export function parseJournalPolicy(value = "legacy"): JournalPolicy {
  if (value !== "legacy" && value !== "memory-v2") throw new Error("Unknown journal policy");
  return value;
}
