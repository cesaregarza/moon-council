import { afterEach, describe, expect, it } from "vitest";
import {
  GameConfigV2Schema,
  emptyJournalV2,
  reportSchema,
  type DecisionOpportunityV1,
  type GameEventV1,
  type PlayerContextV2,
  type PrivateJournalV2,
} from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import {
  DOCTOR_V2,
  STARTER_ROLES,
  createGameCreatedEvent,
  createGameState,
  reduceGame,
  shuffled,
  transition,
} from "@werewolf/engine";
import { FakeDecisionProvider, type DecisionProvider } from "@werewolf/llm";
import { V2GameOrchestrator } from "./orchestrator-v2";
import { DecisionExecutorV2 } from "./decisions-v2";
import { buildContextV2, validateReport } from "./context-v2";
import {
  discussionAuctionPlan,
  nextDiscussionWork,
  rankSpeakerAuction,
  responseDockets,
} from "./scheduler-v2";
import {
  CACHEABLE_PLAYER_INSTRUCTIONS,
  canonicalizeReportReferences,
  decisionRequestV2,
  estimatedTokens,
  stableDecisionContext,
  stableGameReference,
} from "./request-v2";
import { auditGameV2 } from "./audit-v2";

const connections: DatabaseConnection[] = [];
afterEach(() => {
  while (connections.length) connections.pop()!.close();
});
const role = (id: string) =>
  id === "doctor"
    ? structuredClone(DOCTOR_V2)
    : structuredClone(STARTER_ROLES.find((candidate) => candidate.id === id)!);
