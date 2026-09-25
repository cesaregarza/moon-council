import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import {
  DecisionReportV2Schema,
  providerJsonSchema,
  reportSchema,
  type PlayerContextV2,
  type UsageV2,
} from "@werewolf/contracts";
import { STARTER_ROLES } from "@werewolf/engine";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CodexLoginProvider } from "./codex";
import { FakeDecisionProvider } from "./fake";
import { OpenAIResponsesProvider } from "./openai";
import type { DecisionRequest } from "./provider";

const answerSchema = z.object({ answer: z.string() });

function request<T>(
  schema: z.ZodType<T>,
  overrides: Partial<DecisionRequest<T>> = {},
): DecisionRequest<T> {
  return {
    kind: "decision_v2",
    model: "gpt-test",
    schemaName: "test_report",
    schema,
    maxOutputTokens: 200,
    ...overrides,
  };
}

function installOpenAiCreate(provider: OpenAIResponsesProvider, create: unknown): void {
  (provider as unknown as { client: unknown }).client = { responses: { create } };
}

function context(overrides: Partial<PlayerContextV2> = {}): PlayerContextV2 {
  return {
    schemaVersion: "player_context_v2",
    phase: "day_vote",
    day: 1,
    self: {
      id: "p1",
      name: "Player 1",
      role: structuredClone(STARTER_ROLES.find((role) => role.id === "villager")!),
    },
    players: [
      { id: "p1", name: "Player 1", alive: true },
      { id: "p2", name: "Player 2", alive: true },
      { id: "p3", name: "Player 3", alive: true },
    ],
    knownAllies: [],
    rules: {},
    sources: [],
    legalActions: [],
    legalTargets: ["p2", "p3"],
    journal: {
      schemaVersion: "journal_v2",
      version: 2,
      beliefs: [],
      hypotheses: [],
      strategy: "Compare claims.",
      goals: ["Find the wolves."],
      unresolvedQuestions: [],
      deceptionPlan: null,
    },
    responseDocket: [],
    closing: false,
    ...overrides,
  };
}

function assertStrictJsonSchema(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) assertStrictJsonSchema(child);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  expect(node).not.toHaveProperty("oneOf");
  if (node.type === "object" && node.properties && typeof node.properties === "object") {
    expect(node.additionalProperties).toBe(false);
    expect(new Set(node.required as string[])).toEqual(
      new Set(Object.keys(node.properties as Record<string, unknown>)),
    );
  }
  for (const child of Object.values(node)) assertStrictJsonSchema(child);
}

