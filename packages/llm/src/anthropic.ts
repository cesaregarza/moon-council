import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import Anthropic from "@anthropic-ai/sdk";
import { providerJsonSchema, unknownUsage, type UsageV2 } from "@werewolf/contracts";
import { assertClaudePriced, claudeReservationUsd, isTokenCount } from "./anthropic-pricing";
import { promptFor } from "./prompt";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "./provider";
import { ClaudeWarmGate } from "./claude-warm-gate";
import {
  claudeErrorDiagnostics,
  retryableClaudeError,
  type ClaudeErrorDiagnostics,
} from "./anthropic-errors";
import { ClaudeSpendLedger } from "./spend-ledger";
import { mappedUsage, markedTtls, parseClaudeUsage, recordCostUsd } from "./anthropic-usage";

export { claudeResponseCostUsd, claudeUsage, parseClaudeUsage } from "./anthropic-usage";

/** `stop_reason: "refusal"`. No other model is tried: a silent switch would corrupt per-model results. */
export class ClaudeRefusalError extends Error {
  constructor(
    readonly category: string | null,
    explanation: string | null,
  ) {
    super(
      `Claude refused (${category ?? "uncategorized"})${explanation ? `: ${explanation}` : ""}`,
    );
  }
}
/** Rate limited on every attempt; each retry honoured retry-after. */
export class ClaudeRateLimitError extends Error {}

/**
 * Attempts per Claude call: one, plus up to two explicit retries of a retryable failure. The
 * SDK's own retries are off on every request, injected clients included, so every attempt is
 * admitted, reserved, sent and settled on its own. A retry waits what the API asks (Retry-After),
 * clamped to MAX_RETRY_WAIT_MS.
 */
export const CLAUDE_MAX_ATTEMPTS = 3;
export const MAX_RETRY_WAIT_MS = 60_000;

type ClaudeApiError = InstanceType<typeof Anthropic.APIError>;

/**
 * The wait the API asked for (retry-after-ms, then retry-after in seconds or as a date), clamped
 * to MAX_RETRY_WAIT_MS; without a usable header, backoff from 0.5 s, doubling to at most 8 s.
 */
export function retryDelayMs(error: ClaudeApiError, attempt: number): number {
  const header = (name: string) => error.headers?.get(name) ?? "";
  const ms = Number.parseFloat(header("retry-after-ms"));
  const seconds = Number.parseFloat(header("retry-after"));
  const asked = Number.isFinite(ms)
    ? ms
    : Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(header("retry-after")) - Date.now();
  if (asked > 0) return Math.min(asked, MAX_RETRY_WAIT_MS);
  return Math.min(500 * 2 ** (attempt - 1), 8_000);
}

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Always explicit: Opus 5.5 and Haiku 5.5 default to medium, other models to high. */
export function claudeEffort(value: string | undefined): Effort {
  if (EFFORTS.includes(value as Effort)) return value as Effort;
  return value === "none" || value === "minimal" ? "low" : "medium";
}

// Structured outputs reject these; the request's own zod schema still validates the result.
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);
export function claudeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(claudeJsonSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !UNSUPPORTED_SCHEMA_KEYS.has(key))
      .map(([key, value]) => [key, claudeJsonSchema(value)]),
  );
}

const FIVE_MINUTES = { type: "ephemeral", ttl: "5m" } as const;

/**
 * Baseline layout for agent_v3_1/agent_v3_2: l0 in `system`, then l1, shared input, l2 and l3 as
 * one user turn. Breakpoints sit only at the end of l0 and l1; per-call private content is never
 * written to the cache (CES-1038: l2 is 76-80% of a request and almost never repeats). A session
 * harness's own request (CES-1556) is sent unchanged instead.
 */
export function claudeMessages(request: DecisionRequest<unknown>): {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
} {
  if (request.claudeHarness)
    return { system: request.claudeHarness.system, messages: request.claudeHarness.messages };
  const prompt = promptFor(request);
  const format = request.apiResponseFormat;
  const text = (value: string, cached = false): Anthropic.TextBlockParam => ({
    type: "text",
    text: value,
    ...(cached ? { cache_control: FIVE_MINUTES } : {}),
  });
  const content = [
    ...(prompt.publicInput ? [text(prompt.publicInput, true)] : []),
    ...[prompt.sharedInput, prompt.privateInput, prompt.input]
      .filter((value): value is string => Boolean(value))
      .map((value) => text(value)),
  ];
  return {
    system: [text(prompt.instructions + (format ? `\n\n${format.instructions}` : ""), true)],
    messages: [{ role: "user", content }],
  };
}

