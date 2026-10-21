import { expect, it } from "vitest";
import { z } from "zod";
import { AnthropicMessagesProvider } from "./anthropic";

// One tiny call against the real API, counted in the monthly ledger. Never runs in CI.
it.skipIf(process.env.RUN_LIVE_ANTHROPIC !== "1")(
  "returns schema-valid JSON from the configured Claude model",
  async () => {
    const model = process.env.ANTHROPIC_MODEL;
    if (!model) throw new Error("ANTHROPIC_MODEL is required for the live smoke test");
    const usage: unknown[] = [];
    const result = await new AnthropicMessagesProvider().decide({
      kind: "narration",
      model,
      schemaName: "smoke",
      schema: z.object({ ok: z.boolean() }),
      maxOutputTokens: 2_000,
      reasoningEffort: "low",
      preparedPrompt: { instructions: "Reply with JSON only.", input: 'Return {"ok": true}.' },
      timeoutMs: 60_000,
      onUsage: (value) => usage.push(value),
    });
    expect(result.data).toEqual({ ok: true });
    expect(result.provider).toBe("anthropic");
    expect(usage).toHaveLength(1);
  },
  90_000,
);
