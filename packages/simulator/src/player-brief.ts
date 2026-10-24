import { createHash } from "node:crypto";
import type { ContextSourceV2, GameEventV1, PlayerContextV2 } from "@werewolf/contracts";

export const JOURNAL_EVIDENCE_TYPES = new Set([
  "speech.public",
  "vote.resolved",
  "player.eliminated",
  "role.revealed",
  "inspection.delivered",
  "moderator.announcement",
]);

/**
 * A revision of the journal evidence a player holds, hashed before rendering; phase and pack
 * changes need no reflection. It hashes those sources' event sequence numbers, which unlike their
 * random IDs are the same in every replay of a seeded game (CES-1558). `events` is the game's
 * full event log. A source it does not hold keeps its ID: test fixtures with synthetic packets
 * pass [] explicitly, and the legacy scheme (revisions.ts) passes [] on purpose.
 */
export function journalEvidenceRevision(
  sources: ContextSourceV2[],
  events: readonly GameEventV1[],
): string {
  const sequences = new Map(events.map((event) => [event.id, event.sequence]));
  const keys = sources
    .filter((source) => JOURNAL_EVIDENCE_TYPES.has(source.type))
    .map((source) => sequences.get(source.id) ?? source.id);
  return createHash("sha256").update(JSON.stringify(keys)).digest("hex");
}

export function currentDecisionBrief(packet: PlayerContextV2) {
  const brief = packet.journal.decisionBrief;
  const revision = packet.rules.journalRevision;
  if (!brief || brief.playerId !== packet.self.id) return undefined;
  if (typeof revision !== "string" || brief.evidenceRevision !== revision) return undefined;
  return brief;
}