/** Current-model rules: adaptive thinking, explicit effort, structured output, no sampling knobs. */
export function claudeRequest<T>(
  request: DecisionRequest<T>,
  maxTokensCap: number,
): Anthropic.MessageCreateParamsNonStreaming {
  const schema = providerJsonSchema(request.apiResponseFormat?.schema ?? request.schema);
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? maxTokensCap,
    ...claudeMessages(request as DecisionRequest<unknown>),
    ...(request.claudeHarness?.automaticCache ? { cache_control: FIVE_MINUTES } : {}),
    thinking: { type: "adaptive" },
    output_config: {
      effort: claudeEffort(request.reasoningEffort),
      format: { type: "json_schema", schema: claudeJsonSchema(schema) as Record<string, unknown> },
    },
  };
}

/** Content whose cost its serialized bytes cannot bound (images, documents, tool traffic). */
export class UnboundedClaudeContentError extends Error {
  override name = "UnboundedClaudeContentError";
}

type ClaudeBody = Anthropic.MessageCreateParamsNonStreaming;
const blocksOf = (messages: Anthropic.MessageParam[]) =>
  messages.flatMap((message) => (typeof message.content === "string" ? [] : message.content));
/** A session's replayed turns may carry the model's own thinking; its recorded usage bounds it. */
const REPLAYED_BLOCK_TYPES = new Set(["text", "thinking", "redacted_thinking"]);

/**
 * Moon Council sends text only. Any other block (an image, a document, a URL- or file-backed
 * source) costs what it references, not what it serializes to, so it is refused before admission.
 * The one exception is a session's replayed history, when `replayedTokens` (the previous turn's
 * recorded prompt plus reply) bounds it: there the model's own thinking blocks may return.
 */
function assertBoundedContent(body: ClaudeBody, replayedTokens: number | undefined): void {
  const replayed = replayedTokens === undefined ? [] : body.messages.slice(0, -1);
  const fresh = replayedTokens === undefined ? body.messages : body.messages.slice(-1);
  const unbounded = [
    ...(Array.isArray(body.system) ? body.system : []).filter((block) => block.type !== "text"),
    ...blocksOf(fresh).filter((block) => block.type !== "text"),
    ...blocksOf(replayed).filter((block) => !REPLAYED_BLOCK_TYPES.has(block.type)),
  ][0];
  if (unbounded)
    throw new UnboundedClaudeContentError(
      `Claude request holds a ${unbounded.type} block that its bytes or recorded usage cannot bound`,
    );
}

/**
 * Upper bound on prompt tokens before sending: a token is never shorter than a UTF-8 byte, and
 * the exact serialized body (envelope included) holds every byte the prompt can take. A session's
 * replayed history counts at its recorded tokens instead, plus the body without that history.
 */
function promptCeilingTokens(body: ClaudeBody, replayedTokens: number | undefined): number {
  if (replayedTokens === undefined) return Buffer.byteLength(JSON.stringify(body), "utf8");
  const rest = { ...body, messages: body.messages.slice(-1) };
  return replayedTokens + Buffer.byteLength(JSON.stringify(rest), "utf8");
}

/** We only ever send whole, positive output caps (our policy, not a claim about the API). */
const isOutputCap = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export class InvalidClaudeOutputCapError extends Error {
  override name = "InvalidClaudeOutputCapError";
}

/** The default output cap: the option, else ANTHROPIC_MAX_OUTPUT_TOKENS, else 16000. */
function configuredOutputCap(option: number | undefined): number {
  if (option !== undefined) {
    if (!isOutputCap(option))
      throw new InvalidClaudeOutputCapError(`Invalid Claude output cap: ${String(option)}`);
    return option;
  }
  const raw = process.env.ANTHROPIC_MAX_OUTPUT_TOKENS;
  if (raw === undefined || raw.trim() === "") return 16_000;
  const cap = Number(raw);
  if (!isOutputCap(cap))
    throw new InvalidClaudeOutputCapError(`Invalid ANTHROPIC_MAX_OUTPUT_TOKENS: ${raw}`);
  return cap;
}

export interface ClaudeClient {
  messages: {
    stream(
      body: Anthropic.MessageStreamParams,
      options?: Anthropic.RequestOptions,
    ): {
      on(event: "streamEvent", listener: (event: Anthropic.MessageStreamEvent) => void): unknown;
      finalMessage(): Promise<Anthropic.Message>;
      abort(): void;
    };
  };
}

export interface ClaudeProviderOptions {
  client?: ClaudeClient;
  apiKey?: string;
  ledger?: Pick<ClaudeSpendLedger, "reserve" | "settle">;
  warmGate?: ClaudeWarmGate;
  /** Output cap when a request sets none; `max_tokens` is required by the API. */
  maxTokensCap?: number;
}

