import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AnthropicMessagesProvider,
  ClaudeRefusalError,
  claudeRequest,
  claudeResponseCostUsd,
  claudeUsage,
  type ClaudeClient,
} from "./anthropic";
import { claudeCostUsd, claudeReservationUsd, UnpricedModelError } from "./anthropic-pricing";
import type { DecisionRequest } from "./provider";
import { ClaudeSpendLedger, SpendLimitError } from "./spend-ledger";

const directories: string[] = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});
function ledger(limitUsd = 200, now = () => new Date("2026-10-22T12:00:00Z")) {
  const directory = mkdtempSync(join(tmpdir(), "claude-ledger-"));
  directories.push(directory);
  return new ClaudeSpendLedger(join(directory, "spend.json"), limitUsd, now);
}

const usage = (fields: Partial<Anthropic.Usage> = {}): Anthropic.Usage =>
  ({
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    ...fields,
  }) as Anthropic.Usage;

function message(fields: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: '{"choice":"a"}', citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: usage(),
    ...fields,
  } as Anthropic.Message;
}

/** A scripted SDK client: records every body and returns the next scripted message. */
function fakeClient(replies: Anthropic.Message[]) {
  const bodies: Anthropic.MessageStreamParams[] = [];
  const client: ClaudeClient = {
    messages: {
      stream(body) {
        bodies.push(body);
        const reply = replies.shift();
        return {
          on: () => undefined,
          finalMessage: async () => {
            if (!reply) throw new Error("no scripted reply");
            return reply as never;
          },
          abort: () => undefined,
        };
      },
    },
  };
  return { client, bodies };
}

// Deliberately not key-shaped, so the history secret scan never matches a test fixture.
const FAKE_API_KEY = "fake-anthropic-key-for-tests";
function request(fields: Partial<DecisionRequest<{ choice: string }>> = {}) {
  return {
    kind: "decision_v3_1",
    model: "claude-haiku-5-5",
    schemaName: "choice",
    schema: z.object({ choice: z.string() }),
    maxOutputTokens: 4_000,
    reasoningEffort: "high",
    preparedPrompt: {
      instructions: "Act as the player.",
      publicInput: '{"public":1}',
      privateInput: '{"private":2}',
      input: '{"task":3}',
    },
    ...fields,
  } as DecisionRequest<{ choice: string }>;
}

