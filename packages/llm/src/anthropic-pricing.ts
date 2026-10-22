import type { UsageV2 } from "@werewolf/contracts";

/** USD per million tokens. */
export interface ClaudeRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}
interface ClaudePrice {
  standard: ClaudeRates;
  /** Higher rates when the prompt, counting cache reads and writes, exceeds `threshold` tokens. */
  long?: { threshold: number; rates: ClaudeRates };
}

/**
 * Anthropic first-party prices from https://platform.claude.com/docs/en/about-claude/pricing,
 * read 2026-10-22. A model missing here cannot be admitted.
 */
export const CLAUDE_PRICES: Readonly<Record<string, ClaudePrice>> = {
  "claude-opus-5-5": {
    standard: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  },
  "claude-sonnet-5-5": {
    standard: { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  },
  "claude-haiku-5-5": {
    standard: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
    long: {
      threshold: 100_000,
      rates: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 },
    },
  },
};

export class UnpricedModelError extends Error {}

function claudePrice(model: string): ClaudePrice {
  const price = CLAUDE_PRICES[model];
  if (!price) throw new UnpricedModelError(`No Claude price for ${model}; it cannot be admitted`);
  return price;
}

export function assertClaudePriced(model: string): void {
  claudePrice(model);
}

export interface ClaudeTokens {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

export function claudeCostUsd(model: string, tokens: ClaudeTokens): number {
  const price = claudePrice(model);
  const prompt =
    tokens.uncachedInput + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
  const rates = price.long && prompt > price.long.threshold ? price.long.rates : price.standard;
  return (
    (tokens.uncachedInput * rates.input +
      tokens.cacheRead * rates.cacheRead +
      tokens.cacheWrite5m * rates.cacheWrite5m +
      tokens.cacheWrite1h * rates.cacheWrite1h +
      tokens.output * rates.output) /
    1_000_000
  );
}

/**
 * Worst case before sending: every prompt token written to cache at the 1-hour rate, plus the
 * whole output cap. `promptCeilingTokens` must be an upper bound (such as the prompt's UTF-8 byte
 * length); when it exceeds a long-context threshold, the whole call is priced at the higher tier.
 */
export function claudeReservationUsd(
  model: string,
  promptCeilingTokens: number,
  maxOutputTokens: number,
): number {
  return claudeCostUsd(model, {
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: promptCeilingTokens,
    output: maxOutputTokens,
  });
}

/**
 * Settled cost from mapped usage (inputTokens includes cache reads and writes). Usage does not
 * split writes by TTL, so writes are priced at the 1-hour rate; an unknown split is priced as
 * writes. Returns null when usage is unknown, so callers keep the reservation.
 */
export function claudeUsageCostUsd(model: string, usage: UsageV2): number | null {
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  if (usage.cachedInputTokens === null || usage.cacheWriteInputTokens === null)
    return claudeReservationUsd(model, usage.inputTokens, usage.outputTokens);
  const read = usage.cachedInputTokens,
    write = usage.cacheWriteInputTokens;
  return claudeCostUsd(model, {
    uncachedInput: Math.max(0, usage.inputTokens - read - write),
    cacheRead: read,
    cacheWrite5m: 0,
    cacheWrite1h: write,
    output: usage.outputTokens,
  });
}