export class AnthropicMessagesProvider implements DecisionProvider {
  private readonly client: ClaudeClient;
  private readonly ledger: Pick<ClaudeSpendLedger, "reserve" | "settle">;
  private readonly maxTokensCap: number;
  private readonly warmGate: ClaudeWarmGate;

  constructor(options: ClaudeProviderOptions = {}) {
    if (options.client) this.client = options.client;
    else {
      const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic");
      // No hidden retries: decide() retries itself, reserving every attempt.
      this.client = new Anthropic({ apiKey, maxRetries: 0 });
    }
    this.ledger = options.ledger ?? new ClaudeSpendLedger();
    this.warmGate = options.warmGate ?? new ClaudeWarmGate();
    this.maxTokensCap = configuredOutputCap(options.maxTokensCap);
  }

  /** Anthropic keeps no conversation state: every call re-sends the full prompt. */
  releaseSession(): void {}

  async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    const body = claudeRequest(request, this.maxTokensCap);
    if (!isOutputCap(body.max_tokens))
      throw new InvalidClaudeOutputCapError(
        `Claude output cap must be a positive safe integer; got ${String(body.max_tokens)}`,
      );
    assertClaudePriced(body.model);
    // An invalid recorded count is never trusted: the history is then bounded by its bytes, and
    // replayed thinking (which bytes cannot bound) is refused.
    const recorded = request.claudeHarness?.replayedTokens;
    const replayedTokens = isTokenCount(recorded) ? recorded : undefined;
    assertBoundedContent(body, replayedTokens);
    if (request.signal?.aborted) throw new Error("Claude decision aborted");
    const reservation = claudeReservationUsd(
      body.model,
      promptCeilingTokens(body, replayedTokens),
      body.max_tokens,
    );
    const call: ClaudeCall = { recordedUsd: 0, held: false, attempts: 0, transportFailures: [] };
    const reported: { usage: boolean; metadata: Record<string, unknown> | null } = {
      usage: false,
      metadata: null,
    };
    const tracked: DecisionRequest<T> = {
      ...request,
      onUsage: (usage, metadata) => {
        reported.usage = true;
        request.onUsage?.(usage, metadata);
      },
      onProviderMetadata: (metadata) => {
        reported.metadata = metadata;
        request.onProviderMetadata?.(metadata);
      },
    };
    const signals = [request.signal, request.timeoutMs && AbortSignal.timeout(request.timeoutMs)];
    const signal = AbortSignal.any(signals.filter((s): s is AbortSignal => Boolean(s)));
    try {
      request.onProviderRequest?.(body as unknown as Record<string, unknown>);
      for (let attempt = 1; ; attempt++) {
        try {
          const sent = await this.attempt(body, reservation, signal, call, request);
          const spend = claudeSpendMetadata(call, sent.cost);
          return claudeResult(tracked, sent.message, spend, sent.usage);
        } catch (error) {
          if (error instanceof Anthropic.APIError)
            call.transportFailures.push(claudeErrorDiagnostics(error, signal));
          if (!retryableClaudeError(error, signal) || attempt >= CLAUDE_MAX_ATTEMPTS) throw error;
          await sleep(retryDelayMs(error, attempt), undefined, { signal });
        }
      }
    } catch (error) {
      if (call.attempts > 0 && !reported.usage)
        request.onUsage?.(unknownUsage(), {
          provider: "anthropic",
          model: body.model,
          outputLimitEnforced: true,
        });
      if (call.attempts > 0)
        request.onProviderMetadata?.(
          claudeFailureMetadata(call, body.model, error, signal, reported.metadata),
        );
      throw claudeFailure(error, signal);
    }
  }

  /**
   * One attempt: admit and reserve its worst case, send, then settle. It settles at its actual
   * cost when usage parses (Rule U); a failure or unknown usage keeps the reservation, and so does
   * a settle that throws.
   */
  private async attempt(
    body: Anthropic.MessageCreateParamsNonStreaming,
    reservation: number,
    signal: AbortSignal,
    call: ClaudeCall,
    request: Pick<DecisionRequest<unknown>, "admitSpend" | "claudeHarness">,
  ) {
    signal.throwIfAborted();
    const id = randomUUID();
    // In order and with no await between: the game admits the call's running total (what earlier
    // attempts hold, plus this attempt), then the month reserves this attempt.
    request.admitSpend?.(call.recordedUsd + reservation);
    signal.throwIfAborted();
    this.ledger.reserve(id, reservation);
    call.attempts += 1;
    let cost: number | null = null;
    try {
      const message = await this.streamOnce(body, signal, request.claudeHarness?.warmGateKey);
      // Usage is parsed once; the settled cost and the reported usage both come from it.
      const record = parseClaudeUsage(message.usage);
      cost = recordCostUsd(body.model, record, markedTtls(body));
      return { message, cost, usage: mappedUsage(record) };
    } finally {
      // Until settle returns, the ledger holds the reservation.
      const heldBefore = call.held;
      call.recordedUsd += reservation;
      call.held = true;
      this.ledger.settle(id, cost ?? reservation);
      if (cost !== null) {
        call.recordedUsd += cost - reservation;
        call.held = heldBefore;
      }
    }
  }

  /** Streams one request; a gated request releases the gate at its first content block. */
  private async streamOnce(
    body: Anthropic.MessageCreateParamsNonStreaming,
    signal: AbortSignal,
    warmGateKey: string | undefined,
  ): Promise<Anthropic.Message> {
    const release = warmGateKey ? await this.warmGate.enter(warmGateKey, signal) : undefined;
    try {
      // maxRetries 0 on the request itself: an injected client's own retries are off too.
      signal.throwIfAborted();
      const stream = this.client.messages.stream(body, { signal, maxRetries: 0 });
      stream.on("streamEvent", (event) => {
        if (event.type === "content_block_start") release?.(true);
      });
      const message = await stream.finalMessage();
      release?.(true);
      return message;
    } finally {
      release?.(false);
    }
  }
}

