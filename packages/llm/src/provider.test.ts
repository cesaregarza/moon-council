import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decideWithRepair, type DecisionProvider, type DecisionRequest } from "./index";

describe("provider repair boundary", () => {
  it("repairs one malformed response and returns the validated second result", async () => {
    let calls = 0;
    const provider: DecisionProvider = {
      async decide<T>(request: DecisionRequest<T>) {
        calls += 1;
        return {
          data: (calls === 1 ? { answer: 4 } : { answer: "legal" }) as T,
          provider: "test",
          model: request.model,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const attempt = await decideWithRepair(provider, {
      kind: "narration",
      model: "test",
      schemaName: "test",
      schema: z.object({ answer: z.string() }),
      maxOutputTokens: 100,
    });
    expect(attempt.result?.data.answer).toBe("legal");
    expect(attempt.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it("returns a safe failure after two provider errors", async () => {
    const provider: DecisionProvider = {
      async decide() {
        throw new Error("offline");
      },
    };
    const attempt = await decideWithRepair(provider, {
      kind: "narration",
      model: "test",
      schemaName: "test",
      schema: z.object({ answer: z.string() }),
      maxOutputTokens: 100,
    });
    expect(attempt.result).toBeUndefined();
    expect(attempt.providerFailure).toBe(true);
    expect(attempt.attempts).toBe(2);
  });
});
