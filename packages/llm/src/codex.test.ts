import { access } from "node:fs/promises";
import { InitiativeDecisionSchema, SpeechDecisionSchema, TeamPointDecisionSchema } from "@werewolf/contracts";
import type { CodexOptions, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CodexLoginProvider } from "./codex";

const request = {
  kind: "narration" as const,
  model: "gpt-test",
  schemaName: "answer",
  schema: z.object({ answer: z.string() }),
  maxOutputTokens: 100,
  disclosurePacket: { allowed: true },
};

describe("Codex login provider", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("isolates a structured decision and records SDK usage", async () => {
    let clientOptions: CodexOptions | undefined;
    let threadOptions: ThreadOptions | undefined;
    let turnOptions: TurnOptions | undefined;
    let workingDirectory = "";
    const provider = new CodexLoginProvider({
      environment: { HOME: "/safe-home", PATH: "/usr/bin" },
      createClient(options) {
        clientOptions = options;
        return {
          startThread(options) {
            threadOptions = options;
            workingDirectory = options?.workingDirectory ?? "";
            return {
              async run(_input, options) {
                turnOptions = options;
                return {
                  finalResponse: JSON.stringify({ answer: "legal" }),
                  usage: {
                    input_tokens: 21,
                    cached_input_tokens: 3,
                    cache_write_input_tokens: 0,
                    output_tokens: 4,
                    reasoning_output_tokens: 1,
                  },
                };
              },
            };
          },
        };
      },
    });

    const result = await provider.decide(request);

    expect(result).toMatchObject({
      data: { answer: "legal" },
      provider: "codex",
      model: "gpt-test",
      usage: { inputTokens: 21, outputTokens: 4, totalTokens: 25 },
    });
    expect(clientOptions?.env).toEqual({ HOME: "/safe-home", PATH: "/usr/bin" });
    expect(clientOptions?.config).toMatchObject({
      model_provider:"werewolf-login",
      model_providers:{"werewolf-login":{name:"OpenAI",requires_openai_auth:true,request_max_retries:0,stream_max_retries:0}},
      history: { persistence: "none" },
      features: { apps: false, multi_agent: false, shell_tool: false, unified_exec: false },
    });
    expect(clientOptions?.configOverrides).toEqual(["mcp_servers={}", "plugins={}"]);
    expect(threadOptions).toMatchObject({
      model: "gpt-test",
      sandboxMode: "read-only",
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
    });
    expect(turnOptions?.outputSchema).toMatchObject({ type: "object" });
    await expect(access(workingDirectory)).rejects.toThrow();
  });

  it("emits strict schemas with every property required and optional values represented by null", () => {
    const assertStrictObjects = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) assertStrictObjects(child);
        return;
      }
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (node.type === "object" && node.properties && typeof node.properties === "object") {
        expect(new Set(node.required as string[])).toEqual(
          new Set(Object.keys(node.properties as Record<string, unknown>)),
        );
      }
      for (const child of Object.values(node)) assertStrictObjects(child);
    };

    for (const schema of [InitiativeDecisionSchema, SpeechDecisionSchema, TeamPointDecisionSchema]) {
      assertStrictObjects(z.toJSONSchema(schema, { target: "draft-7" }));
    }
    const initiative = z.toJSONSchema(InitiativeDecisionSchema, { target: "draft-7" }) as {
      properties: Record<string, unknown>;
    };
    expect(JSON.stringify(initiative.properties.replyToEventId)).toContain('"null"');
    expect(JSON.stringify(initiative.properties.topic)).toContain('"null"');
  });

  it("renders V3.1 public, private, and task layers in that order",async()=>{
    let delivered="";
    const provider=new CodexLoginProvider({
      environment:{HOME:"/safe-home",PATH:"/usr/bin"},
      createClient:()=>({startThread:()=>({run:async(input)=>{delivered=input;return {finalResponse:'{"answer":"ok"}',usage:null};}})}),
    });
    await provider.decide({...request,kind:"decision_v3_1",preparedPrompt:{instructions:"L0 rules",publicInput:"L1 public",privateInput:"L2 private",input:"L3 task"}});
    expect(delivered).toBe("L1 public\nL2 private\nL3 task");
  });

  it("aborts a slow Codex turn at the configured timeout", async () => {
    const provider = new CodexLoginProvider({
      timeoutMs: 5,
      createClient: () => ({
        startThread: () => ({
          run: (_input, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
        }),
      }),
    });

    await expect(provider.decide(request)).rejects.toThrow("Codex decision timed out after 5ms");
  });

  it("never inherits an API key into a default Codex child environment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "must-not-cross-provider-boundary");
    let childEnvironment: Record<string, string> | undefined;
    const provider = new CodexLoginProvider({
      createClient(options) {
        childEnvironment = options.env;
        return {
          startThread: () => ({
            run: async () => ({ finalResponse: '{"answer":"ok"}', usage: null }),
          }),
        };
      },
    });

    await provider.decide(request);
    expect(childEnvironment).not.toHaveProperty("OPENAI_API_KEY");
  });
});