/**
 * What a call's attempts recorded in the ledger. `held` is set once any attempt settled at its
 * reservation: the call's cost is then unknown, and only the recorded total is reported.
 */
interface ClaudeCall {
  recordedUsd: number;
  held: boolean;
  /** Attempts sent so far (admitted and reserved). */
  attempts: number;
  transportFailures: ClaudeErrorDiagnostics[];
}

/** Spend reflects every explicit attempt, including conservatively settled unknown usage. */
function claudeSpendMetadata(call: ClaudeCall, cost: number | null) {
  return {
    ...(call.held ? { heldUsd: call.recordedUsd } : { costUsd: cost! }),
    attempts: call.attempts,
    ...(call.transportFailures.length ? { transportFailures: call.transportFailures } : {}),
  };
}

/** A parse failure already reported actual spend; diagnostics must not replace it with a hold. */
function claudeFailureMetadata(
  call: ClaudeCall,
  model: string,
  error: unknown,
  signal: AbortSignal,
  reported: Record<string, unknown> | null,
) {
  return {
    ...(reported ?? { model, heldUsd: call.recordedUsd, attempts: call.attempts }),
    errorDiagnostics: claudeErrorDiagnostics(error, signal),
    ...(call.transportFailures.length ? { transportFailures: call.transportFailures } : {}),
  };
}

/** Records usage and metadata, then decodes the structured answer. */
function claudeResult<T>(
  request: DecisionRequest<T>,
  message: Anthropic.Message,
  spend: ({ costUsd: number } | { heldUsd: number }) & {
    attempts: number;
    transportFailures?: ClaudeErrorDiagnostics[];
  },
  usage: UsageV2,
): DecisionResult<T> {
  request.onUsage?.(usage, {
    provider: "anthropic",
    model: message.model,
    outputLimitEnforced: true,
  });
  request.onClaudeReply?.({ content: message.content, stopReason: message.stop_reason, usage });
  request.onProviderMetadata?.({
    responseId: message.id,
    model: message.model,
    stopReason: message.stop_reason,
    stopDetails: message.stop_details ?? null,
    // costUsd only when every attempt settled at its actual cost; otherwise what was held. Also
    // how many attempts were sent.
    ...spend,
  });
  if (message.stop_reason === "refusal")
    throw new ClaudeRefusalError(
      message.stop_details?.category ?? null,
      message.stop_details?.explanation ?? null,
    );
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  if (text) request.onRawResponse?.(text);
  if (message.stop_reason !== "end_turn")
    throw new Error(`Claude response incomplete: ${message.stop_reason}`);
  const parsed = JSON.parse(text);
  return {
    data: request.schema.parse(
      request.apiResponseFormat ? request.apiResponseFormat.decode(parsed) : parsed,
    ),
    provider: "anthropic",
    model: message.model,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    },
    content: message.content,
  };
}

/** Names rate-limit and timeout failures; everything else propagates unchanged. */
function claudeFailure(error: unknown, signal: AbortSignal): unknown {
  if (error instanceof Anthropic.RateLimitError)
    return new ClaudeRateLimitError("Claude rate limit persisted on every attempt", {
      cause: error,
    });
  if (signal.aborted && !(error instanceof ClaudeRefusalError))
    return new Error("Claude decision aborted or timed out", { cause: error });
  return error;
}
