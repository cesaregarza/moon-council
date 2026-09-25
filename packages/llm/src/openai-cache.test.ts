import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openAIRequest, supportsExplicitPromptCaching } from "./openai-cache";
import { OpenAIResponsesProvider } from "./openai";
import type { DecisionRequest } from "./provider";

const record = (index: number) => ({
  handle: `E${index}`,
  type: "speech.public",
  day: 1,
  scope: "public",
  data: { text: `Speech ${index}` },
});
function request(player = "p1", count = 2): DecisionRequest<{ answer: string }> {
  return {
    gameId: "game-one",
    playerId: player,
    kind: "decision_v3_1",
    model: "gpt-6-luna",
    reasoningEffort: "xhigh",
    schema: z.object({ answer: z.string() }),
    schemaName: "journal",
    maxOutputTokens: 8192,
    preparedPrompt: {
      instructions:
        'Immutable behavior\n\nFROZEN PUBLIC GAME REFERENCE (data):\n{"rules":"Frozen rules"}',
      publicInput: JSON.stringify({
        PUBLIC_GAME_STATE: {
          protocolVersion: "agent_v3_1",
          day: 1,
          phase: "day_discussion",
          closing: false,
          players: ["p1", "p2"],
          evidence: [
            { handle: "E1", type: "vote.resolved", day: 1, scope: "public", data: { ballots: [] } },
            ...Array.from({ length: count }, (_, i) => record(i + 2)),
          ],
        },
      }),
      privateInput: `Only ${player}'s private knowledge`,
      input: "Reflect",
      cache: { mode: "explicit", ttl: "30m", stablePrefix: "same-rules", boundary: "public" },
    },
  };
}
const inputs = (req: DecisionRequest<unknown>) =>
  openAIRequest(req).input as Array<{
    role: string;
    content: Array<{ text: string; prompt_cache_breakpoint?: unknown }>;
  }>;

it("retains behavior, rules and durable outcomes when speech windows or phases change", () => {
  const first = request(),
    next = request("p2", 3);
  const publicState = JSON.parse(next.preparedPrompt!.publicInput!);
  publicState.PUBLIC_GAME_STATE.phase = "day_vote";
  next.preparedPrompt!.publicInput = JSON.stringify(publicState);
  const a = inputs(first),
    b = inputs(next);
  expect(b.slice(0, 3)).toEqual(a.slice(0, 3)); // behavior, rules, durable public outcomes
  expect(b[3]!.content[0]!.text).toContain('"E4"');
  expect(JSON.stringify(b)).not.toContain("p1's private knowledge");
  expect(
    b
      .filter((m) => m.content[0]?.prompt_cache_breakpoint)
      .every((m) => !m.content[0]!.text.includes("private knowledge")),
  ).toBe(true);
  const wire = openAIRequest(next);
  expect(wire.prompt_cache_key).toBe(openAIRequest(first).prompt_cache_key);
  expect(wire).not.toHaveProperty("previous_response_id");
  expect(wire).not.toHaveProperty("conversation");
});

it("reconstructs all public facts exactly and invalidates edited or compacted records", () => {
  const req = request(),
    messages = inputs(req);
  const durable = JSON.parse(messages[2]!.content[0]!.text).DURABLE_PUBLIC_EVIDENCE;
  const current = JSON.parse(messages[3]!.content[0]!.text).PUBLIC_GAME_STATE;
  expect({ ...current, evidence: [...durable, ...current.evidence] }).toEqual(
    JSON.parse(req.preparedPrompt!.publicInput!).PUBLIC_GAME_STATE,
  );
  const changed = JSON.parse(req.preparedPrompt!.publicInput!);
  changed.PUBLIC_GAME_STATE.evidence[1].data.text = "Corrected speech";
  req.preparedPrompt!.publicInput = JSON.stringify(changed);
  expect(inputs(req)[3]).not.toEqual(messages[3]);
  expect(inputs(req).slice(0, 3)).toEqual(messages.slice(0, 3));
  expect(inputs(req)[0]).toEqual(messages[0]);
});

it("keeps retries out of cached prefixes and separates game accounting", () => {
  const req = request(),
    first = inputs(req);
  req.preparedPrompt!.input = "Repair your malformed reply";
  expect(inputs(req).slice(0, -1)).toEqual(first.slice(0, -1));
  expect(openAIRequest({ ...req, gameId: "another-game" }).prompt_cache_key).not.toBe(
    openAIRequest(req).prompt_cache_key,
  );
  req.preparedPrompt!.cache!.boundary = "instructions";
  expect(inputs(req).filter((m) => m.content[0]?.prompt_cache_breakpoint)).toHaveLength(2);
});

