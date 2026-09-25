import {
  ExperimentSpecV2Schema,
  GameConfigV2Schema,
  type DecisionOpportunityV1,
  type GameEventV1,
} from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { createGameCreatedEvent, createGameState, STARTER_ROLES } from "@werewolf/engine";
import { afterEach, describe, expect, it } from "vitest";
import { runExperiment, summarizeExperiment } from "./experiments";
import { DOCTOR_V2 } from "@werewolf/engine";
import { FakeDecisionProvider } from "@werewolf/llm";

const connections: DatabaseConnection[] = [];
afterEach(() => {
  while (connections.length) connections.pop()!.close();
});

function createRepository(): LabRepository {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  const repository = new LabRepository(connection);
  repository.seedRoles(STARTER_ROLES);
  return repository;
}

function config() {
  const roleIds = ["werewolf", "seer", "doctor", "villager", "villager"];
  const seats = roleIds.map((_, index) => ({
    id: `p${index + 1}`,
    name: `Player ${index + 1}`,
    personality: "test",
  }));
  return GameConfigV2Schema.parse({
    schemaVersion: "game_config_v2",
    name: "V2 batch",
    seed: "v2-batch",
    seats,
    roleDeck: roleIds.map((id) => structuredClone(STARTER_ROLES.find((role) => role.id === id)!)),
    modelSettings: Object.fromEntries(
      seats.map((seat) => [
        seat.id,
        { model: "fake-model", reasoningEffort: "medium", provider: "fake" },
      ]),
    ),
    safety: { maxCycles: 2, maxModelCalls: 50, maxOutputTokens: 200, maxWallClockMs: 60_000 },
  });
}

function spec() {
  return ExperimentSpecV2Schema.parse({
    schemaVersion: "experiment_v2",
    name: "V2 summary",
    baseConfig: config(),
    runs: 4,
    concurrency: 2,
    baseSeed: "batch",
    pricingPerMillionTokens: { "fake-model": { input: 1, output: 2 } },
  });
}

function appendCreated(
  repository: LabRepository,
  gameId: string,
  gameConfig: ReturnType<typeof config>,
): void {
  repository.appendEvent(gameId, createGameCreatedEvent(createGameState(gameId, gameConfig)));
}

