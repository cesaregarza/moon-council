import { afterEach, describe, expect, it } from "vitest";
import {
  GameConfigV2Schema,
  type DecisionOpportunityV1,
  type GameConfigV2,
} from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import {
  DOCTOR_V2,
  STARTER_ROLES,
  createGameCreatedEvent,
  createGameState,
} from "@werewolf/engine";
import { FakeDecisionProvider } from "@werewolf/llm";
import { assertV2Budget, V2BudgetError } from "./decisions-v2";
import { V2GameOrchestrator } from "./orchestrator-v2";

const connections: DatabaseConnection[] = [];
afterEach(() => {
  while (connections.length) connections.pop()!.close();
});

const roles = ["werewolf", "werewolf", "seer", "doctor", "villager", "villager", "villager"];
/** Every seat on Claude Haiku 5.5, the pilot model. */
function claudeConfig(overrides: Record<string, unknown> = {}) {
  const seats = roles.map((_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}` }));
  return {
    schemaVersion: "game_config_v2",
    protocolVersion: "agent_v3_1",
    preset: "custom-v2",
    name: "Claude spend",
    seed: "spend",
    seats,
    roleDeck: roles.map((id) =>
      id === "doctor" ? DOCTOR_V2 : STARTER_ROLES.find((role) => role.id === id),
    ),
    rules: { firstCycle: "day_first" },
    discussion: { speakerSelection: "listener_auction", maxParallelDecisions: 2 },
    modelSettings: Object.fromEntries(
      seats.map((s) => [
        s.id,
        { model: "claude-haiku-5-5", provider: "anthropic", reasoningEffort: "medium" },
      ]),
    ),
    safety: { maxCycles: 4, maxModelCalls: 500, maxOutputTokens: 4_000, maxWallClockMs: 60_000 },
    ...overrides,
  };
}

/** A game whose attempts are written directly, so spend can be checked without a provider. */
function ledger(maxSpendUsd: number) {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  const repository = new LabRepository(connection);
  repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
  // Built from an OpenAI-shaped config so this compiles and runs against the old schema too.
  const base = GameConfigV2Schema.parse({
    ...claudeConfig(),
    modelSettings: Object.fromEntries(
      roles.map((_, i) => [`p${i + 1}`, { model: "gpt-6-luna", provider: "openai" }]),
    ),
  });
  const game = repository.createGame(base);
  const config = { ...base, maxSpendUsd } as unknown as GameConfigV2;
  const store = new DecisionStore(repository);
  const op = {
    gameId: game.id,
    id: "decision",
    playerId: "p1",
    recovery: 0,
    phase: "day_discussion",
    day: 1,
  } as DecisionOpportunityV1;
  const attempt = (model: string, maxOutputTokens: number) =>
    store.beginAttempt(op, {
      model,
      provider: "anthropic",
      reasoningEffort: "medium",
      optional: false,
      maxOutputTokens,
      request: { instructions: "x", input: "y", schema: {} },
    });
  const settle = (
    record: ReturnType<typeof attempt>,
    inputTokens: number,
    outputTokens: number,
  ) => {
    record.usage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: null,
    };
    record.status = "valid";
    store.updateAttempt(record);
  };
  return { store, gameId: game.id, config, attempt, settle };
}

describe("per-game Claude spend admission", () => {
  it("requires maxSpendUsd for a game with Claude seats", () => {
    expect(() => GameConfigV2Schema.parse(claudeConfig())).toThrow(/maxSpendUsd/);
    expect(GameConfigV2Schema.parse(claudeConfig({ maxSpendUsd: 2 }))).toMatchObject({
      maxSpendUsd: 2,
    });
  });

  it("refuses once settled spend reaches the limit, and settles to actual usage", () => {
    // Haiku 5.5 up to 100K prompt tokens: $0.10/M in, $0.50/M out. 100K in + 20K out = $0.02.
    const generous = ledger(0.05);
    generous.settle(generous.attempt("claude-haiku-5-5", 100_000), 100_000, 20_000);
    // Settled at the actual $0.02, not the $0.05+ worst case of a 100K output cap.
    expect(() => assertV2Budget(generous.store, generous.gameId, generous.config)).not.toThrow();
    const tight = ledger(0.02);
    tight.settle(tight.attempt("claude-haiku-5-5", 100_000), 100_000, 20_000);
    expect(() => assertV2Budget(tight.store, tight.gameId, tight.config)).toThrow(V2BudgetError);
  });

  it("reserves an unsettled call at its worst case", () => {
    const game = ledger(0.04);
    // Unknown usage: at least 100K output tokens at $0.50/M = $0.05 is held.
    game.attempt("claude-haiku-5-5", 100_000);
    expect(() => assertV2Budget(game.store, game.gameId, game.config)).toThrow(/spend/);
  });

  it("refuses a call whose own reservation would cross the limit", () => {
    const game = ledger(0.01);
    expect(() => assertV2Budget(game.store, game.gameId, game.config)).not.toThrow();
    expect(() =>
      assertV2Budget(game.store, game.gameId, game.config, 0, true, {
        provider: "anthropic",
        model: "claude-haiku-5-5",
        inputTokens: 1_000,
        maxOutputTokens: 100_000,
      }),
    ).toThrow(/spend/);
  });

  it("bounds the next call's prompt by its bytes, pricing a possible long Haiku prompt high", () => {
    // A 40K estimate (bytes / 3) can be up to 120K tokens: past 100K, so long-tier rates apply.
    // Long tier: 120K at $1/M plus 4K output at $2.50/M = $0.13; by the estimate alone, $0.01.
    const game = ledger(0.05);
    const next = {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 40_000,
      maxOutputTokens: 4_000,
    };
    expect(() => assertV2Budget(game.store, game.gameId, game.config, 0, true, next)).toThrow(
      /spend/,
    );
  });

  it("prices cache writes of unknown TTL at the 1-hour rate", () => {
    // 10K Opus 5.5 write tokens: $0.08 at the 1-hour rate ($8/M), $0.05 at the 5-minute rate.
    const game = ledger(0.09);
    const record = game.attempt("claude-opus-5-5", 1_000);
    game.settle(record, 10_000, 0);
    record.usage = { ...record.usage, cacheWriteInputTokens: 10_000 };
    game.store.updateAttempt(record);
    const next = {
      provider: "anthropic",
      model: "claude-opus-5-5",
      inputTokens: 0,
      maxOutputTokens: 1_040, // $0.0208 at $20/M
    };
    expect(() => assertV2Budget(game.store, game.gameId, game.config, 0, true, next)).toThrow(
      /spend/,
    );
  });

  it("uses the provider's actual attempt cost when it is recorded", () => {
    const game = ledger(0.09);
    const record = game.attempt("claude-opus-5-5", 1_000);
    game.settle(record, 10_000, 0);
    record.usage = { ...record.usage, cacheWriteInputTokens: 10_000 };
    record.providerMetadata = { costUsd: 0.05 }; // all 5-minute writes
    game.store.updateAttempt(record);
    const next = {
      provider: "anthropic",
      model: "claude-opus-5-5",
      inputTokens: 0,
      maxOutputTokens: 1_040,
    };
    expect(() => assertV2Budget(game.store, game.gameId, game.config, 0, true, next)).not.toThrow();
    record.providerMetadata = { costUsd: 0.08 }; // all 1-hour writes
    game.store.updateAttempt(record);
    expect(() => assertV2Budget(game.store, game.gameId, game.config, 0, true, next)).toThrow(
      /spend/,
    );
  });

  it("fails closed for a Claude model with no price", () => {
    const game = ledger(100);
    game.settle(game.attempt("claude-unpriced-9", 1_000), 10, 10);
    expect(() => assertV2Budget(game.store, game.gameId, game.config)).toThrow(/price/);
  });

  it("ends the game through game.budget_exhausted when the next reservation would exceed it", async () => {
    const connection = openDatabase(":memory:");
    connections.push(connection);
    const repository = new LabRepository(connection);
    repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
    const record = repository.createGame(
      GameConfigV2Schema.parse(claudeConfig({ maxSpendUsd: 0.000_01 })),
    );
    repository.appendEvent(
      record.id,
      createGameCreatedEvent(createGameState(record.id, record.config)),
    );
    repository.updateGame(record.id, { status: "running" });
    const orchestrator = new V2GameOrchestrator(repository, new FakeDecisionProvider());
    for (let step = 0; step < 10; step += 1) {
      await orchestrator.runGameStep(record.id);
      if (repository.getGame(record.id)!.status !== "running") break;
    }
    expect(repository.getGame(record.id)!.status).toBe("budget_exhausted");
    expect(repository.listEvents(record.id).some((e) => e.type === "game.budget_exhausted")).toBe(
      true,
    );
    expect(new DecisionStore(repository).attempts(record.id)).toHaveLength(0);
  });
});
