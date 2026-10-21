import { mkdtempSync, rmSync } from "node:fs";
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
import { ClaudeSpendLedger } from "./spend-ledger";

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

  it("sends a harness-built request unchanged and returns the full content, thinking included", async () => {
    const harness = {
      system: [
        { type: "text" as const, text: "frozen", cache_control: { type: "ephemeral" as const } },
      ],
      messages: [
        { role: "user" as const, content: "turn 1" },
        {
          role: "assistant" as const,
          content: [
            { type: "thinking" as const, thinking: "", signature: "sig-1" },
            { type: "text" as const, text: '{"choice":"b"}' },
          ],
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
