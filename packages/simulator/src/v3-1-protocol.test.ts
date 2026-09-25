import { afterEach, describe, expect, it } from "vitest";
import {
  providerJsonSchema,
  GameConfigV2Schema,
  emptyJournalV2,
  type GameEventV1,
} from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import {
  DOCTOR_V2,
  STARTER_ROLES,
  createGameCreatedEvent,
  createGameState,
} from "@werewolf/engine";
import { FakeDecisionProvider } from "@werewolf/llm";
import { authorizedSources, buildContextV2 } from "./context-v2";
import { V2GameOrchestrator } from "./orchestrator-v2";
import type { V3TaskSpec } from "./request-v3";
import {
  canonicalizeV31Plan,
  decisionRequestV31,
  evidenceMapV31,
  normalizeV31Submission,
  v31SubmissionSchema,
  v31ApiResponseFormat,
  validateV31Submission,
} from "./request-v3-1";

const role = (id: string) =>
  id === "doctor"
    ? structuredClone(DOCTOR_V2)
    : structuredClone(STARTER_ROLES.find((candidate) => candidate.id === id)!);
const connections: DatabaseConnection[] = [];
afterEach(() => {
  while (connections.length) connections.pop()!.close();
});
function config() {
  const ids = [
    "werewolf",
    "werewolf",
    "seer",
    "doctor",
    "villager",
    "villager",
    "villager",
    "villager",
  ];
  const seats = ids.map((_, index) => ({
    id: `p${index + 1}`,
    name: `Player ${index + 1}`,
    personality: "test",
  }));
  return GameConfigV2Schema.parse({
    schemaVersion: "game_config_v2",
    protocolVersion: "agent_v3_1",
    preset: "standard-8-v2",
    name: "V3.1 protocol",
    seed: "v31-seed",
    seats,
    roleDeck: ids.map(role),
    rules: { firstCycle: "day_first" },
    discussion: { speakerSelection: "listener_auction", maxParallelDecisions: 4 },
    deliberation: { mode: "gated", maxContextTokens: 8_000, bidReasoningEffort: "medium" },
    modelSettings: Object.fromEntries(
      seats.map((seat) => [seat.id, { model: "fake", provider: "fake", reasoningEffort: "xhigh" }]),
    ),
    safety: { maxCycles: 4, maxModelCalls: 500, maxOutputTokens: 600, maxWallClockMs: 60_000 },
  });
}
function event(
  id: string,
  sequence: number,
  type: string,
  visibility: GameEventV1["visibility"],
  audienceIds: string[],
  payload: Record<string, unknown>,
): GameEventV1 {
  return {
    schemaVersion: "game_event_v1",
    id,
    gameId: "game",
    sequence,
    type,
    phase: "day_discussion",
    day: 2,
    visibility,
    audienceIds,
    payload,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
const memory = {
  beliefs: [],
  hypotheses: [],
  strategyUpdate: null,
  questionsUpdate: null,
  deceptionUpdate: null,
};

describe("V3.1 evidence and cache protocol", () => {
  it("keeps public handles identical across players while private deliveries use an owner-only namespace", () => {
    const state = createGameState("game", config());
    state.phase = "day_discussion";
    state.day = 2;
    const events = [
      event("public-a", 1, "speech.public", "public", [], {
        playerId: "p2",
        playerName: "Player 2",
        text: "First claim",
        acts: [],
        respondsTo: [],
        closing: false,
      }),
      event("private-a", 2, "inspection.delivered", "player", ["p1"], {
        actorId: "p1",
        targetId: "p2",
        targetName: "Player 2",
        result: "werewolf",
      }),
      event("public-b", 3, "speech.public", "public", [], {
        playerId: "p3",
        playerName: "Player 3",
        text: "Second claim",
        acts: [],
        respondsTo: [],
        closing: false,
      }),
    ];
    const p1 = buildContextV2(state, events, "p1", emptyJournalV2(), "bid-p1", "discussion");
    const p2 = buildContextV2(state, events, "p2", emptyJournalV2(), "bid-p2", "discussion");
    const first = evidenceMapV31(p1),
      second = evidenceMapV31(p2);
    expect(first.toCanonical.get("E1")).toBe("public-a");
    expect(first.toCanonical.get("E2")).toBe("public-b");
    expect(second.toCanonical.get("E1")).toBe("public-a");
    expect(second.toCanonical.get("E2")).toBe("public-b");
    expect(first.toCanonical.get("R2")).toBe("private-a");
    expect(second.toCanonical.has("R2")).toBe(false);
    expect(
      authorizedSources(state, events, "p1").find((source) => source.id === "private-a")
        ?.privateIndex,
    ).toBe(2);
  });

  it("builds byte-identical public and schema layers across seats while private layers differ", () => {
    const state = createGameState("game", config());
    state.phase = "day_discussion";
    state.day = 1;
    const events = [
      event("public-a", 1, "speech.public", "public", [], {
        playerId: "p3",
        playerName: "Player 3",
        text: "A public claim",
        acts: [],
        respondsTo: [],
        closing: false,
      }),
    ];
    const task: V3TaskSpec = {
      type: "discussion_bid",
      eligible: true,
      candidateIds: state.players.map((player) => player.id),
      revision: "one",
    };
    const p1 = decisionRequestV31(
      buildContextV2(state, events, "p1", emptyJournalV2(), "p1", "discussion"),
      task,
      true,
      null,
      null,
    );
    const p2 = decisionRequestV31(
      buildContextV2(state, events, "p2", emptyJournalV2(), "p2", "discussion"),
      task,
      true,
      null,
      null,
    );
    expect(p1.prompt.instructions).toBe(p2.prompt.instructions);
    expect(p1.prompt.publicInput).toBe(p2.prompt.publicInput);
    expect(p1.prompt.privateInput).not.toBe(p2.prompt.privateInput);
    expect(p1.jsonSchema).toEqual(p2.jsonSchema);
    expect(p1.prompt.layerHashes?.l1).toBe(p2.prompt.layerHashes?.l1);
    expect(p1.prompt.layerHashes?.schema).toBe(p2.prompt.layerHashes?.schema);
    expect(p1.prompt.cache).toMatchObject({
      stablePrefix: `werewolf-player-v3.1:${p1.prompt.layerHashes!.l0.slice(0, 16)}`,
      boundary: "public",
    });
  });

  it("keeps one strict API schema across journal, free speech and closing without weakening task validation", () => {
    const state = createGameState("game", config());
    state.phase = "day_discussion";
    const packet = buildContextV2(state, [], "p1", emptyJournalV2(), "api", "discussion");
    packet.rules.jevWorkflow = "journal_v2";
    const journalTask: V3TaskSpec = { type: "journal_update", sourceIds: [], revision: "a" };
    const speechTask: V3TaskSpec = { type: "discussion_free_speech", ready: false, revision: "b" };
    const closingTask: V3TaskSpec = { type: "closing_response", revision: "c" };
    const journal = v31ApiResponseFormat(packet, journalTask)!,
      speech = v31ApiResponseFormat(packet, speechTask)!,
      closing = v31ApiResponseFormat(packet, closingTask)!;
    expect(providerJsonSchema(journal.schema)).toEqual(providerJsonSchema(speech.schema));
    expect(providerJsonSchema(closing.schema)).toEqual(providerJsonSchema(speech.schema));
    expect(journal.instructions).toBe(speech.instructions);
    const envelope = {
      task: "journal_update",
      memory: { ...memory, attentionUpdate: null },
      speech: null,
      rationale: "No change.",
    };
    expect(
      v31SubmissionSchema(packet, journalTask).safeParse(journal.decode(envelope)).success,
    ).toBe(true);
    expect(() => speech.decode(envelope)).toThrow("Expected API response task");
    expect(() =>
      journal.decode({ ...envelope, speech: { text: "hello", acts: [], respondsTo: [] } }),
    ).toThrow("cannot contain speech");
    const decoded = closing.decode({
      ...envelope,
      task: "closing_response",
      speech: {
        text: "An accusation",
        acts: [{ kind: "accusation", targetId: "p2", claim: "Suspect", evidence: null }],
        respondsTo: [],
      },
    });
    expect(v31SubmissionSchema(packet, closingTask).safeParse(decoded).success).toBe(false);
    expect(() =>
      speech.decode({
        ...envelope,
        task: "discussion_free_speech",
        speech: { text: "hello", acts: [], respondsTo: [] },
        memory: { ...envelope.memory, attentionUpdate: [] },
      }),
    ).toThrow("Listening-note replacement");
  });

  it("never publishes private provenance or packet handles in natural-language speech", () => {
    const state = createGameState("game", config());
    state.phase = "day_discussion";
    state.day = 2;
    const events = [
      event("private-a", 1, "inspection.delivered", "player", ["p1"], {
        actorId: "p1",
        targetId: "p2",
        targetName: "Player 2",
        result: "werewolf",
      }),
    ];
    const packet = buildContextV2(state, events, "p1", emptyJournalV2(), "speech", "discussion");
    const task: V3TaskSpec = {
      type: "discussion_speech",
      plan: {
        kind: "result_claim",
        targetId: "p2",
        respondsTo: [],
        point: "State my private result.",
      },
      ready: false,
      revision: "one",
    };
    const submission = {
      text: "I inspected Player 2 last night and received a werewolf result.",
      acts: [
        {
          kind: "result_claim" as const,
          targetId: "p2",
          claim: "My private result names Player 2 as a werewolf.",
          evidence: "R2",
        },
      ],
      respondsTo: [],
      rationale: "Disclose the result without authenticating metadata.",
      memory,
    };
    expect(validateV31Submission(packet, task, submission)).toEqual([]);
    const report = normalizeV31Submission(packet, task, submission, "speech", true);
    expect(report.proposal).toMatchObject({
      kind: "discussion",
      speech: { acts: [{ sourceId: null }] },
    });
    expect(
      validateV31Submission(packet, task, { ...submission, text: "The result is recorded as R2." }),
    ).toContain('public text contains bookkeeping handle "R2"; describe the evidence in words');
    expect(
      validateV31Submission(packet, task, {
        ...submission,
        acts: [{ kind: "result_claim", targetId: "p2", claim: "See e15.", evidence: "R2" }],
      }),
    ).toContain('public text contains bookkeeping handle "e15"; describe the evidence in words');
  });

  it("keeps a frozen public reply stable between bid and speech packets", () => {
    const state = createGameState("game", config());
    state.phase = "day_discussion";
    state.day = 2;
    const events = [
      event("public-a", 1, "speech.public", "public", [], {
        playerId: "p2",
        playerName: "Player 2",
        text: "Answer this.",
        acts: [],
        respondsTo: [],
        closing: false,
      }),
    ];
    const bidPacket = buildContextV2(state, events, "p1", emptyJournalV2(), "bid", "discussion");
    const plan = canonicalizeV31Plan(bidPacket, {
      kind: "reply",
      targetId: "p2",
      respondsTo: ["E1"],
      point: "Answer the question.",
    });
    expect(plan.respondsTo).toEqual(["public-a"]);
    const speechPacket = buildContextV2(
      state,
      events,
      "p1",
      emptyJournalV2(),
      "speech",
      "discussion",
      plan.respondsTo,
    );
    const request = decisionRequestV31(
      speechPacket,
      { type: "discussion_speech", plan, ready: false, revision: "one" },
      true,
      null,
      null,
    );
    const task = JSON.parse(request.prompt.input).REQUEST.task as {
      plan: { respondsTo: string[] };
    };
    expect(task.plan.respondsTo).toEqual(["E1"]);
  });

  it("uses one fixed listener schema for all seats, including self and dead seats as null", () => {
    const state = createGameState("game", config());
    state.phase = "day_discussion";
    state.day = 2;
    state.players[7]!.alive = false;
    const packet = buildContextV2(state, [], "p1", emptyJournalV2(), "bid", "discussion");
    const task: V3TaskSpec = {
      type: "discussion_bid",
      eligible: true,
      candidateIds: ["p1", "p2"],
      revision: "one",
    };
    const schema = v31SubmissionSchema(packet, task);
    const listen = Object.fromEntries(
      state.players.map((player) => [player.id, player.id === "p1" || !player.alive ? null : 0.5]),
    );
    const result = {
      urge: 0,
      ready: false,
      plan: null,
      listen,
      memory,
      rationale: "Listen first.",
    };
    expect(schema.safeParse(result).success).toBe(true);
    expect(validateV31Submission(packet, task, result)).toEqual([]);
    expect(
      validateV31Submission(packet, task, { ...result, listen: { ...listen, p1: 0.5 } }),
    ).toContain("listen.p1 must be null for self or dead players");
  });

  it("runs a complete mocked game with stable task schemas and no published handle tokens", async () => {
    const connection = openDatabase(":memory:");
    connections.push(connection);
    const repository = new LabRepository(connection);
    repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
    const record = repository.createGame(config());
    repository.appendEvent(
      record.id,
      createGameCreatedEvent(createGameState(record.id, record.config)),
    );
    repository.updateGame(record.id, { status: "running" });
    const orchestrator = new V2GameOrchestrator(repository, new FakeDecisionProvider());
    for (let step = 0; step < 40; step += 1) {
      await orchestrator.runGameStep(record.id);
      if (
        ["completed", "paused", "budget_exhausted"].includes(repository.getGame(record.id)!.status)
      )
        break;
    }
    expect(repository.getGame(record.id)?.status, repository.getGame(record.id)?.error).toBe(
      "completed",
    );
    const events = repository.listEvents(record.id);
    expect(
      events
        .filter((item) => item.type === "speech.public")
        .some((item) => /\b(?:E|R|e)\d+\b/.test(String(item.payload.text))),
    ).toBe(false);
    const attempts = new DecisionStore(repository).attempts(record.id);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((attempt) => attempt.promptVersion === "player_prompt_v3.1")).toBe(true);
    const schemaHashes = new Map<string, Set<string>>();
    const publicHashesByTaskRevision = new Map<string, Set<string>>();
    for (const attempt of attempts) {
      const schemaHash = attempt.request.layerHashes?.schema;
      if (!schemaHash) continue;
      const hashes = schemaHashes.get(attempt.schemaVersion) ?? new Set<string>();
      hashes.add(schemaHash);
      schemaHashes.set(attempt.schemaVersion, hashes);
      const request = JSON.parse(attempt.request.input ?? "{}") as {
        REQUEST?: { task?: { type?: string; revision?: string } };
      };
      const type = request.REQUEST?.task?.type,
        revision = request.REQUEST?.task?.revision;
      if (type && revision && attempt.request.layerHashes?.l1) {
        const key = `${type}:${revision}`,
          values = publicHashesByTaskRevision.get(key) ?? new Set<string>();
        values.add(attempt.request.layerHashes.l1);
        publicHashesByTaskRevision.set(key, values);
      }
    }
    expect([...schemaHashes.values()].every((values) => values.size === 1)).toBe(true);
    expect([...publicHashesByTaskRevision.values()].every((values) => values.size === 1)).toBe(
      true,
    );
  }, 120_000);
});
