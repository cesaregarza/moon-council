import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DecisionStore, LabRepository, openDatabaseReadOnly } from "@werewolf/db";
import { reduceGame } from "@werewolf/engine";
import {
  AnthropicMessagesProvider,
  AskJevProvider,
  ClaudeSpendLedger,
  createDecisionProvider,
  loadProviderEnvironment,
  selectedProviderKind,
  type DecisionProvider,
  type DecisionProviderKind,
} from "@werewolf/llm";
import { assertReviewSpendBounded, ReviewSpendCap } from "./lib/analysis-spend";
import { collectMoments, publicViews, selectForReview } from "./lib/analyze-moments";
import { assertSafeReportPaths, writeReportAtomically } from "./lib/analyze-output";
import {
  assertReviewProviderBounded,
  reviewMoments,
  UncappedReviewSpendError,
  type ReviewItem,
} from "./lib/analyze-review";

export { ReviewSpendCap, ReviewSpendLimitError } from "./lib/analysis-spend";

export interface AnalyzeOptions {
  dbPath: string;
  gameId: string;
  outDir: string;
  jev: DecisionProvider;
  jevModel: string;
  /** Claude reviews reserve each call through `spendCap`, which the run's cap sizes. */
  review: { provider: DecisionProvider; kind: string; model: string; spendCap?: ReviewSpendCap };
  /** USD cap on the review; required when it spends real credit. Jev's cost is not counted. */
  maxSpendUsd?: number;
  cap?: number;
  recall?: number;
  tokenBudget?: number;
  maxOutputTokens?: number;
}

const DEFAULT_TOKEN_BUDGET = 200_000;

/** Inclusive ranges for the numeric options; anything else refuses the run before it starts. */
const NUMERIC_LIMITS = {
  cap: [1, 1_000],
  recall: [1, 1_000],
  tokenBudget: [1, 100_000_000],
  maxOutputTokens: [1, 1_000_000],
} as const;

function assertNumericOptions(options: AnalyzeOptions): void {
  for (const [name, [min, max]] of Object.entries(NUMERIC_LIMITS)) {
    const value = options[name as keyof typeof NUMERIC_LIMITS];
    if (value !== undefined && !(Number.isInteger(value) && value >= min && value <= max))
      throw new Error(`${name} must be an integer from ${min} to ${max}; got ${value}`);
  }
}

/**
 * Refuses a run the analysis cannot bound, before the database is opened or any call is made,
 * and returns the review's worst case.
 */
function assertAnalysisBounded(options: AnalyzeOptions): number {
  assertNumericOptions(options);
  assertReviewProviderBounded(options.review.kind, options.review.model);
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const worstCase = assertReviewSpendBounded(
    { ...options.review, tokenBudget },
    options.maxSpendUsd,
  );
  if (options.review.kind === "anthropic" && !options.review.spendCap)
    throw new UncappedReviewSpendError(
      "Claude reviews must reserve each call through the analysis run's spend cap",
    );
  if (options.maxSpendUsd !== undefined) options.review.spendCap?.allow(options.maxSpendUsd);
  return worstCase;
}

function jevUsage(calls: Awaited<ReturnType<typeof publicViews>>["jevCalls"]) {
  // Unknown when any call is unknown or the sum is not finite; never Infinity.
  const total = (key: "inputTokens" | "outputTokens" | "totalTokens" | "costUsd") => {
    if (calls.some((call) => call[key] === null)) return null;
    const sum = calls.reduce((t, call) => t + call[key]!, 0);
    return Number.isFinite(sum) ? sum : null;
  };
  return {
    calls: calls.length,
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    totalTokens: total("totalTokens"),
    costUsd: total("costUsd"),
    perCall: calls,
  };
}

/**
 * Post-game surprise analysis (CES-1040). Opens the game database read-only, asks Jev for a
 * public-view prediction of each recorded decision, scores and ranks the moments, and sends
 * the top ones plus a recall sample to a review model. The report holds moderator data: it is
 * written next to the run's research.json and never committed.
 */
