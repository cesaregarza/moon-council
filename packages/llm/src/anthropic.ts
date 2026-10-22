import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { providerJsonSchema, unknownUsage, type UsageV2 } from "@werewolf/contracts";
import {
  assertClaudePriced,
  claudeCostUsd,
  claudeReservationUsd,
  isTokenCount,
} from "./anthropic-pricing";
import { promptFor } from "./prompt";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "./provider";
import { ClaudeWarmGate } from "./claude-warm-gate";
import { ClaudeSpendLedger } from "./spend-ledger";

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
/** Rate limited after the SDK's own retries, which honour retry-after, ran out. */
export class ClaudeRateLimitError extends Error {}

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

/** A reply's usage after validation (Rule U); everything downstream derives from it. */
interface ClaudeUsageRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The TTL split, only when both components are valid and account for every write. */
  split: { fiveMinutes: number; oneHour: number } | null;
  thinking: number | null;
}

/** A cache count may be null or absent (zero); anything else must be a valid count. */
const cacheCount = (value: unknown): number | undefined =>
  value === null || value === undefined ? 0 : isTokenCount(value) ? value : undefined;

/**
 * Parses raw SDK usage once. Null means unknown usage: a required count (input or output) is
 * not a valid count, or a cache count is invalid. A null TTL component is never zero.
 */
export function parseClaudeUsage(usage: unknown): ClaudeUsageRecord | null {
  if (!usage || typeof usage !== "object") return null;
  const raw = usage as Record<string, unknown>;
  const cacheRead = cacheCount(raw.cache_read_input_tokens);
  const cacheWrite = cacheCount(raw.cache_creation_input_tokens);
  const { input_tokens: input, output_tokens: output } = raw;
  if (!isTokenCount(input) || !isTokenCount(output)) return null;
  if (cacheRead === undefined || cacheWrite === undefined) return null;
  const split = (raw.cache_creation ?? {}) as Record<string, unknown>;
  const [fiveMinutes, oneHour] = [split.ephemeral_5m_input_tokens, split.ephemeral_1h_input_tokens];
  const complete =
    isTokenCount(fiveMinutes) && isTokenCount(oneHour) && fiveMinutes + oneHour === cacheWrite;
  const thinking = (raw.output_tokens_details as Record<string, unknown> | null | undefined)
    ?.thinking_tokens;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    split: complete ? { fiveMinutes, oneHour } : null,
    thinking: isTokenCount(thinking) ? thinking : null,
  };
}

/** Anthropic's input_tokens excludes cache reads and writes; UsageV2.inputTokens includes them. */
function mappedUsage(record: ClaudeUsageRecord | null): UsageV2 {
  if (!record) return unknownUsage();
  const inputTokens = record.input + record.cacheRead + record.cacheWrite;
  return {
    inputTokens,
    outputTokens: record.output,
    totalTokens: inputTokens + record.output,
    cachedInputTokens: record.cacheRead,
    cacheWriteInputTokens: record.cacheWrite,
    reasoningTokens: record.thinking,
  };
}

export function claudeUsage(usage: Anthropic.Usage | undefined): UsageV2 {
  return mappedUsage(parseClaudeUsage(usage));
}

/** Cache TTLs the request marked, on blocks or as the top-level marker ("5m" when unset). */
function markedTtls(body: Anthropic.MessageCreateParamsNonStreaming): Set<string> {
  const blocks = [
    ...(Array.isArray(body.system) ? body.system : []),
    ...body.messages.flatMap((message) =>
      typeof message.content === "string" ? [] : message.content,
    ),
  ];
  const marks = [
    body.cache_control,
    ...blocks.map((block) => ("cache_control" in block ? block.cache_control : undefined)),
  ].filter((mark): mark is Anthropic.CacheControlEphemeral => Boolean(mark));
  return new Set(marks.map((mark) => mark.ttl ?? "5m"));
}

/**
 * Trusted cost of a validated usage record, or null when usage is unknown (the caller keeps its
 * reservation). Writes use the TTL split when it is complete; otherwise they are priced at
 * 5 minutes only if the request marked nothing else, and at the 1-hour rate when its markers
 * were mixed or unknown.
 */
function recordCostUsd(
  model: string,
  record: ClaudeUsageRecord | null,
  marked?: Set<string>,
): number | null {
  if (!record) return null;
  const only5m =
    marked !== undefined && marked.size > 0 && [...marked].every((ttl) => ttl === "5m");
  const write1h = record.split ? record.split.oneHour : only5m ? 0 : record.cacheWrite;
  const cost = claudeCostUsd(model, {
    uncachedInput: record.input,
    cacheRead: record.cacheRead,
    cacheWrite5m: record.cacheWrite - write1h,
    cacheWrite1h: write1h,
    output: record.output,
  });
  return Number.isFinite(cost) ? cost : null;
}

export function claudeResponseCostUsd(
  model: string,
  usage: Anthropic.Usage,
  marked?: Set<string>,
): number | null {
  return recordCostUsd(model, parseClaudeUsage(usage), marked);
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
      // SDK retries (default 2) honour retry-after; exhaustion becomes ClaudeRateLimitError.
      this.client = new Anthropic({ apiKey });
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
    const replayedTokens = request.claudeHarness?.replayedTokens;
    assertBoundedContent(body, replayedTokens);
    if (request.signal?.aborted) throw new Error("Claude decision aborted");
    const reservationId = randomUUID();
    const reservation = claudeReservationUsd(
      body.model,
      promptCeilingTokens(body, replayedTokens),
      body.max_tokens,
    );
    // One figure, in order and with no await between: the game admits it, the month reserves it.
    request.admitSpend?.(reservation);
    this.ledger.reserve(reservationId, reservation);
    const spent = { usd: reservation }; // unknown usage keeps the worst case
    let usageReported = false;
    const tracked: DecisionRequest<T> = {
      ...request,
      onUsage: (usage, metadata) => {
        usageReported = true;
        request.onUsage?.(usage, metadata);
      },
    };
    const signals = [request.signal, request.timeoutMs && AbortSignal.timeout(request.timeoutMs)];
    const signal = AbortSignal.any(signals.filter((s): s is AbortSignal => Boolean(s)));
    try {
      request.onProviderRequest?.(body as unknown as Record<string, unknown>);
      const message = await this.streamOnce(body, signal, request.claudeHarness?.warmGateKey);
      // Invalid raw usage yields no cost: the held reservation settles, and no cost is trusted.
      // Usage is parsed once; the settled cost and the reported usage both come from it.
      const record = parseClaudeUsage(message.usage);
      const cost = recordCostUsd(body.model, record, markedTtls(body));
      if (cost !== null) spent.usd = cost;
      return claudeResult(tracked, message, cost, mappedUsage(record));
    } catch (error) {
      if (!usageReported)
        request.onUsage?.(unknownUsage(), {
          provider: "anthropic",
          model: body.model,
          outputLimitEnforced: true,
        });
      throw claudeFailure(error, signal);
    } finally {
      this.ledger.settle(reservationId, spent.usd);
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
      const stream = this.client.messages.stream(body, { signal });
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

/** Records usage and metadata, then decodes the structured answer. */
function claudeResult<T>(
  request: DecisionRequest<T>,
  message: Anthropic.Message,
  costUsd: number | null,
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
    ...(costUsd === null ? {} : { costUsd }),
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
    return new ClaudeRateLimitError("Claude rate limit persisted after SDK retries", {
      cause: error,
    });
  if (signal.aborted && !(error instanceof ClaudeRefusalError))
    return new Error("Claude decision aborted or timed out", { cause: error });
  return error;
}
