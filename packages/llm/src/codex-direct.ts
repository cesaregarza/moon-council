import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { providerJsonSchema, unknownUsage, type UsageV2 } from "@werewolf/contracts";
import { promptFor } from "./prompt";
import type { DecisionProvider, DecisionRequest, DecisionResult, PreparedPrompt } from "./provider";

// Codex-login credentials against the Responses wire API, without the Codex agent SDK.
//
// The SDK starts a full agent session per decision. Regressing reported input tokens
// against measured request size over 102 attempts gave `reported = 1.53 * est + 9451`:
// a fixed ~9,450-token harness on every call -- roughly 63% of an average prompt -- for
// tool and sandbox features this lab disables outright. This transport sends only the
// four prompt layers and nothing else.
//
// The trade is caching. Prompt caching on this backend is scoped to a Codex thread: SDK
// retries reusing a session hit 3 of 3, while first attempts opening a new session hit
// 17 of 82, and bare direct calls never hit at all. A direct request cannot opt in,
// because the server assigns its own prompt_cache_key per response and ignores ours.
// Even so, ~5.5k uncached tokens beats ~15k tokens at 33% cached.
//
// OpenAI does not support driving the subscription backend this way: the endpoint, the
// mandatory-stream rule, the header set, and the accepted parameters may all change
// without notice. Keep the SDK adapter available as a fallback.

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";

interface CodexCredentials {
  accessToken: string;
  accountId: string;
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

let cached: { path: string; mtimeMs: number; credentials: CodexCredentials } | undefined;

/**
 * Re-reads auth.json whenever the CLI rewrites it, so a background token refresh is picked
 * up without restarting the runner.
 */
export async function loadCodexCredentials(path = join(codexHome(), "auth.json")): Promise<CodexCredentials> {
  const { mtimeMs } = await stat(path).catch(() => {
    throw new Error(`Codex credentials not found at ${path}; run \`codex login\``);
  });
  if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.credentials;
  const parsed = JSON.parse(await readFile(path, "utf8")) as { tokens?: Record<string, unknown> };
  const accessToken = parsed.tokens?.access_token;
  const accountId = parsed.tokens?.account_id;
  if (typeof accessToken !== "string" || !accessToken) throw new Error(`No access_token in ${path}; run \`codex login\``);
  if (typeof accountId !== "string" || !accountId) throw new Error(`No account_id in ${path}; run \`codex login\``);
  const credentials = { accessToken, accountId };
  cached = { path, mtimeMs, credentials };
  return credentials;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nested(value: unknown, key: string): number | null {
  return value && typeof value === "object" ? numberOrNull((value as Record<string, unknown>)[key]) : null;
}

function responsesUsage(value: unknown): UsageV2 {
  if (!value || typeof value !== "object") return unknownUsage();
  const usage = value as Record<string, unknown>;
  return {
    inputTokens: numberOrNull(usage.input_tokens),
    outputTokens: numberOrNull(usage.output_tokens),
    totalTokens: numberOrNull(usage.total_tokens),
    cachedInputTokens: nested(usage.input_tokens_details, "cached_tokens"),
    cacheWriteInputTokens: nested(usage.input_tokens_details, "cache_write_tokens"),
    reasoningTokens: nested(usage.output_tokens_details, "reasoning_tokens"),
  };
}

function outputText(response: Record<string, unknown>): string {
  const output = response.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    const content = item && typeof item === "object" ? (item as Record<string, unknown>).content : undefined;
    if (!Array.isArray(content)) continue;
    for (const chunk of content) {
      if (!chunk || typeof chunk !== "object") continue;
      const { type, text } = chunk as { type?: unknown; text?: unknown };
      if (typeof text === "string" && (type === undefined || type === "output_text")) parts.push(text);
    }
  }
  return parts.join("");
}

/**
 * Layers the prompt most-stable first so the longest identical prefix is shared across
 * seats: instructions, public state, the seat's private state, then the changing task.
 *
 * Ordering is the only available lever here. Measured against this backend on
 * gpt-5.6-luna, every explicit cache control is refused:
 *   prompt_cache_options    -> 400 "Unsupported parameter: prompt_cache_options"
 *   prompt_cache_breakpoint -> 400 "prompt_cache_breakpoint is not supported on this model"
 *   prompt_cache_key        -> accepted but ignored; the server returns its own fresh
 *                              UUID per response, so two identical 6,842-token prompts
 *                              three seconds apart both reported cached_tokens = 0.
 *
 * So this transport trades caching away for a far smaller prompt: it carries none of the
 * agent harness the SDK adds. Use the API-key `openai` provider when explicit prompt
 * caching is the goal.
 */
function layeredInput(prompt: PreparedPrompt): unknown[] {
  const layers: Array<{ role: "developer" | "user"; text: string | undefined }> = [
    { role: "developer", text: prompt.instructions },
    { role: "user", text: prompt.publicInput },
    { role: "user", text: prompt.privateInput },
    { role: "user", text: prompt.sharedInput },
    { role: "user", text: prompt.input },
  ];
  return layers
    .filter((layer): layer is { role: "developer" | "user"; text: string } => Boolean(layer.text))
    .map((layer) => ({ role: layer.role, content: [{ type: "input_text", text: layer.text }] }));
}

/**
 * Consumes the SSE body and returns the terminal response object. The backend rejects
 * non-streaming requests, so this is the only available shape.
 */
async function readStreamedResponse(body: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: Record<string, unknown> | undefined;
  let failure: string | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Split only on newlines; SSE payloads may contain U+2028, which splitting by "lines" would break.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type === "response.completed") completed = event.response as Record<string, unknown>;
      if (event.type === "response.failed" || event.type === "error") failure = JSON.stringify(event).slice(0, 400);
    }
  }
  if (failure) throw new Error(`Codex direct stream reported failure: ${failure}`);
  if (!completed) throw new Error("Codex direct stream ended without response.completed");
  return completed;
}