describe("V2 provider contracts", () => {
  it("disables invisible OpenAI SDK retries", () => {
    const provider = new OpenAIResponsesProvider("test-key");
    expect((provider as unknown as { client: { maxRetries: number } }).client.maxRetries).toBe(0);
  });
  it("serializes each prepared prompt independently without conversation state", async () => {
    const bodies: ResponseCreateParamsNonStreaming[] = [];
    const create = vi.fn(async (body: ResponseCreateParamsNonStreaming) => {
      bodies.push(body);
      return {
        status: "completed",
        output_text: JSON.stringify({ answer: "ok" }),
        usage: null,
      } as never;
    });
    const provider = new OpenAIResponsesProvider("test-key");
    installOpenAiCreate(provider, create);

    await provider.decide(
      request(answerSchema, { preparedPrompt: { instructions: "frozen-a", input: "packet-a" } }),
    );
    await provider.decide(
      request(answerSchema, { preparedPrompt: { instructions: "frozen-b", input: "packet-b" } }),
    );

    expect(bodies.map((body) => [body.instructions, body.input])).toEqual([
      ["frozen-a", "packet-a"],
      ["frozen-b", "packet-b"],
    ]);
    expect(bodies.every((body) => body.store === false)).toBe(true);
    expect(bodies[0]).not.toHaveProperty("previous_response_id");
    expect(bodies[0]).not.toHaveProperty("conversation");
  });

  it("places cache breakpoints after the game prefix and stable decision context for GPT-5.6", async () => {
    const bodies: ResponseCreateParamsNonStreaming[] = [];
    const provider = new OpenAIResponsesProvider("test-key");
    installOpenAiCreate(
      provider,
      vi.fn(async (body: ResponseCreateParamsNonStreaming) => {
        bodies.push(body);
        return { status: "completed", output_text: '{"answer":"ok"}', usage: null } as never;
      }),
    );
    await provider.decide(
      request(answerSchema, {
        model: "gpt-5.6-luna",
        preparedPrompt: {
          instructions: "stable rules",
          sharedInput: "stable player context",
          input: "changing episode suffix",
          cache: { mode: "explicit", ttl: "30m", stablePrefix: "werewolf-player-v2.2" },
        },
      }),
    );
    expect(bodies[0]).toMatchObject({
      store: false,
      prompt_cache_key: "werewolf-player-v2.2",
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "stable rules",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "stable player context",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
        { role: "user", content: [{ type: "input_text", text: "changing episode suffix" }] },
      ],
    });
    expect(bodies[0]).not.toHaveProperty("instructions");
  });

  it("places V3.1 public state before private state and the changing task suffix", async () => {
    const bodies: ResponseCreateParamsNonStreaming[] = [];
    const provider = new OpenAIResponsesProvider("test-key");
    installOpenAiCreate(
      provider,
      vi.fn(async (body: ResponseCreateParamsNonStreaming) => {
        bodies.push(body);
        return { status: "completed", output_text: '{"answer":"ok"}', usage: null } as never;
      }),
    );
    await provider.decide(
      request(answerSchema, {
        kind: "decision_v3_1",
        model: "gpt-5.6-luna",
        preparedPrompt: {
          instructions: "L0 rules",
          publicInput: "L1 public",
          privateInput: "L2 private",
          input: "L3 task",
          cache: {
            mode: "explicit",
            ttl: "30m",
            stablePrefix: "werewolf-player-v3.1:abc",
            boundary: "public",
          },
        },
      }),
    );
    expect(bodies[0]).toMatchObject({
      prompt_cache_key: "werewolf-player-v3.1:abc",
      input: [
        {
          role: "developer",
          content: [
            { type: "input_text", text: "L0 rules", prompt_cache_breakpoint: { mode: "explicit" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "L1 public",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
        { role: "user", content: [{ type: "input_text", text: "L2 private" }] },
        { role: "user", content: [{ type: "input_text", text: "L3 task" }] },
      ],
    });
  });

  it("emits a strict JSON-compatible report schema", () => {
    for (const kind of ["discussion", "night_action", "team_point", "vote", "pass"] as const)
      for (const commitOnly of [false, true])
        assertStrictJsonSchema(
          z.toJSONSchema(reportSchema(kind, commitOnly), { target: "draft-7" }),
        );
    const schema = z.toJSONSchema(reportSchema("discussion", true), { target: "draft-7" });
    assertStrictJsonSchema(schema);
    expect(schema).toMatchObject({ type: "object", properties: { proposal: { type: "object" } } });
    expect(DecisionReportV2Schema.safeParse({}).success).toBe(false);
  });
  it("keeps the provider schema stable when delivered citation IDs change", async () => {
    const first = context({
      sources: [
        {
          id: "known-source",
          type: "speech.public",
          day: 1,
          scope: "public",
          data: { text: "a claim" },
        },
      ],
    });
    const second = context({
      sources: [
        {
          id: "different-source",
          type: "speech.public",
          day: 1,
          scope: "public",
          data: { text: "another claim" },
        },
      ],
    });
    const firstSchema = reportSchema("vote", true, first),
      secondSchema = reportSchema("vote", true, second);
    assertStrictJsonSchema(providerJsonSchema(firstSchema));
    expect(providerJsonSchema(firstSchema)).toEqual(providerJsonSchema(secondSchema));
    const fake = await new FakeDecisionProvider().decide(
      request(firstSchema, { contextV2: first, proposalKind: "vote", commitOnly: true }),
    );
    // Domain validation, rather than a repeated enum in the provider schema, rejects this later.
    expect(firstSchema.safeParse({ ...fake.data, observations: ["not-delivered"] }).success).toBe(
      true,
    );
    // Stable identifier syntax prevents a model from placing explanatory prose in a citation slot.
    expect(
      firstSchema.safeParse({
        ...fake.data,
        observations: ["This is an inference, not a source ID."],
      }).success,
    ).toBe(false);
  });

  it("reports usage before rejecting malformed output", async () => {
    const create = vi.fn(
      async () =>
        ({
          status: "completed",
          output_text: "{malformed",
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            total_tokens: 18,
            input_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        }) as never,
    );
    const provider = new OpenAIResponsesProvider("test-key");
    installOpenAiCreate(provider, create);
    let parsingStarted = false;
    const usages: UsageV2[] = [];
    const responses: string[] = [];

    await expect(
      provider.decide(
        request(answerSchema, {
          onUsage: (usage) => {
            expect(parsingStarted).toBe(false);
            usages.push(usage);
          },
          onRawResponse: (response) => responses.push(response),
        }),
      ),
    ).rejects.toThrow();
    parsingStarted = true;

    expect(usages).toEqual([
      {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        cachedInputTokens: 3,
        cacheWriteInputTokens: 4,
        reasoningTokens: 2,
      },
    ]);
    expect(responses).toEqual(["{malformed"]);
  });

  it("reports unknown usage once when OpenAI times out", async () => {
    const create = vi.fn(
      async (_body: unknown, options: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const provider = new OpenAIResponsesProvider("test-key");
    installOpenAiCreate(provider, create);
    const usages: UsageV2[] = [];

    await expect(
      provider.decide(
        request(answerSchema, { timeoutMs: 5, onUsage: (usage) => usages.push(usage) }),
      ),
    ).rejects.toThrow("OpenAI decision timed out after 5ms");
    expect(usages).toEqual([
      {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        reasoningTokens: null,
      },
    ]);
  });

  it("honors external OpenAI abort and reports unknown usage", async () => {
    const create = vi.fn(
      async (_body: unknown, options: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const provider = new OpenAIResponsesProvider("test-key");
    installOpenAiCreate(provider, create);
    const controller = new AbortController();
    const usages: UsageV2[] = [];
    const pending = provider.decide(
      request(answerSchema, { signal: controller.signal, onUsage: (usage) => usages.push(usage) }),
    );
    controller.abort();

    await expect(pending).rejects.toThrow("OpenAI decision aborted");
    expect(usages).toHaveLength(1);
    expect(usages[0]?.inputTokens).toBeNull();
  });

  it("honors Codex effort override and marks output limits unenforced", async () => {
    let threadEffort: string | undefined;
    const usages: UsageV2[] = [];
    const provider = new CodexLoginProvider({
      environment: { HOME: "/safe-home", PATH: "/usr/bin" },
      createClient: () => ({
        startThread: (options) => {
          threadEffort = options?.modelReasoningEffort;
          return {
            run: async () => ({ finalResponse: JSON.stringify({ answer: "ok" }), usage: null }),
          };
        },
      }),
    });

    await provider.decide(
      request(answerSchema, {
        reasoningEffort: "high",
        onUsage: (usage, metadata) => {
          usages.push(usage);
          expect(metadata.outputLimitEnforced).toBe(false);
        },
      }),
    );

    expect(threadEffort).toBe("high");
    expect(usages).toEqual([
      {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        reasoningTokens: null,
      },
    ]);
  });

  it("uses separate Codex threads for concurrent isolated player decisions", async () => {
    let started = 0,
      active = 0,
      maxActive = 0;
    const workingDirectories: string[] = [];
    const provider = new CodexLoginProvider({
      createClient: () => ({
        startThread: (options) => {
          started += 1;
          workingDirectories.push(options?.workingDirectory ?? "");
          return {
            run: async () => {
              active += 1;
              maxActive = Math.max(maxActive, active);
              await new Promise((resolve) => setTimeout(resolve, 5));
              active -= 1;
              return { finalResponse: '{"answer":"ok"}', usage: null };
            },
          };
        },
      }),
    });
    await Promise.all([
      provider.decide(
        request(answerSchema, {
          playerId: "p1",
          preparedPrompt: { instructions: "shared stable prefix", input: "private packet one" },
        }),
      ),
      provider.decide(
        request(answerSchema, {
          playerId: "p2",
          preparedPrompt: { instructions: "shared stable prefix", input: "private packet two" },
        }),
      ),
    ]);
    expect(started).toBe(2);
    expect(maxActive).toBe(2);
    expect(new Set(workingDirectories).size).toBe(2);
  });

  it("reuses one isolated Codex thread within an episode and appends only the changing suffix", async () => {
    let started = 0;
    const inputs: string[] = [];
    const provider = new CodexLoginProvider({
      createClient: () => ({
        startThread: () => {
          started += 1;
          return {
            run: async (input) => {
              inputs.push(input);
              return { finalResponse: '{"answer":"ok"}', usage: null };
            },
          };
        },
      }),
    });
    const preparedPrompt = {
      instructions: "game prefix",
      sharedInput: "stable decision context",
      input: "suffix one",
    };
    await provider.decide(request(answerSchema, { sessionKey: "game:decision:0", preparedPrompt }));
    await provider.decide(
      request(answerSchema, {
        sessionKey: "game:decision:0",
        preparedPrompt: { ...preparedPrompt, input: "suffix two" },
      }),
    );
    expect(started).toBe(1);
    expect(inputs).toEqual(["stable decision context\nsuffix one", "suffix two"]);
    await provider.releaseSession("game:decision:0");
    await provider.decide(request(answerSchema, { sessionKey: "game:decision:0", preparedPrompt }));
    expect(started).toBe(2);
    await provider.releaseSession("game:decision:0");
  });

  it("emits unknown usage on Codex external abort", async () => {
    const controller = new AbortController();
    const usages: UsageV2[] = [];
    const provider = new CodexLoginProvider({
      createClient: () => ({
        startThread: () => ({
          run: (_input, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            }),
        }),
      }),
    });
    const pending = provider.decide(
      request(answerSchema, { signal: controller.signal, onUsage: (usage) => usages.push(usage) }),
    );
    controller.abort();

    await expect(pending).rejects.toThrow("Codex decision aborted");
    expect(usages).toHaveLength(1);
    expect(usages[0]?.totalTokens).toBeNull();
  });

  it("makes an informationless fake vote a uniform proposal rather than a failure fallback", async () => {
    const usages: UsageV2[] = [];
    const result = await new FakeDecisionProvider().decide(
      request(reportSchema("vote"), {
        contextV2: context(),
        proposalKind: "vote",
        onUsage: (usage) => usages.push(usage),
      }),
    );

    expect(result.data.proposal).toEqual({
      kind: "vote",
      targets: { mode: "uniform", playerIds: ["p2", "p3"] },
    });
    expect(result.data.proposal.kind).not.toBe("pass");
    expect(result.data.observations).toEqual([]);
    expect(usages).toHaveLength(1);
  });
});
