import { CLAUDE_PRICES, type ClaudeSpendLedger } from "@werewolf/llm";

/** A cost counts only when it is a finite, non-negative number; otherwise it is unknown. */
export const validUsd = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** One attempt plus the Anthropic SDK's default two retries (packages/llm/src/anthropic.ts). */
export const CLAUDE_MAX_ATTEMPTS = 3;

/** A paid review (Claude) needs a per-run cap; Jev's cost is not counted (Cesar, 2026-10-23). */
export class MissingAnalysisSpendCapError extends Error {
  override name = "MissingAnalysisSpendCapError";
}
/** The review's worst case is over the run's cap; no call was made. */
export class AnalysisSpendCapError extends Error {
  override name = "AnalysisSpendCapError";
}
/** The review model has no price, so its worst case cannot be bounded. */
export class UnpricedReviewModelError extends Error {
  override name = "UnpricedReviewModelError";
}
/** A Claude review call would pass the run's cap; it was not sent. */
export class ReviewSpendLimitError extends Error {
  override name = "ReviewSpendLimitError";
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
 * Refuses a review spend the run cannot bound, before any call: a paid review needs a positive
 * cap, and its worst case (the whole token budget at the highest price, every attempt) must fit.
 * Returns that worst case. Jev's cost is not counted (Cesar's decision, 2026-10-23).
 */
export function assertReviewSpendBounded(
  review: { kind: string; model: string; tokenBudget: number },
  maxSpendUsd: number | undefined,
): number {
  const worstCase = review.tokenBudget * reviewUsdPerToken(review.kind, review.model);
  if (maxSpendUsd === undefined) {
    if (worstCase === 0) return 0;
    throw new MissingAnalysisSpendCapError(
      `Review provider ${review.kind} spends real credit: pass a per-run USD cap (--max-spend-usd; in the pilot, --analysis-max-spend-usd)`,
    );
  }
  if (!(Number.isFinite(maxSpendUsd) && maxSpendUsd > 0))
    throw new Error(`The analysis spend cap must be a positive dollar amount; got ${maxSpendUsd}`);
  if (worstCase > maxSpendUsd)
    throw new AnalysisSpendCapError(
      `Review worst case $${worstCase.toFixed(4)} exceeds the $${maxSpendUsd} cap; no call was made`,
    );
  return worstCase;
}

/**
 * The run's cap for Claude reviews, in front of the monthly ledger. Each call's reservation must
 * fit in the allowance (the run's cap) beside everything already spent or held; the monthly
 * ledger then admits it too. Settling follows Rule L: an invalid
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
