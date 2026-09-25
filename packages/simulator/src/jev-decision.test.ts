import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import {
  providerJsonSchema,
  GameConfigV2Schema,
  emptyJournalV2,
  type DecisionOpportunityV1,
  type GameConfigV2,
  type GameEventV1,
} from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { DOCTOR_V2, STARTER_ROLES, createGameState, reduceGame } from "@werewolf/engine";
import {
  openAIRequest,
  AskJevProvider,
  FakeDecisionProvider,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  type JevRequest,
} from "@werewolf/llm";
import { applyJournalV2, buildContextV2 } from "./context-v2";
import { DecisionExecutorV2, usageTotals, type ExecuteDecisionOptions } from "./decisions-v2";
import { prepareJevStage } from "./jev-decision";
import { journalTokens } from "./freeform-journal";
import { journalCompactionRequest, materializeCompactedJournal } from "./journal-compaction";
import { jevBriefing } from "./jev-briefing";
import { usesJournalWorkflow } from "./jev-actions";
import { V2GameOrchestrator } from "./orchestrator-v2";
import {
  decisionRequestV31,
  normalizeV31Submission,
  validateV31Submission,
  v31SubmissionSchema,
} from "./request-v3-1";
import type { V3TaskSpec } from "./request-v3";
import { decisionDetail, decisionRecords, observerPayload } from "../../../apps/api/src/observer";

interface TestJevState {
  task: { type?: string; REQUEST?: { task: { type: string } } };
  journal?: string;
  public?: unknown;
  facts?: string;
  verifiedFacts?: string;
  legalChoices?: Record<string, unknown>;
  private?: {
    AUTHORIZED_PRIVATE_STATE: {
      self: { id: string };
      knownAllies: { id: string }[];
      evidence: { type: string }[];
      journal: { attentionNotes: unknown[] };
    };
  };
}
const testState = (request: JevRequest) => request.state as TestJevState;
const taskType = (request: JevRequest) => {
  const { task } = testState(request);
  return task.type ?? task.REQUEST!.task.type;
};
const speechActs = (event: GameEventV1) =>
  z
    .array(
      z.object({
        kind: z.string(),
        targetId: z.string().nullable(),
      }),
    )
    .parse(event.payload.acts);

