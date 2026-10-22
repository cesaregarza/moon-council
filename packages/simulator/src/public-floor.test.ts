import { describe, expect, it } from "vitest";
import {
  GameConfigV2Schema,
  emptyJournalV2,
  type GameEventV1,
  type PlayerContextV2,
} from "@werewolf/contracts";
import { createGameState } from "@werewolf/engine";
import type { JevRequest } from "@werewolf/llm";
import { buildContextV2 } from "./context-v2";
import { prepareJevStage } from "./jev-decision";
import { decisionRequestV31, normalizeV31Submission } from "./request-v3-1";
import type { V3TaskSpec } from "./request-v3";
import { actorConfig } from "./testing/actor-fixtures";

const CANARIES = ["CANARY-INSPECT-31a", "CANARY-BID-77e", "CANARY-JOURNAL-c02"];

function config(workflow: "journal_v2" | "journal_v3" | "journal_v4") {
  // agent_v3_1 with the smallest context: the public window keeps only a few speeches.
  return GameConfigV2Schema.parse({
    ...actorConfig(),
    protocolVersion: "agent_v3_1",
    decisionEngine: { mode: "jev", workflow },
    deliberation: { maxJournalTokens: 16000, maxContextTokens: 8000 },
  });
}

/** Day 2: Briar speaks three times, Cato once, and fillers overflow the v3.1 window. */
function busyDay(workflow: "journal_v2" | "journal_v3" | "journal_v4") {
  const state = createGameState("floor", config(workflow));
  state.day = 2;
  state.phase = "day_discussion";
  let sequence = 0;
  const events: GameEventV1[] = [];
  const push = (
    type: string,
    payload: Record<string, unknown>,
    visibility: GameEventV1["visibility"] = "public",
    audienceIds: string[] = [],
  ) =>
    events.push({
      schemaVersion: "game_event_v1",
      id: `e${++sequence}`,
      gameId: "floor",
      sequence,
      type,
      phase: "day_discussion",
      day: 2,
      visibility,
      audienceIds,
      payload,
      createdAt: new Date(Date.UTC(2026, 8, 24, 10, 0, sequence)).toISOString(),
    });
  const speech = (playerId: string, acts: unknown[] = [], text = "I have thoughts.") =>
    push("speech.public", { playerId, text, acts, respondsTo: [], closing: false });
  speech("p2", [{ kind: "accusation", targetId: "p3", claim: "Cato is evasive." }]);
  speech("p3", [{ kind: "challenge", targetId: "p2", claim: "Briar has no evidence." }]);
  speech("p2");
  // About 1,000 estimated tokens each: far beyond what the 8k context can carry.
  for (let i = 0; i < 40; i++) speech(["p4", "p5", "p6", "p7"][i % 4]!, [], "x".repeat(3000));
  speech("p2", [{ kind: "accusation", targetId: "p5", claim: "Ember follows the crowd." }]);
  // Private records that must never be counted or copied.
  push("inspection.delivered", { actorId: "p1", targetId: "p2", note: CANARIES[0] }, "player", [
    "p1",
  ]);
  push("discussion.bid_submitted", { playerId: "p2", rationale: CANARIES[1] }, "player", ["p2"]);
  push("journal.v2_updated", { playerId: "p2", journal: { text: CANARIES[2] } }, "player", ["p2"]);
  return { state, events };
}

function schedulingPacket(workflow: "journal_v2" | "journal_v3" | "journal_v4") {
  const { state, events } = busyDay(workflow);
  return buildContextV2(state, events, "p1", emptyJournalV2(), "score", "discussion");
}

