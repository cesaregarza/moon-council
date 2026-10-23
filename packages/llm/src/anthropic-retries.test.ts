import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as anthropic from "./anthropic";
import { AnthropicMessagesProvider } from "./anthropic";
import type { DecisionRequest } from "./provider";
import { ClaudeSpendLedger } from "./spend-ledger";

/**
 * CES-1564 ruling 1: no hidden retries. The SDK's own retries are off; the provider retries a
 * retryable failure itself, up to three attempts, and every attempt is its own reserve → send →
 * settle. Driven through the real SDK client with a scripted `fetch`, one response per request.
 */
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

// Deliberately not key-shaped, so the history secret scan never matches a test fixture.
const FAKE_API_KEY = "fake-anthropic-key-for-tests";

/** The monthly ledger, with every reserve and settle it receives recorded in order. */
function recordedLedger() {
  const directory = mkdtempSync(join(tmpdir(), "claude-retries-"));
  directories.push(directory);
  const ledger = new ClaudeSpendLedger(
    join(directory, "spend.json"),
    200,
    () => new Date("2026-10-23T12:00:00Z"),
  );
  const reserved: { id: string; usd: number }[] = [];
  const settled: { id: string; usd: number }[] = [];
  const recording = {
    reserve(id: string, usd: number) {
      ledger.reserve(id, usd);
      reserved.push({ id, usd });
    },
    settle(id: string, usd: number) {
      ledger.settle(id, usd);
      settled.push({ id, usd });
    },
  };
  const month = () =>
    JSON.parse(readFileSync(ledger.path, "utf8")).months["2026-10"] as {
      settledUsd: number;
      reservations: Record<string, unknown>;
    };
  return { recording, reserved, settled, month };
}

const sse = (events: Record<string, unknown>[]) =>
  events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");

/** A complete streamed reply: 1,000 input and 100 output tokens. */
function success(): Response {
  const body = sse([
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 1_000,
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
      delta: { type: "text_delta", text: '{"choice":"a"}' },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 100 },
    },
    { type: "message_stop" },
  ]);
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
// Haiku 5.5 standard rates: $0.10/M input, $0.50/M output.
const ACTUAL = (1_000 * 0.1 + 100 * 0.5) / 1_000_000;

/** An overloaded response that asks for a 1 ms wait. */
const overloaded = () =>
  new Response(
    JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    { status: 529, headers: { "content-type": "application/json", "retry-after-ms": "1" } },
  );
const badRequest = () =>
  new Response(
    JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }),
    { status: 400, headers: { "content-type": "application/json" } },
  );

/** Stubs the global fetch the SDK binds at construction; counts every HTTP request. */
function scriptedFetch(replies: (() => Response)[]) {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    requests.push(String(input instanceof Request ? input.url : input));
    const reply = replies.shift();
    if (!reply) throw new Error("no scripted reply");
    return reply();
  });
  return requests;
}

const request = (metadata: Record<string, unknown>[]) =>
  ({
    kind: "decision_v3_1",
    model: "claude-haiku-5-5",
    schemaName: "choice",
    schema: z.object({ choice: z.string() }),
    maxOutputTokens: 4_000,
    reasoningEffort: "high",
    preparedPrompt: { instructions: "Review.", input: '{"moment":1}' },
    onProviderMetadata: (value) => metadata.push(value),
  }) as DecisionRequest<{ choice: string }>;

