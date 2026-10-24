import type { ContextSourceV2, GameEventV1, PrivateJournalV2 } from "@werewolf/contracts";
import { journalEvidenceRevision } from "./player-brief";

/** Public events that change what players can respond to; the latest one names the revision. */
const revisesPublicRecord = (e: GameEventV1) =>
  e.type === "speech.public" ||
  e.type === "vote.resolved" ||
  e.type === "player.eliminated" ||
  e.type === "role.revealed";

/**
 * The public revision: the sequence number of the latest public event players can respond to,
 * or "initial" before any. Unlike the event's random ID, the sequence number is the same in
 * every replay of a seeded game, so seeded orders and keys that embed the revision replay too
 * (CES-1558). Unique only within one game.
 */
export const publicRevision = (events: GameEventV1[]): string => {
  const latest = events.filter(revisesPublicRecord).at(-1);
  return latest ? String(latest.sequence) : "initial";
};

/** The evidence a stored revision names: the public record, or one player's journal evidence. */
export type RevisionEvidence =
  | { kind: "public"; events: GameEventV1[] }
  | { kind: "journal"; sources: ContextSourceV2[]; events: readonly GameEventV1[] };

const currentRevision = (evidence: RevisionEvidence): string =>
  evidence.kind === "public"
    ? publicRevision(evidence.events)
    : journalEvidenceRevision(evidence.sources, evidence.events);

// RETIRE-AFTER CES-1569: legacy, ID-keyed revisions. Games saved before CES-1558 stored these;
// remove once no pre-change game remains to resume.
const legacyRevision = (evidence: RevisionEvidence): string =>
  evidence.kind === "public"
    ? (evidence.events.filter(revisesPublicRecord).at(-1)?.id ?? "initial")
    : // With no events to look sequences up in, every source keeps its ID: the old hash.
      journalEvidenceRevision(evidence.sources, []);

/**
 * Whether a stored revision still names the current evidence. New writes use event sequence
 * numbers; a game saved before CES-1558 stored the same revisions keyed by event IDs. A stored
 * value is current if it equals the current evidence's revision under either scheme, so changed
 * evidence matches neither and every staleness check stays as strict as before.
 */
export function revisionIsCurrent(stored: unknown, evidence: RevisionEvidence): boolean {
  return stored === currentRevision(evidence) || stored === legacyRevision(evidence);
}

/**
 * The journal revision to stamp on a new packet. The seat's brief is checked against this stamp
 * without the evidence at hand, so the stamp follows the scheme in which that brief is current.
 * RETIRE-AFTER CES-1569: a brief stored before CES-1558 and still current gets the legacy value
 * (the value the old code wrote here), until the seat's next real refresh replaces it. Otherwise
 * (no brief, a new-scheme brief, or changed evidence) the new value.
 */
export function journalRevisionStamp(
  brief: PrivateJournalV2["decisionBrief"],
  playerId: string,
  sources: ContextSourceV2[],
  events: readonly GameEventV1[],
): string {
  const evidence: RevisionEvidence = { kind: "journal", sources, events };
  const current = currentRevision(evidence);
  const legacy = legacyRevision(evidence);
  const _legacyBrief =
    brief?.playerId === playerId &&
    brief.evidenceRevision === legacy &&
    brief.evidenceRevision !== current;
  return current;
}

/**
 * The revision to embed in a key that finds stored work: an auction base, or a seat's journal
 * refresh. RETIRE-AFTER CES-1569: a game paused before CES-1558 may hold work that was in flight
 * at the pause (bids, an auction resolution, an open reflection) under the legacy revision of
 * the same evidence. That work keeps its key, so resuming continues it instead of asking again.
 * Otherwise, and in every game started after the change, the new revision.
 */
export function keyRevision(
  evidence: RevisionEvidence,
  inFlightUnder: (legacyRevision: string) => boolean,
): string {
  const current = currentRevision(evidence);
  const legacy = legacyRevision(evidence);
  return legacy !== current && inFlightUnder(legacy) ? legacy : current;
}