const connections: DatabaseConnection[] = [];
afterEach(() => {
  while (connections.length) connections.pop()!.close();
});
function config(overrides: Record<string, unknown> = {}) {
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
  const seats = ids.map((_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}` }));
  return GameConfigV2Schema.parse({
    schemaVersion: "game_config_v2",
    protocolVersion: "agent_v3_1",
    preset: "standard-8-v2",
    name: "Hybrid",
    seed: "jev-test",
    seats,
    roleDeck: ids.map((id) =>
      id === "doctor" ? DOCTOR_V2 : STARTER_ROLES.find((r) => r.id === id),
    ),
    rules: { firstCycle: "day_first" },
    discussion: { speakerSelection: "listener_auction", maxParallelDecisions: 1 },
    decisionEngine: { mode: "jev" },
    deliberation: { maxContextTokens: 16_000 },
    safety: { maxCycles: 4, maxModelCalls: 500, maxWallClockMs: 60_000 },
    modelSettings: Object.fromEntries(
      seats.map((s) => [s.id, { provider: "fake", model: "fake", reasoningEffort: "high" }]),
    ),
    ...overrides,
  });
}
function answer(request: JevRequest, reason = false, target?: string) {
  return {
    model: "jev-test",
    usage: { input_tokens: 100, output_tokens: 20 },
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([key, q]) => {
        if (q.type === "noul")
          return [key, { type: "noul", noul: key === "needs_reasoning" ? Number(reason) : 0.8 }];
        if (q.type === "score")
          return [
            key,
            {
              type: "score",
              score: 3,
              confidence: 1,
              probabilities: Object.fromEntries(
                q.criteria.map((_, i) => [String(i), Number(i === 3)]),
              ),
            },
          ];
        const options = Object.keys(q.criteria),
          choice =
            target && options.includes(target)
              ? target
              : key === "plan"
                ? options.find((o) => o.startsWith("challenge_"))!
                : options[0]!;
        return [
          key,
          {
            type: "choice",
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(options.map((o) => [o, Number(o === choice)])),
          },
        ];
      }),
    ),
  };
}
class RecordingJev extends AskJevProvider {
  requests: JevRequest[] = [];
  constructor(reason = false, hook?: (request: JevRequest, index: number) => void) {
    const requests: JevRequest[] = [];
    super(async (input) => {
      const request = JSON.parse(input) as JevRequest;
      requests.push(request);
      hook?.(request, requests.length);
      return JSON.stringify(answer(request, reason));
    });
    this.requests = requests;
  }
}
class RecordingLlm extends FakeDecisionProvider {
  requests: DecisionRequest<unknown>[] = [];
  override async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    this.requests.push(request);
    return super.decide(request);
  }
}
function setup(cfg: GameConfigV2 = config()) {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  const repository = new LabRepository(connection);
  repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
  const game = repository.createGame(cfg);
  new V2GameOrchestrator(repository, new FakeDecisionProvider()).initialize(game.id);
  repository.updateGame(game.id, { status: "running" });
  const state = reduceGame(game.id, repository.listEvents(game.id));
  const packet = buildContextV2(
    state,
    repository.listEvents(game.id),
    "p1",
    emptyJournalV2(),
    "jev",
    "vote",
  );
  const op: DecisionOpportunityV1 = {
    id: "hybrid-vote",
    gameId: game.id,
    playerId: "p1",
    kind: "vote",
    phase: state.phase,
    day: state.day,
    epoch: `${state.day}:${state.phase}`,
    viewId: "test-view",
    baseJournalVersion: 0,
    packet,
    status: "open",
    best: null,
    recovery: 0,
    createdAt: new Date().toISOString(),
    taskType: "vote_choice",
  };
  const store = new DecisionStore(repository);
  store.save(op);
  const task: V3TaskSpec = { type: "vote_choice", proposalKind: "vote" };
  const options: ExecuteDecisionOptions = {
    opportunity: op,
    mandatoryRemaining: 1,
    validateCurrent: () => true,
    eventsForCommit: () => [],
    requestForAttempt: (commitOnly, previous, repair) => ({
      ...decisionRequestV31(packet, task, commitOnly, previous, repair),
      schemaName: task.type,
      providerKind: "decision_v3_1",
      normalize: (value) => normalizeV31Submission(packet, task, value as never, op.id, commitOnly),
      validateSubmission: (value) => validateV31Submission(packet, task, value as never),
    }),
  };
  return { repository, game, op, options, store, task };
}

describe("Jev hybrid decisions", () => {
  it("passes the full API output budget, persists exact transport evidence, and isolates it from other seats", async () => {
    const cfg = config({
      decisionEngine: { mode: "llm" },
      safety: { maxOutputTokens: 8192, maxModelCalls: 500, maxWallClockMs: 60000 },
    });
    for (const settings of Object.values(cfg.modelSettings)) {
      settings.provider = "openai";
      settings.model = "gpt-6-luna";
    }
    const { repository, game, options, store } = setup(cfg);
    const fake = new FakeDecisionProvider();
    const provider: DecisionProvider = {
      decide: async (request) => {
        expect(request.maxOutputTokens).toBe(8192);
        expect(request.gameId).toBe(game.id);
        request.onProviderRequest?.(openAIRequest(request) as unknown as Record<string, unknown>);
        request.onProviderMetadata?.({
          responseId: "test-response",
          cacheDiagnostics: { type: "cache_hit" },
        });
        const result = await fake.decide({ ...request, onUsage: undefined });
        request.onUsage?.(
          {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            cachedInputTokens: 80,
            cacheWriteInputTokens: 10,
            reasoningTokens: 30,
          },
          { provider: "openai", model: request.model, outputLimitEnforced: true },
        );
        return { ...result, provider: "openai" };
      },
    };
    await new DecisionExecutorV2(repository, provider).execute(options);
    const attempt = store.attempts(game.id)[0]!;
    expect(attempt).toMatchObject({
      maxOutputTokens: 8192,
      wireRequest: { model: "gpt-6-luna", max_output_tokens: 8192, store: false },
      providerMetadata: { responseId: "test-response" },
    });
    expect(
      JSON.stringify(
        observerPayload(repository, repository.getGame(game.id)!, { kind: "public" }, undefined, {
          includeAttempts: true,
        }),
      ),
    ).not.toContain("test-response");
    expect(
      decisionDetail(repository, game.id, options.opportunity.id, {
        kind: "player",
        playerId: "p2",
      }),
    ).toBeUndefined();
    const start = repository.listEvents(game.id).find((e) => e.type === "model.attempt_started")!;
    expect(
      decisionDetail(
        repository,
        game.id,
        options.opportunity.id,
        { kind: "moderator" },
        start.sequence,
      )?.attempts[0]?.providerMetadata,
    ).toBeUndefined();
    attempt.usage.totalTokens = null;
    store.updateAttempt(attempt);
    expect(usageTotals(store, game.id).admissionTokens).toBeGreaterThan(8192);
  });
  it("commits a fast vote without calling the LLM and retains the full distribution", async () => {
    const { repository, game, options, store } = setup();
    const llm = new RecordingLlm(),
      jev = new RecordingJev();
    await new DecisionExecutorV2(repository, llm, jev).execute(options);
    expect(llm.requests).toHaveLength(0);
    expect(store.attempts(game.id)).toHaveLength(1);
    expect(store.attempts(game.id)[0]).toMatchObject({
      provider: "jev",
      status: "valid",
      usage: { totalTokens: 120 },
      outputLimitEnforced: false,
    });
    expect(
      JSON.parse(store.attempts(game.id)[0]!.response!).answers.target.probabilities,
    ).toBeDefined();
    expect(store.opportunities(game.id)[0]?.best?.proposal).toMatchObject({
      kind: "vote",
      targets: { mode: "direct" },
    });
  });
  it("asks the configured LLM once then gives its explicit response to Jev before committing", async () => {
    const { repository, game, options, store } = setup();
    const llm = new RecordingLlm(),
      jev = new RecordingJev(true);
    await new DecisionExecutorV2(repository, llm, jev).execute(options);
    expect(store.attempts(game.id).map((a) => a.provider)).toEqual(["jev", "fake", "jev"]);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]).toMatchObject({ model: "fake", reasoningEffort: "high" });
    expect(
      (jev.requests[1]!.state as { explicitReasoning: unknown }).explicitReasoning,
    ).toMatchObject({ rationale: expect.any(String) });
    expect(jev.requests[1]!.questions.needs_reasoning).toBeUndefined();
    expect(
      repository.listEvents(game.id).filter((e) => e.type === "decision.committed"),
    ).toHaveLength(1);
    expect(store.attempts(game.id).every((a) => a.status === "valid")).toBe(true);
  });
  it("does not expose future analysis in historical replay or another player's view", async () => {
    const { repository, game, options, store } = setup();
    await new DecisionExecutorV2(repository, new RecordingLlm(), new RecordingJev(true)).execute(
      options,
    );
    const events = repository.listEvents(game.id);
    const firstGate = events.findIndex((e) => e.type === "decision.jev_stage");
    const before = decisionRecords(repository, game.id, { kind: "moderator" }, firstGate - 1)[0];
    expect(before?.jevState).toBeUndefined();
    const gate = decisionDetail(
      repository,
      game.id,
      options.opportunity.id,
      { kind: "moderator" },
      firstGate,
    )!;
    expect(gate.opportunity.jevState).toMatchObject({ stage: "reason" });
    expect(gate.opportunity.jevState?.reasoning).toBeUndefined();
    expect(gate.attempts[0]?.status).toBe("valid");
    expect(decisionRecords(repository, game.id, { kind: "player", playerId: "p2" })).toEqual([]);
    expect(
      JSON.stringify(observerPayload(repository, repository.getGame(game.id)!, { kind: "public" })),
    ).not.toContain("explicitReasoning");
    expect(store.attempts(game.id)).toHaveLength(3);
  });
  it("resumes an intermediate checkpoint without treating analysis as a fallback vote", async () => {
    const { repository, game, options, store } = setup();
    const jev = new RecordingJev(true, (_request, index) => {
      if (index === 1) repository.updateGame(game.id, { status: "paused" });
    });
    const llm = new RecordingLlm();
    expect(await new DecisionExecutorV2(repository, llm, jev).execute(options)).toBe(false);
    expect(store.opportunities(game.id)[0]).toMatchObject({
      best: null,
      jevState: { stage: "reason" },
    });
    repository.updateGame(game.id, { status: "running" });
    await new DecisionExecutorV2(repository, llm, jev).execute(options);
    expect(jev.requests).toHaveLength(2);
    expect(llm.requests).toHaveLength(1);
    expect(
      repository.listEvents(game.id).filter((e) => e.type === "decision.committed"),
    ).toHaveLength(1);
  });
  it("pauses on Jev failure without inventing a pass or falling back to the LLM", async () => {
    const { repository, game, options, store } = setup();
    const llm = new RecordingLlm();
    await expect(
      new DecisionExecutorV2(
        repository,
        llm,
        new AskJevProvider(async () => {
          throw new Error("offline");
        }),
      ).execute(options),
    ).rejects.toThrow("no action fabricated");
    expect(store.opportunities(game.id)[0]).toMatchObject({ best: null, status: "paused" });
    expect(llm.requests).toHaveLength(0);
    expect(store.attempts(game.id)).toHaveLength(2);
  });
  it.each([{ mode: "single" }, { maxCalls: 2 }, { optionalDayCalls: 0 }])(
    "disables the reasoning gate when policy cannot fund it: %j",
    async (deliberation) => {
      const { repository, game, options, store } = setup(
        config({ deliberation: { maxContextTokens: 16_000, ...deliberation } }),
      );
      const jev = new RecordingJev(true),
        llm = new RecordingLlm();
      await new DecisionExecutorV2(repository, llm, jev).execute(options);
      expect(jev.requests[0]?.questions.needs_reasoning).toBeUndefined();
      expect(llm.requests).toHaveLength(0);
      expect(store.attempts(game.id)).toHaveLength(1);
    },
  );
  it("aborts in-flight Jev work without committing an action", async () => {
    const { repository, game, options, store } = setup();
    const jev = new AskJevProvider(async (_input, { signal }) => {
      setTimeout(() => repository.updateGame(game.id, { status: "aborted" }), 1);
      return new Promise((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    });
    expect(await new DecisionExecutorV2(repository, new RecordingLlm(), jev).execute(options)).toBe(
      false,
    );
    expect(store.opportunities(game.id)[0]?.best).toBeNull();
    expect(
      repository.listEvents(game.id).some((event) => event.type === "decision.committed"),
    ).toBe(false);
    expect(store.attempts(game.id)[0]?.status).toBe("unknown");
  });
  it("keeps omitted engine settings on the original LLM path and rejects older Jev protocols", () => {
    expect(config({ decisionEngine: undefined }).decisionEngine.mode).toBe("llm");
    expect(() => config({ protocolVersion: "agent_v2" })).toThrow("Jev decisions require");
  });
  it("converts bid scores, null listener slots, and silence without generating prose", () => {
    const { op, options } = setup();
    op.taskType = "discussion_bid";
    op.kind = "discussion";
    op.packet.players.find((player) => player.id === "p8")!.alive = false;
    const task: V3TaskSpec = {
      type: "discussion_bid",
      eligible: true,
      candidateIds: ["p1", "p2"],
      revision: "one",
    };
    const base = {
      ...options.requestForAttempt!(true, null, null),
      ...decisionRequestV31(op.packet, task, true, null, null),
    };
    const stage = prepareJevStage(op, config(), base, true);
    const request = JSON.parse(stage.prepared.prompt.input) as JevRequest;
    const speaking = stage.toSubmission(answer(request)) as {
      urge: number;
      listen: Record<string, number | null>;
    };
    expect(speaking.urge).toBe(0.75);
    expect(speaking.listen.p1).toBeNull();
    expect(speaking.listen.p8).toBeNull();
    expect(speaking.listen.p2).toBe(0.75);
    const silent = stage.toSubmission(answer(request, false, "silence"));
    expect(silent).toMatchObject({ plan: null, urge: 0 });
    expect(validateV31Submission(op.packet, task, silent as never)).toEqual([]);
  });
  it("keeps another player's secret out of Jev's rendered state", () => {
    const cfg = config(),
      state = createGameState("privacy", cfg);
    state.phase = "day_discussion";
    const events: GameEventV1[] = [
      {
        schemaVersion: "game_event_v1",
        id: "other-secret",
        gameId: "privacy",
        sequence: 1,
        type: "inspection.delivered",
        phase: "night_actions",
        day: 1,
        visibility: "player",
        audienceIds: ["p2"],
        payload: { actorId: "p2", targetId: "p3", result: "OTHER_PRIVATE_SECRET" },
        createdAt: new Date().toISOString(),
      },
    ];
    const { op, options } = setup();
    op.packet = buildContextV2(state, events, "p1", emptyJournalV2(), "privacy", "vote");
    const base = {
      ...options.requestForAttempt!(true, null, null),
      ...decisionRequestV31(
        op.packet,
        { type: "vote_choice", proposalKind: "vote" },
        true,
        null,
        null,
      ),
    };
    expect(prepareJevStage(op, cfg, base, true).prepared.prompt.input).not.toContain(
      "OTHER_PRIVATE_SECRET",
    );
  });
  it("runs a complete hybrid fake game with legal decisions and separate speech calls", async () => {
    const connection = openDatabase(":memory:");
    connections.push(connection);
    const repository = new LabRepository(connection);
    repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
    const game = repository.createGame(config({ deliberation: { maxContextTokens: 8_000 } })),
      llm = new RecordingLlm(),
      jev = new RecordingJev();
    const orchestrator = new V2GameOrchestrator(repository, llm, jev);
    for (let i = 0; i < 80; i++) {
      await orchestrator.runGameStep(game.id);
      if (["completed", "paused", "budget_exhausted"].includes(repository.getGame(game.id)!.status))
        break;
    }
    expect(repository.getGame(game.id)?.status, repository.getGame(game.id)?.error).toBe(
      "completed",
    );
    expect(jev.requests.length).toBeGreaterThan(0);
    expect(llm.requests.length).toBeGreaterThan(0);
    expect(
      llm.requests.every((r) => ["discussion_speech", "closing_response"].includes(r.schemaName)),
    ).toBe(true);
  }, 60_000);
});

function journalConfig(overrides: Record<string, unknown> = {}) {
  const seats = ["p1", "p2", "p3", "p4", "p5"].map((id, i) => ({ id, name: `Player ${i + 1}` }));
  return config({
    preset: "custom-v2",
    seats,
    roleDeck: [
      STARTER_ROLES.find((r) => r.id === "werewolf")!,
      STARTER_ROLES.find((r) => r.id === "werewolf")!,
      STARTER_ROLES.find((r) => r.id === "seer")!,
      DOCTOR_V2,
      STARTER_ROLES.find((r) => r.id === "villager")!,
    ],
    modelSettings: Object.fromEntries(
      seats.map((s) => [s.id, { provider: "fake", model: "fake", reasoningEffort: "high" }]),
    ),
    ...overrides,
  });
}

describe("Jev with mandatory LLM journals and free speech", () => {
  it("preserves positive speaking urgency without a topic choice or a reasoning gate", () => {
    const cfg = config({ decisionEngine: { mode: "jev", workflow: "journal_v2" } }),
      state = createGameState("score", cfg);
    state.phase = "day_discussion";
    const packet = buildContextV2(state, [], "p1", emptyJournalV2(), "score", "discussion");
    const task: V3TaskSpec = {
      type: "discussion_score",
      eligible: true,
      candidateIds: packet.players.map((p) => p.id),
      revision: "initial",
    };
    const base = {
      ...decisionRequestV31(packet, task, true, null, null),
      schemaName: task.type,
      normalize: (value: unknown) =>
        normalizeV31Submission(packet, task, value as never, "score", true),
    };
    const stage = prepareJevStage({ packet, playerId: "p1", taskType: task.type }, cfg, base, true);
    const request = JSON.parse(stage.prepared.prompt.input) as JevRequest;
    expect(request.questions.plan).toBeUndefined();
    expect(request.questions.needs_reasoning).toBeUndefined();
    const submission = v31SubmissionSchema(packet, task).parse(stage.toSubmission(answer(request)));
    expect(submission).not.toHaveProperty("plan");
    expect(submission).toMatchObject({ urge: 0.75 });
    expect(validateV31Submission(packet, task, submission)).toEqual([]);
    expect(base.normalize(submission)).toMatchObject({
      speakerIntent: { wantsToSpeak: true, urge: 0.75 },
    });
  });

  it("delivers newly reviewed speech in full even when the shared ledger has compacted it", () => {
    const cfg = config({
        protocolVersion: "agent_v3_2",
        decisionEngine: { mode: "jev", workflow: "journal_v2" },
      }),
      state = createGameState("reflection", cfg);
    const packet = buildContextV2(state, [], "p1", emptyJournalV2(), "reflection", "pass");
    packet.sources.push({
      id: "new-speech",
      type: "speech.public",
      day: 1,
      scope: "public",
      publicIndex: 1,
      cacheLayer: "public",
      detail: "stub",
      data: {
        playerId: "p2",
        playerName: "Player 2",
        text: "I accused Player 3 because their vote contradicted their claim.",
        acts: [],
        respondsTo: [],
      },
    });
    const task: V3TaskSpec = {
      type: "journal_update",
      revision: "speech-1",
      sourceIds: ["new-speech"],
    };
    const request = decisionRequestV31(packet, task, true, null, null);
    const privateState = JSON.parse(request.prompt.privateInput!).AUTHORIZED_PRIVATE_STATE;
    expect(privateState.reflectionEvidence[0].data.text).toContain("vote contradicted their claim");
    expect(
      JSON.parse(request.prompt.publicInput!).PUBLIC_GAME_STATE.evidence[0].data.text,
    ).toBeUndefined();
    expect(() =>
      decisionRequestV31(packet, { ...task, sourceIds: ["missing"] }, true, null, null),
    ).toThrow("missing newly delivered evidence");
  });

  it("does not acknowledge a reflection whose journal is invalid", async () => {
    const { repository, game, op, store } = setup(
      config({
        decisionEngine: { mode: "jev", workflow: "journal_v2" },
        deliberation: { maxJournalTokens: 200, maxContextTokens: 8_000 },
      }),
    );
    op.taskType = "journal_update";
    op.kind = "pass";
    store.save(op);
    const task: V3TaskSpec = { type: "journal_update", revision: "initial", sourceIds: [] };
    const provider: DecisionProvider = {
      decide: async (request) => ({
        data: request.schema.parse({
          memory: {
            beliefs: [],
            hypotheses: [],
            strategyUpdate: { strategy: "s".repeat(600), goals: Array(4).fill("g".repeat(200)) },
            questionsUpdate: null,
            deceptionUpdate: null,
            attentionUpdate: op.packet.players.map((p) => ({
              playerId: p.id,
              note: "n".repeat(200),
              evidence: [],
            })),
          },
          rationale: "Reflect on the latest evidence.",
        }),
        provider: "fake",
        model: "fake",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    };
    const executeOptions: ExecuteDecisionOptions = {
      opportunity: op,
      mandatoryRemaining: 0,
      validateCurrent: () => true,
      eventsForCommit: () => [
        {
          type: "journal.refreshed",
          phase: op.phase,
          day: op.day,
          visibility: "player",
          audienceIds: [op.playerId],
          payload: { playerId: op.playerId },
        },
      ],
      requestForAttempt: (_commit, _previous, repair) => ({
        ...decisionRequestV31(op.packet, task, true, null, repair),
        schemaName: task.type,
        providerKind: "decision_v3_1",
        normalize: (value) => normalizeV31Submission(op.packet, task, value as never, op.id, true),
        validateSubmission: (value) => validateV31Submission(op.packet, task, value as never),
      }),
    };
    await expect(
      new DecisionExecutorV2(repository, provider, new RecordingJev()).execute(executeOptions),
    ).rejects.toThrow("no action fabricated");
    expect(repository.listEvents(game.id).some((e) => e.type === "journal.refreshed")).toBe(false);
    expect(store.journal(game.id, op.playerId).version).toBe(0);
    expect(store.attempts(game.id)[0]!.status).toBe("valid");
    expect(
      store
        .attempts(game.id)
        .slice(1)
        .every((a) => a.status === "invalid"),
    ).toBe(true);
    expect(
      store.get<DecisionOpportunityV1>(game.id, `decision:${op.id}`)?.journalCompaction?.result,
    ).toBeUndefined();
    let recoveryFeedback: string | undefined;
    const recovered: DecisionProvider = {
      decide: async (request) => {
        const input = JSON.parse(request.preparedPrompt!.input);
        recoveryFeedback = input.repair;
        expect(request.schemaName).toBe("journal_compaction");
        return {
          data: request.schema.parse({
            beliefNotes: {},
            hypotheses: {},
            strategy: "Listen.",
            goals: [],
            unresolvedQuestions: [],
            deceptionPlan: null,
            attentionNotes: Object.fromEntries(
              input.NOTEBOOK.attentionNotes.map((n: { playerId: string }) => [
                n.playerId,
                "Listen.",
              ]),
            ),
          }),
          provider: "fake",
          model: "fake",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    expect(
      await new DecisionExecutorV2(repository, recovered, new RecordingJev()).execute(
        executeOptions,
      ),
    ).toBe(true);
    expect(recoveryFeedback).toBeTruthy();
    expect(
      repository.listEvents(game.id).filter((e) => e.type === "journal.compacted"),
    ).toHaveLength(1);
    expect(
      repository.listEvents(game.id).filter((e) => e.type === "journal.refreshed"),
    ).toHaveLength(1);
    expect(store.journal(game.id, op.playerId).version).toBe(1);
  });

  it.each(
    ["agent_v3_1", "agent_v3_2"].flatMap((protocolVersion) =>
      ["journal_v2", "journal_v3"].map((workflow) => ({ protocolVersion, workflow })),
    ),
  )(
    "reflects before rescoring and preserves free speech and response rights under $protocolVersion / $workflow",
    async ({ protocolVersion, workflow }) => {
      const connection = openDatabase(":memory:");
      connections.push(connection);
      const repository = new LabRepository(connection);
      repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
      const cfg = journalConfig({
        protocolVersion,
        decisionEngine: { mode: "jev", workflow },
        deliberation: { maxContextTokens: 32_000, maxJournalTokens: 16_000 },
        safety: { maxModelCalls: 1000, maxWallClockMs: 60_000, maxCycles: 4 },
      });
      const game = repository.createGame(cfg),
        llm = new RecordingLlm(),
        jev = new RecordingJev(true);
      const runner = new V2GameOrchestrator(repository, llm, jev);
      await runner.runGameStep(game.id); // setup
      await runner.runGameStep(game.id); // first discussion, including all reflections
      expect(repository.getGame(game.id)?.status, repository.getGame(game.id)?.error).toBe(
        "running",
      );
      const events = repository.listEvents(game.id),
        store = new DecisionStore(repository);
      const speeches = events.filter((e) => e.type === "speech.public");
      expect(speeches.length).toBeGreaterThan(1);
      expect(llm.requests.some((r) => r.schemaName === "journal_update")).toBe(true);
      expect(llm.requests.some((r) => r.schemaName === "discussion_free_speech")).toBe(true);
      expect(
        llm.requests.every((r) =>
          ["journal_update", "discussion_free_speech", "closing_response"].includes(r.schemaName),
        ),
      ).toBe(true);
      expect(jev.requests.every((r) => !r.questions.plan && !r.questions.needs_reasoning)).toBe(
        true,
      );
      const free = llm.requests.find((r) => r.schemaName === "discussion_free_speech")!;
      expect(JSON.parse(free.preparedPrompt!.input).REQUEST.task).not.toHaveProperty("plan");
      expect(free.preparedPrompt!.instructions).toContain("choose your own topic");
      const scoring = jev.requests.find((r) => r.questions.urge)!;
      if (workflow === "journal_v3")
        expect(testState(scoring).journal).toContain("answers to outstanding questions");
      else
        expect(
          testState(scoring).private!.AUTHORIZED_PRIVATE_STATE.journal.attentionNotes.length,
        ).toBe(4);
      for (const speech of speeches.filter((e) => !e.payload.closing)) {
        const nextScore = events.find(
          (e) =>
            e.sequence > speech.sequence &&
            e.type === "decision.opened" &&
            store.opportunities(game.id).find((op) => op.id === e.payload.decisionId)?.taskType ===
              "discussion_score",
        );
        if (!nextScore) continue;
        const updates = events.filter(
          (e) =>
            e.sequence > speech.sequence &&
            e.sequence < nextScore.sequence &&
            e.type === "journal.refreshed",
        );
        expect(new Set(updates.map((e) => e.payload.playerId)).size).toBe(5);
        expect(updates.every((e) => (e.payload.sourceIds as string[]).includes(speech.id))).toBe(
          true,
        );
      }
      const accusation = speeches.find((e) => speechActs(e).some((a) => a.kind === "challenge"))!;
      const target = speechActs(accusation).find((a) => a.kind === "challenge")!.targetId;
      expect(
        llm.requests.some(
          (r) => r.playerId === target && r.contextV2?.responseDocket.includes(accusation.id),
        ),
      ).toBe(true);
      const privateView = observerPayload(repository, repository.getGame(game.id)!, {
        kind: "public",
      });
      expect(JSON.stringify(privateView)).not.toContain("attentionNotes");
      if (workflow === "journal_v3")
        expect(JSON.stringify(privateView)).not.toContain(
          "Compare new claims and votes with prior evidence",
        );
      const initialReview = events.find((e) => e.type === "journal.refreshed")!;
      expect(
        store.journal(game.id, String(initialReview.payload.playerId), initialReview.sequence - 1)
          .attentionNotes,
      ).toBeUndefined();
      if (workflow === "journal_v3")
        expect(store.journal(game.id, String(initialReview.payload.playerId)).text).toContain(
          "Listen to",
        );
      else
        expect(
          store.journal(game.id, String(initialReview.payload.playerId)).attentionNotes?.length,
        ).toBe(4);
      // A new runner reuses committed journal checkpoints before ballots, with no duplicate review.
      const before = events.filter((e) => e.type === "journal.refreshed").length;
      await new V2GameOrchestrator(repository, llm, jev).runGameStep(game.id);
      const after = repository.listEvents(game.id);
      expect(after.some((e) => e.type === "vote.resolved")).toBe(true);
      expect(
        after.filter((e) => e.type === "journal.refreshed").length - before,
      ).toBeLessThanOrEqual(5); // pending closing speech only
      expect(jev.requests.some((r) => r.questions.target)).toBe(true);
      expect(
        jev.requests
          .filter((r) => r.questions.target)
          .every((r) =>
            workflow === "journal_v3"
              ? testState(r).journal
              : testState(r).private!.AUTHORIZED_PRIVATE_STATE.journal.attentionNotes,
          ),
      ).toBe(true);
    },
    120_000,
  );

  it.each(["journal_v2", "journal_v3", "journal_v4"])(
    "runs the full %s workflow with Jev votes/night/pack choices and no topic routing",
    async (workflow) => {
      const connection = openDatabase(":memory:");
      connections.push(connection);
      const repository = new LabRepository(connection);
      repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
      const game = repository.createGame(
        journalConfig({
          decisionEngine: { mode: "jev", workflow },
          deliberation: { maxContextTokens: 32_000, maxJournalTokens: 16_000 },
          safety: { maxCycles: 6, maxModelCalls: 2000, maxWallClockMs: 120_000 },
          maxTotalTokens: 10_000_000,
        }),
      );
      const llm = new RecordingLlm(),
        requests: JevRequest[] = [];
      const jev = new AskJevProvider(async (input) => {
        const request = JSON.parse(input) as JevRequest;
        requests.push(request);
        const state = testState(request),
          task = taskType(request);
        const choices =
          state.legalChoices ??
          (request.questions.target?.type === "choice" ? request.questions.target.criteria : {});
        let target: string | undefined;
        if (task === "vote_choice") target = "abstain";
        if (task === "team_point_choice") {
          const playerId = (choice: unknown) =>
            typeof choice === "string"
              ? (choice.match(/\(([^)]+)\)\.$/)?.[1] ?? "")
              : (choice as { playerId: string }).playerId;
          const entries = Object.entries(choices).sort((a, b) =>
            playerId(a[1]).localeCompare(playerId(b[1])),
          );
          const own = state.private?.AUTHORIZED_PRIVATE_STATE;
          const first = own && !own.evidence.some((e) => e.type === "team.point");
          const facts = state.verifiedFacts ?? state.facts;
          target =
            workflow !== "journal_v2"
              ? entries[
                  facts!.includes("Current pack points:")
                    ? 0
                    : requests.filter((r) => testState(r).task.type === "team_point_choice")
                        .length % 2
                ]?.[0]
              : entries[first && own.self.id > own.knownAllies[0]!.id ? 1 : 0]?.[0];
        }
        return JSON.stringify(answer(request, false, target));
      });
      const runner = new V2GameOrchestrator(repository, llm, jev);
      for (let i = 0; i < 80; i++) {
        await runner.runGameStep(game.id);
        if (
          ["completed", "paused", "budget_exhausted"].includes(repository.getGame(game.id)!.status)
        )
          break;
      }
      expect(repository.getGame(game.id)?.status, repository.getGame(game.id)?.error).toBe(
        "completed",
      );
      const tasks = requests.map((r) => taskType(r));
      expect(tasks).toContain("vote_choice");
      expect(tasks).toContain("night_choice");
      expect(tasks).toContain("team_point_choice");
      expect(
        tasks.every((t) =>
          [
            "discussion_score",
            "discussion_listen",
            "vote_choice",
            "night_choice",
            "team_point_choice",
          ].includes(t),
        ),
      ).toBe(true);
      expect(
        llm.requests.every((r) =>
          ["journal_update", "discussion_free_speech", "closing_response"].includes(r.schemaName),
        ),
      ).toBe(true);
      expect(
        requests.some((r) =>
          JSON.stringify(
            testState(r).public ?? testState(r).verifiedFacts ?? testState(r).facts,
          ).includes("ballots"),
        ),
      ).toBe(true);
      expect(
        requests.some((r) =>
          JSON.stringify(
            testState(r).private ?? testState(r).verifiedFacts ?? testState(r).facts,
          ).includes(workflow !== "journal_v2" ? "Current pack points" : "team.point"),
        ),
      ).toBe(true);
    },
    120_000,
  );

  it("keeps archived Jev games on their recorded workflow", () => {
    expect(usesJournalWorkflow(config())).toBe(false);
    expect(
      usesJournalWorkflow(config({ decisionEngine: { mode: "jev", workflow: "journal_v2" } })),
    ).toBe(true);
  });
});

describe("free-form journals and journal-first Jev input", () => {
  const proseConfig = () =>
    config({
      decisionEngine: { mode: "jev", workflow: "journal_v3" },
      deliberation: { maxJournalTokens: 16_000, maxContextTokens: 32_000 },
    });
  it("accepts a full 16k prose budget without metadata taxes or individual-note quotas", () => {
    const state = createGameState("prose", proseConfig());
    const packet = buildContextV2(state, [], "p1", emptyJournalV2(), "prose", "pass");
    const task: V3TaskSpec = { type: "journal_update", revision: "initial", sourceIds: [] };
    const text = "A complete thought. ".repeat(2400); // exactly 48,000 UTF-8 bytes
    const request = decisionRequestV31(packet, task, true, null, null);
    const submission = request.schema.parse({
      memory: { journalUpdate: { mode: "replace", text } },
      rationale: "Preserve the reasoning.",
    });
    const report = normalizeV31Submission(packet, task, submission, "prose", true);
    const journal = applyJournalV2(packet.journal, report, 16_000);
    expect(journal.text).toBe(text);
    expect(journalTokens(journal)).toBe(16_000);
    expect(() =>
      applyJournalV2(
        journal,
        {
          ...report,
          journalPatch: [{ op: "write_text", mode: "append", text: "New information." }],
        },
        16_000,
      ),
    ).toThrow("journal_limit:");
    expect(journalTokens({ ...journal, text: "狼🐺" })).toBe(3);
    expect(decisionRequestV31({ ...packet, journal }, task, true, null, null).tokens).toBeLessThan(
      32_000,
    );
    expect(
      JSON.parse(
        decisionRequestV31({ ...packet, journal }, task, true, null, null).prompt.privateInput!,
      ).AUTHORIZED_PRIVATE_STATE.journal,
    ).toBe(text);
    const compacting = {
      candidate: { ...journal, text: text + " More." },
      sourceReport: report,
      sourceSubmission: submission,
      sourceAttemptId: "reflection",
    };
    const compact = journalCompactionRequest(compacting, 16_000, 8192, null);
    const summary = {
      text: "I still suspect Ben, but this is inference. I promised to vote Ben unless he answers the contradiction. Hear Gus defend himself first. ".repeat(
        30,
      ),
    };
    expect(compact.schema.safeParse(summary).success).toBe(true);
    expect(compact.validateSubmission(summary)).toEqual([]);
    expect(compact.validateSubmission({ text: text + "too large" }).join()).toContain("still uses");
    expect(materializeCompactedJournal(compacting, summary)).toMatchObject({
      version: journal.version,
      text: summary.text,
    });
  });

  it("gives Jev the journal, facts and task constraints without unrelated transcript or night-action labels on votes", () => {
    const cfg = proseConfig(),
      state = createGameState("brief", cfg);
    state.day = 1;
    const packet = buildContextV2(
      state,
      [],
      "p1",
      {
        ...emptyJournalV2(),
        text: "I intend to vote Player 2 because his ballot contradicted his claim. Hear Player 3's defense before deciding.",
      },
      "brief",
      "vote",
    );
    packet.sources.push(
      {
        id: "speech",
        type: "speech.public",
        scope: "public",
        day: 1,
        publicIndex: 1,
        data: { playerId: "p2", text: "unrelated transcript ".repeat(1000) },
      },
      {
        id: "inspect",
        type: "inspection.delivered",
        scope: "player",
        day: 1,
        privateIndex: 2,
        data: { targetId: "p3", result: { alignment: "village" } },
      },
      {
        id: "ballot",
        type: "vote.resolved",
        scope: "public",
        day: 1,
        publicIndex: 2,
        data: {
          ballots: [
            { voterId: "p2", targetId: "p4" },
            { voterId: "p3", targetId: null },
          ],
          targetId: "p4",
        },
      },
      {
        id: "point",
        type: "team.point",
        scope: "team",
        day: 1,
        privateIndex: 3,
        data: { playerId: "p2", targetId: "p5" },
      },
      {
        id: "point-new",
        type: "team.point",
        scope: "team",
        day: 1,
        privateIndex: 4,
        data: { playerId: "p2", targetId: "p3" },
      },
    );
    const task: V3TaskSpec = { type: "vote_choice", proposalKind: "vote" };
    const base = {
      ...decisionRequestV31(packet, task, true, null, null),
      schemaName: task.type,
      normalize: (value: unknown) =>
        normalizeV31Submission(packet, task, value as never, "vote", true),
    };
    const stage = prepareJevStage({ packet, playerId: "p1", taskType: task.type }, cfg, base, true);
    const request = JSON.parse(stage.prepared.prompt.input) as JevRequest,
      brief = request.state as ReturnType<typeof jevBriefing>;
    expect(Object.keys(brief)[0]).toBe("journal");
    expect(brief.journal).toBe(packet.journal.text);
    expect(brief.facts).toContain('Player 3 returned {"alignment":"village"}');
    expect(brief.facts).toContain("Player 2 -> Player 4; Player 3 -> abstain");
    expect(brief.task.rules).toContain("elimination ballot");
    expect(stage.prepared.prompt.input).not.toContain("unrelated transcript");
    expect(stage.prepared.prompt.input).not.toContain("divine_alignment");
    expect(stage.prepared.prompt.input).not.toContain("protect_player");
    expect(brief).not.toHaveProperty("gameReference");
    expect(brief).not.toHaveProperty("legalChoices");
    expect(brief.facts).not.toContain("pack points");
    const pack = jevBriefing(packet, "team_point_choice");
    expect(pack.facts).toContain("Current pack points: Player 2 -> Player 3.");
    expect(pack.facts).not.toContain("Player 2 -> Player 5");
    const normalized = base.normalize(stage.toSubmission(answer(request, false, "abstain")));
    expect(normalized.proposal).toEqual({ kind: "vote", targets: null });
    expect(normalized.journalPatch).toEqual([]);
    expect(stage.prepared.prompt.input.length).toBeLessThan(
      base.prompt.privateInput!.length + base.prompt.publicInput!.length,
    );
    const forcedPacket = { ...packet, legalTargets: ["p2"] };
    const forced = prepareJevStage(
      { packet: forcedPacket, playerId: "p1", taskType: "night_choice" },
      cfg,
      base,
      true,
    );
    const forcedRequest = JSON.parse(forced.prepared.prompt.input) as JevRequest;
    expect(forcedRequest.questions.forced?.instructions).toContain("Player 2");
    expect(forced.toSubmission(answer(forcedRequest))).toMatchObject({
      mode: "direct",
      choiceHandles: ["a"],
    });
  });

  it("shares a stable API schema between reflection and speech while limiting memory changes to reflection", () => {
    const state = createGameState("cache", proseConfig()),
      packet = buildContextV2(state, [], "p1", emptyJournalV2(), "cache", "pass");
    const reflection = decisionRequestV31(
      packet,
      { type: "journal_update", revision: "initial", sourceIds: [] },
      true,
      null,
      null,
    );
    const speechTask: V3TaskSpec = {
      type: "discussion_free_speech",
      revision: "test",
      ready: false,
    };
    const speech = decisionRequestV31(packet, speechTask, true, null, null);
    expect(providerJsonSchema(reflection.apiResponseFormat!.schema)).toEqual(
      providerJsonSchema(speech.apiResponseFormat!.schema),
    );
    expect(reflection.apiResponseFormat!.instructions).toBe(speech.apiResponseFormat!.instructions);
    const envelope = {
      task: "discussion_free_speech",
      memory: { journalUpdate: null },
      speech: { text: "I have a question.", acts: [], respondsTo: [] },
      rationale: "Speak.",
    };
    expect(speech.apiResponseFormat!.decode(envelope)).toMatchObject({
      text: "I have a question.",
      memory: { journalUpdate: null },
    });
    expect(() =>
      speech.apiResponseFormat!.decode({
        ...envelope,
        memory: { journalUpdate: { mode: "replace", text: "Delete prior beliefs." } },
      }),
    ).toThrow("belong in journal_update");
    const data = speech.schema.parse({
      ...envelope.speech,
      rationale: "Speak.",
      memory: { journalUpdate: { mode: "replace", text: "Delete prior beliefs." } },
    });
    expect(validateV31Submission(packet, speechTask, data)).toContain(
      "Journal changes belong in journal_update",
    );
  });

  it("persists overflow, resumes prose compaction, and acknowledges the reflection exactly once", async () => {
    const { repository, game, op, store } = setup(
      config({
        decisionEngine: { mode: "jev", workflow: "journal_v3" },
        deliberation: { maxJournalTokens: 200, maxContextTokens: 32_000 },
      }),
    );
    op.taskType = "journal_update";
    op.kind = "pass";
    store.save(op);
    const task: V3TaskSpec = { type: "journal_update", revision: "initial", sourceIds: [] };
    const options: ExecuteDecisionOptions = {
      opportunity: op,
      mandatoryRemaining: 0,
      validateCurrent: () => true,
      eventsForCommit: () => [
        {
          type: "journal.refreshed",
          phase: op.phase,
          day: op.day,
          visibility: "player",
          audienceIds: [op.playerId],
          payload: { playerId: op.playerId },
        },
      ],
      requestForAttempt: (_commit, _previous, repair) => ({
        ...decisionRequestV31(op.packet, task, true, null, repair),
        schemaName: task.type,
        providerKind: "decision_v3_1",
        normalize: (value) => normalizeV31Submission(op.packet, task, value as never, op.id, true),
        validateSubmission: (value) => validateV31Submission(op.packet, task, value as never),
      }),
    };
    const overflowing: DecisionProvider = {
      decide: async (request) => {
        if (request.schemaName === "journal_compaction") throw new Error("interrupted compaction");
        return {
          data: request.schema.parse({
            memory: {
              journalUpdate: {
                mode: "append",
                text: "Ben changed his ballot without explaining why. ".repeat(30),
              },
            },
            rationale: "Record evidence.",
          }),
          provider: "fake",
          model: "fake",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    await expect(
      new DecisionExecutorV2(repository, overflowing, new RecordingJev()).execute(options),
    ).rejects.toThrow("no action fabricated");
    expect(store.journal(game.id, op.playerId).version).toBe(0);
    expect(repository.listEvents(game.id).some((e) => e.type === "journal.refreshed")).toBe(false);
    const summary =
      "Ben changed his ballot without explanation; ask him why. This is suspicious, not proof he is a wolf.";
    const recovery: DecisionProvider = {
      decide: async (request) => {
        expect(request.schemaName).toBe("journal_compaction");
        expect(JSON.parse(request.preparedPrompt!.input).journal).toContain(
          "Ben changed his ballot",
        );
        return {
          data: request.schema.parse({ text: summary }),
          provider: "fake",
          model: "fake",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    expect(
      await new DecisionExecutorV2(repository, recovery, new RecordingJev()).execute(options),
    ).toBe(true);
    expect(store.journal(game.id, op.playerId)).toMatchObject({ version: 1, text: summary });
    expect(
      repository.listEvents(game.id).filter((e) => e.type === "journal.refreshed"),
    ).toHaveLength(1);
    expect(
      repository.listEvents(game.id).filter((e) => e.type === "journal.compacted"),
    ).toHaveLength(1);
  });
});