function makeConfig(
  ids = ["werewolf", "werewolf", "seer", "doctor", "villager", "villager", "villager", "villager"],
) {
  const seats = ids.map((_, index) => ({
    id: "p" + (index + 1),
    name: "Player " + (index + 1),
    personality: "test",
  }));
  return GameConfigV2Schema.parse({
    schemaVersion: "game_config_v2",
    name: "V2 protocol",
    seed: "strict-v2-seed",
    seats,
    roleDeck: ids.map(role),
    modelSettings: Object.fromEntries(
      seats.map((seat) => [
        seat.id,
        { model: "fake-model", reasoningEffort: "medium", provider: "fake" },
      ]),
    ),
    safety: { maxCycles: 4, maxModelCalls: 500, maxOutputTokens: 600, maxWallClockMs: 60_000 },
    deliberation: { maxContextTokens: 8_000 },
  });
}
function repo(): LabRepository {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  const repository = new LabRepository(connection);
  repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
  return repository;
}
function game(
  repository: LabRepository,
  ids = ["werewolf", "werewolf", "seer", "doctor", "villager", "villager", "villager", "villager"],
) {
  const record = repository.createGame(makeConfig(ids));
  repository.appendEvent(
    record.id,
    createGameCreatedEvent(createGameState(record.id, record.config)),
  );
  return record;
}
function runningGame(repository: LabRepository) {
  const record = game(repository);
  repository.appendEvent(record.id, {
    type: "game.started",
    phase: "setup",
    day: 0,
    visibility: "public",
    payload: { startedAt: "2026-01-01T00:00:00.000Z" },
  });
  repository.appendEvent(
    record.id,
    transition(reduceGame(record.id, repository.listEvents(record.id)), "night_actions", 1),
  );
  repository.updateGame(record.id, { status: "running" });
  return record;
}
let eventSequence = 0;
function event(
  type: string,
  phase: GameEventV1["phase"],
  day: number,
  payload: Record<string, unknown>,
  visibility: GameEventV1["visibility"] = "public",
  audienceIds: string[] = [],
): GameEventV1 {
  return {
    schemaVersion: "game_event_v1",
    id: type + "-" + day + "-" + eventSequence,
    gameId: "game",
    sequence: eventSequence++,
    type,
    phase,
    day,
    visibility,
    audienceIds,
    payload,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
function context(
  state: ReturnType<typeof createGameState>,
  playerId = "p1",
  kind: DecisionOpportunityV1["kind"] = "vote",
  journal: PrivateJournalV2 = emptyJournalV2(),
  events: GameEventV1[] = [],
): PlayerContextV2 {
  return buildContextV2(state, events, playerId, journal, "test-" + kind, kind);
}
function opportunity(
  repository: LabRepository,
  state = reduceGame("game", repository.listEvents("game")),
  kind: DecisionOpportunityV1["kind"] = "vote",
): DecisionOpportunityV1 {
  const packet = context(state, "p1", kind);
  return {
    id: "decision-test",
    gameId: state.gameId,
    playerId: "p1",
    kind,
    phase: state.phase,
    day: state.day,
    epoch: state.day + ":" + state.phase,
    viewId: "",
    baseJournalVersion: 0,
    packet,
    status: "open",
    best: null,
    recovery: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
describe("V2 mocked protocol", () => {
  it("runs a complete normal Day 1 vote before Night 1 and batches independent calls", async () => {
    const repository = repo(),
      config = makeConfig();
    config.protocolVersion = "agent_v2_1";
    config.rules.firstCycle = "day_first";
    config.discussion = {
      ...config.discussion,
      speakerSelection: "listener_auction",
      speakerBias: 0.25,
      maxParallelDecisions: 4,
    };
    const record = repository.createGame(config),
      fake = new FakeDecisionProvider();
    let active = 0,
      maxActive = 0;
    const provider: DecisionProvider = {
      decide: async (request) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise((resolve) =>
            setTimeout(resolve, request.playerId?.endsWith("1") ? 4 : 1),
          );
          return await fake.decide(request);
        } finally {
          active -= 1;
        }
      },
    };
    const orchestrator = new V2GameOrchestrator(repository, provider);
    await orchestrator.runGameStep(record.id);
    let state = reduceGame(record.id, repository.listEvents(record.id));
    expect(state).toMatchObject({ phase: "day_discussion", day: 1 });
    expect(repository.listEvents(record.id).some((e) => e.type === "team.point")).toBe(false);

    await orchestrator.runGameStep(record.id);
    state = reduceGame(record.id, repository.listEvents(record.id));
    expect(state).toMatchObject({ phase: "day_vote", day: 1 });
    expect(
      repository
        .listEvents(record.id)
        .filter(
          (e) => e.day === 1 && e.type === "discussion.completed" && e.payload.stage === "opening",
        )
        .map((e) => String(e.payload.playerId))
        .sort(),
    ).toEqual(state.players.map((p) => p.id).sort());
    const expectedBallotOrder = shuffled(
      state.players.filter((player) => player.alive).map((player) => player.id),
      `${config.seed}:discussion:1:ballots`,
    );

    await orchestrator.runGameStep(record.id);
    state = reduceGame(record.id, repository.listEvents(record.id));
    const events = repository.listEvents(record.id);
    expect(state).toMatchObject({ phase: "night_team", day: 1 });
    expect(events.filter((e) => e.day === 1 && e.type === "vote.cast")).toHaveLength(8);
    expect(
      events
        .filter((e) => e.day === 1 && e.type === "vote.cast")
        .map((e) => (e.payload.vote as { voterId: string }).voterId),
    ).toEqual(expectedBallotOrder);
    expect(events.filter((e) => e.day === 1 && e.type === "vote.resolved")).toHaveLength(1);
    expect(events.filter((e) => e.type === "team.point")).toHaveLength(0);
    expect(maxActive).toBe(4);
  }, 30_000);
  it("commits willing-to-listen updates and passes without forcing a speaker", async () => {
    const repository = repo(),
      config = makeConfig();
    config.protocolVersion = "agent_v2_1";
    config.rules.firstCycle = "day_first";
    config.discussion = {
      ...config.discussion,
      speakerSelection: "listener_auction",
      speakerBias: 0.25,
      maxParallelDecisions: 4,
    };
    const fake = new FakeDecisionProvider();
    const provider: DecisionProvider = {
      decide: async (request) => {
        const result = await fake.decide(request);
        if (request.proposalKind !== "discussion") return result;
        const report = result.data as Record<string, unknown>;
        const proposal = report.proposal as Record<string, unknown>;
        return {
          ...result,
          data: {
            ...report,
            proposal: { ...proposal, speech: null, ready: true, interests: [], silenceCase: null },
            speakerIntent: {
              wantsToSpeak: false,
              urge: 0,
              willingnessToListen: (report.speakerIntent as { willingnessToListen: unknown[] })
                .willingnessToListen,
            },
          },
        } as typeof result;
      },
    };
    const record = repository.createGame(config),
      orchestrator = new V2GameOrchestrator(repository, provider);
    await orchestrator.runGameStep(record.id);
    await orchestrator.runGameStep(record.id);
    const state = reduceGame(record.id, repository.listEvents(record.id)),
      events = repository.listEvents(record.id);
    expect(state).toMatchObject({ phase: "day_vote", day: 1 });
    expect(
      events.filter((e) => e.type === "discussion.completed" && e.payload.stage === "opening"),
    ).toHaveLength(8);
    expect(events.filter((e) => e.type === "discussion.speaker_selected")).toHaveLength(0);
    expect(events.filter((e) => e.type === "speech.public")).toHaveLength(0);
  });
  it("keeps distinct custom team channels out of each other's pointing packets", async () => {
    const repository = repo(),
      config = makeConfig();
    for (const [index, channel] of ["red-pack", "blue-pack"].entries())
      config.roleDeck[index] = {
        ...structuredClone(config.roleDeck[index]!),
        id: channel,
        name: channel,
        passives: { ...config.roleDeck[index]!.passives, teamChannel: channel },
      };
    const record = repository.createGame(config),
      orchestrator = new V2GameOrchestrator(repository, new FakeDecisionProvider());
    await orchestrator.runGameStep(record.id);
    await orchestrator.runGameStep(record.id);
    const events = repository.listEvents(record.id),
      state = reduceGame(record.id, events),
      points = events.filter((e) => e.type === "team.point");
    expect(points).toHaveLength(2);
    for (const point of points) {
      const actor = state.players.find((p) => p.id === point.payload.playerId)!;
      expect(point.audienceIds).toEqual([actor.id]);
      const other = state.players.find(
        (p) => p.role.alignment === "werewolf" && p.id !== actor.id,
      )!;
      const packet = buildContextV2(
        state,
        events,
        other.id,
        emptyJournalV2(),
        "channel-test",
        "team_point",
      );
      expect(packet.sources.some((source) => source.id === point.id)).toBe(false);
    }
  });
  it("records optional narration through the same attempt ledger without a player packet", async () => {
    const repository = repo(),
      config = makeConfig();
    config.moderatorNarration = true;
    const record = repository.createGame(config),
      orchestrator = new V2GameOrchestrator(repository, new FakeDecisionProvider());
    for (let step = 0; step < 4; step++) await orchestrator.runGameStep(record.id);
    const attempts = new DecisionStore(repository)
      .attempts(record.id)
      .filter((a) => a.playerId === "moderator");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.request.input).not.toContain("journal");
    expect(
      repository.listEvents(record.id).filter((e) => e.type === "moderator.announcement"),
    ).toHaveLength(1);
    expect(repository.getGame(record.id)!.status).toBe("running");
  });
  it("runs a strict mocked eight-seat game to completion", async () => {
    const repository = repo(),
      config = makeConfig();
    config.protocolVersion = "agent_v2_1";
    config.rules.firstCycle = "day_first";
    config.discussion = {
      ...config.discussion,
      speakerSelection: "listener_auction",
      speakerBias: 0.25,
      maxParallelDecisions: 4,
    };
    const record = repository.createGame(config);
    repository.appendEvent(
      record.id,
      createGameCreatedEvent(createGameState(record.id, record.config)),
    );
    const fake = new FakeDecisionProvider();
    const provider: DecisionProvider = {
      decide: async (request) => {
        const result = await fake.decide(request),
          report = result.data as Record<string, unknown>;
        if (request.proposalKind !== "vote") return result;
        const target = reduceGame(record.id, repository.listEvents(record.id)).players.find(
          (player) =>
            player.alive && player.role.alignment === "werewolf" && player.id !== request.playerId,
        )?.id;
        if (!target)
          return {
            ...result,
            data: { ...report, control: { kind: "commit", question: null, reason: null } },
          } as typeof result;
        return {
          ...result,
          data: {
            ...report,
            selectedAlternativeId: "direct",
            proposal: { kind: "vote", targets: { mode: "direct", playerIds: [target] } },
            control: { kind: "commit", question: null, reason: null },
          },
        } as typeof result;
      },
    };
    const orchestrator = new V2GameOrchestrator(repository, provider);
    for (let step = 0; step < 512; step += 1) {
      await orchestrator.runGameStep(record.id);
      const status = repository.getGame(record.id)!.status;
      if (["completed", "paused", "budget_exhausted"].includes(status)) break;
    }
    expect(repository.getGame(record.id)!.status, repository.getGame(record.id)!.error).toBe(
      "completed",
    );
    for (const point of repository
      .listEvents(record.id)
      .filter((event) => event.type === "team.point")) {
      expect(Object.keys(point.payload).sort()).toEqual(["blind", "playerId", "round", "targetId"]);
      expect(point.payload).toMatchObject({
        blind: expect.any(Boolean),
        round: expect.any(Number),
      });
    }
    expect(auditGameV2(repository, record.id).issues).toEqual([]);
  }, 30_000);
  it("keeps opponent roles and journals out of projections and excludes global metadata", () => {
    const state = createGameState("game", makeConfig());
    state.phase = "day_discussion";
    state.day = 2;
    const journal = { ...emptyJournalV2(), strategy: "private strategy", goals: ["goal"] };
    const speech = event("speech.public", "day_discussion", 2, {
      playerId: "p2",
      playerName: "Player 2",
      text: "hello",
      acts: [],
      respondsTo: [],
      role: "hidden-opponent-role",
      journal: "hidden-opponent-journal",
      globalSeq: 99,
      seed: "secret-seed",
      timestamp: "secret-time",
    });
    const packet = context(state, "p1", "discussion", journal, [speech]);
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain("hidden-opponent-role");
    expect(serialized).not.toContain("hidden-opponent-journal");
    expect(serialized).not.toContain("globalSeq");
    expect(serialized).not.toContain("secret-seed");
    expect(serialized).not.toContain("secret-time");
    expect(packet.journal).toEqual(journal);
    expect(packet.self.role).toEqual(state.players.find((player) => player.id === "p1")!.role);
    const changed = structuredClone(state);
    changed.players[1]!.role.description = "different hidden description";
    expect(JSON.stringify(context(changed, "p1", "discussion", journal, [speech]))).toBe(
      serialized,
    );
  });
  it("accepts citations only for sources actually delivered", async () => {
    const state = createGameState("game", makeConfig());
    state.phase = "day_vote";
    state.day = 1;
    const source = event("speech.public", "day_discussion", 1, {
      playerId: "p2",
      playerName: "Player 2",
      text: "claim",
      acts: [],
      respondsTo: [],
    });
    const packet = context(state, "p1", "vote", emptyJournalV2(), [source]);
    const result = await new FakeDecisionProvider().decide({
      kind: "decision_v2",
      model: "fake",
      schemaName: "vote",
      schema: reportSchema("vote"),
      maxOutputTokens: 600,
      contextV2: packet,
      proposalKind: "vote",
    });
    const report = result.data as Parameters<typeof validateReport>[0];
    expect(validateReport(report, packet, 1200)).toEqual([]);
    expect(validateReport({ ...report, observations: ["not-delivered"] }, packet, 1200)).toContain(
      "citations must reference delivered source IDs",
    );
  });
  it("restricts Doctor consecutive targets and vote targets to legal context choices", () => {
    const state = createGameState("game", makeConfig());
    state.phase = "night_actions";
    state.day = 2;
    const doctor = state.players.find((player) => player.role.id === "doctor")!;
    const opponent = state.players.find((player) => player.id !== doctor.id)!;
    state.protectionHistory[doctor.id + ":protect_player:1"] = [opponent.id];
    const doctorContext = context(state, doctor.id, "night_action");
    expect(doctorContext.legalActions[0]!.targets).not.toContain(opponent.id);
    state.phase = "day_vote";
    opponent.alive = false;
    const voteContext = context(state, doctor.id, "vote");
    expect(voteContext.legalTargets).not.toContain(doctor.id);
    expect(voteContext.legalTargets).not.toContain(opponent.id);
  });
});
describe("V2 decision safety", () => {
  it("compares informative single/gated fixtures and makes the final allowance commit-only", async () => {
    const counts: number[] = [];
    for (const mode of ["single", "gated"] as const) {
      const repository = repo(),
        config = makeConfig();
      config.deliberation.mode = mode;
      config.deliberation.optionalNightCalls = 1;
      const record = repository.createGame(config);
      repository.appendEvent(
        record.id,
        createGameCreatedEvent(createGameState(record.id, record.config)),
      );
      repository.appendEvent(record.id, {
        type: "phase.changed",
        phase: "night_actions",
        day: 1,
        visibility: "public",
        payload: { from: "setup", to: "night_actions" },
      });
      repository.updateGame(record.id, { status: "running" });
      const op = opportunity(repository, reduceGame(record.id, repository.listEvents(record.id)));
      op.packet.sources.push({
        id: "claim",
        type: "speech.public",
        day: 1,
        scope: "public",
        data: { playerId: "p2", text: "An uncertain claim" },
      });
      const fake = new FakeDecisionProvider(),
        flags: boolean[] = [];
      const provider: DecisionProvider = {
        decide: async (request) => {
          flags.push(request.commitOnly!);
          return fake.decide(request);
        },
      };
      const executor = new DecisionExecutorV2(repository, provider);
      await executor.execute({
        opportunity: op,
        mandatoryRemaining: 1,
        eventsForCommit: () => [],
        validateCurrent: () => true,
      });
      counts.push(flags.length);
      expect(flags.at(-1)).toBe(true);
      if (mode === "gated") expect(flags).toEqual([false, true]);
    }
    expect(counts).toEqual([1, 2]);
  });
  it("does not grant another call just to wait for a future public response", async () => {
    const repository = repo(),
      record = runningGame(repository),
      op = opportunity(repository, reduceGame(record.id, repository.listEvents(record.id)));
    op.packet.sources.push({
      id: "claim",
      type: "speech.public",
      day: 1,
      scope: "public",
      data: { text: "A claim" },
    });
    const fake = new FakeDecisionProvider();
    const provider: DecisionProvider = {
      decide: async (request) => {
        const result = await fake.decide(request);
        return {
          ...result,
          data: {
            ...(result.data as object),
            control: {
              kind: "continue",
              question: "Will another player reveal new information?",
              reason: "plan_response",
            },
          },
        } as typeof result;
      },
    };
    const executor = new DecisionExecutorV2(repository, provider);
    await executor.execute({
      opportunity: op,
      mandatoryRemaining: 1,
      eventsForCommit: () => [],
      validateCurrent: () => true,
    });
    expect(executor.store.attempts(record.id)).toHaveLength(1);
    expect(
      repository.listEvents(record.id).find((e) => e.type === "decision.reported")?.payload
        .continuation,
    ).toBe("denied_missing_comparison_ids");
  });
  it("bounds an always-continue provider by the configured episode calls", async () => {
    const repository = repo();
    const record = runningGame(repository);
    const state = reduceGame(record.id, repository.listEvents(record.id));
    const op = opportunity(repository, state);
    const fake = new FakeDecisionProvider();
    const provider: DecisionProvider = {
      decide: async (request) => {
        const result = await fake.decide(request);
        const data = result.data as Record<string, unknown>;
        return {
          ...result,
          data: {
            ...data,
            control: { kind: "continue", question: "compare", reason: "compare_alternative" },
          },
        } as typeof result;
      },
    };
    const executor = new DecisionExecutorV2(repository, provider);
    await executor
      .execute({
        opportunity: op,
        mandatoryRemaining: 1,
        eventsForCommit: () => [],
        validateCurrent: () => true,
      })
      .catch(() => undefined);
    expect(executor.store.attempts(record.id, op.id).length).toBeLessThanOrEqual(
      makeConfig().deliberation.maxCalls,
    );
  });
  it("pauses on malformed output without fabricating an action", async () => {
    const repository = repo();
    const record = runningGame(repository);
    const state = reduceGame(record.id, repository.listEvents(record.id));
    const op = opportunity(repository, state);
    const provider: DecisionProvider = {
      decide: async () =>
        ({
          data: "{malformed",
          provider: "fake",
          model: "fake",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        }) as never,
    };
    const executor = new DecisionExecutorV2(repository, provider);
    await expect(
      executor.execute({
        opportunity: op,
        mandatoryRemaining: 1,
        eventsForCommit: () => [
          {
            type: "night.action_submitted",
            phase: state.phase,
            day: state.day,
            visibility: "player",
            audienceIds: ["p1"],
            payload: { action: { actorId: "p1", actionId: "protect_player", targetIds: ["p1"] } },
          },
        ],
        validateCurrent: () => true,
      }),
    ).rejects.toThrow("no action fabricated");
    expect(executor.store.get<DecisionOpportunityV1>(record.id, "decision:" + op.id)?.status).toBe(
      "paused",
    );
    expect(repository.listEvents(record.id).some((e) => e.type === "night.action_submitted")).toBe(
      false,
    );
  });
  it("keeps a pending pause result and commits once after resume", async () => {
    const repository = repo();
    const record = runningGame(repository);
    const state = reduceGame(record.id, repository.listEvents(record.id));
    const op = opportunity(repository, state);
    let calls = 0;
    const fake = new FakeDecisionProvider();
    const provider: DecisionProvider = {
      decide: async (request) => {
        calls += 1;
        const result = await fake.decide(request);
        repository.updateGame(record.id, { status: "paused" });
        return result;
      },
    };
    const executor = new DecisionExecutorV2(repository, provider);
    const committed = [
      {
        type: "vote.cast",
        phase: state.phase,
        day: state.day,
        visibility: "player" as const,
        audienceIds: ["p1"],
        payload: { vote: { voterId: "p1", targetId: null } },
      },
    ];
    expect(
      await executor.execute({
        opportunity: op,
        mandatoryRemaining: 1,
        eventsForCommit: () => committed,
        validateCurrent: () => true,
      }),
    ).toBe(false);
    expect(executor.store.get<DecisionOpportunityV1>(record.id, "decision:" + op.id)?.status).toBe(
      "pending",
    );
    repository.updateGame(record.id, { status: "running" });
    expect(
      await executor.execute({
        opportunity: op,
        mandatoryRemaining: 1,
        eventsForCommit: () => committed,
        validateCurrent: () => true,
      }),
    ).toBe(true);
    expect(calls).toBe(1);
    expect(repository.listEvents(record.id).filter((e) => e.type === "vote.cast")).toHaveLength(1);
  });
  it("releases the provider's isolated decision session after an episode", async () => {
    const repository = repo(),
      record = runningGame(repository),
      op = opportunity(repository, reduceGame(record.id, repository.listEvents(record.id)));
    const fake = new FakeDecisionProvider(),
      released: string[] = [];
    const provider: DecisionProvider = {
      decide: (request) => fake.decide(request),
      releaseSession: (key) => {
        released.push(key);
      },
    };
    await new DecisionExecutorV2(repository, provider).execute({
      opportunity: op,
      mandatoryRemaining: 1,
      eventsForCommit: () => [],
      validateCurrent: () => true,
    });
    expect(released).toEqual([`${record.id}:${op.id}:0`]);
  });
});
describe("V2 context and scheduler authorization", () => {
  it("ranks a frozen listener auction by biased urge times normalized listening", () => {
    const scores = rankSpeakerAuction(
      ["p1", "p2", "p3"],
      [
        {
          playerId: "p1",
          intent: {
            wantsToSpeak: true,
            urge: 0.1,
            willingnessToListen: [
              { playerId: "p2", willingness: 1 },
              { playerId: "p3", willingness: 0 },
            ],
          },
        },
        {
          playerId: "p2",
          intent: {
            wantsToSpeak: true,
            urge: 0.4,
            willingnessToListen: [
              { playerId: "p1", willingness: 0.2 },
              { playerId: "p3", willingness: 0.8 },
            ],
          },
        },
        {
          playerId: "p3",
          intent: {
            wantsToSpeak: true,
            urge: 0.8,
            willingnessToListen: [
              { playerId: "p1", willingness: 0.4 },
              { playerId: "p2", willingness: 0.2 },
            ],
          },
        },
      ],
      0.25,
      ["p1", "p2", "p3"],
    );
    expect(scores.map((score) => score.playerId)).toEqual(["p3", "p2", "p1"]);
    expect(scores[0]!.priority).toBeCloseTo((0.25 + 0.8) * (0.4 / 1.3));
    expect(scores.reduce((sum, score) => sum + score.normalizedListenerInterest, 0)).toBeCloseTo(1);
  });
  it("does not force a player who declined to speak into the auction", () => {
    const scores = rankSpeakerAuction(
      ["p1", "p2"],
      [
        {
          playerId: "p1",
          intent: {
            wantsToSpeak: false,
            urge: 0,
            willingnessToListen: [{ playerId: "p2", willingness: 1 }],
          },
        },
        {
          playerId: "p2",
          intent: {
            wantsToSpeak: true,
            urge: 0.1,
            willingnessToListen: [{ playerId: "p1", willingness: 1 }],
          },
        },
      ],
      0.25,
      ["p1", "p2"],
    );
    expect(scores.map((score) => score.playerId)).toEqual(["p2"]);
  });
  it("restricts auction candidates to an owed responder before applying scores", () => {
    const config = makeConfig();
    config.discussion = {
      ...config.discussion,
      speakerSelection: "listener_auction",
      speakerBias: 0.25,
      maxParallelDecisions: 4,
    };
    const state = createGameState("game", config);
    state.phase = "day_discussion";
    state.day = 1;
    const opening = state.players.map((player) =>
      event("discussion.completed", "day_discussion", 1, {
        playerId: player.id,
        stage: "opening",
        ready: false,
        interests: [],
        docket: [],
        publicRevision: "initial",
      }),
    );
    const accusation = event("speech.public", "day_discussion", 1, {
      playerId: "p1",
      playerName: "Player 1",
      text: "Player 2 is suspicious",
      acts: [{ kind: "accusation", targetId: "p2", claim: "suspicious", sourceId: null }],
      respondsTo: [],
      closing: false,
    });
    expect(discussionAuctionPlan(state, [...opening, accusation])?.candidates).toEqual(["p2"]);
  });
  it("requires a complete private listener ballot on every auction report", async () => {
    const config = makeConfig();
    config.discussion = {
      ...config.discussion,
      speakerSelection: "listener_auction",
      speakerBias: 0.25,
      maxParallelDecisions: 4,
    };
    const state = createGameState("game", config);
    state.phase = "day_discussion";
    state.day = 1;
    const packet = context(state, "p1", "discussion");
    const result = await new FakeDecisionProvider().decide({
      kind: "decision_v2",
      model: "fake",
      schemaName: "discussion",
      schema: reportSchema("discussion", true, packet),
      maxOutputTokens: 600,
      contextV2: packet,
      proposalKind: "discussion",
      commitOnly: true,
    });
    const report = result.data as Parameters<typeof validateReport>[0] & {
      speakerIntent: { willingnessToListen: { playerId: string; willingness: number }[] };
    };
    expect(validateReport(report, packet, 1200)).toEqual([]);
    const incomplete = {
      ...report,
      speakerIntent: {
        ...report.speakerIntent,
        willingnessToListen: report.speakerIntent.willingnessToListen.slice(1),
      },
    } as typeof report;
    expect(validateReport(incomplete, packet, 1200)).toContain(
      "willingnessToListen must rate every other living player exactly once",
    );
  });
  it("keeps the shared player prefix above the explicit cache threshold", () => {
    expect(estimatedTokens(CACHEABLE_PLAYER_INSTRUCTIONS)).toBeGreaterThanOrEqual(1_024);
  });
  it("puts frozen game data and stable episode context before the changing suffix", () => {
    const config = makeConfig();
    config.protocolVersion = "agent_v2_1";
    config.discussion = {
      ...config.discussion,
      speakerSelection: "listener_auction",
      speakerBias: 0.25,
      maxParallelDecisions: 4,
    };
    const state = createGameState("game", config);
    state.phase = "day_discussion";
    state.day = 2;
    const first = context(state, "p1", "discussion"),
      second = context(state, "p2", "discussion");
    const firstRequest = decisionRequestV2(first, "discussion", "gated", false);
    const secondRequest = decisionRequestV2(second, "discussion", "gated", false);
    expect(stableGameReference(first)).toEqual(stableGameReference(second));
    expect(firstRequest.prompt.instructions).toBe(secondRequest.prompt.instructions);
    expect(firstRequest.prompt.sharedInput).not.toBe(secondRequest.prompt.sharedInput);
    expect(firstRequest.prompt.input).toBe(secondRequest.prompt.input);
    const repair = decisionRequestV2(
      first,
      "discussion",
      "gated",
      true,
      null,
      "Citations must be delivered.",
    );
    expect(repair.prompt.instructions).toBe(firstRequest.prompt.instructions);
    expect(repair.prompt.sharedInput).toBe(firstRequest.prompt.sharedInput);
    expect(repair.prompt.input).not.toBe(firstRequest.prompt.input);
    expect(repair.jsonSchema).toEqual(firstRequest.jsonSchema);
  });
  it("fits a speech-heavy, journal-rich decision below the configured request limit", () => {
    const config = makeConfig();
    config.protocolVersion = "agent_v2_1";
    config.discussion = {
      ...config.discussion,
      speakerSelection: "listener_auction",
      speakerBias: 0.25,
      maxParallelDecisions: 4,
    };
    const state = createGameState("game", config);
    state.phase = "day_discussion";
    state.day = 2;
    const speeches = Array.from({ length: 7 }, (_, index) =>
      event("speech.public", "day_discussion", 2, {
        playerId: "p1",
        playerName: "Player 1",
        text: `commit-${index} ${"x".repeat(600)}`,
        acts: [],
        respondsTo: [],
        closing: false,
      }),
    );
    const journal = {
      ...emptyJournalV2(),
      strategy: "s".repeat(600),
      goals: ["g".repeat(120)],
      beliefs: state.players.slice(1, 7).map((player) => ({
        playerId: player.id,
        probability: 0.5,
        basis: "inference" as const,
        note: "n".repeat(120),
        sources: [],
      })),
    };
    const packet = context(state, "p1", "discussion", journal, speeches);
    expect(decisionRequestV2(packet, "discussion", "gated").tokens).toBeLessThanOrEqual(
      config.deliberation.maxContextTokens,
    );
  });
  it("presents short citation aliases and restores canonical IDs before persistence", async () => {
    const state = createGameState("game", makeConfig());
    state.phase = "day_vote";
    state.day = 1;
    const source = event("speech.public", "day_discussion", 1, {
      playerId: "p2",
      playerName: "Player 2",
      text: "A concrete claim.",
      acts: [],
      respondsTo: [],
      closing: false,
    });
    const packet = context(state, "p1", "vote", emptyJournalV2(), [source]);
    const presented = stableDecisionContext(packet, "vote");
    expect(presented.allowedCitationIds).toEqual(["s1", "s2", "s3", "s4"]);
    expect(JSON.stringify(presented)).not.toContain(source.id);
    const result = await new FakeDecisionProvider().decide({
      kind: "decision_v2",
      model: "fake",
      schemaName: "vote",
      schema: reportSchema("vote"),
      maxOutputTokens: 600,
      contextV2: packet,
      proposalKind: "vote",
    });
    const aliased = {
      ...(result.data as Parameters<typeof canonicalizeReportReferences>[0]),
      observations: ["s4"],
    };
    expect(canonicalizeReportReferences(aliased, packet).observations).toEqual([source.id]);
    const request = decisionRequestV2(
      packet,
      "vote",
      "gated",
      false,
      canonicalizeReportReferences(aliased, packet),
    );
    expect(request.prompt.input).toContain('"observations":["s4"]');
    expect(request.prompt.input).not.toContain(source.id);
  });
  it("keeps the complete recent-day self commitment window essential without making old speech unbounded", () => {
    const config = makeConfig();
    config.protocolVersion = "agent_v2_1";
    config.discussion = {
      ...config.discussion,
      speakerSelection: "listener_auction",
      speakerBias: 0.25,
      maxParallelDecisions: 4,
    };
    const state = createGameState("game", config);
    state.phase = "day_discussion";
    state.day = 5;
    const speeches = Array.from({ length: 30 }, (_, index) =>
      event("speech.public", "day_discussion", Math.floor(index / 6) + 1, {
        playerId: "p1",
        playerName: "Player 1",
        text: `commit-${index} ${"x".repeat(300)}`,
        acts: [],
        respondsTo: [],
        closing: false,
      }),
    );
    const packet = context(state, "p1", "discussion", emptyJournalV2(), speeches),
      included = new Set(packet.sources.map((source) => source.id));
    for (const speech of speeches.slice(-4)) expect(included.has(speech.id)).toBe(true);
    expect(included.has(speeches[0]!.id)).toBe(false);
  });
  it("delivers historical journals only at or before their requested event boundary", () => {
    const repository = repo();
    const record = game(repository);
    const store = new DecisionStore(repository);
    repository.appendEvent(record.id, {
      type: "journal.v2_updated",
      phase: "setup",
      day: 0,
      visibility: "player",
      audienceIds: ["p1"],
      payload: { playerId: "p1", journal: { ...emptyJournalV2(), version: 1, strategy: "old" } },
    });
    const oldSequence = repository.listEvents(record.id).at(-1)!.sequence;
    repository.appendEvent(record.id, {
      type: "journal.v2_updated",
      phase: "setup",
      day: 0,
      visibility: "player",
      audienceIds: ["p1"],
      payload: { playerId: "p1", journal: { ...emptyJournalV2(), version: 2, strategy: "new" } },
    });
    expect(store.journal(record.id, "p1", oldSequence).strategy).toBe("old");
    expect(store.journal(record.id, "p1").strategy).toBe("new");
  });
  it("honors response rights, readiness quorum, and finite follow-up work", () => {
    const state = createGameState("game", makeConfig());
    state.phase = "day_discussion";
    state.day = 1;
    const opening = state.players.map((player) =>
      event("discussion.completed", "day_discussion", 1, {
        playerId: player.id,
        stage: "opening",
        ready: true,
        interests: [],
        docket: [],
        publicRevision: "initial",
      }),
    );
    const accusation = event("speech.public", "day_discussion", 1, {
      playerId: "p1",
      playerName: "Player 1",
      text: "Player 2",
      acts: [{ kind: "accusation", targetId: "p2" }],
      respondsTo: [],
      closing: false,
    });
    const rights = responseDockets(state, [accusation]);
    expect(rights.p2).toContain(accusation.id);
    expect(rights.p1).toEqual([]);
    expect(
      responseDockets(state, [
        accusation,
        event("discussion.completed", "day_discussion", 1, {
          playerId: "p2",
          docket: [accusation.id],
        }),
      ]).p2,
    ).toEqual([]);
    expect(nextDiscussionWork(state, opening)).toBeNull();
    const owed = nextDiscussionWork(state, [...opening, accusation]);
    expect(owed?.stage).toBe("followup");
    expect(owed?.playerId).toBe("p2");
    const capped = makeConfig();
    capped.discussion.maxFollowUpsPerPlayer = 0;
    const cappedState = createGameState("game", capped);
    cappedState.phase = "day_discussion";
    cappedState.day = 1;
    expect(nextDiscussionWork(cappedState, opening)).toBeNull();
  });
  it("keeps closing work finite when the docket is empty", () => {
    const state = createGameState("game", makeConfig());
    state.phase = "day_discussion";
    state.day = 1;
    const opening = state.players.map((player) =>
      event("discussion.completed", "day_discussion", 1, {
        playerId: player.id,
        stage: "opening",
        ready: true,
        interests: [],
        docket: [],
        publicRevision: "initial",
      }),
    );
    for (let index = 0; index < 16; index += 1)
      expect(nextDiscussionWork(state, opening)).toBeNull();
  });
});
