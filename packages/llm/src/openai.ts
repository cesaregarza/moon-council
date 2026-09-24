import OpenAI from "openai";
import { z } from "zod";
import { promptFor } from "./prompt";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "./provider";
import { providerJsonSchema, unknownUsage, type UsageV2 } from "@werewolf/contracts";

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function openAiUsage(value: unknown): UsageV2 {
  if (!value || typeof value !== "object") return unknownUsage();
  const usage = value as Record<string, unknown>;
  const inputDetails = usage.input_tokens_details;
  const outputDetails = usage.output_tokens_details;
  return {
    inputTokens: numberOrNull(usage.input_tokens),
    outputTokens: numberOrNull(usage.output_tokens),
    totalTokens: numberOrNull(usage.total_tokens),
    cachedInputTokens:
      inputDetails && typeof inputDetails === "object"
        ? numberOrNull((inputDetails as Record<string, unknown>).cached_tokens)
        : null,
    cacheWriteInputTokens:
      inputDetails && typeof inputDetails === "object"
        ? numberOrNull((inputDetails as Record<string, unknown>).cache_write_tokens)
        : null,
    reasoningTokens:
      outputDetails && typeof outputDetails === "object"
        ? numberOrNull((outputDetails as Record<string, unknown>).reasoning_tokens)
        : null,
  };
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal | undefined): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
} {
  if (!first) return { signal: second, cleanup: () => undefined };
  if (!second) return { signal: first, cleanup: () => undefined };
  const controller = new AbortController();
  const abort = (source: AbortSignal) => controller.abort(source.reason);
  first.addEventListener("abort", () => abort(first), { once: true });
  second.addEventListener("abort", () => abort(second), { once: true });
  if (first.aborted) abort(first);
  else if (second.aborted) abort(second);
  return { signal: controller.signal, cleanup: () => undefined };
}

function supportsExplicitPromptCaching(model:string):boolean {
  return /^gpt-(?:5\.(?:[6-9]|[1-9]\d)|[6-9])(?:-|$)/.test(model);
}

export class OpenAIResponsesProvider implements DecisionProvider {
  private readonly client: OpenAI;

  constructor(apiKey = process.env.OPENAI_API_KEY) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
    // The application owns and records retries; SDK retries would bypass the attempt ledger.
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
  }

  async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    const prompt = promptFor(request);
    let usageReported = false;
    const reportUsage = (usage: UsageV2): void => {
      if (usageReported) return;
      usageReported = true;
      request.onUsage?.(usage, { provider: "openai", model: request.model, outputLimitEnforced: true });
    };
    let timedOut = false;
    const timeoutController = request.timeoutMs ? new AbortController() : undefined;
    const timeout = request.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          timeoutController?.abort(new Error("request timeout"));
        }, request.timeoutMs)
      : undefined;
    const combined = combineSignals(request.signal, timeoutController?.signal);

    try {
      if (request.signal?.aborted) throw new Error("request aborted");
      const explicitCache=Boolean(request.preparedPrompt?.cache)&&supportsExplicitPromptCaching(request.model);
      const combinedInput=[prompt.publicInput,prompt.privateInput,prompt.sharedInput,prompt.input].filter((part):part is string=>Boolean(part)).join("\n");
      const response = await this.client.responses.create(
        {
          model: request.model,
          store: false,
          ...(explicitCache?{
            input:[
              {role:"developer" as const,content:[{type:"input_text" as const,text:prompt.instructions,prompt_cache_breakpoint:{mode:"explicit" as const}}]},
              ...(prompt.publicInput ? [{role:"user" as const,content:[{type:"input_text" as const,text:prompt.publicInput,prompt_cache_breakpoint:{mode:"explicit" as const}}]}] : []),
              ...(prompt.privateInput ? [{role:"user" as const,content:prompt.privateInput}] : []),
              ...(prompt.sharedInput ? [{role:"user" as const,content:[{type:"input_text" as const,text:prompt.sharedInput,prompt_cache_breakpoint:{mode:"explicit" as const}}]}] : []),
              {role:"user" as const,content:prompt.input},
            ],
            prompt_cache_key:request.preparedPrompt!.cache!.stablePrefix,
            prompt_cache_options:{mode:"explicit" as const,ttl:"30m" as const},
          }:{instructions:prompt.instructions,input:combinedInput}),
          max_output_tokens: request.maxOutputTokens,
          ...(request.reasoningEffort
            ? { reasoning: { effort: request.reasoningEffort as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } }
            : {}),
          text: {
            format: {
              type: "json_schema",
              name: request.schemaName,
              strict: true,
              schema: providerJsonSchema(request.schema) as Record<string, unknown>,
            },
          },
        },
        {
          ...(combined.signal ? { signal: combined.signal } : {}),
          ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}),
        },
      );
      const usage = openAiUsage(response.usage);
      reportUsage(usage);
      if (!response.output_text) throw new Error("OpenAI response did not contain output_text");
      request.onRawResponse?.(response.output_text);
      const data = request.schema.parse(JSON.parse(response.output_text));
      return {
        data,
        provider: "openai",
        model: request.model,
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
        },
      };
    } catch (error) {
      reportUsage(unknownUsage());
      if (timedOut) throw new Error(`OpenAI decision timed out after ${request.timeoutMs}ms`, { cause: error });
      if (request.signal?.aborted) throw new Error("OpenAI decision aborted", { cause: error });
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      combined.cleanup();
    }
  }
}