export async function analyzeGame(options: AnalyzeOptions) {
  const reviewWorstCaseUsd = assertAnalysisBounded(options);
  assertSafeReportPaths(options.dbPath, options.outDir);
  const connection = openDatabaseReadOnly(options.dbPath);
  try {
    const repository = new LabRepository(connection);
    const game = repository.getGame(options.gameId);
    if (!game) throw new Error(`Unknown game: ${options.gameId}`);
    const sources = collectMoments(repository, new DecisionStore(repository), game);
    const { moments, jevCalls } = await publicViews(
      repository,
      game,
      sources,
      options.jev,
      options.jevModel,
    );
    const selected = selectForReview(moments, {
      cap: options.cap ?? 12,
      recall: options.recall ?? 2,
      seed: game.id,
    });
    const sourceOf = new Map(sources.map((source) => [source.moment.id, source]));
    const items: ReviewItem[] = [
      ...selected.noteworthy.map((moment) => ({ moment, recall: false })),
      ...selected.recall.map((moment) => ({ moment, recall: true })),
    ].map((item) => ({ ...item, source: sourceOf.get(item.moment.id)! }));
    const events = repository.listEvents(game.id);
    const roles = Object.fromEntries(
      reduceGame(game.id, events).players.map((player) => [player.id, player.role.name]),
    );
    const { outcomes, usage } = await reviewMoments(items, {
      provider: options.review.provider,
      model: options.review.model,
      maxOutputTokens: options.maxOutputTokens ?? 4_000,
      tokenBudget: options.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
      events,
      roles,
    });
    const report = {
      schemaVersion: "game_analysis_v1",
      gameId: game.id,
      models: {
        jev: options.jevModel,
        review: { provider: options.review.kind, model: options.review.model },
      },
      usage: { jev: jevUsage(jevCalls), review: usage },
      // The cap bounds the review only; Jev's cost is not counted (Cesar, 2026-10-23).
      spend: {
        capUsd: options.maxSpendUsd ?? null,
        reviewWorstCaseUsd,
        reviewActualUsd: usage.costUsd,
      },
      moments: moments.map((moment) => ({
        id: moment.id,
        kind: moment.kind,
        actorId: moment.actorId,
        actual: moment.actual,
        ...(moment.selected ? { selected: moment.selected } : {}),
        class: moment.class,
        ...(moment.noSignalReason ? { noSignalReason: moment.noSignalReason } : {}),
        ...(moment.wolfProbabilities ? { wolfProbabilities: moment.wolfProbabilities } : {}),
        score: moment.score,
      })),
      reviews: items.map((item, index) => ({
        momentId: item.moment.id,
        class: item.moment.class,
        recall: item.recall,
        ...outcomes[index]!,
      })),
    };
    mkdirSync(options.outDir, { recursive: true });
    assertSafeReportPaths(options.dbPath, options.outDir);
    writeReportAtomically(
      join(options.outDir, "analysis.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    writeReportAtomically(join(options.outDir, "analysis.md"), markdown(report));
    return report;
  } finally {
    connection.close();
  }
}

type AnalysisReport = Awaited<ReturnType<typeof analyzeGame>>;

/**
 * The automatic post-game run is off unless asked for, and then needs an explicit review
 * provider and model: there is no default, because the review spends real credit.
 */
export function postGameAnalysisRequest(values: {
  analyze?: boolean;
  "review-provider"?: string;
  "review-model"?: string;
  "analysis-max-spend-usd"?: string;
}): { kind: string; model: string; maxSpendUsd?: number } | null {
  if (!values.analyze) return null;
  const kind = values["review-provider"];
  const model = values["review-model"];
  if (!kind || !model) throw new Error("--analyze requires --review-provider and --review-model");
  const maxSpendUsd = dollars(values["analysis-max-spend-usd"]);
  assertReviewProviderBounded(kind, model);
  assertReviewSpendBounded({ kind, model, tokenBudget: DEFAULT_TOKEN_BUDGET }, maxSpendUsd);
  return { kind, model, ...(maxSpendUsd === undefined ? {} : { maxSpendUsd }) };
}

const dollars = (value: string | undefined) => (value === undefined ? undefined : Number(value));

/** The review provider; Claude reserves every call through a run cap in front of the monthly ledger. */
export function reviewProvider(kind: DecisionProviderKind): {
  provider: DecisionProvider;
  spendCap?: ReviewSpendCap;
} {
  if (kind !== "anthropic") return { provider: createDecisionProvider(kind) };
  const spendCap = new ReviewSpendCap(new ClaudeSpendLedger());
  return { provider: new AnthropicMessagesProvider({ ledger: spendCap }), spendCap };
}

const usd = (value: number | null) => (value === null ? "unknown" : `$${value.toFixed(4)}`);

function markdown(report: AnalysisReport) {
  const lines = [
    `# Surprise analysis: game ${report.gameId}`,
    "",
    `Jev ${report.models.jev}; review ${report.models.review.provider}:${report.models.review.model}. ` +
      `${report.moments.length} moments; ${report.usage.jev.calls} Jev calls, ` +
      `${report.usage.jev.totalTokens ?? "unknown"} Jev tokens; ${report.usage.review.calls} reviews, ` +
      `${report.usage.review.tokens} review tokens, ${usd(report.usage.review.costUsd)} reported cost.`,
    "",
    `Review spend cap ${usd(report.spend.capUsd)}: ${usd(report.spend.reviewWorstCaseUsd)} worst case, ` +
      `${usd(report.spend.reviewActualUsd)} reported. Jev's cost is not counted toward the cap.`,
    "",
  ];
  for (const review of report.reviews) {
    const head = `## ${review.momentId} (${review.class}${review.recall ? ", recall check" : ""}): ${review.status}`;
    lines.push(head);
    if ("review" in review && review.review) lines.push("", review.review.explanation);
    if ("issues" in review && review.issues?.length)
      lines.push("", ...review.issues.map((issue) => `- Rejected citation: ${issue}`));
    lines.push("");
  }
  for (const moment of report.moments)
    if (moment.noSignalReason)
      lines.push(`## ${moment.id}: no signal: ${moment.noSignalReason}`, "");
  return lines.join("\n");
}

function usage(): never {
  console.error(
    "Usage: npm run game:analyze -- --db PATH --game ID --out DIR --review-provider KIND --review-model MODEL [--max-spend-usd USD] [--jev-model jev-latest] [--cap 12] [--recall 2] [--review-token-budget 200000] [--review-max-output 4000]\nOpens the database read-only. Calls Jev once per decision and the review model once per selected moment; both spend real credit. A paid review (anthropic) requires --max-spend-usd, which caps the review only; Jev's cost is not counted.",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      game: { type: "string" },
      out: { type: "string" },
      "review-provider": { type: "string" },
      "review-model": { type: "string" },
      "max-spend-usd": { type: "string" },
      "jev-model": { type: "string", default: "jev-latest" },
      cap: { type: "string", default: "12" },
      recall: { type: "string", default: "2" },
      "review-token-budget": { type: "string", default: "200000" },
      "review-max-output": { type: "string", default: "4000" },
    },
  });
  if (!values.db || !values.game || !values.out) usage();
  // No default review model: a silent choice would change cost and results.
  if (!values["review-provider"] || !values["review-model"]) usage();
  loadProviderEnvironment();
  const kind = selectedProviderKind(values["review-provider"]);
  const model = values["review-model"];
  const maxSpendUsd = dollars(values["max-spend-usd"]);
  const tokenBudget = Number(values["review-token-budget"]);
  // Refused before Jev or the review provider is constructed.
  assertReviewProviderBounded(kind, model);
  assertReviewSpendBounded({ kind, model, tokenBudget }, maxSpendUsd);
  const report = await analyzeGame({
    dbPath: resolve(values.db),
    gameId: values.game,
    outDir: resolve(values.out),
    jev: new AskJevProvider(),
    jevModel: values["jev-model"]!,
    review: { ...reviewProvider(kind), kind, model },
    maxSpendUsd,
    cap: Number(values.cap),
    recall: Number(values.recall),
    tokenBudget,
    maxOutputTokens: Number(values["review-max-output"]),
  });
  console.log(JSON.stringify({ gameId: report.gameId, usage: report.usage }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
