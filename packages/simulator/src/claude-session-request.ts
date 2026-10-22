import { createHash } from "node:crypto";
import type { ContextSourceV2, PlayerContextV2 } from "@werewolf/contracts";
import type { DecisionRequest, DecisionResult } from "@werewolf/llm";
import { journalText } from "./freeform-journal";
import { evidenceMapV31, renderSource } from "./request-v3-1";

export type ClaudeHarness = NonNullable<DecisionRequest<unknown>["claudeHarness"]>;
export type ClaudeReplyContent = NonNullable<DecisionResult<unknown>["content"]>;

/** Explains the session shape; part of system block 1, so identical for every seat and call. */
export const SESSION_INSTRUCTIONS = `CONVERSATION FORMAT (Claude session): the second system block is the public record before today. Your first message holds your private state at the start of this day: journal, previous decision brief and private evidence. Each later message lists NEW_RECORDS you are authorized to see since your previous message, oldest first, then NOW (day, phase, response docket, any legal choices) and the REQUEST to answer. Your earlier replies in this conversation are your own previous answers; treat them as history. Answer only the current REQUEST, in the response envelope.`;

/**
 * Records the packet carries, in event order, without the synthetic `facts:*` entries. The
 * list for one seat only ever grows at the end, so an index into it is a stable cursor.
 */
export function orderedSources(packet: PlayerContextV2): ContextSourceV2[] {
  return packet.sources.filter((source) => !source.id.startsWith("facts:"));
}

function digestChars(packet: PlayerContextV2): number {
  return typeof packet.rules.digestChars === "number" ? packet.rules.digestChars : 140;
}

/** Every record is shown once, so it is shown at full fidelity with its durable handle. */
function render(packet: PlayerContextV2, sources: ContextSourceV2[]) {
  const map = evidenceMapV31(packet);
  return sources
    .filter((source) => map.toAlias.has(source.id))
    .map((source) => renderSource(source, map, digestChars(packet), "full"));
}

/**
 * Block 1: behavior, frozen reference, output envelope and session format. Block 2: the public
 * record before today. Both come only from shared inputs, so every seat sends the same bytes.
 */
export function sharedSystemBlocks(
  packet: PlayerContextV2,
  instructions: string,
  formatInstructions: string,
): [string, string] {
  const prior = orderedSources(packet).filter(
    (source) => source.scope === "public" && source.day < packet.day,
  );
  return [
    [instructions, formatInstructions, SESSION_INSTRUCTIONS].join("\n\n"),
    JSON.stringify({ PUBLIC_RECORD_BEFORE_DAY: packet.day, records: render(packet, prior) }),
  ];
}

/** The seat's private state when the session opens: journal, brief and private evidence. */
export function dayStartBlock(packet: PlayerContextV2, openCursor: number): string {
  const privateSources = orderedSources(packet)
    .slice(0, openCursor + 1)
    .filter((source) => source.scope !== "public");
  return JSON.stringify({
    DAY_START: {
      day: packet.day,
      self: packet.self,
      knownAllies: [...packet.knownAllies].sort((a, b) => a.id.localeCompare(b.id)),
      factionObjective: packet.rules.factionObjective,
      journal: journalText(packet.journal),
      previousDecisionBrief: packet.journal.decisionBrief ?? null,
      privateEvidence: render(packet, privateSources),
    },
  });
}

export interface TurnCursors {
  day: number;
  /** Last record index covered when the session opened (private records are in DAY_START). */
  openCursor: number;
  /** Last record index already sent in a turn; -1 before the first turn. */
  turnCursor: number;
}

/**
 * One user turn: records not yet shown in this session, in event order, then NOW and the
 * request. Public records from before today are in system block 2; private records up to the
 * session's opening are in DAY_START; everything else appears exactly once, here.
 */
export function turnText(packet: PlayerContextV2, cursors: TurnCursors, requestInput: string) {
  const ordered = orderedSources(packet);
  const fresh = ordered.filter(
    (source, index) =>
      index > cursors.turnCursor &&
      (index > cursors.openCursor || (source.scope === "public" && source.day >= cursors.day)),
  );
  const map = evidenceMapV31(packet);
  const choices = packet.legalTargets.map((id, index) => [
    String.fromCharCode(97 + index),
    { playerId: id, name: packet.players.find((player) => player.id === id)?.name ?? id },
  ]);
  const now = {
    day: packet.day,
    phase: packet.phase,
    at: new Date().toISOString(),
    responseDocket: packet.responseDocket.flatMap((id) => map.toAlias.get(id) ?? []),
    ...(choices.length ? { legalChoices: Object.fromEntries(choices) } : {}),
  };
  return {
    text: [
      JSON.stringify({ NEW_RECORDS: render(packet, fresh) }),
      JSON.stringify({ NOW: now }),
      requestInput,
    ].join("\n"),
    cursor: ordered.length - 1,
  };
}

export const sharedPrefixKey = (model: string, blocks: [string, string]) =>
  createHash("sha256")
    .update(JSON.stringify([model, blocks]))
    .digest("hex");