describe("Claude request rules", () => {
  it("uses adaptive thinking, explicit effort and structured output, with no sampling or prefill", () => {
    const body = claudeRequest(request({ reasoningEffort: undefined }), 16_000);
    expect(body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 4_000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema" } },
    });
    for (const key of ["temperature", "top_p", "top_k", "tool_choice", "tools", "fallbacks"])
      expect(body).not.toHaveProperty(key);
    expect(body.messages.map((m) => m.role)).toEqual(["user"]);
    expect(claudeRequest(request({ maxOutputTokens: null }), 12_345).max_tokens).toBe(12_345);
  });

  it("places 5-minute breakpoints only at the end of l0 and l1, never on private content", () => {
    const body = claudeRequest(
      request({
        preparedPrompt: {
          instructions: "L0",
          publicInput: "L1",
          sharedInput: "SHARED",
          privateInput: "L2",
          input: "L3",
        },
      }),
      16_000,
    );
    const marker = { type: "ephemeral", ttl: "5m" };
    expect(body.system).toEqual([{ type: "text", text: "L0", cache_control: marker }]);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "L1", cache_control: marker },
          { type: "text", text: "SHARED" },
          { type: "text", text: "L2" },
          { type: "text", text: "L3" },
        ],
      },
    ]);
  });

  it("uses the API response format's schema and instructions when set", () => {
    const wire = z.object({ envelope: z.string() });
    const body = claudeRequest(
      request({
        apiResponseFormat: {
          name: "envelope",
          schema: wire,
          instructions: "Return the envelope.",
          decode: (value) => value,
        },
      }),
      16_000,
    );
    expect(JSON.stringify(body.output_config?.format)).toContain('"envelope"');
    expect(JSON.stringify(body.output_config?.format)).not.toContain('"choice"');
    expect(body.system).toMatchObject([{ text: "Act as the player.\n\nReturn the envelope." }]);
  });

  // Scope: #20 replays text only. Replaying thinking blocks needs the recorded-usage ceiling only
  // a session harness has (CES-1556, PR #21); thinking in a reply is still returned in full.
  it("sends a text-only harness request unchanged and returns the full reply, thinking included", async () => {
    const harness = {
      system: [
        { type: "text" as const, text: "frozen", cache_control: { type: "ephemeral" as const } },
      ],
      messages: [
        { role: "user" as const, content: "turn 1" },
        {
          role: "assistant" as const,
          // Text only: replaying thinking blocks needs a recorded-usage ceiling (CES-1556).
          content: [{ type: "text" as const, text: '{"choice":"b"}' }],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "turn 2" }] },
      ],
    };
    const snapshot = JSON.stringify(harness);
    const content = [
      { type: "thinking", thinking: "", signature: "sig-2" },
      { type: "text", text: '{"choice":"a"}', citations: null },
    ] as Anthropic.ContentBlock[];
    const { client, bodies } = fakeClient([message({ content })]);
    const result = await new AnthropicMessagesProvider({ client, ledger: ledger() }).decide(
      request({ claudeHarness: harness }),
    );
    expect(bodies[0]).toMatchObject({ system: harness.system, messages: harness.messages });
    expect(JSON.stringify({ system: bodies[0]!.system, messages: bodies[0]!.messages })).toBe(
      snapshot,
    );
    expect(result.content).toEqual(content);
    expect(result.data).toEqual({ choice: "a" });
  });

  it("strips schema keywords structured outputs reject, keeping the rest", () => {
    const bounded = z.object({ n: z.number().min(0).max(1), s: z.string().max(5) });
    const body = claudeRequest(
      { ...request(), schema: bounded } as DecisionRequest<unknown>,
      16_000,
    );
    const text = JSON.stringify(body.output_config);
    expect(text).not.toMatch(/"(minimum|maximum|maxLength)"/);
    expect(text).toContain('"additionalProperties":false');
  });

  it("never puts the API key in the recorded request body", async () => {
    const { client } = fakeClient([message()]);
    const recorded: Record<string, unknown>[] = [];
    await new AnthropicMessagesProvider({ client, ledger: ledger(), apiKey: FAKE_API_KEY }).decide(
      request({ onProviderRequest: (body) => recorded.push(body) }),
    );
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded)).not.toContain(FAKE_API_KEY);
  });
});

describe("Claude usage and cost", () => {
  it("maps input to include cache reads and writes", () => {
    expect(
      claudeUsage(
        usage({
          input_tokens: 100,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 600,
          output_tokens: 50,
          output_tokens_details: { thinking_tokens: 20 } as Anthropic.OutputTokensDetails,
        }),
      ),
    ).toEqual({
      inputTokens: 1_000,
      outputTokens: 50,
      totalTokens: 1_050,
      cachedInputTokens: 600,
      cacheWriteInputTokens: 300,
      reasoningTokens: 20,
    });
  });

  it("prices 5-minute and 1-hour writes, reads and output", () => {
    // Opus 5.5: $4 in, $5 5m write, $8 1h write, $0.20 read, $20 out (per million).
    const cost = claudeResponseCostUsd(
      "claude-opus-5-5",
      usage({
        input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000_000,
          ephemeral_1h_input_tokens: 1_000_000,
        },
        output_tokens: 1_000_000,
      }),
    );
    expect(cost).toBeCloseTo(4 + 0.2 + 5 + 8 + 20);
  });

  it("switches Haiku 5.5 to its higher rates above 100K prompt tokens, counting cache", () => {
    const at = (uncachedInput: number, cacheRead: number) =>
      claudeCostUsd("claude-haiku-5-5", {
        uncachedInput,
        cacheRead,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 0,
      });
    expect(at(100_000, 0)).toBeCloseTo(0.01); // $0.10/M
    expect(at(50_000, 50_001)).toBeCloseTo((50_000 * 0.5 + 50_001 * 0.05) / 1e6);
    expect(claudeReservationUsd("claude-haiku-5-5", 200_000, 0)).toBeCloseTo(0.2); // $1/M 1h write
  });

  it("refuses an unpriced model before any request or reservation", async () => {
    const { client, bodies } = fakeClient([message()]);
    const book = ledger();
    await expect(
      new AnthropicMessagesProvider({ client, ledger: book }).decide(
        request({ model: "claude-unpriced-9" }),
      ),
    ).rejects.toBeInstanceOf(UnpricedModelError);
    expect(bodies).toHaveLength(0);
    expect(book.status()).toMatchObject({ settledUsd: 0, openReservations: 0 });
  });

  it("settles the monthly reservation to the actual cost", async () => {
    const { client } = fakeClient([message({ usage: usage({ input_tokens: 50_000 }) })]);
    const book = ledger();
    await new AnthropicMessagesProvider({ client, ledger: book }).decide(request());
    // 50K uncached Haiku input at $0.10/M plus 50 output tokens at $0.50/M (under 100K).
    expect(book.status().settledUsd).toBeCloseTo(0.005 + 50 * 0.5e-6, 8);
    expect(book.status().openReservations).toBe(0);
  });

  it("reserves against the prompt's byte length, so a long Haiku prompt is never under-reserved", async () => {
    // 60K three-byte characters: about 20K tokens by characters/3, but up to 180K tokens by bytes,
    // past Haiku's 100K threshold. Admitted, the scripted reply would settle above $200.
    const prompt = "\u20ac".repeat(60_000);
    const { client, bodies } = fakeClient([
      message({ usage: usage({ input_tokens: 120_000, output_tokens: 4_000 }) }),
    ]);
    const book = ledger();
    book.reserve("earlier", 199.965);
    book.settle("earlier", 199.965);
    const call = new AnthropicMessagesProvider({ client, ledger: book }).decide(
      request({ preparedPrompt: { instructions: "Act.", input: prompt } }),
    );
    await expect(call).rejects.toBeInstanceOf(SpendLimitError);
    expect(bodies).toHaveLength(0);
    expect(book.status().settledUsd).toBeLessThanOrEqual(200);
  });
});

