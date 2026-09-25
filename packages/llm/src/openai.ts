import OpenAI from "openai";
import { cacheComparisonGroup, openAIRequest } from "./openai-cache";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "./provider";
import { unknownUsage, type UsageV2 } from "@werewolf/contracts";

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
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

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
} {
  if (!first) return { signal: second, cleanup: () => undefined };
  if (!second) return { signal: first, cleanup: () => undefined };
  const controller = new AbortController();
  const abort = (source: AbortSignal) => controller.abort(source.reason);
  const onFirst = () => abort(first),
    onSecond = () => abort(second);
  first.addEventListener("abort", onFirst, { once: true });
  second.addEventListener("abort", onSecond, { once: true });
  if (first.aborted) abort(first);
  else if (second.aborted) abort(second);
  return {
    signal: controller.signal,
    cleanup: () => {
      first.removeEventListener("abort", onFirst);
      second.removeEventListener("abort", onSecond);
    },
  };
}

export class OpenAIResponsesProvider implements DecisionProvider {
  private readonly client: OpenAI;
  private readonly comparisons = new Map<string, { id: string; at: number }>();

  constructor(apiKey = process.env.OPENAI_API_KEY) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
    // The application owns and records retries; SDK retries would bypass the attempt ledger.
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
  }

  async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    const initialBody = openAIRequest(request);
    const group = cacheComparisonGroup(request, initialBody);
    const baseline = group ? this.comparisons.get(group) : undefined;
    const comparisonId =
      request.cacheComparisonResponseId ??
      (baseline && Date.now() - baseline.at < 30 * 60_000 ? baseline.id : undefined);
    const body = comparisonId ? openAIRequest(request, comparisonId) : initialBody;
    let responseModel = request.model;
    let usageReported = false;
    const reportUsage = (usage: UsageV2): void => {
      if (usageReported) return;
      usageReported = true;
      request.onUsage?.(usage, {
        provider: "openai",
        model: responseModel,
        outputLimitEnforced: request.maxOutputTokens !== null,
      });
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
      request.onProviderRequest?.(body as unknown as Record<string, unknown>);
      const response = await this.client.responses.create(body, {
        ...(combined.signal ? { signal: combined.signal } : {}),
        ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}),
      });
      responseModel = response.model || request.model;
      request.onProviderMetadata?.({
        responseId: response.id ?? null,
        status: response.status ?? null,
        model: responseModel,
        serviceTier: response.service_tier ?? null,
        cacheLayout: body.prompt_cache_options ? "openai_layers_v2" : "implicit",
        cacheDiagnostics: response.prompt_cache_diagnostics ?? null,
        incompleteReason: response.incomplete_details?.reason ?? null,
      });
      if (group && response.status === "completed" && response.id) {
        this.comparisons.delete(group);
        this.comparisons.set(group, { id: response.id, at: Date.now() });
        if (this.comparisons.size > 128)
          this.comparisons.delete(this.comparisons.keys().next().value!);
      }
      const usage = openAiUsage(response.usage);
      reportUsage(usage);
      if (response.output_text) request.onRawResponse?.(response.output_text);
      if (response.status !== "completed")
        throw new Error(
          `OpenAI response ${response.status}: ${response.incomplete_details?.reason ?? "no completed result"}`,
        );
      if (!response.output_text) throw new Error("OpenAI response did not contain output_text");
      const parsed = JSON.parse(response.output_text);
      const data = request.schema.parse(
        request.apiResponseFormat ? request.apiResponseFormat.decode(parsed) : parsed,
      );
      return {
        data,
        provider: "openai",
        model: responseModel,
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
        },
      };
    } catch (error) {
      reportUsage(unknownUsage());
      if (timedOut)
        throw new Error(`OpenAI decision timed out after ${request.timeoutMs}ms`, { cause: error });
      if (request.signal?.aborted) throw new Error("OpenAI decision aborted", { cause: error });
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      combined.cleanup();
    }
  }
}
