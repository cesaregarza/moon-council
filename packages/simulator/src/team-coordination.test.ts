import { afterEach, describe, expect, it } from "vitest";
import { GameConfigSchema } from "@werewolf/contracts";
import { LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { STARTER_ROLES } from "@werewolf/engine";
import {
  FakeDecisionProvider,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
} from "@werewolf/llm";
import { GameOrchestrator } from "./orchestrator";

const connections: DatabaseConnection[] = [];
const emptyJournal = { beliefs: [], goals: [], strategy: "", unresolvedQuestions: [] };

afterEach(() => {
  while (connections.length) connections.pop()!.close();
});

function setup(provider: DecisionProvider) {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  const repository = new LabRepository(connection);
  repository.seedRoles(STARTER_ROLES);
  const roleIds = ["werewolf", "werewolf", "villager", "villager", "villager"];
  const config = GameConfigSchema.parse({
    schemaVersion: "game_config_v1",
    name: "Pointing test",
    seed: "pointing-seed",
    seats: roleIds.map((_, index) => ({
      id: `p${index + 1}`,
      name: `Player ${index + 1}`,
      personality: "Test",
    })),
    roleDeck: roleIds.map((id) => structuredClone(STARTER_ROLES.find((role) => role.id === id)!)),
    speedMs: 0,
  });
  const game = repository.createGame(config);
  const orchestrator = new GameOrchestrator(repository, provider, "test-model");
  orchestrator.initializeGame(game);
  repository.updateGame(game.id, { status: "running" });
  return { repository, game, orchestrator };
}

async function runPointingPhase(orchestrator: GameOrchestrator, gameId: string): Promise<void> {
  await orchestrator.runGameStep(gameId);
  await orchestrator.runGameStep(gameId);
}

class DisagreeingPointProvider implements DecisionProvider {
  calls = 0;

  async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    if (request.kind !== "team_point" || !request.view) {
      throw new Error(`Unexpected decision request: ${request.kind}`);
    }
    this.calls += 1;
    const packIds = [
      request.view.self.id,
      ...request.view.knownAllies.map((player) => player.id),
    ].sort();
    const pack = new Set(packIds);
    const targets = request.view.players
      .filter((player) => player.alive && !pack.has(player.id))
      .map((player) => player.id)
      .sort();
    const targetId = targets[packIds.indexOf(request.view.self.id) % targets.length]!;
    return {
      data: request.schema.parse({
        kind: "team_point",
        targetId,
        journal: {
          ...emptyJournal,
          strategy: `Keep pointing at ${targetId}.`,
        },
      }),
      provider: "disagreement-test",
      model: request.model,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}

describe("point-only werewolf coordination", () => {
  it("commits a pack kill only after every living werewolf points at the same target", async () => {
    const { repository, game, orchestrator } = setup(new FakeDecisionProvider());
    await runPointingPhase(orchestrator, game.id);

    let events = repository.listEvents(game.id);
    const points = events.filter((event) => event.type === "team.pointed");
    expect(points).toHaveLength(2);
    expect(points.every((event) => event.visibility === "team")).toBe(true);
    expect(points.every((event) => !("text" in event.payload))).toBe(true);
    expect(events.some((event) => event.type === "message.team")).toBe(false);
    expect(events.find((event) => event.type === "team.consensus_reached")?.payload).toMatchObject({
      participants: 2,
      turns: 2,
    });

    await orchestrator.runGameStep(game.id);
    events = repository.listEvents(game.id);
    const submissions = events.filter(
      (event) =>
        event.type === "night.action_submitted" && event.payload.source === "team_consensus",
    );
    expect(submissions).toHaveLength(2);
    const targets = submissions.map(
      (event) => (event.payload.action as { targetIds: string[] }).targetIds[0],
    );
    expect(new Set(targets).size).toBe(1);
    expect(events.filter((event) => event.type === "player.eliminated")).toHaveLength(1);
  });

  it("stops after three turns per living werewolf and skips the kill without unanimity", async () => {
    const provider = new DisagreeingPointProvider();
    const { repository, game, orchestrator } = setup(provider);
    await runPointingPhase(orchestrator, game.id);

    let events = repository.listEvents(game.id);
    const points = events.filter((event) => event.type === "team.pointed");
    expect(points).toHaveLength(6);
    expect(provider.calls).toBe(6);
    expect(events.some((event) => event.type === "team.consensus_reached")).toBe(false);
    expect(events.find((event) => event.type === "team.consensus_failed")?.payload).toMatchObject({
      reason: "turn_limit",
      turns: 6,
      maxTurns: 6,
    });

    await orchestrator.runGameStep(game.id);
    events = repository.listEvents(game.id);
    expect(events.some((event) => event.type === "night.action_submitted")).toBe(false);
    expect(events.some((event) => event.type === "player.eliminated")).toBe(false);
    expect(
      events.find((event) => event.type === "night.team_action_skipped")?.payload,
    ).toMatchObject({
      reason: "no_unanimous_target",
    });
  });
});