describe("Claude raw response accounting", () => {
  // halcyon's adapter controls (PR #20, 05:35Z): the reply's raw usage is checked before it is
  // trusted, and an unreported TTL split never prices writes below what the request marked.
  const oneHourHarness = {
    system: [
      {
        type: "text" as const,
        text: "frozen",
        cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
      },
    ],
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "go" }] }],
  };

  it("prices writes of an unreported TTL split at the 1-hour rate the request marked", async () => {
    // 10K Opus writes + 50 output: $0.081 at 1 hour, $0.051 if assumed 5 minutes.
    const { client } = fakeClient([
      message({
        model: "claude-opus-5-5",
        usage: usage({
          input_tokens: 0,
          cache_creation_input_tokens: 10_000,
          cache_creation: null,
          output_tokens: 50,
        }),
      }),
    ]);
    const book = ledger();
    book.reserve("earlier", 199.7);
    book.settle("earlier", 199.7);
    const metadata: Record<string, unknown>[] = [];
    await new AnthropicMessagesProvider({ client, ledger: book }).decide(
      request({
        model: "claude-opus-5-5",
        claudeHarness: oneHourHarness,
        onProviderMetadata: (value) => metadata.push(value),
      }),
    );
    expect(metadata[0]?.costUsd).toBeCloseTo(0.081, 10);
    expect(book.status().settledUsd).toBeCloseTo(199.781, 10);
    expect(() => book.reserve("next", 0.23)).toThrow(SpendLimitError);
  });

  it("keeps the 5-minute rate for an unreported split when the request marked only 5 minutes", () => {
    const write = usage({
      input_tokens: 0,
      cache_creation_input_tokens: 10_000,
      cache_creation: null,
      output_tokens: 50,
    });
    const priced = claudeResponseCostUsd as (
      model: string,
      usage: Anthropic.Usage,
      marked?: Set<string>,
    ) => number | null;
    expect(priced("claude-opus-5-5", write, new Set(["5m"]))).toBeCloseTo(0.051, 10);
    expect(priced("claude-opus-5-5", write, new Set(["5m", "1h"]))).toBeCloseTo(0.081, 10);
    expect(priced("claude-opus-5-5", write)).toBeCloseTo(0.081, 10);
  });

  it("settles at the held reservation when raw usage holds a negative count", async () => {
    const { client, bodies } = fakeClient([
      message({ usage: usage({ input_tokens: 100, output_tokens: -100_000 }) }),
    ]);
    const book = ledger();
    book.reserve("earlier", 199.965);
    book.settle("earlier", 199.965);
    const metadata: Record<string, unknown>[] = [];
    await new AnthropicMessagesProvider({ client, ledger: book })
      .decide(request({ onProviderMetadata: (value) => metadata.push(value) }))
      .catch(() => undefined);
    const held = claudeReservationUsd(
      "claude-haiku-5-5",
      Buffer.byteLength(JSON.stringify(bodies[0]), "utf8"),
      bodies[0]!.max_tokens,
    );
    expect(book.status().settledUsd).toBeCloseTo(199.965 + held, 10);
    expect(metadata[0]).not.toHaveProperty("costUsd");
  });

  it("emits no trusted cost when any raw count is invalid", async () => {
    // halcyon's probe: 1,000 Opus input and output -1 computed a small positive cost that the
    // game trusted over its $0.08 held reservation.
    const { client } = fakeClient([
      message({
        model: "claude-opus-5-5",
        usage: usage({ input_tokens: 1_000, output_tokens: -1 }),
      }),
    ]);
    const metadata: Record<string, unknown>[] = [];
    await new AnthropicMessagesProvider({ client, ledger: ledger() })
      .decide(
        request({ model: "claude-opus-5-5", onProviderMetadata: (value) => metadata.push(value) }),
      )
      .catch(() => undefined);
    expect(metadata[0]).not.toHaveProperty("costUsd");
  });

  it("reserves against the exact serialized body sent, envelope included", async () => {
    const { client, bodies } = fakeClient([message()]);
    const reserved: number[] = [];
    const book = {
      reserve: (_id: string, usd: number) => reserved.push(usd),
      settle: () => undefined,
    };
    await new AnthropicMessagesProvider({ client, ledger: book }).decide(request());
    expect(reserved).toEqual([
      claudeReservationUsd(
        "claude-haiku-5-5",
        Buffer.byteLength(JSON.stringify(bodies[0]), "utf8"),
        bodies[0]!.max_tokens,
      ),
    ]);
  });
});