it("keeps every reusable layer writable within four slots even for a long game", () => {
  const messages = inputs(request("p1", 100));
  expect(messages.filter((m) => m.content[0]?.prompt_cache_breakpoint)).toHaveLength(4);
  expect(messages.slice(0, 4).every((m) => m.content[0]?.prompt_cache_breakpoint)).toBe(true);
  expect(messages.slice(4).every((m) => !m.content[0]?.prompt_cache_breakpoint)).toBe(true);
});

it("uses supported controls only, preserves old formats, and never invents cache hits", () => {
  expect(supportsExplicitPromptCaching("gpt-6-luna")).toBe(true);
  expect(supportsExplicitPromptCaching("gpt-5.6-luna-2026-01-01")).toBe(true);
  expect(supportsExplicitPromptCaching("gpt-5.5")).toBe(false);
  expect(supportsExplicitPromptCaching("custom-model")).toBe(false);
  const req = request();
  const old = openAIRequest({ ...req, model: "gpt-5.5" });
  expect(old).not.toHaveProperty("prompt_cache_options");
  expect(old.input).toContain(req.preparedPrompt!.privateInput);
});

describe("OpenAI cache diagnostics and receipt handling", () => {
  function setup(responses: object[]) {
    const provider = new OpenAIResponsesProvider("test-only");
    const create = vi.fn(async () => responses.shift());
    (provider as unknown as { client: unknown }).client = { responses: { create } };
    return { provider, create };
  }
  const completed = (id: string) => ({
    id,
    model: "gpt-6-luna",
    status: "completed",
    output_text: '{"answer":"ok"}',
    usage: {
      input_tokens: 1500,
      output_tokens: 100,
      total_tokens: 1600,
      input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 200 },
      output_tokens_details: { reasoning_tokens: 80 },
    },
  });
  it("compares completed calls only within a game/model/schema family, with bounded process-local state", async () => {
    const { provider, create } = setup([
      completed("one"),
      {
        ...completed("bad"),
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
      completed("two"),
      completed("three"),
      completed("four"),
    ]);
    const req = request();
    await provider.decide(req);
    await expect(provider.decide(req)).rejects.toThrow("incomplete: max_output_tokens");
    await provider.decide(request("p2"));
    await provider.decide({ ...req, gameId: "another-game" });
    await provider.decide({ ...req, schemaName: "different-schema" });
    const bodies = create.mock.calls as unknown as Array<[ReturnType<typeof openAIRequest>]>;
    expect(bodies[0]![0].prompt_cache_options).not.toHaveProperty("comparison_response_id");
    expect(bodies[1]![0].prompt_cache_options).toHaveProperty("comparison_response_id", "one");
    expect(bodies[2]![0].prompt_cache_options).toHaveProperty("comparison_response_id", "one");
    expect(bodies[3]![0].prompt_cache_options).not.toHaveProperty("comparison_response_id");
    expect(bodies[4]![0].prompt_cache_options).not.toHaveProperty("comparison_response_id");
  });
  it("omits an explicitly unlimited output cap and records that it was not enforced", async () => {
    const { provider, create } = setup([completed("unlimited")]);
    const onUsage = vi.fn();
    await provider.decide({ ...request(), maxOutputTokens: null, onUsage });
    expect((create.mock.calls as unknown as Array<[object]>)[0]![0]).not.toHaveProperty(
      "max_output_tokens",
    );
    expect(onUsage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ outputLimitEnforced: false }),
    );
  });
  it("records the wire body, actual returned model and cache usage even on incomplete responses", async () => {
    const { provider } = setup([
      {
        ...completed("partial"),
        model: "actual-snapshot",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        prompt_cache_diagnostics: { type: "cache_miss", reason: "input_changed" },
      },
    ]);
    const onUsage = vi.fn(),
      onProviderRequest = vi.fn(),
      onProviderMetadata = vi.fn(),
      onRawResponse = vi.fn();
    await expect(
      provider.decide({
        ...request(),
        onUsage,
        onProviderRequest,
        onProviderMetadata,
        onRawResponse,
      }),
    ).rejects.toThrow("max_output_tokens");
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cachedInputTokens: 1000,
        cacheWriteInputTokens: 200,
        reasoningTokens: 80,
      }),
      expect.objectContaining({ model: "actual-snapshot" }),
    );
    expect(onProviderRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        store: false,
        max_output_tokens: 8192,
        truncation: "disabled",
        service_tier: "default",
      }),
    );
    expect(onProviderMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        incompleteReason: "max_output_tokens",
        cacheDiagnostics: { type: "cache_miss", reason: "input_changed" },
      }),
    );
    expect(onRawResponse).toHaveBeenCalledWith('{"answer":"ok"}');
  });
});