function jevSchedulingRequest(packet: PlayerContextV2, workflow: "journal_v3" | "journal_v4") {
  const task: V3TaskSpec = {
    type: "discussion_score",
    eligible: true,
    candidateIds: packet.players.map((p) => p.id),
    revision: "initial",
  };
  if (workflow === "journal_v4")
    packet.journal.decisionBrief = {
      playerId: "p1",
      evidenceRevision: String(packet.rules.journalRevision),
      action: "Hear the accused before voting.",
      attention: "Briar keeps the floor; hear Cato's defense.",
    };
  const base = {
    ...decisionRequestV31(packet, task, true, null, null),
    schemaName: task.type,
    normalize: (value: unknown) => normalizeV31Submission(packet, task, value as never, "s", true),
  };
  const stage = prepareJevStage(
    { packet, playerId: "p1", taskType: task.type },
    config(workflow),
    base,
    true,
  );
  return JSON.parse(stage.prepared.prompt.input) as JevRequest;
}

describe("public floor facts for journal_v4 scheduling", () => {
  it("counts the whole day even when the v3.1 window drops speeches", () => {
    const { state, events } = busyDay("journal_v4");
    const packet = buildContextV2(state, events, "p1", emptyJournalV2(), "score", "discussion");
    const delivered = packet.sources.filter((s) => s.type === "speech.public").length;
    expect(delivered).toBeLessThan(events.filter((e) => e.type === "speech.public").length);
    expect(packet).toMatchObject({
      publicFloor: {
        day: 2,
        players: expect.arrayContaining([
          { playerId: "p2", speeches: 3, accusations: 2, challenges: 0, responsesOwed: 0 },
          { playerId: "p3", speeches: 1, accusations: 0, challenges: 1, responsesOwed: 0 },
          { playerId: "p4", speeches: 10, accusations: 0, challenges: 0, responsesOwed: 0 },
          { playerId: "p5", speeches: 10, accusations: 0, challenges: 0, responsesOwed: 1 },
        ]),
      },
    });
  });

  it("renders the counts in every v4 scheduling request (three speeches versus one)", () => {
    const request = jevSchedulingRequest(schedulingPacket("journal_v4"), "journal_v4");
    expect(request.state).toMatchObject({
      floorToday: expect.stringContaining(
        "Briar (p2): 3 public speeches, 2 accusations and 0 challenges made, 0 responses owed",
      ),
    });
    expect(JSON.stringify(request.state)).toContain(
      "Cato (p3): 1 public speeches, 0 accusations and 1 challenges made, 0 responses owed",
    );
  });

  it("builds the counts from public records only", () => {
    const packet = schedulingPacket("journal_v4");
    const request = JSON.stringify(jevSchedulingRequest(packet, "journal_v4"));
    for (const canary of CANARIES) expect(JSON.stringify(packet)).not.toContain(canary);
    for (const canary of CANARIES) expect(request).not.toContain(canary);
    // Seats that only appear in private records are counted from public speech alone.
    expect(packet).toMatchObject({
      publicFloor: {
        players: expect.arrayContaining([
          { playerId: "p1", speeches: 0, accusations: 0, challenges: 0, responsesOwed: 0 },
        ]),
      },
    });
  });

  it("never sends publicFloor to the LLM: player prompts are byte-identical without it", () => {
    const packet = schedulingPacket("journal_v4");
    expect(packet).toHaveProperty("publicFloor");
    const withoutFloor: PlayerContextV2 & { publicFloor?: unknown } = { ...packet };
    delete withoutFloor.publicFloor;
    const task: V3TaskSpec = { type: "journal_update", sourceIds: [], revision: "r" };
    const prompt = (p: PlayerContextV2) => decisionRequestV31(p, task, true, null, null).prompt;
    expect(JSON.stringify(prompt(packet))).toBe(JSON.stringify(prompt(withoutFloor)));
  });

  it("leaves journal_v2 and journal_v3 packets and Jev requests without floor facts", () => {
    for (const workflow of ["journal_v2", "journal_v3"] as const)
      expect(schedulingPacket(workflow)).not.toHaveProperty("publicFloor");
    const v3 = JSON.stringify(jevSchedulingRequest(schedulingPacket("journal_v3"), "journal_v3"));
    expect(v3).not.toContain("floorToday");
    expect(v3).not.toContain("public speeches");
  });
});
