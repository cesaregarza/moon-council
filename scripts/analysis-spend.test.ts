import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AnthropicMessagesProvider,
  ClaudeSpendLedger,
  claudeReservationUsd,
  type ClaudeClient,
  type DecisionRequest,
} from "@werewolf/llm";
import * as analysis from "./game-analyze";

/**
 * CES-1564: Claude review calls reserve and settle each call against the analysis run's cap and
 * the monthly ledger (Rules U and L), and stop at the cap by name before any request is sent.
 */
interface SpendCap {
  allow(usd: number): void;
  reserve(id: string, usd: number): void;
  settle(id: string, usd: number): void;
  readonly spentUsd: number;
}
// Read through a cast so this file compiles before the analyzer exports the cap (tests first).
const api = analysis as unknown as {
  ReviewSpendCap?: new (ledger: Pick<ClaudeSpendLedger, "reserve" | "settle">) => SpendCap;
};
function spendCap(ledger: ClaudeSpendLedger): SpendCap {
  expect(api.ReviewSpendCap).toBeTypeOf("function");
  return new api.ReviewSpendCap!(ledger);
}

const directories: string[] = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});
function monthly() {
  const directory = mkdtempSync(join(tmpdir(), "analysis-spend-"));
  directories.push(directory);
  return new ClaudeSpendLedger(
    join(directory, "spend.json"),
    200,
    () => new Date("2026-10-23T12:00:00Z"),
  );
}
const stored = (ledger: ClaudeSpendLedger) =>
  JSON.parse(readFileSync(ledger.path, "utf8")).months["2026-10"] as {
    settledUsd: number;
    reservations: Record<string, unknown>;
  };

const usage = (fields: Partial<Anthropic.Usage> = {}): Anthropic.Usage =>
  ({
    input_tokens: 1_000,
    output_tokens: 100,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    ...fields,
  }) as Anthropic.Usage;
const message = (fields: Partial<Anthropic.Message> = {}) =>
  ({
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
  }) as Anthropic.Message;

/** A scripted SDK client that counts every request it is sent. */
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

const request = () =>
  ({
    kind: "decision_v3_1",
    model: "claude-haiku-5-5",
    schemaName: "choice",
    schema: z.object({ choice: z.string() }),
    maxOutputTokens: 4_000,
    reasoningEffort: "high",
    preparedPrompt: { instructions: "Review.", input: '{"moment":1}' },
  }) as DecisionRequest<{ choice: string }>;

// Haiku 5.5 standard rates: $0.10/M input, $0.50/M output.
const SETTLED = (1_000 * 0.1 + 100 * 0.5) / 1_000_000;

describe("analysis review spend cap", () => {
  it("reserves and settles each Claude call in the run cap and the monthly ledger", async () => {
    const ledger = monthly();
    const cap = spendCap(ledger);
    cap.allow(1);
    const { client, bodies } = fakeClient([message(), message()]);
    const provider = new AnthropicMessagesProvider({ client, ledger: cap });
    await provider.decide(request());
    await provider.decide(request());
    expect(bodies).toHaveLength(2);
    expect(cap.spentUsd).toBeCloseTo(2 * SETTLED, 12);
    expect(stored(ledger).settledUsd).toBeCloseTo(2 * SETTLED, 12);
    expect(stored(ledger).reservations).toEqual({});
  });

  it("stops by name before sending a call whose reservation would pass the cap", async () => {
    const ledger = monthly();
    const cap = spendCap(ledger);
    cap.allow(1);
    const { client, bodies } = fakeClient([message(), message()]);
    const provider = new AnthropicMessagesProvider({ client, ledger: cap });
    await provider.decide(request());
    const reservation = claudeReservationUsd(
      "claude-haiku-5-5",
      Buffer.byteLength(JSON.stringify(bodies[0])),
      4_000,
    );
    // Room for what is spent plus less than one more reservation.
    cap.allow(cap.spentUsd + reservation / 2);
    await expect(provider.decide(request())).rejects.toMatchObject({
      name: "ReviewSpendLimitError",
    });
    expect(bodies).toHaveLength(1);
    expect(stored(ledger).settledUsd).toBeCloseTo(SETTLED, 12);
    expect(stored(ledger).reservations).toEqual({});
  });

  it("admits nothing until the run's allowance is set", async () => {
    const ledger = monthly();
    const cap = spendCap(ledger);
    const { client, bodies } = fakeClient([message()]);
    await expect(
      new AnthropicMessagesProvider({ client, ledger: cap }).decide(request()),
    ).rejects.toMatchObject({ name: "ReviewSpendLimitError" });
    expect(bodies).toHaveLength(0);
  });

  it("keeps the reservation when usage is unknown, in both the cap and the monthly ledger", async () => {
    const ledger = monthly();
    const cap = spendCap(ledger);
    cap.allow(1);
    const { client, bodies } = fakeClient([
      message({ usage: usage({ input_tokens: -1 as never }) }),
    ]);
    await new AnthropicMessagesProvider({ client, ledger: cap }).decide(request());
    const reservation = claudeReservationUsd(
      "claude-haiku-5-5",
      Buffer.byteLength(JSON.stringify(bodies[0])),
      4_000,
    );
    expect(cap.spentUsd).toBeCloseTo(reservation, 12);
    expect(stored(ledger).settledUsd).toBeCloseTo(reservation, 12);
  });

  it("settles an invalid amount at what it holds (Rule L)", () => {
    const ledger = monthly();
    const cap = spendCap(ledger);
    cap.allow(1);
    cap.reserve("a", 0.25);
    cap.settle("a", Number.NaN);
    cap.reserve("b", 0.25);
    cap.settle("b", Number.POSITIVE_INFINITY);
    expect(cap.spentUsd).toBe(0.5);
    expect(stored(ledger).settledUsd).toBe(0.5);
    expect(() => cap.reserve("c", Number.NaN)).toThrow();
    expect(stored(ledger).reservations).toEqual({});
  });
});
