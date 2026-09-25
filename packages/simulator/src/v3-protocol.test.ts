import { afterEach, describe, expect, it } from "vitest";
import {
  GameConfigV2Schema,
  emptyJournalV2,
  type DiscussionBidV3,
  type TargetChoiceSubmissionV3,
} from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import {
  DOCTOR_V2,
  STARTER_ROLES,
  createGameCreatedEvent,
  createGameState,
  reduceGame,
} from "@werewolf/engine";
import { FakeDecisionProvider, type DecisionProvider } from "@werewolf/llm";
import { applyJournalV2, buildContextV2 } from "./context-v2";
import { V2GameOrchestrator } from "./orchestrator-v2";
import {
  canonicalizeV3Plan,
  decisionRequestV3,
  normalizeV3Submission,
  validateV3Submission,
  v3SubmissionSchema,
} from "./request-v3";
import { estimatedTokens } from "./request-v2";
import { auditGameV2 } from "./audit-v2";
import { validatePreparedReport } from "./decisions-v2";

const connections: DatabaseConnection[] = [];
afterEach(() => {
  while (connections.length) connections.pop()!.close();
});
const role = (id: string) =>
  id === "doctor"
    ? structuredClone(DOCTOR_V2)
    : structuredClone(STARTER_ROLES.find((candidate) => candidate.id === id)!);
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
    ],
    seats = ids.map((_, index) => ({
      id: `p${index + 1}`,
      name: `Player ${index + 1}`,
      personality: "test",
    }));
  return GameConfigV2Schema.parse({
    schemaVersion: "game_config_v2",
    protocolVersion: "agent_v3",
    preset: "standard-8-v2",
    name: "V3 protocol",
    seed: "v3-seed",
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
function repo() {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  const repository = new LabRepository(connection);
  repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
  return repository;
}

describe("V3 task protocol", () => {
  it("constrains evidence and legal selections to local handles and constructs the canonical report in code", () => {
    const state = createGameState("game", config());
    state.phase = "day_vote";
    state.day = 1;
    const packet = buildContextV2(
      state,
      [],
      "p1",
      emptyJournalV2(),
      "vote",
      "vote",
      [],
      false,
      (candidate) =>
        decisionRequestV3(
          candidate,
          { type: "vote_choice", proposalKind: "vote" },
          true,
          null,
          null,
        ).tokens,
    );
    const task = { type: "vote_choice", proposalKind: "vote" } as const,
      schema = v3SubmissionSchema(packet, task);
    const valid: TargetChoiceSubmissionV3 = {
      mode: "direct",
      choiceHandles: ["a"],
      rationale: "A tentative social choice.",
      evidence: ["e1"],
      memory: {
        beliefs: [],
        hypotheses: [],
        strategyUpdate: null,
        questionsUpdate: null,
        deceptionUpdate: null,
      },
      reconsiderationQuestion: null,
    };
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, choiceHandles: ["not-a-choice"] }).success).toBe(false);
    expect(schema.safeParse({ ...valid, evidence: ["invented"] }).success).toBe(false);
    const unavailable = { ...valid, choiceHandles: ["p"] } as TargetChoiceSubmissionV3;
    expect(schema.safeParse(unavailable).success).toBe(true);
    expect(validateV3Submission(packet, task, unavailable)).toContain(
      "choice handles must reference current legal choices",
    );
    const report = normalizeV3Submission(packet, task, valid, "decision", true);
    expect(report.proposal).toEqual({
      kind: "vote",
      targets: { mode: "direct", playerIds: [packet.legalTargets[0]] },
    });
    expect(report).toMatchObject({ selectedAlternativeId: "a1", control: { kind: "commit" } });
  });

  it("lets a closing reply cite delivered supporting evidence while addressing only its frozen docket", () => {
    const state = createGameState("game", config());
    state.phase = "day_discussion";
    state.day = 2;
    const packet = buildContextV2(
      state,
      [],
      "p1",
      emptyJournalV2(),
      "closing",
      "discussion",
      [],
      true,
    );
    packet.sources.push(
      {
        id: "docket-speech",
        type: "speech.public",
        day: 2,
        scope: "public",
        data: { playerId: "p2", text: "Why did you vote there?" },
      },
      {
        id: "supporting-result",
        type: "vote.resolved",
        day: 1,
        scope: "public",
        data: { targetId: "p3" },
      },
    );
    packet.responseDocket = ["docket-speech"];
    const task = { type: "closing_response", revision: "closing" } as const;
    const submission = {
      text: "I answered that vote question using yesterday's result.",
      acts: [
        {
          kind: "reply" as const,
          targetId: "p2",
          claim: "The revealed result changed my view.",
          evidence: "e5",
        },
      ],
      respondsTo: ["e4"],
      rationale: "Answer the outstanding accusation.",
      memory: {
        beliefs: [],
        hypotheses: [],
        strategyUpdate: null,
        questionsUpdate: null,
        deceptionUpdate: null,
      },
    };
    expect(validateV3Submission(packet, task, submission)).toEqual([]);
    const report = normalizeV3Submission(packet, task, submission, "closing-decision", true);
    expect(validatePreparedReport(report, packet, 1_200, true).errors).toEqual([]);
    expect(validateV3Submission(packet, task, { ...submission, respondsTo: ["e5"] })).toContain(
      "closing speech must reply to the frozen docket",
    );
  });

  it("carries frozen reply references canonically between bid and speech packets", () => {
    const state = createGameState("game", config());
    state.phase = "day_discussion";
    state.day = 2;
    const source = {
      id: "canonical-speech",
      type: "speech.public",
      day: 2,
      scope: "public",
      data: { playerId: "p2", text: "Answer this question." },
    } as const;
    const bidPacket = buildContextV2(state, [], "p1", emptyJournalV2(), "bid", "discussion");
    bidPacket.sources.push(source);
    const canonicalPlan = canonicalizeV3Plan(bidPacket, {
      kind: "reply",
      targetId: "p2",
      respondsTo: [`e${bidPacket.sources.length}`],
      point: "Answer the question.",
    });
    expect(canonicalPlan.respondsTo).toEqual([source.id]);
    const speechPacket = buildContextV2(
      state,
      [],
      "p1",
      emptyJournalV2(),
      "speech",
      "discussion",
      canonicalPlan.respondsTo,
    );
    speechPacket.sources.push(source);
    const task = {
      type: "discussion_speech",
      plan: canonicalPlan,
      ready: false,
      revision: "frozen",
    } as const;
    const request = decisionRequestV3(speechPacket, task, true, null, null);
    const briefing = JSON.parse(request.prompt.sharedInput!) as {
      AUTHORIZED_PLAYER_BRIEFING: { task: { plan: { respondsTo: string[] } } };
    };
    expect(briefing.AUTHORIZED_PLAYER_BRIEFING.task.plan.respondsTo).toEqual([
      `e${speechPacket.sources.length}`,
    ]);
    const submission = {
      text: "I am answering it now.",
      acts: [
        { kind: "reply" as const, targetId: "p2", claim: "Here is my answer.", evidence: null },
      ],
      respondsTo: [],
      rationale: "Reply to the frozen question.",
      memory: {
        beliefs: [],
        hypotheses: [],
        strategyUpdate: null,
        questionsUpdate: null,
        deceptionUpdate: null,
      },
    };
    expect(validateV3Submission(speechPacket, task, submission)).toEqual([]);
    expect(
      normalizeV3Submission(speechPacket, task, submission, "speech", true).proposal,
    ).toMatchObject({ kind: "discussion", speech: { respondsTo: [source.id] } });
  });

  it("runs reactive bids before selected-only speeches without superseding unused drafts", async () => {
    const repository = repo(),
      record = repository.createGame(config());
    repository.appendEvent(
      record.id,
      createGameCreatedEvent(createGameState(record.id, record.config)),
    );
    repository.updateGame(record.id, { status: "running" });
    const fake = new FakeDecisionProvider(),
      calls: { kind: string; effort?: string; player?: string }[] = [];
    const provider: DecisionProvider = {
      decide: async (request) => {
        calls.push({
          kind: request.schemaName,
          effort: request.reasoningEffort,
          player: request.playerId,
        });
        return fake.decide(request);
      },
    };
    const orchestrator = new V2GameOrchestrator(repository, provider);
    await orchestrator.runGameStep(record.id);
    expect(reduceGame(record.id, repository.listEvents(record.id)).phase).toBe("day_discussion");
    await orchestrator.runGameStep(record.id);
    const events = repository.listEvents(record.id),
      state = reduceGame(record.id, events),
      store = new DecisionStore(repository);
    expect(state.phase).toBe("day_vote");
    const auctionSpeeches = events.filter(
      (event) => event.type === "speech.public" && !event.payload.closing,
    );
    expect(auctionSpeeches.length).toBeGreaterThan(0);
    expect(auctionSpeeches.length).toBeLessThanOrEqual(12);
    expect(events.filter((event) => event.type === "decision.superseded")).toHaveLength(0);
    expect(
      calls
        .filter((call) => call.kind === "discussion_bid" || call.kind === "discussion_listen")
        .every((call) => call.effort === "medium"),
    ).toBe(true);
    expect(
      calls
        .filter((call) => call.kind === "discussion_speech")
        .every((call) => call.effort === "xhigh"),
    ).toBe(true);
    const speechDecisions = store
      .opportunities(record.id)
      .filter((opportunity) => opportunity.taskType === "discussion_speech");
    expect(speechDecisions).toHaveLength(auctionSpeeches.length);
    expect(
      speechDecisions.every((opportunity) =>
        Boolean((opportunity.bestSubmission as { text?: string } | undefined)?.text),
      ),
    ).toBe(true);
    expect(
      store
        .opportunities(record.id)
        .filter((opportunity) => opportunity.taskType === "discussion_bid")
        .every((opportunity) => !("proposal" in (opportunity.bestSubmission as object))),
    ).toBe(true);
  }, 30_000);

  it("keeps a listener's sparse memory even when another player wins the auction", () => {
    const state = createGameState("game", config());
    state.phase = "day_discussion";
    state.day = 1;
    const packet = buildContextV2(state, [], "p1", emptyJournalV2(), "bid", "discussion"),
      task = {
        type: "discussion_bid",
        eligible: true,
        candidateIds: state.players.map((player) => player.id),
        revision: "initial",
      } as const;
    const bid: DiscussionBidV3 = {
      urge: 0,
      ready: false,
      plan: null,
      listen: Object.fromEntries(
        state.players.filter((player) => player.id !== "p1").map((player) => [player.id, 0.5]),
      ),
      memory: {
        beliefs: [
          {
            playerId: "p2",
            probability: 0.65,
            note: "Their opening posture is somewhat suspicious.",
            evidence: ["e3"],
          },
        ],
        hypotheses: [],
        strategyUpdate: null,
        questionsUpdate: null,
        deceptionUpdate: null,
      },
      rationale: "Listen before speaking.",
    };
    expect(validateV3Submission(packet, task, bid)).toEqual([]);
    const report = normalizeV3Submission(packet, task, bid, "bid-memory", true);
    expect(report.journalPatch).toMatchObject([
      { op: "upsert_belief", value: { playerId: "p2", probability: 0.65, basis: "inference" } },
    ]);
    expect(
      (report as unknown as { speakerIntent: { wantsToSpeak: boolean } }).speakerIntent
        .wantsToSpeak,
    ).toBe(false);
  });

  it("replaces the oldest hypothesis when a bounded journal is already full", () => {
    const state = createGameState("game", config());
    state.phase = "day_discussion";
    state.day = 2;
    const journal = {
      ...emptyJournalV2(),
      hypotheses: Array.from({ length: 6 }, (_, index) => ({
        id: `old-${index}`,
        statement: `Old hypothesis ${index}`,
        confidence: 0.4,
        sources: [],
      })),
    };
    const packet = buildContextV2(state, [], "p1", journal, "saturated", "discussion"),
      task = {
        type: "discussion_listen" as const,
        eligible: false as const,
        candidateIds: ["p2"] as string[],
        revision: "initial",
      };
    const submission = {
      ready: false,
      listen: Object.fromEntries(
        state.players.filter((player) => player.id !== "p1").map((player) => [player.id, 0.5]),
      ),
      memory: {
        beliefs: [],
        hypotheses: [{ statement: "A fresher explanation", confidence: 0.7, evidence: ["e3"] }],
        strategyUpdate: null,
        questionsUpdate: null,
        deceptionUpdate: null,
      },
      rationale: "Update the bounded memory.",
    };
    const report = normalizeV3Submission(packet, task, submission, "saturated-decision", true),
      next = applyJournalV2(journal, report, 1_200);
    expect(next.hypotheses).toHaveLength(6);
    expect(next.hypotheses.some((item) => item.statement === "A fresher explanation")).toBe(true);
    expect(next.hypotheses.some((item) => item.statement === "Old hypothesis 0")).toBe(false);
  });

  it("keeps a valid task choice when only an optional journal patch exceeds its token budget", () => {
    const state = createGameState("game", config());
    state.phase = "day_discussion";
    state.day = 1;
    const packet = buildContextV2(
        state,
        [],
        "p1",
        emptyJournalV2(),
        "annotation-limit",
        "discussion",
      ),
      task = {
        type: "discussion_listen" as const,
        eligible: false as const,
        candidateIds: ["p2"] as string[],
        revision: "initial",
      };
    const submission = {
      ready: false,
      listen: Object.fromEntries(
        state.players.filter((player) => player.id !== "p1").map((player) => [player.id, 0.5]),
      ),
      memory: {
        beliefs: [],
        hypotheses: [],
        strategyUpdate: { strategy: "x".repeat(600), goals: [] },
        questionsUpdate: null,
        deceptionUpdate: null,
      },
      rationale: "Keep listening.",
    };
    const report = normalizeV3Submission(packet, task, submission, "large-annotation", true);
    const result = validatePreparedReport(report, packet, 200, true);
    expect(result.errors).toEqual([]);
    expect(result.annotationErrors.some((error) => error.includes("journal_limit"))).toBe(true);
    expect(result.report.journalPatch).toEqual([]);
  });

  it("keeps a cacheable public prefix identical while private player briefings vary", () => {
    const state = createGameState("game", config());
    state.phase = "day_discussion";
    state.day = 1;
    const task = {
      type: "discussion_bid",
      eligible: true,
      candidateIds: state.players.map((player) => player.id),
      revision: "initial",
    } as const;
    const first = decisionRequestV3(
      buildContextV2(state, [], "p1", emptyJournalV2(), "bid-p1", "discussion"),
      task,
      true,
      null,
      null,
    );
    const second = decisionRequestV3(
      buildContextV2(state, [], "p2", emptyJournalV2(), "bid-p2", "discussion"),
      task,
      true,
      null,
      null,
    );
    expect(first.prompt.instructions).toBe(second.prompt.instructions);
    expect(first.prompt.sharedInput).not.toBe(second.prompt.sharedInput);
    expect(first.prompt.cache?.stablePrefix).toBe(second.prompt.cache?.stablePrefix);
    expect(estimatedTokens(first.prompt.instructions)).toBeGreaterThan(1_024);
    const expanded = buildContextV2(
      state,
      [],
      "p1",
      emptyJournalV2(),
      "bid-p1-later",
      "discussion",
    );
    expanded.sources.push({
      id: "event-later",
      type: "speech.public",
      day: 1,
      scope: "public",
      data: {
        playerId: "p2",
        playerName: "Player 2",
        text: "A later claim.",
        acts: [],
        respondsTo: [],
        closing: false,
      },
    });
    expect(decisionRequestV3(expanded, task, true, null, null).jsonSchema).toEqual(
      first.jsonSchema,
    );
  });

  it("runs a complete mocked standard game through V3 bids, votes, and night choices", async () => {
    const repository = repo(),
      record = repository.createGame(config()),
      fake = new FakeDecisionProvider();
    const provider: DecisionProvider = {
      decide: async (request) => {
        const result = await fake.decide(request);
        if (request.schemaName !== "vote_choice") return result;
        const target = reduceGame(record.id, repository.listEvents(record.id)).players.find(
          (player) =>
            player.alive && player.role.alignment === "werewolf" && player.id !== request.playerId,
        )?.id;
        if (!target) return result;
        const briefing = JSON.parse(request.preparedPrompt!.sharedInput!) as {
          AUTHORIZED_PLAYER_BRIEFING: { legalChoices: Record<string, { playerId: string }> };
        };
        const handle = Object.entries(briefing.AUTHORIZED_PLAYER_BRIEFING.legalChoices).find(
          ([, choice]) => choice.playerId === target,
        )?.[0];
        if (!handle) return result;
        return {
          ...result,
          data: {
            ...(result.data as TargetChoiceSubmissionV3),
            mode: "direct",
            choiceHandles: [handle],
            reconsiderationQuestion: null,
          },
        } as typeof result;
      },
    };
    const orchestrator = new V2GameOrchestrator(repository, provider);
    for (let step = 0; step < 32; step += 1) {
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
      events.filter(
        (event) => event.type === "player.eliminated" && event.payload.roleName === "Werewolf",
      ),
    ).toHaveLength(2);
    for (const point of events.filter((event) => event.type === "team.point")) {
      expect(Object.keys(point.payload).sort()).toEqual(["blind", "playerId", "round", "targetId"]);
      expect(point.payload).toMatchObject({
        blind: expect.any(Boolean),
        round: expect.any(Number),
      });
    }
    expect(auditGameV2(repository, record.id).issues).toEqual([]);
  }, 45_000);
});
