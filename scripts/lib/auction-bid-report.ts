import type { JevResponse } from "@werewolf/llm";
import { NEAR_TIE, PAIRS, type BidMode } from "./auction-bid-design";
import type { BidObservation } from "./auction-bid-runner";

/** Match the study runner: normalized expectation of ordinal probabilities, not answer.score. */
export function expectedBidScore(answer: JevResponse["answers"][string]): number {
  if (answer.type !== "score") throw new Error("Expected score answer");
  const entries = Object.entries(answer.probabilities);
  const mass = entries.reduce((sum, [, p]) => sum + p, 0);
  if (!(mass > 0)) throw new Error("Empty score distribution");
  return entries.reduce((sum, [key, p]) => sum + Number(key) * p, 0) / (4 * mass);
}
export function summarizeBids(observations: BidObservation[]) {
  const keys = observations.map((item) => `${item.id}:${item.mode}`);
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate observation");
  return PAIRS.flatMap((pair) =>
    (["authored", "luna"] as BidMode[]).map((mode) => {
      const score = (variant: string) => {
        const observation = observations.find(
          (o) => o.id === `${pair.id}-${variant}` && o.mode === mode,
        );
        const answer = observation?.response?.answers[pair.question];
        return observation?.status === "complete" && answer ? expectedBidScore(answer) : null;
      };
      const a = score("a"),
        b = score("b");
      const delta = a === null || b === null ? null : a - b;
      let direction: string;
      if (delta === null) direction = "missing";
      else if (pair.expected === "exploratory") direction = "exploratory";
      else if (Math.abs(delta) <= NEAR_TIE) direction = "near tie";
      else
        direction = (pair.expected === "a_gt_b" ? delta > 0 : delta < 0) ? "expected" : "opposite";
      return {
        pair: pair.id,
        mode,
        question: pair.question,
        expectation: pair.expected,
        a,
        b,
        delta,
        direction,
      };
    }),
  );
}
export function bidReport(observations: BidObservation[], manifestHash: string) {
  const rows = summarizeBids(observations);
  const fmt = (value: number | null) => (value === null ? "—" : value.toFixed(3));
  const lines = [
    "# Speaker auction: paired judgment probes",
    "",
    "Eight synthetic paired contexts, one actor per context, with current clue-chain Jev prompts. Each is scored once with an authored factual journal and once after Luna updates a separate prior journal from the same events. No conversation or changed scheduler is simulated.",
    "",
    `Manifest SHA-256: ${manifestHash}. Maximum 48 provider calls: 16 Luna journal updates and 32 Jev score calls. No retries or replacement of failures.`,
    "",
    `Scores are probability-weighted ordinal expectations divided by four (0–1), matching the study runner. A−B is descriptive; differences within ${NEAR_TIE} are labeled near ties, not statistically equivalent. One observation per cell; no significance tests or population estimates.`,
    "",
    "| Contrast | Journal | A | B | A−B | Direction |",
    "|---|---|---:|---:|---:|---|",
    ...rows.map(
      (r) =>
        `| ${r.pair} (${r.question}) | ${r.mode} | ${fmt(r.a)} | ${fmt(r.b)} | ${fmt(r.delta)} | ${r.direction} |`,
    ),
    "",
    "## Frozen comparisons",
    "",
    ...PAIRS.flatMap((pair) => [
      `### ${pair.id}`,
      "",
      `A: ${pair.a.label}. B: ${pair.b.label}.`,
      "",
      pair.hypothesis,
      "",
      `Limit: ${pair.limitation}`,
      "",
    ]),
    "## Interpretation limits",
    "",
    "Authored journals test extraction of stated beliefs and intentions. Luna journals additionally test interpretation and retention; one realization cannot uniquely identify the cause of a changed score. Listening is desire for another contribution, not a truth or trust rating. The concise/padded and objective comparisons are exploratory. Objective changes may induce multiple valid tactics.",
    "",
    "Inspect the pending/delivered journals for provenance errors separately: a plausible urgency score cannot prove that the journal is faithful. Neither score confidence nor a directional match demonstrates task success. Raw inputs, successful validated outputs, generated journals, failures, and usage remain in the private run directory. The ask-jev CLI also retains its standard durable request/error log.",
    "",
  ];
  return lines.join("\n");
}
