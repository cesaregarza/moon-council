import { afterEach, describe, expect, it } from "vitest";
import { ExperimentSpecSchema, GameConfigSchema } from "@werewolf/contracts";
import { LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { projectEvents, reduceGame, STARTER_ROLES } from "@werewolf/engine";
import { FakeDecisionProvider } from "@werewolf/llm";
import { GameOrchestrator, runExperiment } from "./index";

const connections: DatabaseConnection[] = [];
afterEach(() => {
  while (connections.length) connections.pop()!.close();
});

function repository() {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  const repo = new LabRepository(connection);
  repo.seedRoles(STARTER_ROLES);
  return repo;
}

function gameConfig() {
  const ids = [
    "werewolf",
    "werewolf",
    "seer",
    "doctor",
    "roleblocker",
    "mayor",
    "villager",
    "villager",
  ];
  return GameConfigSchema.parse({
    schemaVersion: "game_config_v1",
    name: "Integration council",
    seed: "integration-seed",
    seats: ids.map((_, index) => ({
      id: `p${index + 1}`,
      name: `Player ${index + 1}`,
      personality: "Decisive test player",
    })),
    roleDeck: ids.map((id) => structuredClone(STARTER_ROLES.find((role) => role.id === id)!)),
    safety: { maxCycles: 3, maxModelCalls: 500, maxOutputTokens: 600, maxWallClockMs: 1_800_000 },
    speedMs: 0,
  });
}

describe("full simulation", () => {
  it("runs an eight-seat fake-provider game to a terminal replayable state", async () => {
    const repo = repository();
    const game = repo.createGame(gameConfig());
    const orchestrator = new GameOrchestrator(repo, new FakeDecisionProvider(), "fake-model");
    orchestrator.initializeGame(game);
    repo.updateGame(game.id, { status: "running" });
    await orchestrator.runToCompletion(game.id);

    const record = repo.getGame(game.id)!;
    expect(["completed", "budget_exhausted"]).toContain(record.status);
    const events = repo.listEvents(game.id);
    const replay = reduceGame(game.id, events);
    expect(replay.phase).toBe("ended");
    expect(events.some((event) => event.type === "message.public")).toBe(true);
    expect(
      projectEvents(events, { kind: "public" }).every((event) => event.visibility === "public"),
    ).toBe(true);
    expect(repo.listJournals(game.id)).toHaveProperty("p1");
  }, 20_000);

  it("completes a ten-run experiment and aggregates outcomes", async () => {
    const repo = repository();
    const spec = ExperimentSpecSchema.parse({
      schemaVersion: "experiment_v1",
      name: "Ten game check",
      baseConfig: gameConfig(),
      runs: 10,
      concurrency: 2,
      baseSeed: "batch-seed",
      pricingPerMillionTokens: {},
    });
    const experiment = repo.createExperiment(spec);
    const summary = await runExperiment(
      repo,
      new FakeDecisionProvider(),
      experiment.id,
      "fake-model",
    );
    expect(summary.runsCompleted + summary.budgetTruncated).toBe(10);
    expect(Object.values(summary.survivalByRole).reduce((sum, item) => sum + item.total, 0)).toBe(
      summary.runsCompleted * 8,
    );
    expect(repo.getExperiment(experiment.id)?.status).toBe("completed");
  }, 90_000);
});