describe("V2 experiment summaries", () => {
  it("completes ten standard games without duplicate runs and persists outcome denominators", async () => {
    const repository = createRepository();
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
    const baseConfig = GameConfigV2Schema.parse({
      ...config(),
      preset: "standard-8-v2",
      seats,
      roleDeck: ids.map((id) =>
        id === "doctor" ? DOCTOR_V2 : STARTER_ROLES.find((r) => r.id === id)!,
      ),
      safety: { maxCycles: 8, maxModelCalls: 500, maxOutputTokens: 600, maxWallClockMs: 1_800_000 },
      modelSettings: Object.fromEntries(
        seats.map((s) => [s.id, { model: "fake", provider: "fake", reasoningEffort: "xhigh" }]),
      ),
    });
    const experiment = repository.createExperiment(
      ExperimentSpecV2Schema.parse({ ...spec(), baseConfig, runs: 10, concurrency: 3 }),
    );
    const summary = await runExperiment(
      repository,
      new FakeDecisionProvider(),
      experiment.id,
      "fake",
    );
    expect(
      summary.completed + summary.budgetTruncated,
      JSON.stringify(
        repository
          .listGames(50, experiment.id)
          .map((game) => ({ status: game.status, error: game.error })),
      ),
    ).toBe(10);
    expect(summary.interrupted).toBe(0);
    expect(repository.listGames(50, experiment.id)).toHaveLength(10);
    await runExperiment(repository, new FakeDecisionProvider(), experiment.id, "fake");
    expect(repository.listGames(50, experiment.id)).toHaveLength(10);
    expect(repository.getExperiment(experiment.id)!.summary).toMatchObject({
      validOutcomeDenominator: summary.completed,
      completed: summary.completed,
    });
  }, 90_000);
  it("keeps incomplete outcomes separate while aggregating all attempt usage", () => {
    const repository = createRepository();
    const experiment = repository.createExperiment(spec());
    const complete = repository.createGame(
      { ...config(), name: "complete", seed: "batch:0" },
      experiment.id,
    );
    appendCreated(repository, complete.id, complete.config as ReturnType<typeof config>);
    repository.appendEvent(complete.id, {
      type: "game.started",
      phase: "setup",
      day: 0,
      visibility: "public",
      payload: { startedAt: "2026-01-01T00:00:00.000Z" },
    });
    repository.appendEvent(complete.id, {
      type: "game.ended",
      phase: "ended",
      day: 1,
      visibility: "public",
      payload: { winnerAlignments: ["village"], winnerPlayerIds: ["p2"], reason: "test" },
    });
    repository.updateGame(complete.id, { status: "completed" });

    const paused = repository.createGame(
      { ...config(), name: "paused", seed: "batch:1" },
      experiment.id,
    );
    appendCreated(repository, paused.id, paused.config as ReturnType<typeof config>);
    repository.updateGame(paused.id, { status: "paused" });
    const failed = repository.createGame(
      { ...config(), name: "failed", seed: "batch:2" },
      experiment.id,
    );
    repository.updateGame(failed.id, { status: "failed" });
    const budget = repository.createGame(
      { ...config(), name: "budget", seed: "batch:3" },
      experiment.id,
    );
    repository.updateGame(budget.id, { status: "budget_exhausted" });

    const store = new DecisionStore(repository);
    store.registerRun(experiment.id, 0, complete.id);
    store.registerRun(experiment.id, 1, paused.id);
    const opportunity: DecisionOpportunityV1 = {
      id: "decision-1",
      gameId: paused.id,
      playerId: "p1",
      kind: "vote",
      phase: "day_vote",
      day: 1,
      epoch: "1:day_vote",
      viewId: "view-1",
      baseJournalVersion: 0,
      packet: {
        schemaVersion: "player_context_v2",
        phase: "day_vote",
        day: 1,
        self: { id: "p1", name: "Player 1", role: structuredClone(STARTER_ROLES[0]!) },
        players: [],
        knownAllies: [],
        rules: {},
        sources: [],
        legalActions: [],
        legalTargets: [],
        journal: {
          schemaVersion: "journal_v2",
          version: 0,
          beliefs: [],
          hypotheses: [],
          strategy: "",
          goals: [],
          unresolvedQuestions: [],
          deceptionPlan: null,
        },
        responseDocket: [],
        closing: false,
      },
      status: "open",
      best: null,
      recovery: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const attempt = store.beginAttempt(opportunity, {
      model: "fake-model",
      provider: "fake",
      reasoningEffort: "medium",
      optional: false,
      request: { instructions: "i", input: "p", schema: {} },
    });
    attempt.usage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 2,
      reasoningTokens: 3,
    };
    store.updateAttempt(attempt);

    const summary = summarizeExperiment(repository, experiment.id, experiment.spec);
    expect(summary).toMatchObject({
      runsRequested: 4,
      runsCompleted: 1,
      completed: 1,
      interrupted: 1,
      failed: 1,
      budgetTruncated: 1,
      validOutcomeDenominator: 1,
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(summary.estimatedCost).toBeCloseTo(0.00002);
    expect(summary.winsByAlignment).toEqual({ village: 1 });
  });

  it("uses a stable registered game for a run index instead of creating a duplicate", () => {
    const repository = createRepository();
    const experiment = repository.createExperiment(spec());
    const game = repository.createGame(
      { ...config(), name: "run 1", seed: "batch:0" },
      experiment.id,
    );
    const store = new DecisionStore(repository);
    store.atomic(() => store.registerRun(experiment.id, 0, game.id));

    expect(store.runGame(experiment.id, 0)).toBe(game.id);
    expect(repository.listGames(20, experiment.id)).toHaveLength(1);
  });
});
