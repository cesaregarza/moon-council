import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Codex,
  type CodexOptions,
  type ModelReasoningEffort,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
} from "@openai/codex-sdk";
import { providerJsonSchema, unknownUsage, type UsageV2 } from "@werewolf/contracts";
import { z } from "zod";
import { promptFor } from "./prompt";
import type { DecisionProvider, DecisionRequest, DecisionResult, PreparedPrompt } from "./provider";

interface CodexTurnLike {
  finalResponse: string;
  usage: Usage | null;
}

interface CodexThreadLike {
  run(input: string, options?: TurnOptions): Promise<CodexTurnLike>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
}

export interface CodexLoginProviderOptions {
  createClient?: (options: CodexOptions) => CodexClientLike;
  codexPath?: string;
  environment?: Record<string, string>;
  reasoningEffort?: ModelReasoningEffort;
  tempRoot?: string;
  timeoutMs?: number;
}

const reasoningEfforts = new Set<ModelReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
]);

const inheritedEnvironmentKeys = [
  "ALL_PROXY",
  "CODEX_CA_CERTIFICATE",
  "CODEX_HOME",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_FILE",
  "TMPDIR",
  "USER",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

function inheritedCodexEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of inheritedEnvironmentKeys) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

function configuredReasoningEffort(
  value = process.env.CODEX_REASONING_EFFORT,
): ModelReasoningEffort {
  const effort = (value?.trim() || "medium") as ModelReasoningEffort;
  if (!reasoningEfforts.has(effort)) {
    throw new Error(`Unsupported CODEX_REASONING_EFFORT: ${value}`);
  }
  return effort;
}

