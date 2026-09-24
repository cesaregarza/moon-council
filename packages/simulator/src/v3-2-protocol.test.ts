import { describe, expect, it } from "vitest";
import { GameConfigV2Schema, emptyJournalV2, type GameEventV1, type PlayerContextV2, type PrivateJournalV2 } from "@werewolf/contracts";
import { DOCTOR_V2, STARTER_ROLES, createGameState } from "@werewolf/engine";
import { buildContextV2 } from "./context-v2";
import { tierOf } from "./evidence-tiers";
import type { V3TaskSpec } from "./request-v3";
import { decisionRequestV32, evidenceMapV31 } from "./request-v3-1";

const role = (id: string) => (id === "doctor" ? structuredClone(DOCTOR_V2) : structuredClone(STARTER_ROLES.find((c) => c.id === id)!));

function config() {
  const ids = ["werewolf", "werewolf", "seer", "doctor", "villager", "villager", "villager", "villager"];
  const seats = ids.map((_, index) => ({ id: `p${index + 1}`, name: `Player ${index + 1}`, personality: "test" }));
  return GameConfigV2Schema.parse({
    schemaVersion: "game_config_v2", protocolVersion: "agent_v3_2", preset: "standard-8-v2",
    name: "V3.2 ledger", seed: "v32-seed", seats, roleDeck: ids.map(role), rules: { firstCycle: "day_first" },
    discussion: { speakerSelection: "listener_auction", maxParallelDecisions: 4 },
    deliberation: { mode: "gated", maxContextTokens: 8_000, bidReasoningEffort: "medium" },
    modelSettings: Object.fromEntries(seats.map((seat) => [seat.id, { model: "fake", provider: "fake", reasoningEffort: "xhigh" }])),
    safety: { maxCycles: 8, maxModelCalls: 500, maxOutputTokens: 600, maxWallClockMs: 60_000 },
  });
}