describe("Claude retries are explicit attempts", () => {
  it("reserves and settles each of three attempts: two held, one at its actual cost", async () => {
    const requests = scriptedFetch([overloaded, overloaded, success]);
    const book = recordedLedger();
    const metadata: Record<string, unknown>[] = [];
    const provider = new AnthropicMessagesProvider({
      apiKey: FAKE_API_KEY,
      ledger: book.recording,
    });
    const result = await provider.decide(request(metadata));
    expect(result.data).toEqual({ choice: "a" });
    // Exactly one HTTP request per attempt: the SDK's own retry is off.
    expect(requests).toHaveLength(3);
    expect(book.reserved).toHaveLength(3);
    expect(new Set(book.reserved.map((r) => r.id)).size).toBe(3);
    expect(book.settled.map((s) => s.id)).toEqual(book.reserved.map((r) => r.id));
    expect(book.settled[0]!.usd).toBe(book.reserved[0]!.usd);
    expect(book.settled[1]!.usd).toBe(book.reserved[1]!.usd);
    expect(book.settled[2]!.usd).toBeCloseTo(ACTUAL, 15);
    const recorded = book.reserved[0]!.usd + book.reserved[1]!.usd + book.settled[2]!.usd;
    expect(book.month().settledUsd).toBeCloseTo(recorded, 15);
    expect(book.month().reservations).toEqual({});
    // Held attempts make the call's cost unknown; heldUsd is what the ledger recorded.
    const last = metadata.at(-1)!;
    expect(last).not.toHaveProperty("costUsd");
    expect(last.heldUsd).toBeCloseTo(recorded, 15);
    // The call reports how many attempts it sent.
    expect(last.attempts).toBe(3);
  });

  it("raises the failure after three attempts, every one settled at its reservation", async () => {
    const requests = scriptedFetch([overloaded, overloaded, overloaded]);
    const book = recordedLedger();
    const metadata: Record<string, unknown>[] = [];
    const provider = new AnthropicMessagesProvider({
      apiKey: FAKE_API_KEY,
      ledger: book.recording,
    });
    await expect(provider.decide(request(metadata))).rejects.toThrow();
    expect(requests).toHaveLength(3);
    expect(book.reserved).toHaveLength(3);
    expect(book.settled.map((s) => s.usd)).toEqual(book.reserved.map((r) => r.usd));
    const held = book.reserved.reduce((sum, r) => sum + r.usd, 0);
    expect(book.month().settledUsd).toBeCloseTo(held, 15);
    expect(book.month().reservations).toEqual({});
    expect(metadata.at(-1)).toMatchObject({ heldUsd: expect.closeTo(held, 15) });
    expect(metadata.at(-1)).not.toHaveProperty("costUsd");
  });

  it("does not retry a request the API rejects as invalid", async () => {
    const requests = scriptedFetch([badRequest, success]);
    const book = recordedLedger();
    const provider = new AnthropicMessagesProvider({
      apiKey: FAKE_API_KEY,
      ledger: book.recording,
    });
    await expect(provider.decide(request([]))).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(book.reserved).toHaveLength(1);
    expect(book.settled[0]!.usd).toBe(book.reserved[0]!.usd);
  });

  it("reports the actual cost, and no held amount, when one attempt succeeds", async () => {
    const requests = scriptedFetch([success]);
    const book = recordedLedger();
    const metadata: Record<string, unknown>[] = [];
    const provider = new AnthropicMessagesProvider({
      apiKey: FAKE_API_KEY,
      ledger: book.recording,
    });
    await provider.decide(request(metadata));
    expect(requests).toHaveLength(1);
    expect(metadata.at(-1)!.costUsd).toBeCloseTo(ACTUAL, 15);
    expect(metadata.at(-1)).not.toHaveProperty("heldUsd");
  });

  it("sends no hidden retries from an injected SDK client with default retries", async () => {
    // halcyon's control: a real client built with the SDK's default two retries, injected.
    const requests: string[] = [];
    const replies = [overloaded, overloaded, success];
    const client = new Anthropic({
      apiKey: FAKE_API_KEY,
      fetch: async (input: RequestInfo | URL) => {
        requests.push(String(input instanceof Request ? input.url : input));
        return replies.shift()!();
      },
    });
    const book = recordedLedger();
    const provider = new AnthropicMessagesProvider({ client, ledger: book.recording });
    await expect(provider.decide(request([]))).resolves.toBeDefined();
    expect(requests).toHaveLength(3);
    expect(book.reserved).toHaveLength(3);
  });

  it("reports the reservation as held, and no cost, when settling throws", async () => {
    scriptedFetch([success]);
    const reserved: number[] = [];
    const ledger = {
      reserve: (_id: string, usd: number) => void reserved.push(usd),
      settle: () => {
        throw new Error("ledger unavailable");
      },
    };
    const metadata: Record<string, unknown>[] = [];
    const provider = new AnthropicMessagesProvider({ apiKey: FAKE_API_KEY, ledger });
    await expect(provider.decide(request(metadata))).rejects.toThrow(/ledger unavailable/);
    expect(reserved).toHaveLength(1);
    const last = metadata.at(-1)!;
    expect(last).not.toHaveProperty("costUsd");
    expect(last.heldUsd).toBe(reserved[0]);
  });

  it("clamps a long Retry-After to 60 seconds instead of falling back to the short backoff", () => {
    const delay = (anthropic as unknown as { retryDelayMs?: (e: unknown, n: number) => number })
      .retryDelayMs;
    expect(delay).toBeTypeOf("function");
    const asking = (headers: Record<string, string>) =>
      Anthropic.APIError.generate(
        529,
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
        "Overloaded",
        new Headers(headers),
      );
    expect(delay!(asking({ "retry-after": "120" }), 1)).toBe(60_000);
    expect(delay!(asking({ "retry-after-ms": "250" }), 1)).toBe(250);
    expect(delay!(asking({}), 2)).toBe(1_000);
  });

  it("keeps the warm gate working across explicit retries", async () => {
    // The first call's first attempt fails before streaming: the gate passes to the waiting
    // sibling, and the retry waits until that sibling streams.
    const started: string[] = [];
    const finishes: (() => void)[] = [];
    const client: anthropic.ClaudeClient = {
      messages: {
        stream(body) {
          const seat = JSON.stringify(body.messages).includes("seat 1") ? "seat 1" : "seat 2";
          started.push(seat);
          const failing = seat === "seat 1" && started.filter((s) => s === "seat 1").length === 1;
          let listener: ((event: Anthropic.MessageStreamEvent) => void) | undefined;
          let finish!: () => void;
          const done = new Promise<void>((resolve) => (finish = resolve));
          finishes.push(() => {
            listener?.({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "", citations: null },
            } as Anthropic.MessageStreamEvent);
            finish();
          });
          return {
            on: (_event, handler) => (listener = handler),
            finalMessage: async () => {
              if (failing) throw overloadedError();
              await done;
              return streamedMessage();
            },
            abort: () => undefined,
          };
        },
      },
    };
    const provider = new AnthropicMessagesProvider({ client, ledger: recordedLedger().recording });
    const gated = (turn: string) =>
      ({
        ...request([]),
        claudeHarness: {
          system: [{ type: "text", text: "shared" }],
          messages: [{ role: "user", content: turn }],
          warmGateKey: "day-1",
        },
      }) as DecisionRequest<{ choice: string }>;
    const first = provider.decide(gated("seat 1"));
    const second = provider.decide(gated("seat 2"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual(["seat 1", "seat 2"]);
    finishes[1]!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual(["seat 1", "seat 2", "seat 1"]);
    finishes[2]!();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});

/** The SDK's own error for an overloaded API, asking for a 1 ms wait. */
const overloadedError = () =>
  Anthropic.APIError.generate(
    529,
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    "Overloaded",
    new Headers({ "retry-after-ms": "1" }),
  );
const streamedMessage = () =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: '{"choice":"a"}', citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1_000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }) as unknown as Anthropic.Message;