/**
 * Felix's Rule U (CES-1554 ruling f8b21c5e): raw usage is parsed once into a validated record,
 * and the trusted cost and the mapped usage both come from it. Malformed fields never become
 * a cost, a credit or plausible usage.
 */
describe("Claude usage validation (Rule U)", () => {
  const BAD: [string, unknown][] = [
    ["null", null],
    ["absent", undefined],
    ["true", true],
    ['"5"', "5"],
    ["1.5", 1.5],
    ["-1", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["2^53", 2 ** 53],
  ];
  /** A reply whose usage has `field` set to `value` (deleted when undefined). */
  const reply = (field: string, value: unknown, base: Partial<Anthropic.Usage> = {}) => {
    const raw = usage({ input_tokens: 1_000, output_tokens: 50, ...base }) as unknown as Record<
      string,
      unknown
    >;
    if (value === undefined) delete raw[field];
    else raw[field] = value;
    return message({ usage: raw as unknown as Anthropic.Usage });
  };
  /** Runs one call from $199.965 settled; a 47K output cap holds about $0.0236. */
  async function settleFrom(reply: Anthropic.Message) {
    const { client, bodies } = fakeClient([reply]);
    const book = ledger();
    book.reserve("earlier", 199.965);
    book.settle("earlier", 199.965);
    const metadata: Record<string, unknown>[] = [];
    const usages: unknown[] = [];
    await new AnthropicMessagesProvider({ client, ledger: book })
      .decide(
        request({
          maxOutputTokens: 47_000,
          onProviderMetadata: (value) => metadata.push(value),
          onUsage: (value) => usages.push(value),
        }),
      )
      .catch(() => undefined);
    const held = claudeReservationUsd(
      "claude-haiku-5-5",
      Buffer.byteLength(JSON.stringify(bodies[0]), "utf8"),
      bodies[0]!.max_tokens,
    );
    return { book, metadata, usage: usages[0], held };
  }

  for (const field of ["input_tokens", "output_tokens"])
    it.each(BAD)(
      `treats ${field} = %s as unknown usage, settling the held reservation`,
      async (_label, value) => {
        const { book, metadata, usage: mapped, held } = await settleFrom(reply(field, value));
        expect(metadata[0]).not.toHaveProperty("costUsd");
        expect(readFileSync(book.path, "utf8")).not.toContain("null");
        expect(book.status().settledUsd).toBeCloseTo(199.965 + held, 10);
        expect(() => book.reserve("next", 0.03)).toThrow(SpendLimitError);
        expect(mapped).toMatchObject({ inputTokens: null, outputTokens: null });
      },
    );

  it.each([
    ["null", null],
    ["absent", undefined],
  ])("trusts a cache count that is %s as zero", async (_label, value) => {
    for (const field of ["cache_read_input_tokens", "cache_creation_input_tokens"]) {
      const { metadata, usage: mapped } = await settleFrom(reply(field, value));
      // 1,000 Haiku input at $0.10/M plus 50 output at $0.50/M.
      expect(metadata[0]?.costUsd).toBeCloseTo(0.0001 + 0.000025, 12);
      expect(mapped).toMatchObject({ inputTokens: 1_000, outputTokens: 50 });
    }
  });

  it.each(BAD.filter(([label]) => !["null", "absent", "NaN", "Infinity"].includes(label)))(
    "treats a cache count of %s as unknown usage",
    async (_label, value) => {
      for (const field of ["cache_read_input_tokens", "cache_creation_input_tokens"]) {
        const { metadata, usage: mapped } = await settleFrom(reply(field, value));
        expect(metadata[0]).not.toHaveProperty("costUsd");
        expect(mapped).toMatchObject({ inputTokens: null, outputTokens: null });
      }
    },
  );

  const write = (split: unknown) =>
    ({
      ...usage({ input_tokens: 0, cache_creation_input_tokens: 10_000, output_tokens: 50 }),
      cache_creation: split,
    }) as unknown as Anthropic.Usage;
  const priced = claudeResponseCostUsd as (
    model: string,
    usage: Anthropic.Usage,
    marked?: Set<string>,
  ) => number | null;

  it.each([
    ["5m 10000, 1h null", { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: null }],
    ["5m null, 1h 10000", { ephemeral_5m_input_tokens: null, ephemeral_1h_input_tokens: 10_000 }],
    ["5m true, 1h 9999", { ephemeral_5m_input_tokens: true, ephemeral_1h_input_tokens: 9_999 }],
    ["a missing component", { ephemeral_5m_input_tokens: 10_000 }],
  ])("prices an incomplete split (%s) at the 1-hour marker rate", (_label, split) => {
    // halcyon's case: 10K Opus writes + 50 output are $0.081 at 1 hour, not $0.051.
    expect(priced("claude-opus-5-5", write(split), new Set(["1h"]))).toBeCloseTo(0.081, 10);
  });

  it("trusts a complete, valid split", () => {
    const split = { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 0 };
    expect(priced("claude-opus-5-5", write(split), new Set(["1h"]))).toBeCloseTo(0.051, 10);
  });

  it("records the largest safe count as a finite cost in a readable ledger", async () => {
    const { book } = await settleFrom(reply("output_tokens", Number.MAX_SAFE_INTEGER));
    expect(Number.isFinite(book.status().settledUsd)).toBe(true);
    expect(() => book.reserve("next", 0.01)).toThrow(SpendLimitError);
  });
});

/** Felix's ruling 497ec6b7: the output cap is a positive safe integer, from any source. */
describe("Claude output cap", () => {
  const INVALID = [
    ["-1", -1],
    ["0", 0],
    ["1.5", 1.5],
    ["NaN", Number.NaN],
    ["2^53", 2 ** 53],
  ] as const;

  it.each(INVALID)(
    "refuses a request cap of %s before any reservation or SDK call",
    async (_label, cap) => {
      const { client, bodies } = fakeClient([message()]);
      const book = ledger();
      await expect(
        new AnthropicMessagesProvider({ client, ledger: book }).decide(
          request({ maxOutputTokens: cap }),
        ),
      ).rejects.toThrow(/output cap/);
      expect(bodies).toHaveLength(0);
      expect(book.status()).toMatchObject({ settledUsd: 0, openReservations: 0 });
    },
  );

  it.each(INVALID)("refuses ANTHROPIC_MAX_OUTPUT_TOKENS=%s at construction", (_label, cap) => {
    const saved = process.env.ANTHROPIC_MAX_OUTPUT_TOKENS;
    process.env.ANTHROPIC_MAX_OUTPUT_TOKENS = String(cap);
    try {
      const { client } = fakeClient([]);
      expect(() => new AnthropicMessagesProvider({ client, ledger: ledger() })).toThrow(
        /ANTHROPIC_MAX_OUTPUT_TOKENS/,
      );
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_MAX_OUTPUT_TOKENS;
      else process.env.ANTHROPIC_MAX_OUTPUT_TOKENS = saved;
    }
  });

  it("keeps the default 16000 cap", async () => {
    const saved = process.env.ANTHROPIC_MAX_OUTPUT_TOKENS;
    process.env.ANTHROPIC_MAX_OUTPUT_TOKENS = "16000";
    try {
      const { client, bodies } = fakeClient([message()]);
      await new AnthropicMessagesProvider({ client, ledger: ledger() }).decide(
        request({ maxOutputTokens: null }),
      );
      expect(bodies[0]!.max_tokens).toBe(16_000);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_MAX_OUTPUT_TOKENS;
      else process.env.ANTHROPIC_MAX_OUTPUT_TOKENS = saved;
    }
  });
});

describe("Claude content admission", () => {
  it("refuses image and other non-text content before reserving or calling the SDK", async () => {
    // halcyon's probe: 100 URL images cost what the images are, not what their URLs serialize to.
    const images = Array.from({ length: 100 }, (_, i) => ({
      type: "image" as const,
      source: { type: "url" as const, url: `https://example.invalid/${i}.png` },
    }));
    const { client, bodies } = fakeClient([message()]);
    const book = ledger();
    book.reserve("earlier", 199.965);
    book.settle("earlier", 199.965);
    const call = new AnthropicMessagesProvider({ client, ledger: book }).decide(
      request({
        claudeHarness: {
          system: [{ type: "text", text: "frozen" }],
          messages: [{ role: "user", content: [{ type: "text", text: "look" }, ...images] }],
        } as never,
      }),
    );
    await expect(call).rejects.toMatchObject({ name: "UnboundedClaudeContentError" });
    expect(bodies).toHaveLength(0);
    expect(book.status()).toMatchObject({ settledUsd: 199.965, openReservations: 0 });
  });
});

describe("Claude session replay ceilings", () => {
  // A replayed thinking block's bytes (its signature) cannot bound its tokens; the recorded usage
  // of the previous turn (its prompt plus its reply) can (Felix, CES-1556 note on PR #20).
  const replay = (
    replayedTokens?: number,
    pending: unknown[] = [{ type: "text", text: "turn 2" }],
  ) =>
    ({
      system: [{ type: "text", text: "frozen" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "turn 1" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "sig-1" },
            { type: "text", text: '{"choice":"b"}' },
          ],
        },
        { role: "user", content: pending },
      ],
      ...(replayedTokens === undefined ? {} : { replayedTokens }),
    }) as never;

  it("sends a replayed thinking turn unchanged when its recorded usage bounds it", async () => {
    const { client, bodies } = fakeClient([message()]);
    await expect(
      new AnthropicMessagesProvider({ client, ledger: ledger() }).decide(
        request({ claudeHarness: replay(2_120) }),
      ),
    ).resolves.toMatchObject({ data: { choice: "a" } });
    expect(bodies).toHaveLength(1);
  });

  it("reserves the replayed history at its recorded tokens, not its bytes", async () => {
    // 150K recorded tokens put Haiku past its 100K threshold: well over the $0.035 left.
    const { client, bodies } = fakeClient([message()]);
    const book = ledger();
    book.reserve("earlier", 199.965);
    book.settle("earlier", 199.965);
    const call = new AnthropicMessagesProvider({ client, ledger: book }).decide(
      request({ claudeHarness: replay(150_000) }),
    );
    await expect(call).rejects.toBeInstanceOf(SpendLimitError);
    expect(bodies).toHaveLength(0);
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 53])(
    "reserves the whole body's byte ceiling when the replayed count is %s",
    async (replayedTokens) => {
      // halcyon's repro: a total of -1 would subtract from the ceiling. An invalid recorded count
      // is never added; the reservation falls back to the exact serialized body.
      const harness = {
        system: [{ type: "text", text: "frozen" }],
        messages: [
          { role: "user", content: [{ type: "text", text: "history ".repeat(25_000) }] },
          { role: "assistant", content: [{ type: "text", text: '{"choice":"b"}' }] },
          { role: "user", content: [{ type: "text", text: "turn 2" }] },
        ],
        replayedTokens,
      };
      const { client, bodies } = fakeClient([message()]);
      const reserved: number[] = [];
      const book = {
        reserve: (_id: string, usd: number) => reserved.push(usd),
        settle: () => undefined,
      };
      await new AnthropicMessagesProvider({ client, ledger: book }).decide(
        request({ claudeHarness: harness as never }),
      );
      expect(reserved).toEqual([
        claudeReservationUsd(
          "claude-haiku-5-5",
          Buffer.byteLength(JSON.stringify(bodies[0]), "utf8"),
          bodies[0]!.max_tokens,
        ),
      ]);
    },
  );

  it("refuses replayed thinking with no recorded usage, and thinking in the new turn", async () => {
    for (const harness of [
      replay(),
      replay(2_120, [{ type: "thinking", thinking: "", signature: "forged" }]),
    ]) {
      const { client, bodies } = fakeClient([message()]);
      await expect(
        new AnthropicMessagesProvider({ client, ledger: ledger() }).decide(
          request({ claudeHarness: harness }),
        ),
      ).rejects.toMatchObject({ name: "UnboundedClaudeContentError" });
      expect(bodies).toHaveLength(0);
    }
  });
});