function configuredTimeout(value = process.env.CODEX_TIMEOUT_MS): number {
  if (!value) return 120_000;
  const milliseconds = Number(value);
  if (!Number.isInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("CODEX_TIMEOUT_MS must be a positive integer");
  }
  return milliseconds;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function codexUsage(value: Usage | null | undefined): UsageV2 {
  if (!value) return unknownUsage();
  return {
    inputTokens: numberOrNull(value.input_tokens),
    outputTokens: numberOrNull(value.output_tokens),
    totalTokens:
      typeof value.input_tokens === "number" && typeof value.output_tokens === "number"
        ? value.input_tokens + value.output_tokens
        : null,
    cachedInputTokens: numberOrNull(value.cached_input_tokens),
    cacheWriteInputTokens: numberOrNull(value.cache_write_input_tokens),
    reasoningTokens: numberOrNull(value.reasoning_output_tokens),
  };
}

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal {
  if (!first) return second!;
  if (!second) return first;
  const controller = new AbortController();
  const abort = (source: AbortSignal) => controller.abort(source.reason);
  first.addEventListener("abort", () => abort(first), { once: true });
  second.addEventListener("abort", () => abort(second), { once: true });
  if (first.aborted) abort(first);
  else if (second.aborted) abort(second);
  return controller.signal;
}

export class CodexLoginProvider implements DecisionProvider {
  private readonly createClient: (options: CodexOptions) => CodexClientLike;
  private readonly codexPath?: string;
  private readonly environment: Record<string, string>;
  private readonly reasoningEffort: ModelReasoningEffort;
  private readonly tempRoot: string;
  private readonly timeoutMs: number;
  private readonly sessions = new Map<
    string,
    { thread: CodexThreadLike; workingDirectory: string }
  >();

  constructor(options: CodexLoginProviderOptions = {}) {
    this.createClient = options.createClient ?? ((codexOptions) => new Codex(codexOptions));
    this.codexPath = options.codexPath ?? (process.env.CODEX_BIN?.trim() || undefined);
    this.environment = options.environment ?? inheritedCodexEnvironment();
    this.reasoningEffort = options.reasoningEffort ?? configuredReasoningEffort();
    this.tempRoot = options.tempRoot ?? tmpdir();
    this.timeoutMs = options.timeoutMs ?? configuredTimeout();
  }

  private async startDecisionSession(
    model: string,
    prompt: PreparedPrompt,
    reasoningEffort: ModelReasoningEffort,
  ) {
    const workingDirectory = await mkdtemp(join(this.tempRoot, "werewolf-codex-"));
    const client = this.createClient({
      ...(this.codexPath ? { codexPathOverride: this.codexPath } : {}),
      env: this.environment,
      config: {
        check_for_update_on_startup: false,
        // Same OpenAI/ChatGPT service and login; an alias is needed because built-in IDs
        // cannot be overridden. The application, not the CLI transport, owns retries.
        model_provider: "werewolf-login",
        model_providers: {
          "werewolf-login": {
            name: "OpenAI",
            requires_openai_auth: true,
            wire_api: "responses",
            request_max_retries: 0,
            stream_max_retries: 0,
            supports_websockets: false,
          },
        },
        developer_instructions: `${prompt.instructions}\nDo not call tools or inspect the local system. Return only JSON matching the supplied output schema.`,
        feedback: { enabled: false },
        hide_agent_reasoning: true,
        history: { persistence: "none" },
        memories: { generate_memories: false, use_memories: false },
        project_doc_max_bytes: 0,
        show_raw_agent_reasoning: false,
        web_search: "disabled",
        features: {
          apps: false,
          goals: false,
          hooks: false,
          memories: false,
          multi_agent: false,
          shell_snapshot: false,
          shell_tool: false,
          skill_mcp_dependency_install: false,
          unified_exec: false,
          web_search: false,
        },
      },
      configOverrides: ["mcp_servers={}", "plugins={}"],
    });
    const thread = client.startThread({
      model,
      sandboxMode: "read-only",
      workingDirectory,
      skipGitRepoCheck: true,
      modelReasoningEffort: reasoningEffort,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
    });
    return { thread, workingDirectory };
  }

  async releaseSession(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    this.sessions.delete(sessionKey);
    await rm(session.workingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    if (!request.model.trim()) throw new Error("Codex login provider requires a model");
    const prompt = promptFor(request);
    const abortController = new AbortController();
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort(new Error("request timeout"));
    }, timeoutMs);
    const signal = combineSignals(request.signal, abortController.signal);
    let transientSession: { thread: CodexThreadLike; workingDirectory: string } | undefined;
    let usageReported = false;
    const reportUsage = (usage: UsageV2): void => {
      if (usageReported) return;
      usageReported = true;
      request.onUsage?.(usage, {
        provider: "codex",
        model: request.model,
        outputLimitEnforced: false,
      });
    };

    try {
      if (request.signal?.aborted) throw new Error("request aborted");
      const reasoningEffort = request.reasoningEffort
        ? configuredReasoningEffort(request.reasoningEffort)
        : this.reasoningEffort;
      const existing = request.sessionKey ? this.sessions.get(request.sessionKey) : undefined;
      const session =
        existing ?? (await this.startDecisionSession(request.model, prompt, reasoningEffort));
      if (request.sessionKey && !existing) this.sessions.set(request.sessionKey, session);
      if (!request.sessionKey) transientSession = session;
      if (signal.aborted) throw signal.reason ?? new Error("request aborted");
      const firstInput = [prompt.publicInput, prompt.privateInput, prompt.sharedInput, prompt.input]
        .filter((part): part is string => Boolean(part))
        .join("\n");
      const turn = await session.thread.run(existing ? prompt.input : firstInput, {
        outputSchema: providerJsonSchema(request.schema) as Record<string, unknown>,
        signal,
      });
      const usage = codexUsage(turn.usage);
      reportUsage(usage);
      if (!turn.finalResponse) throw new Error("Codex response did not contain a final response");
      request.onRawResponse?.(turn.finalResponse);
      const data = request.schema.parse(JSON.parse(turn.finalResponse));
      return {
        data,
        provider: "codex",
        model: request.model,
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
        },
      };
    } catch (error) {
      reportUsage(unknownUsage());
      if (timedOut)
        throw new Error(`Codex decision timed out after ${timeoutMs}ms`, { cause: error });
      if (request.signal?.aborted) throw new Error("Codex decision aborted", { cause: error });
      throw error;
    } finally {
      clearTimeout(timeout);
      if (transientSession)
        await rm(transientSession.workingDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
    }
  }
}
