import type Anthropic from "@anthropic-ai/sdk";
import { unknownUsage, type UsageV2 } from "@werewolf/contracts";
import { claudeCostUsd, isTokenCount } from "./anthropic-pricing";

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
export function mappedUsage(record: ClaudeUsageRecord | null): UsageV2 {
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
export function markedTtls(body: Anthropic.MessageCreateParamsNonStreaming): Set<string> {
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
export function recordCostUsd(
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