/** Enough speech across enough days that the public budget cannot carry it all at full. */
function longGame(days = 5, perDay = 8): GameEventV1[] {
  const events: GameEventV1[] = [];
  let sequence = 0;
  for (let day = 1; day <= days; day += 1) {
    for (let index = 0; index < perDay; index += 1) {
      sequence += 1;
      events.push({
        schemaVersion: "game_event_v1", id: `speech-${day}-${index}`, gameId: "game", sequence,
        type: "speech.public", phase: "day_discussion", day, visibility: "public", audienceIds: [],
        payload: {
          playerId: `p${(index % 8) + 1}`, playerName: `Player ${(index % 8) + 1}`,
          text: `Day ${day} statement ${index}. `.repeat(12), acts: [], respondsTo: [], closing: false,
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    }
    sequence += 1;
    events.push({
      schemaVersion: "game_event_v1", id: `vote-${day}`, gameId: "game", sequence,
      type: "vote.resolved", phase: "day_vote", day, visibility: "public", audienceIds: [],
      payload: { ballots: [], tally: { p4: 4, p5: 4 }, tied: true, targetId: null, targetName: null },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }
  return events;
}

function state() {
  const value = createGameState("game", config());
  value.phase = "day_discussion";
  value.day = 5;
  return value;
}

const task: V3TaskSpec = { type: "discussion_bid", eligible: true, candidateIds: ["p1"], revision: "r1" };

// The orchestrator always sizes a V3 packet with its own request builder; without this the
// budget would be measured against the legacy V2 rendering, which ignores delivery tiers.
const sizer = (candidate: PlayerContextV2) => decisionRequestV32(candidate, task, true, null, null).tokens;
const build = (events: GameEventV1[], playerId: string, journal: PrivateJournalV2 = emptyJournalV2(), shared = state()) =>
  buildContextV2(shared, events, playerId, journal, playerId, "discussion", [], false, sizer);

describe("V3.2 delivery ladder", () => {
  it("delivers every public record, so no handle stops resolving under budget pressure", () => {
    const events = longGame();
    const packet = build(events, "p1");
    const delivered = new Set(packet.sources.map((source) => source.id));
    const publicIds = events.map((event) => event.id);
    expect(publicIds.every((id) => delivered.has(id))).toBe(true);

    const map = evidenceMapV31(packet);
    expect(publicIds.every((id) => Boolean(map.toAlias.get(id)))).toBe(true);
  });

  it("keeps recent speech at a higher tier than old speech, and structural records full", () => {
    const packet = build(longGame(), "p1");
    const tierFor = (id: string) => tierOf(packet.sources.find((source) => source.id === id)!);
    const rank = { stub: 0, digest: 1, full: 2 } as const;

    // The newest day is promoted first, so it is never below an older day.
    expect(rank[tierFor("speech-5-0")]).toBeGreaterThan(rank[tierFor("speech-1-0")]);
    expect(tierFor("speech-1-0")).toBe("stub");
    // Structural outcomes cannot be reconstructed from a summary, so they never demote.
    expect(tierFor("vote-1")).toBe("full");
    expect(tierFor("vote-5")).toBe("full");
  });

  it("has a real floor: a talkative current day degrades instead of overrunning the budget", () => {
    // Pilot 2 paused here. Pinning the current day at full made the floor unbounded, so a
    // long Day 2 could not fit an 8k budget however much older history was demoted.
    const shared = state();
    const chatty = longGame(5, 14);
    expect(() => build(chatty, "p1", emptyJournalV2(), shared)).not.toThrow();
    const packet = build(chatty, "p1", emptyJournalV2(), shared);
    expect(packet.sources.some((source) => source.id === "speech-5-0")).toBe(true);
  });

  it("keeps the public layer byte-identical across seats even when the ledger is demoted", () => {
    const events = longGame();
    const shared = state();
    const p1 = decisionRequestV32(build(events, "p1", emptyJournalV2(), shared), task, true, null, null);
    const p2 = decisionRequestV32(build(events, "p2", emptyJournalV2(), shared), task, true, null, null);
    expect(p1.prompt.publicInput).toBe(p2.prompt.publicInput);
    expect(p1.prompt.layerHashes?.l1).toBe(p2.prompt.layerHashes?.l1);
    expect(p1.prompt.instructions).toBe(p2.prompt.instructions);
    expect(p1.prompt.privateInput).not.toBe(p2.prompt.privateInput);
  });

  it("maps a handle to the same canonical event whatever tier it is delivered at", () => {
    const events = longGame();
    const roomy = build(events, "p1");
    const map = evidenceMapV31(roomy);
    // Handle numbering comes from a full scan of the event log, so it cannot shift with tier.
    expect(map.toCanonical.get("E1")).toBe("speech-1-0");
    const last = events.at(-1)!.id;
    const lastHandle = map.toAlias.get(last)!;
    expect(map.toCanonical.get(lastHandle)).toBe(last);
    expect(tierOf(roomy.sources.find((source) => source.id === "speech-1-0")!)).toBe("stub");
  });

  it("re-expands a stubbed record that this seat's journal cites, without touching the shared layer", () => {
    const events = longGame();
    const journal: PrivateJournalV2 = {
      ...emptyJournalV2(),
      beliefs: [{ playerId: "p3", probability: 0.6, basis: "inference", note: "Opening read was evasive", sources: ["speech-1-0"] }],
    };
    const shared = state();
    const plain = build(events, "p1", emptyJournalV2(), shared);
    const citing = build(events, "p1", journal, shared);
    const withoutCitation = decisionRequestV32(plain, task, true, null, null);
    const withCitation = decisionRequestV32(citing, task, true, null, null);

    expect(withCitation.prompt.privateInput).toContain("expandedPublicEvidence");
    expect(withoutCitation.prompt.privateInput).not.toContain("expandedPublicEvidence");
    // The expansion is per-seat, so it must not perturb the shared, cacheable layer.
    expect(withCitation.prompt.publicInput).toBe(withoutCitation.prompt.publicInput);
  });

  it("drops phase transitions from the citable ledger, since they cannot support a claim", () => {
    const phase: GameEventV1 = {
      schemaVersion: "game_event_v1", id: "phase-1", gameId: "game", sequence: 500,
      type: "phase.changed", phase: "day_discussion", day: 5, visibility: "public", audienceIds: [],
      payload: { from: "night_resolution", to: "day_discussion" }, createdAt: "2026-01-01T00:00:00.000Z",
    };
    const events = [...longGame(), phase];
    const packet = build(events, "p1");
    expect(packet.sources.some((source) => source.id === "phase-1")).toBe(false);
    // The speeches around it keep dense, contiguous handles.
    const map = evidenceMapV31(packet);
    expect(map.toCanonical.get("E1")).toBe("speech-1-0");
    expect([...map.toAlias.keys()]).not.toContain("phase-1");
  });

  it("names the exact seats to rate, the field that halted the V3.1 pilot", () => {
    const events = longGame();
    const shared = state();
    shared.players[2]!.alive = false;
    shared.players[5]!.alive = false;
    const request = decisionRequestV32(build(events, "p1", emptyJournalV2(), shared), task, true, null, null);
    const directive = JSON.parse(request.prompt.input).REQUEST.listen;
    expect(directive.rateExactly).toEqual(["p2", "p4", "p5", "p7", "p8"]);
    // Self and the dead are listed too, so neither set has to be inferred from a flag.
    expect(directive.nullFor).toEqual(["p1", "p3", "p6"]);
  });

  it("keeps a closed night's team pointing citable, with its content withheld", () => {
    // Pilot 2 halted here: a wolf journalled its own Night 1 pick, and on Day 2 the
    // record was withheld entirely, so the citation had nothing to resolve to.
    const shared = state();
    // Roles are dealt by seed, so the pointing seat has to be a real werewolf; only a
    // team_channel role is ever shown team pointing.
    const wolves = shared.players.filter((player) => player.role.alignment === "werewolf").map((player) => player.id);
    expect(wolves.length).toBeGreaterThan(0);
    const point: GameEventV1 = {
      schemaVersion: "game_event_v1", id: "point-1", gameId: "game", sequence: 600,
      type: "team.point", phase: "night_team", day: 1, visibility: "team", audienceIds: wolves,
      payload: { playerId: wolves[0], targetId: "p4", round: 0, blind: true }, createdAt: "2026-01-01T00:00:00.000Z",
    };
    const journal: PrivateJournalV2 = {
      ...emptyJournalV2(),
      hypotheses: [{ id: "h1", statement: "The pack opened on Dax", confidence: 0.8, sources: ["point-1"] }],
    };
    const packet = build([...longGame(), point], wolves[0]!, journal, shared);
    const delivered = packet.sources.find((source) => source.id === "point-1");
    expect(delivered).toBeDefined();
    expect(delivered!.data).toEqual({});
    // The handle resolves, so building the request no longer throws.
    const request = decisionRequestV32(packet, task, true, null, null);
    const cited = JSON.parse(request.prompt.privateInput).AUTHORIZED_PRIVATE_STATE.journal.hypotheses[0].sources;
    expect(cited).toHaveLength(1);
    expect(cited[0]).toMatch(/^R\d+$/);
  });

  it("labels V3.2 requests distinctly so V3.1 prefixes are never routed together", () => {
    const packet = build(longGame(), "p1");
    const request = decisionRequestV32(packet, task, true, null, null);
    expect(request.promptVersion).toBe("player_prompt_v3.2");
    expect(request.schemaVersion).toBe("discussion_bid_v3_2");
    expect(request.prompt.cache.stablePrefix.startsWith("werewolf-player-v3.2:")).toBe(true);
  });
});
