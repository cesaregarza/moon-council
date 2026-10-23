import { CLAUDE_PRICES, type ClaudeSpendLedger, type JevRequest } from "@werewolf/llm";

/** A cost counts only when it is a finite, non-negative number; otherwise it is unknown. */
export const validUsd = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Jev's rate: USD per million input tokens; output is free. Taken from the jev tooling,
 * `~/.claude/skills/jev/scripts/jev.py:182`, not from vendor documentation: an assumption.
 */
export const JEV_USD_PER_MILLION_INPUT = 0.042;
/** Headroom over the assumed Jev rate. */
export const JEV_RATE_MARGIN = 1.5;
/**
 * Tokens allowed per Jev call for any provider-side framing. In 2,424 logged calls (ask-jev's
 * request log, 2026-09 and 2026-10), the smallest bill was 501 tokens, so a fixed framing is at
 * most that; billed input never passed 0.567 of the request's bytes as sent.
 */
export const JEV_FRAMING_TOKENS = 512;
/** One attempt plus the Anthropic SDK's default two retries (packages/llm/src/anthropic.ts). */
export const CLAUDE_MAX_ATTEMPTS = 3;

/** Every analysis run calls Jev, so it spends real credit and needs a per-run cap. */
export class MissingAnalysisSpendCapError extends Error {
  override name = "MissingAnalysisSpendCapError";
}
/** The preflight worst case is over the run's cap; no paid call was made. */
export class AnalysisSpendCapError extends Error {
  override name = "AnalysisSpendCapError";
}
/** The review model has no price, so its worst case cannot be bounded. */
export class UnpricedReviewModelError extends Error {
  override name = "UnpricedReviewModelError";
}
/** A Claude review call would pass what the run's cap leaves for reviews; it was not sent. */
export class ReviewSpendLimitError extends Error {
  override name = "ReviewSpendLimitError";
}

export function assertSpendCap(maxSpendUsd: number | undefined): asserts maxSpendUsd is number {
  if (maxSpendUsd === undefined)
    throw new MissingAnalysisSpendCapError(
      "Analysis requires a per-run USD cap (--max-spend-usd): every run calls Jev, which spends real credit",
    );
  if (!(Number.isFinite(maxSpendUsd) && maxSpendUsd > 0))
    throw new Error(`The analysis spend cap must be a positive dollar amount; got ${maxSpendUsd}`);
}

/**
 * The review model's highest USD rate per token, across every token class and tier, so any mix
 * of input, cache and output tokens is bounded by it, times every attempt that may be sent. Only
 * the fake provider and priced Claude models qualify: there is no price table for other
 * providers yet.
 */
export function reviewUsdPerToken(kind: string, model: string): number {
  if (kind === "fake") return 0;
  const price = kind === "anthropic" ? CLAUDE_PRICES[model] : undefined;
  if (!price)
    throw new UnpricedReviewModelError(
      `Review model ${kind}:${model} has no price, so the analysis spend cannot be bounded`,
    );
  const tiers = [price.standard, ...(price.long ? [price.long.rates] : [])];
  return (
    (Math.max(...tiers.flatMap((rates) => Object.values(rates))) * CLAUDE_MAX_ATTEMPTS) / 1_000_000
  );
}

/**
 * The input tokens one Jev call is assumed to bill at most: the UTF-8 bytes of the full request
 * as the client sends it, plus the framing allowance. ask-jev sends exactly one attempt and
 * re-serializes the request with Python's ", " and ": " separators; the same JSON with a
 * one-space indent is never shorter.
 */
export function jevRequestCeilingTokens(request: JevRequest): number {
  return Buffer.byteLength(JSON.stringify(request, null, 1), "utf8") + JEV_FRAMING_TOKENS;
}

/** The run's worst case: every Jev request, then the whole review token budget. */
export function analysisWorstCase(
  jevRequests: JevRequest[],
  review: { kind: string; model: string; tokenBudget: number },
) {
  const jevTokens = jevRequests.reduce((total, r) => total + jevRequestCeilingTokens(r), 0);
  const jev = (jevTokens * JEV_USD_PER_MILLION_INPUT * JEV_RATE_MARGIN) / 1_000_000;
  const reviewUsd = review.tokenBudget * reviewUsdPerToken(review.kind, review.model);
  return { jev, review: reviewUsd, total: jev + reviewUsd };
}

export function assertWithinCap(
  worstCase: ReturnType<typeof analysisWorstCase>,
  maxSpendUsd: number,
): void {
  if (worstCase.total > maxSpendUsd)
    throw new AnalysisSpendCapError(
      `Analysis worst case $${worstCase.total.toFixed(4)} (Jev $${worstCase.jev.toFixed(4)}, review $${worstCase.review.toFixed(4)}) exceeds the $${maxSpendUsd} cap; no paid call was made`,
    );
}

/** Jev's actual input tokens at the assumed rate (no margin); unknown if any call is unknown. */
export function jevActualUsd(inputTokens: number | null): number | null {
  return inputTokens === null ? null : (inputTokens * JEV_USD_PER_MILLION_INPUT) / 1_000_000;
}

/**
 * The run's cap for Claude reviews, in front of the monthly ledger. Each call's reservation must
 * fit in the allowance (what the cap leaves after Jev's worst case) beside everything already
 * spent or held; the monthly ledger then admits it too. Settling follows Rule L: an invalid
 * amount counts as what was held. The allowance is zero until the preflight sets it.
 */
export class ReviewSpendCap implements Pick<ClaudeSpendLedger, "reserve" | "settle"> {
  private allowanceUsd = 0;
  private settledUsd = 0;
  private readonly open = new Map<string, number>();

  constructor(private readonly ledger: Pick<ClaudeSpendLedger, "reserve" | "settle">) {}

  get spentUsd(): number {
    return this.settledUsd;
  }

  allow(usd: number): void {
    if (!validUsd(usd)) throw new Error(`Invalid review allowance: ${String(usd)}`);
    this.allowanceUsd = usd;
  }

  reserve(id: string, usd: number): void {
    if (!validUsd(usd))
      throw new ReviewSpendLimitError(`Refusing an invalid reservation: ${String(usd)}`);
    const held = [...this.open.values()].reduce((total, amount) => total + amount, 0);
    if (this.settledUsd + held + usd > this.allowanceUsd)
      throw new ReviewSpendLimitError(
        `Analysis review cap $${this.allowanceUsd.toFixed(4)} reached: spent $${this.settledUsd.toFixed(4)}, open $${held.toFixed(4)}, this call $${usd.toFixed(4)}`,
      );
    this.ledger.reserve(id, usd);
    this.open.set(id, usd);
  }

  settle(id: string, usd: number): void {
    const held = this.open.get(id);
    try {
      this.ledger.settle(id, usd);
    } finally {
      if (held !== undefined) {
        this.open.delete(id);
        const total = this.settledUsd + usd;
        this.settledUsd = validUsd(usd) && Number.isFinite(total) ? total : this.settledUsd + held;
      }
    }
  }
}
