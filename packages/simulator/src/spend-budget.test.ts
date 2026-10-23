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
import { claudeUsage, FakeDecisionProvider } from "@werewolf/llm";
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

  it("reads stored provider metadata back unchanged, with or without heldUsd", () => {
    // CES-1564: a retried Claude call reports heldUsd instead of costUsd. Records written before
    // the field existed, and records with it, both round-trip through the store as written.
    const game = ledger(1);
    const before = game.attempt("claude-haiku-5-5", 1_000);
    game.settle(before, 1_000, 100);
    before.providerMetadata = { responseId: "msg_1", stopReason: "end_turn", costUsd: 0.01 };
    game.store.updateAttempt(before);
    const retried = game.attempt("claude-haiku-5-5", 1_000);
    game.settle(retried, 1_000, 100);
    retried.providerMetadata = { responseId: "msg_2", stopReason: "end_turn", heldUsd: 0.03 };
    game.store.updateAttempt(retried);
    expect(game.store.attempts(game.gameId).map((a) => a.providerMetadata)).toEqual([
      { responseId: "msg_1", stopReason: "end_turn", costUsd: 0.01 },
      { responseId: "msg_2", stopReason: "end_turn", heldUsd: 0.03 },
    ]);
    expect(() => assertV2Budget(game.store, game.gameId, game.config)).not.toThrow();
  });

  it("holds an in-flight call at the reservation admitted when it began", () => {
    // halcyon's probe (PR #20 re-review): the stored prompt is far smaller than the admitted
    // request, so rebuilding from it under-reserves. $0.177608 + $0.080024 > $0.19.
    const game = ledger(0.19);
    const record = game.attempt("claude-haiku-5-5", 4_000);
    Object.assign(record, { reservedUsd: 0.177608 });
    game.store.updateAttempt(record);
    const next = {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 40, // a 120-token ceiling: $0.000024
      maxOutputTokens: 160_000, // $0.08
    };
    expect(() => assertV2Budget(game.store, game.gameId, game.config, 0, true, next)).toThrow(
      /spend/,
    );
  });

  it("never counts a negative recorded cost as credit", () => {
    const game = ledger(0.09);
    const record = game.attempt("claude-opus-5-5", 1_000);
    game.settle(record, 10_000, 0);
    record.usage = { ...record.usage, cacheWriteInputTokens: 10_000 }; // $0.08 at 1 hour
    record.providerMetadata = { costUsd: -1 };
    game.store.updateAttempt(record);
    const next = {
      provider: "anthropic",
      model: "claude-opus-5-5",
      inputTokens: 0,
      maxOutputTokens: 1_040,
    };
    expect(() => assertV2Budget(game.store, game.gameId, game.config, 0, true, next)).toThrow(
      /spend/,
    );
  });

  it("records the admitted reservation on every Claude attempt when it begins", async () => {
    const connection = openDatabase(":memory:");
    connections.push(connection);
    const repository = new LabRepository(connection);
    repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
    // Few calls keep the run short; every attempt still begins through the real path.
    const safety = {
      maxCycles: 4,
      maxModelCalls: 20,
      maxOutputTokens: 4_000,
      maxWallClockMs: 60_000,
    };
    const record = repository.createGame(
      GameConfigV2Schema.parse(claudeConfig({ maxSpendUsd: 50, safety })),
    );
    repository.appendEvent(
      record.id,
      createGameCreatedEvent(createGameState(record.id, record.config)),
    );
    repository.updateGame(record.id, { status: "running" });
    const orchestrator = new V2GameOrchestrator(repository, new FakeDecisionProvider());
    const store = new DecisionStore(repository);
    for (let step = 0; step < 10 && !store.attempts(record.id).length; step += 1)
      await orchestrator.runGameStep(record.id);
    const attempts = store.attempts(record.id);
    expect(attempts.length).toBeGreaterThan(0);
    const reserved = attempts.map((attempt) => (attempt as { reservedUsd?: unknown }).reservedUsd);
    expect(reserved).toEqual(attempts.map(() => expect.any(Number)));
    expect(reserved.every((usd) => (usd as number) > 0)).toBe(true);
  });

  it.each([
    ["outputTokens", { outputTokens: -1_000 }],
    ["inputTokens", { inputTokens: -50_000 }],
    ["cachedInputTokens", { inputTokens: -490_000, cachedInputTokens: -500_000 }],
    ["cacheWriteInputTokens", { cacheWriteInputTokens: -10_000 }],
  ])("holds the admitted reservation when recorded %s is invalid", (_field, bad) => {
    // halcyon's fixtures: an invalid cost and invalid usage must not rebuild into credit.
    const game = ledger(0.09);
    const record = game.attempt("claude-opus-5-5", 1_000);
    game.settle(record, 10_000, 0);
    record.usage = { ...record.usage, cacheWriteInputTokens: 10_000, ...bad };
    record.providerMetadata = { costUsd: -1 };
    Object.assign(record, { reservedUsd: 0.08 });
    game.store.updateAttempt(record);
    const next = {
      provider: "anthropic",
      model: "claude-opus-5-5",
      inputTokens: 0,
      maxOutputTokens: 1_040, // $0.0208
    };
    expect(() => assertV2Budget(game.store, game.gameId, game.config, 0, true, next)).toThrow(
      /spend/,
    );
  });

  it("refuses admission when an unsettled Claude attempt has no admitted reservation", () => {
    // A record written before reservations were stored: the saved prompt cannot bound it.
    const game = ledger(0.19);
    game.attempt("claude-haiku-5-5", 4_000); // usage unknown, no reservedUsd
    const next = {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 40,
      maxOutputTokens: 160_000, // $0.080024
    };
    let refusal: unknown;
    try {
      assertV2Budget(game.store, game.gameId, game.config, 0, true, next);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ name: "UnreservedClaudeAttemptError" });
  });

  // Rule U, game side: usage mapped from malformed raw counts is unknown, so the game keeps
  // the attempt's admitted reservation ($0.08 + $0.0208 > $0.09 refuses the next call).
  for (const field of ["input_tokens", "output_tokens"])
    it.each([null, undefined, true, "5", 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
      `holds the reservation when the reply's ${field} is %s`,
      (value) => {
        const raw: Record<string, unknown> = {
          input_tokens: 1_000,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        };
        if (value === undefined) delete raw[field];
        else raw[field] = value;
        const game = ledger(0.09);
        const record = game.attempt("claude-opus-5-5", 1_000);
        record.usage = claudeUsage(raw as never);
        record.status = "valid";
        Object.assign(record, { reservedUsd: 0.08 });
        game.store.updateAttempt(record);
        const next = {
          provider: "anthropic",
          model: "claude-opus-5-5",
          inputTokens: 0,
          maxOutputTokens: 1_040,
        };
        expect(() => assertV2Budget(game.store, game.gameId, game.config, 0, true, next)).toThrow(
          /spend/,
        );
      },
    );

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