// Without a recorded-usage bound (no replayedTokens), replayed thinking stays refused, as in #20.
describe("Claude thinking input (text-only scope)", () => {
  it("refuses a replayed thinking block before reserving or calling the SDK", async () => {
    const { client, bodies } = fakeClient([message()]);
    const book = ledger();
    const call = new AnthropicMessagesProvider({ client, ledger: book }).decide(
      request({
        claudeHarness: {
          system: [{ type: "text", text: "frozen" }],
          messages: [
            { role: "user", content: [{ type: "text", text: "turn 1" }] },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "", signature: "sig-1" },
                { type: "text", text: '{"choice":"b"}' },
              ],
            },
            { role: "user", content: [{ type: "text", text: "turn 2" }] },
          ],
        },
      }),
    );
    await expect(call).rejects.toMatchObject({ name: "UnboundedClaudeContentError" });
    expect(bodies).toHaveLength(0);
    expect(book.status()).toMatchObject({ settledUsd: 0, openReservations: 0 });
  });
});

describe("Claude refusals", () => {
  it("records the category as a named failure and calls no other model", async () => {
    const { client, bodies } = fakeClient([
      message({
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: "declined" } as never,
        content: [],
      }),
    ]);
    const metadata: Record<string, unknown>[] = [];
    const failure = new AnthropicMessagesProvider({ client, ledger: ledger() }).decide(
      request({ onProviderMetadata: (value) => metadata.push(value) }),
    );
    await expect(failure).rejects.toBeInstanceOf(ClaudeRefusalError);
    await expect(failure).rejects.toMatchObject({ category: "cyber" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("fallbacks");
    expect(metadata[0]).toMatchObject({
      stopReason: "refusal",
      stopDetails: { category: "cyber" },
    });
  });
});

describe("Claude warm gate in the provider", () => {
  it("holds a second request with the same shared prefix until the first streams", async () => {
    const started: string[] = [];
    const streams: { emit: () => void; finish: () => void }[] = [];
    const client: ClaudeClient = {
      messages: {
        stream(body) {
          started.push(JSON.stringify(body.messages));
          let listener: ((event: Anthropic.MessageStreamEvent) => void) | undefined;
          let finish!: () => void;
          const done = new Promise<void>((resolve) => (finish = resolve));
          streams.push({
            emit: () =>
              listener?.({
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "", citations: null },
              } as Anthropic.MessageStreamEvent),
            finish,
          });
          return {
            on: (_event, handler) => (listener = handler),
            finalMessage: async () => {
              await done;
              return message();
            },
            abort: () => undefined,
          };
        },
      },
    };
    const provider = new AnthropicMessagesProvider({ client, ledger: ledger() });
    const gated = (turn: string) =>
      request({
        claudeHarness: {
          system: [{ type: "text", text: "shared" }],
          messages: [{ role: "user", content: turn }],
          warmGateKey: "day-1",
        },
      });
    const first = provider.decide(gated("seat 1"));
    const second = provider.decide(gated("seat 2"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toHaveLength(1);
    streams[0]!.emit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toHaveLength(2);
    streams.forEach((stream) => stream.finish());
    await Promise.all([first, second]);
  });
});