export interface CodexDirectProviderOptions {
  baseUrl?: string;
  timeoutMs?: number;
  loadCredentials?: () => Promise<CodexCredentials>;
  fetchImpl?: typeof fetch;
}

export class CodexDirectProvider implements DecisionProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly loadCredentials: () => Promise<CodexCredentials>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CodexDirectProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.CODEX_DIRECT_BASE_URL?.trim() ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? Number(process.env.CODEX_TIMEOUT_MS ?? 120_000);
    this.loadCredentials = options.loadCredentials ?? (() => loadCodexCredentials());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    if (!request.model.trim()) throw new Error("Codex direct provider requires a model");
    const prompt = promptFor(request);
    let usageReported = false;
    const reportUsage = (usage: UsageV2): void => {
      if (usageReported) return;
      usageReported = true;
      request.onUsage?.(usage, { provider: "codex_direct", model: request.model, outputLimitEnforced: true });
    };

    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("request timeout"));
    }, timeoutMs);
    const onExternalAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      if (request.signal?.aborted) throw new Error("request aborted");
      const credentials = await this.loadCredentials();
      const body = {
        model: request.model,
        store: false,
        // The subscription backend rejects non-streaming requests outright.
        stream: true,
        input: layeredInput(prompt),
        max_output_tokens: request.maxOutputTokens,
        ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
        text: {
          format: {
            type: "json_schema",
            name: request.schemaName,
            strict: true,
            schema: providerJsonSchema(request.schema) as Record<string, unknown>,
          },
        },
      };

      const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "chatgpt-account-id": credentials.accountId,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "OpenAI-Beta": "responses=experimental",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 400);
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Codex direct auth rejected (${response.status}); refresh with \`codex login\`: ${detail}`);
        }
        throw new Error(`Codex direct request failed (${response.status}): ${detail}`);
      }
      if (!response.body) throw new Error("Codex direct response had no body");

      const completed = await readStreamedResponse(response.body);
      const usage = responsesUsage(completed.usage);
      reportUsage(usage);
      const text = outputText(completed);
      if (!text) throw new Error("Codex direct response did not contain output text");
      request.onRawResponse?.(text);
      const data = request.schema.parse(JSON.parse(text));
      return {
        data,
        provider: "codex_direct",
        model: request.model,
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
        },
      };
    } catch (error) {
      reportUsage(unknownUsage());
      if (timedOut) throw new Error(`Codex direct decision timed out after ${timeoutMs}ms`, { cause: error });
      if (request.signal?.aborted) throw new Error("Codex direct decision aborted", { cause: error });
      throw error;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
