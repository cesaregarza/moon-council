import { createHash } from "node:crypto";
import type { ContextSourceV2, PlayerContextV2 } from "@werewolf/contracts";

export const JOURNAL_EVIDENCE_TYPES = new Set([
  "speech.public",
  "vote.resolved",
  "player.eliminated",
  "role.revealed",
  "inspection.delivered",
  "moderator.announcement",
]);

/** Hash authorized evidence before rendering. Phase and pack changes need no reflection. */
export function journalEvidenceRevision(sources: ContextSourceV2[]): string {
  const ids = sources
    .filter(source => JOURNAL_EVIDENCE_TYPES.has(source.type))
    .map(source => source.id);
  return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

export function currentDecisionBrief(packet: PlayerContextV2) {
  const brief = packet.journal.decisionBrief;
  const revision = packet.rules.journalRevision;
  if (!brief || brief.playerId !== packet.self.id) return undefined;
  if (typeof revision !== "string" || brief.evidenceRevision !== revision) return undefined;
  return brief;
}
