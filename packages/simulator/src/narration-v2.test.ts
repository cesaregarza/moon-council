import { GameConfigV2Schema } from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { createGameCreatedEvent, createGameState, STARTER_ROLES } from "@werewolf/engine";
import type { DecisionProvider } from "@werewolf/llm";
import { afterEach, describe, expect, it } from "vitest";
import { NarrationPausedError, NarrationV2 } from "./narration-v2";

const connections: DatabaseConnection[] = [];
afterEach(() => {
  while (connections.length) connections.pop()!.close();
});

function repository(): LabRepository {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  return new LabRepository(connection);
}

function game(repository: LabRepository) {
  const ids = ["werewolf", "seer", "doctor", "villager", "villager"];
  const seats = ids.map((_, index) => ({ id: `p${index + 1}`, name: `Player ${index + 1}` }));
  const config = GameConfigV2Schema.parse({
    schemaVersion: "game_config_v2",
    name: "narration",
    seed: "narration-test",
    seats,
    roleDeck: ids.map((id) => structuredClone(STARTER_ROLES.find((role) => role.id === id)!)),
    modelSettings: Object.fromEntries(
      seats.map((seat) => [seat.id, { model: "fake", provider: "fake", reasoningEffort: "none" }]),
    ),
    safety: { maxCycles: 2, maxModelCalls: 20, maxOutputTokens: 300, maxWallClockMs: 60_000 },
  });
  const record = repository.createGame(config);
  repository.appendEvent(record.id, createGameCreatedEvent(createGameState(record.id, config)));
  repository.updateGame(record.id, { status: "running" });
  return record;
}

const usage = {
  inputTokens: 4,
  outputTokens: 3,
  totalTokens: 7,
  cachedInputTokens: 1,
  cacheWriteInputTokens: 0,
  reasoningTokens: 0,
};
const metadata = { provider: "fake", model: "fake", outputLimitEnforced: true };
const options = (gameId: string) => ({
  gameId,
  decisionId: "announcement:1",
  phase: "day_announcement" as const,
  day: 1,
  model: "fake",
  disclosurePacket: { text: "The sun rises.", publicRevision: 3 },
  fallbackText: "The day begins.",
});

describe("V2 moderator narration", () => {
  it("uses an exact public prepared prompt and reuses a pending report after restart", async () => {
    const repo = repository();
    const record = game(repo);
    let calls = 0;
    let captured: Record<string, unknown> | undefined;
    const provider: DecisionProvider = {
      decide: async (request) => {
        calls += 1;
        captured = request as unknown as Record<string, unknown>;
        request.onUsage?.(usage, metadata);
        return {
          data: { text: "Dawn finds the village quiet." },
          provider: "fake",
          model: "fake",
          usage: {},
        } as never;
      },
    };
    const narration = new NarrationV2(repo, provider);
    const first = await narration.narrate(options(record.id));
    expect(first).toBe("Dawn finds the village quiet.");
    expect(calls).toBe(1);
    expect(captured?.contextV2).toBeUndefined();
    expect(captured?.playerId).toBe("moderator");
    expect((captured?.preparedPrompt as { input: string } | undefined)?.input).toContain(
      "publicRevision",
    );
    const attempt = narration.store.attempts(record.id, "announcement:1")[0]!;
    expect(attempt.usage).toEqual(usage);
    expect(attempt.promptVersion).toBe("moderator_prompt_v2.1");
    expect(attempt.schemaVersion).toBe("moderator_narration_v2");
    const schema = attempt.request.schema as {
      type: string;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema).toMatchObject({
      type: "object",
      required: ["text"],
      additionalProperties: false,
    });
    expect(await narration.narrate(options(record.id))).toBe(first);
    expect(calls).toBe(1);
    expect(narration.acknowledge(record.id, "announcement:1", first)).toBe(first);
  });

  it("records usage before rejecting malformed structured output and pauses after one repair", async () => {
    const repo = repository();
    const record = game(repo);
    let receipts = 0;
    const provider: DecisionProvider = {
      decide: async (request) => {
        request.onUsage?.(usage, metadata);
        expect(new DecisionStore(repo).attempts(record.id, "malformed").at(-1)?.status).toBe(
          "received",
        );
        receipts += 1;
        return { data: { wrong: "field" }, provider: "fake", model: "fake", usage: {} } as never;
      },
    };
    const narration = new NarrationV2(repo, provider);
    await expect(
      narration.narrate({ ...options(record.id), decisionId: "malformed" }),
    ).rejects.toThrow("no announcement fabricated");
    expect(receipts).toBe(2);
    expect(
      narration.store.attempts(record.id, "malformed").map((attempt) => attempt.status),
    ).toEqual(["invalid", "invalid"]);
    expect(narration.checkpoint(record.id, "malformed")?.status).toBe("paused");
  });

  it("keeps a valid report pending when an operator pauses before acknowledgement", async () => {
    const repo = repository();
    const record = game(repo);
    let calls = 0;
    const provider: DecisionProvider = {
      decide: async (request) => {
        calls += 1;
        request.onUsage?.(usage, metadata);
        repo.updateGame(record.id, { status: "paused" });
        return {
          data: { text: "The moderator pauses the scene." },
          provider: "fake",
          model: "fake",
          usage: {},
        } as never;
      },
    };
    const narration = new NarrationV2(repo, provider);
    await expect(narration.narrate(options(record.id))).rejects.toBeInstanceOf(
      NarrationPausedError,
    );
    expect(narration.checkpoint(record.id, "announcement:1")?.status).toBe("pending");
    repo.updateGame(record.id, { status: "running" });
    expect(await narration.narrate(options(record.id))).toBe("The moderator pauses the scene.");
    expect(calls).toBe(1);
  });

  it("honestly records unknown usage for timeout and external abort", async () => {
    const repo = repository();
    const record = game(repo);
    const provider: DecisionProvider = {
      decide: async (request) =>
        new Promise<never>((_resolve, reject) =>
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true,
          }),
        ),
    };
    const narration = new NarrationV2(repo, provider);
    await expect(
      narration.narrate({ ...options(record.id), decisionId: "timeout", timeoutMs: 5 }),
    ).rejects.toThrow(NarrationPausedError);
    expect(narration.store.attempts(record.id, "timeout")[0]?.status).toBe("unknown");
    const abort = new AbortController();
    abort.abort(new Error("operator abort"));
    await expect(
      narration.narrate({ ...options(record.id), decisionId: "abort", signal: abort.signal }),
    ).rejects.toThrow(NarrationPausedError);
    expect(narration.store.attempts(record.id, "abort")[0]?.status).toBe("unknown");
  });

  it("skips optional narration when the mandatory decision reserve cannot fit", async () => {
    const repo = repository();
    const record = game(repo);
    let calls = 0;
    const provider: DecisionProvider = {
      decide: async () => {
        calls += 1;
        throw new Error("paid call must not happen");
      },
    };
    const narration = new NarrationV2(repo, provider);
    expect(
      await narration.narrate({
        ...options(record.id),
        mandatoryRemaining: 1,
        mandatoryTokenReserve: 2_000_000,
      }),
    ).toBe("The day begins.");
    expect(calls).toBe(0);
    expect(narration.checkpoint(record.id, "announcement:1")?.status).toBe("skipped");
  });
});
