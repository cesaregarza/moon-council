import { describe, expect, it, vi } from "vitest";
import { AskJevProvider, jevResponseSchema, runAskJev, type JevRequest } from "./jev";

const request: JevRequest = {
  model: "jev-latest",
  state: { legal: ["a", "b"] },
  questions: {
    target: {
      type: "choice",
      instructions: "Choose a legal target.",
      criteria: { a: "First", b: "Second" },
    },
  },
};
const response = {
  model: "jev-test",
  answers: {
    target: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.6 },
  },
  usage: { input_tokens: 30, output_tokens: 10 },
};
const call = () => ({
  kind: "jev" as const,
  model: request.model,
  schemaName: "jev",
  schema: jevResponseSchema(request),
  preparedPrompt: { instructions: "typed", input: JSON.stringify(request) },
  maxOutputTokens: 200,
});

describe("Ask Jev provider", () => {
  it("accepts decimal rounding at the declared one-percent boundary without relaxing it", () => {
    const scoreRequest: JevRequest = {
      model: "jev-test",
      state: {},
      questions: {
        listen: {
          type: "score",
          instructions: "Listening interest",
          criteria: ["0", "1", "2", "3", "4"],
        },
      },
    };
    const schema = jevResponseSchema(scoreRequest);
    const parse = (values: number[]) =>
      schema.safeParse({
        model: "jev-test",
        answers: {
          listen: {
            type: "score",
            score: 1.31,
            confidence: 0.56,
            probabilities: Object.fromEntries(values.map((p, i) => [String(i), p])),
          },
        },
      });
    // Exact distribution rejected during the first prose-journal live pilot.
    expect(parse([0.12, 0.56, 0.23, 0.07, 0.01]).success).toBe(true);
    expect(parse([0.12, 0.56, 0.23, 0.07, 0.03]).success).toBe(true);
    expect(parse([0.12, 0.56, 0.23, 0.06, 0.01]).success).toBe(false);
    expect(parse([0.12, 0.56, 0.23, 0.08, 0.03]).success).toBe(false);
    expect(parse([0.12, 0.56, 0.23, 0.07, 0.009999]).success).toBe(false);
  });
  it("uses the CLI wire request and reports measured usage and exact raw output", async () => {
    const run = vi.fn(async (_input: string) => JSON.stringify(response));
    const usage = vi.fn(),
      raw = vi.fn();
    const result = await new AskJevProvider(run).decide({
      ...call(),
      onUsage: usage,
      onRawResponse: raw,
    });
    expect(JSON.parse(run.mock.calls[0]![0] as string)).toEqual(request);
    expect(result).toMatchObject({
      provider: "jev",
      model: "jev-test",
      usage: { totalTokens: 40 },
    });
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 40 }), {
      provider: "jev",
      model: "jev-test",
      outputLimitEnforced: false,
    });
    expect(raw).toHaveBeenCalledWith(JSON.stringify(response));
  });
  it("rejects invented options and inconsistent or malformed distributions while retaining usage", async () => {
    for (const target of [
      { ...response.answers.target, choice: "c" },
      { ...response.answers.target, choice: "b" },
      { ...response.answers.target, probabilities: { a: 0.8, b: 0.8 } },
      { ...response.answers.target, probabilities: { a: 0.8, c: 0.2 } },
    ]) {
      const usage = vi.fn();
      const provider = new AskJevProvider(async () =>
        JSON.stringify({ ...response, answers: { target } }),
      );
      await expect(provider.decide({ ...call(), onUsage: usage })).rejects.toThrow();
      expect(usage).toHaveBeenCalledWith(
        expect.objectContaining({ totalTokens: 40 }),
        expect.anything(),
      );
    }
  });
  it("does not retry or fabricate a decision on service failure", async () => {
    const run = vi.fn(async () => {
        throw new Error("service unavailable");
      }),
      usage = vi.fn();
    await expect(new AskJevProvider(run).decide({ ...call(), onUsage: usage })).rejects.toThrow(
      "service unavailable",
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith(
      expect.objectContaining({ totalTokens: null }),
      expect.anything(),
    );
  });
  it("rejects aborted and oversized requests before starting a subprocess", async () => {
    await expect(
      runAskJev("{}", { signal: AbortSignal.abort(), timeoutMs: 1_000 }),
    ).rejects.toThrow("aborted");
    await expect(runAskJev("x".repeat(1024 * 1024 + 1), { timeoutMs: 1_000 })).rejects.toThrow(
      "1 MiB",
    );
  });
  it("preserves unknown usage rather than recording a free call", async () => {
    const usage = vi.fn();
    const { usage: _usage, ...unmeasured } = response;
    await new AskJevProvider(async () => JSON.stringify(unmeasured)).decide({
      ...call(),
      onUsage: usage,
    });
    expect(usage).toHaveBeenCalledWith(
      expect.objectContaining({ totalTokens: null }),
      expect.anything(),
    );
  });
  it("passes cancellation and bounds the command deadline", async () => {
    const signal = new AbortController().signal;
    const run = vi.fn(async (_input: string, _options: unknown) => JSON.stringify(response));
    await new AskJevProvider(run).decide({ ...call(), timeoutMs: 300_000, signal });
    expect(run.mock.calls[0]![1]).toEqual({ signal, timeoutMs: 20_000 });
  });
});
