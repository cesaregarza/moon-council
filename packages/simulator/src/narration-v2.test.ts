import Anthropic from "@anthropic-ai/sdk";
import { GameConfigV2Schema } from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { createGameCreatedEvent, createGameState, STARTER_ROLES } from "@werewolf/engine";
import {
  AnthropicMessagesProvider,
  claudeReservationUsd,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
} from "@werewolf/llm";
import { estimatedTokens } from "./request-v2";
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

function game(repository: LabRepository, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
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

  it("stores a refusal's stop reason, details and serving model on the attempt", async () => {
    const repo = repository();
    const record = game(repo);
    const provider: DecisionProvider = {
      decide: async (request) => {
        request.onUsage?.(usage, metadata);
        request.onProviderMetadata?.({
          responseId: "msg_refused",
          model: "claude-haiku-5-5-served",
          stopReason: "refusal",
          stopDetails: { category: "cyber", explanation: "declined" },
          costUsd: 0.001,
        });
        throw new Error("Claude refused: cyber");
      },
    };
    const narration = new NarrationV2(repo, provider);
    await expect(
      narration.narrate({ ...options(record.id), decisionId: "refused" }),
    ).rejects.toThrow();
    expect(narration.store.attempts(record.id, "refused")[0]?.providerMetadata).toMatchObject({
      model: "claude-haiku-5-5-served",
      stopReason: "refusal",
      stopDetails: { category: "cyber" },
      costUsd: 0.001,
    });
  });

  it("reserves a repair at the size of the sanitized repair prompt it sends", async () => {
    async function probe(maxSpendUsd: number) {
      const repo = repository();
      const record = game(repo, { maxSpendUsd });
      let calls = 0;
      const provider: DecisionProvider = {
        decide: async () => {
          calls++;
          throw new Error("x".repeat(2_500));
        },
      };
      const narration = new NarrationV2(repo, provider);
      await narration
        .narrate({
          ...options(record.id),
          decisionId: "repair",
          model: "claude-opus-5-5",
          provider: "anthropic",
        })
        .catch(() => undefined);
      return { calls, attempts: narration.store.attempts(record.id, "repair") };
    }
    // Measure only the actual safe prompts in a generous synthetic fixture. The tight fixture
    // fits two first prompts, but refuses the larger correction while preserving the first hold.
    const measured = await probe(1);
    expect(measured.calls).toBe(2);
    const first = measured.attempts[0]!,
      repair = measured.attempts[1]!;
    expect(repair.request.input).not.toContain("x".repeat(20));
    expect(repair.reservedUsd!).toBeGreaterThan(first.reservedUsd!);
    const cap = first.reservedUsd! + (first.reservedUsd! + repair.reservedUsd!) / 2;
    expect(2 * first.reservedUsd!).toBeLessThan(cap);
    const tight = await probe(cap);
    expect(tight.calls).toBe(1);
    expect(tight.attempts[0]?.reservedUsd).toBe(first.reservedUsd);
  });

  it("skips optional narration when the game refuses its exact Claude reservation", async () => {
    // The provider admits its exact reservation before sending (CES-1556); a refusal skips the
    // optional announcement instead of ending the game.
    const repo = repository();
    const record = game(repo, { maxSpendUsd: 0.025 });
    let sent = 0;
    const provider: DecisionProvider = {
      decide: async (request) => {
        (request as { admitSpend?: (usd: number) => void }).admitSpend?.(1);
        sent += 1;
        return {
          data: { text: "Sent anyway." },
          provider: "anthropic",
          model: "m",
          usage: {},
        } as never;
      },
    };
    const narration = new NarrationV2(repo, provider);
    const text = await narration.narrate({
      ...options(record.id),
      decisionId: "refused",
      model: "claude-haiku-5-5",
      provider: "anthropic",
    });
    expect(text).toBe("The day begins.");
    expect(sent).toBe(0);
    expect(narration.checkpoint(record.id, "refused")?.status).toBe("skipped");
  });

  it("reserves narration from the stored request's own serialized envelope", async () => {
    // halcyon's metric note: separate prompt and schema estimates missed the combined record's
    // JSON envelope by nine bytes. The reservation is sized from the request as stored.
    const repo = repository();
    const record = game(repo, { maxSpendUsd: 5 });
    const provider: DecisionProvider = {
      decide: async () => {
        throw new Error("x".repeat(2_000));
      },
    };
    const narration = new NarrationV2(repo, provider);
    await narration
      .narrate({
        ...options(record.id),
        decisionId: "sized",
        model: "claude-opus-5-5",
        provider: "anthropic",
      })
      .catch(() => undefined);
    for (const attempt of narration.store.attempts(record.id, "sized"))
      expect((attempt as { reservedUsd?: number }).reservedUsd).toBeCloseTo(
        claudeReservationUsd("claude-opus-5-5", 3 * estimatedTokens(attempt.request), 300),
        12,
      );
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

it.each([undefined, "anthropic"] as const)(
  "keeps SDK HTTP error-body content out of narration errors, events and correction prompts (provider=%s)",
  async (provider) => {
    const repo = repository();
    const record = game(repo, { maxSpendUsd: 5 });
    const marker = "synthetic-private-narration-error-marker";
    const requests: string[] = [];
    const client = new Anthropic({
      apiKey: "fake-anthropic-key-for-tests",
      fetch: async (_input, init) => {
        if (typeof init?.body !== "string")
          throw new Error("Expected a serialized synthetic request");
        requests.push(init.body);
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: marker },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    const narration = new NarrationV2(
      repo,
      new AnthropicMessagesProvider({
        client,
        ledger: { reserve: () => undefined, settle: () => undefined },
      }),
    );
    await expect(
      narration.narrate({
        ...options(record.id),
        provider,
        model: "claude-haiku-5-5",
        decisionId: "private-http-error",
      }),
    ).rejects.toThrow("no announcement fabricated");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain(marker);
    expect(
      JSON.stringify(
        narration.store.attempts(record.id, "private-http-error").map((attempt) => attempt.error),
      ),
    ).not.toContain(marker);
    expect(
      JSON.stringify(
        repo
          .listEvents(record.id)
          .filter((event) => event.type === "decision.attempt_failed")
          .map((event) => event.payload),
      ),
    ).not.toContain(marker);
    expect(narration.checkpoint(record.id, "private-http-error")?.error).not.toContain(marker);
  },
);

it.each([false, true])(
  "reuses safe narration feedback and suppresses legacy text on restart (legacy=%s)",
  async (legacy) => {
    const repo = repository();
    const record = game(repo, { maxSpendUsd: 5 });
    const decisionId = "safe-restart-correction";
    const marker = "synthetic-private-legacy-narration-marker";
    const prompts: string[] = [];
    let calls = 0;
    const provider: DecisionProvider = {
      async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
        prompts.push(request.preparedPrompt!.input);
        calls++;
        if (calls === 1) {
          repo.updateGame(record.id, { status: "paused" });
          request.schema.parse({ text: "x".repeat(801) });
          throw new Error("unreachable narration schema control");
        }
        return {
          data: request.schema.parse({ text: "The village awaits dawn." }),
          provider: "anthropic",
          model: request.model,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const narration = new NarrationV2(repo, provider);
    const input = {
      ...options(record.id),
      decisionId,
      provider: "anthropic",
      model: "claude-haiku-5-5",
    };
    await expect(narration.narrate(input)).rejects.toThrow("narration paused after failed attempt");
    const checkpoint = narration.checkpoint(record.id, decisionId)!;
    const attempt = narration.store.attempts(record.id, decisionId)[0]!;
    expect(attempt.error).toContain("text: must contain at most 800 characters");
    // Model the checkpoint between one recorded failure and its repair, using synthetic memory only.
    if (legacy) {
      attempt.error = marker;
      attempt.providerMetadata = {};
      narration.store.updateAttempt(attempt);
      checkpoint.error = marker;
    }
    narration.store.put(record.id, `narration:${decisionId}`, { ...checkpoint, status: "open" });
    repo.updateGame(record.id, { status: "running" });
    await expect(narration.narrate(input)).resolves.toBe("The village awaits dawn.");
    const correction = JSON.parse(prompts[1]!).correctionRequired as string;
    expect(correction).not.toContain(marker);
    if (!legacy) expect(correction).toContain("text: must contain at most 800 characters");
    expect(calls).toBe(2);
  },
);

function successfulNarration(): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "synthetic_narration",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: '{"text":"A synthetic dawn."}' },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe.each([undefined, "anthropic"] as const)(
  "round2 independent narration default %s",
  (providerName) => {
    it("does not persist an abort reason before provider usage metadata arrives", async () => {
      const repo = repository();
      const record = game(repo, { maxSpendUsd: 5 });
      const marker = "SYNTHETIC_PRIVATE_ABORT_REASON_83";
      const outer = new AbortController();
      let sends = 0;
      let finished!: () => void;
      const completed = new Promise<void>((resolve) => {
        finished = resolve;
      });
      const client = new Anthropic({
        apiKey: "fake-anthropic-key-for-tests",
        fetch: async (_input, init) => {
          sends++;
          const pending = new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error("synthetic fetch needs abort signal");
            const abort = () => reject(new DOMException("synthetic fetch abort", "AbortError"));
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
          queueMicrotask(() => outer.abort(new Error(marker)));
          return await pending;
        },
      });
      const actual = new AnthropicMessagesProvider({
        client,
        ledger: { reserve() {}, settle() {} },
      });
      const traced: DecisionProvider = {
        async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
          try {
            return await actual.decide(request);
          } finally {
            finished();
          }
        },
      };
      const narration = new NarrationV2(repo, traced);
      const decisionId = "synthetic-abort-default";
      await expect(
        narration.narrate({
          ...options(record.id),
          decisionId,
          provider: providerName,
          model: "claude-haiku-5-5",
          signal: outer.signal,
          timeoutMs: 1000,
        }),
      ).rejects.toThrow("no announcement fabricated");
      await completed;
      expect(sends).toBe(1);
      const attempts = narration.store.attempts(record.id, decisionId);
      const failures = repo
        .listEvents(record.id)
        .filter((e) => e.type === "decision.attempt_failed");
      const leaks = {
        attemptError: JSON.stringify(attempts.map((a) => a.error)).includes(marker),
        failureEvent: JSON.stringify(failures.map((e) => e.payload)).includes(marker),
        checkpointError: String(narration.checkpoint(record.id, decisionId)?.error).includes(
          marker,
        ),
      };
      expect(leaks).toEqual({ attemptError: false, failureEvent: false, checkpointError: false });
    });

    it("does not replay legacy text when the stored provider is unknown", async () => {
      const repo = repository();
      const record = game(repo, { maxSpendUsd: 5 });
      const marker = "SYNTHETIC_UNKNOWN_PROVIDER_LEGACY_84";
      const requests: string[] = [];
      const client = new Anthropic({
        apiKey: "fake-anthropic-key-for-tests",
        fetch: async (_input, init) => {
          if (typeof init?.body !== "string") throw new Error("synthetic request body missing");
          requests.push(init.body);
          return successfulNarration();
        },
      });
      const narration = new NarrationV2(
        repo,
        new AnthropicMessagesProvider({
          client,
          ledger: { reserve() {}, settle() {} },
        }),
      );
      const decisionId = "synthetic-legacy-unknown";
      const input = {
        ...options(record.id),
        decisionId,
        provider: providerName,
        model: "claude-haiku-5-5",
      };
      const basePrompt = {
        instructions: "Synthetic instructions.",
        input: JSON.stringify({ disclosurePacket: input.disclosurePacket }),
      };
      narration.store.put(record.id, `narration:${decisionId}`, {
        schemaVersion: "moderator_narration_v2",
        decisionId,
        recovery: 0,
        status: "open",
        best: null,
        basePrompt,
        lastPrompt: basePrompt,
        error: marker,
      });
      const prior = narration.store.beginAttempt(
        {
          id: decisionId,
          gameId: record.id,
          playerId: "moderator",
          phase: input.phase,
          day: input.day,
          recovery: 0,
        },
        {
          provider: "unknown",
          reasoningEffort: "none",
          model: "claude-haiku-5-5",
          optional: true,
          reservedUsd: 0.001,
          maxOutputTokens: 300,
          request: { ...basePrompt, schema: {} },
        },
      );
      prior.status = "invalid";
      prior.error = marker;
      prior.endedAt = new Date().toISOString();
      narration.store.updateAttempt(prior);
      await expect(narration.narrate(input)).resolves.toBe("A synthetic dawn.");
      expect(requests).toHaveLength(1);
      expect(requests.some((body) => body.includes(marker))).toBe(false);
    });
  },
);

it.each([undefined, "unknown", "fake", "anthropic"] as const)(
  "admits no Claude narration send above the game cap when provider=%s",
  async (providerName) => {
    const repo = repository();
    const record = game(repo, { maxSpendUsd: 0.00001 });
    let sends = 0;
    const reserved: number[] = [];
    const settled: number[] = [];
    const client = new Anthropic({
      apiKey: "fake-anthropic-key-for-tests",
      fetch: async () => {
        sends++;
        return successfulNarration();
      },
    });
    const narration = new NarrationV2(
      repo,
      new AnthropicMessagesProvider({
        client,
        ledger: {
          reserve(_id, usd) {
            reserved.push(usd);
          },
          settle(_id, usd) {
            settled.push(usd);
          },
        },
      }),
    );
    await narration
      .narrate({
        ...options(record.id),
        provider: providerName,
        model: "claude-haiku-5-5",
        decisionId: "synthetic-small-game-cap",
      })
      .catch(() => undefined);
    // This fixture's actual synthetic response alone costs more than the entire game cap.
    const observed = {
      sends,
      reserved: reserved.length,
      settled: settled.length,
      actualChargeExceedsGameCap: settled.some((usd) => usd > 0.00001),
    };
    expect(observed).toEqual({
      sends: 0,
      reserved: 0,
      settled: 0,
      actualChargeExceedsGameCap: false,
    });
  },
);

it.each([undefined, 0.02])(
  "retains unknown-route history or fails closed before another Claude send (reserved=%s)",
  async (reservedUsd) => {
    const repo = repository();
    const record = game(repo, { maxSpendUsd: 0.01 });
    let sends = 0;
    let reservations = 0;
    const client = new Anthropic({
      apiKey: "fake-anthropic-key-for-tests",
      fetch: async () => {
        sends++;
        return successfulNarration();
      },
    });
    const narration = new NarrationV2(
      repo,
      new AnthropicMessagesProvider({
        client,
        ledger: {
          reserve() {
            reservations++;
          },
          settle() {},
        },
      }),
    );
    const prior = narration.store.beginAttempt(
      {
        id: "legacy-unknown-route",
        gameId: record.id,
        playerId: "moderator",
        phase: "day_announcement",
        day: 1,
        recovery: 0,
      },
      {
        provider: "unknown",
        reasoningEffort: "none",
        model: "claude-haiku-5-5",
        optional: true,
        reservedUsd,
        maxOutputTokens: 300,
        request: { instructions: "Synthetic legacy instructions.", input: "{}", schema: {} },
      },
    );
    prior.status = "unknown";
    prior.endedAt = new Date().toISOString();
    narration.store.updateAttempt(prior);
    await expect(
      narration.narrate({
        ...options(record.id),
        model: "claude-haiku-5-5",
        decisionId: "after-unknown-route",
      }),
    ).resolves.toBe("The day begins.");
    expect(sends).toBe(0);
    expect(reservations).toBe(0);
    expect(narration.store.attempts(record.id, "legacy-unknown-route")[0]?.reservedUsd).toBe(
      reservedUsd,
    );
    expect(narration.checkpoint(record.id, "after-unknown-route")?.best).toBeNull();
    expect(narration.checkpoint(record.id, "after-unknown-route")?.status).toBe("skipped");
  },
);

it("keeps the pre-send Claude identity when late usage metadata omits it", async () => {
  const repo = repository();
  const record = game(repo, { maxSpendUsd: 5 });
  const client = new Anthropic({
    apiKey: "fake-anthropic-key-for-tests",
    fetch: async () => successfulNarration(),
  });
  const actual = new AnthropicMessagesProvider({
    client,
    ledger: { reserve() {}, settle() {} },
  });
  const wrapped: DecisionProvider = {
    decide: (request) =>
      actual.decide({
        ...request,
        onUsage: (received, metadata) =>
          request.onUsage?.(received, { ...metadata, provider: "unknown" }),
      }),
  };
  const narration = new NarrationV2(repo, wrapped);
  await expect(
    narration.narrate({
      ...options(record.id),
      model: "claude-haiku-5-5",
      decisionId: "late-unknown-route",
    }),
  ).resolves.toBe("A synthetic dawn.");
  expect(narration.store.attempts(record.id, "late-unknown-route")[0]?.provider).toBe("anthropic");
});
