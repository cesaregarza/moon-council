import { createHash } from "node:crypto";
import type { ContextSourceV2, PlayerContextV2 } from "@werewolf/contracts";

export const JOURNAL_EVIDENCE_TYPES = new Set(["speech.public", "vote.resolved", "player.eliminated", "role.revealed", "inspection.delivered", "moderator.announcement"]);
/** Hash the full authorized event set before context rendering/demotion. Phase-only and pack-point changes do not require another LLM reflection. */
export function journalEvidenceRevision(sources: ContextSourceV2[]): string {
  return createHash("sha256").update(JSON.stringify(sources.filter(s=>JOURNAL_EVIDENCE_TYPES.has(s.type)).map(s=>s.id))).digest("hex");
}
export function currentDecisionBrief(packet: PlayerContextV2) {
  const brief=packet.journal.decisionBrief;
  return brief && brief.playerId===packet.self.id && typeof packet.rules.journalRevision==="string" && brief.evidenceRevision===packet.rules.journalRevision ? brief : undefined;
}
