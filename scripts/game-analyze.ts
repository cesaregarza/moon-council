import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DecisionStore, LabRepository, openDatabase } from "@werewolf/db";
import { reduceGame } from "@werewolf/engine";
import {
  AskJevProvider,
  createDecisionProvider,
  loadProviderEnvironment,
  selectedProviderKind,
  type DecisionProvider,
} from "@werewolf/llm";
import { collectMoments, publicViews, selectForReview } from "./lib/analyze-moments";
import { reviewMoments, type ReviewItem } from "./lib/analyze-review";

export interface AnalyzeOptions {
  dbPath: string;
  gameId: string;
  outDir: string;
  jev: DecisionProvider;
  jevModel: string;
  review: { provider: DecisionProvider; kind: string; model: string };
  cap?: number;
  recall?: number;
  tokenBudget?: number;
  maxOutputTokens?: number;
}

/**
 * Post-game surprise analysis (CES-1040). Opens the game database read-only, asks Jev for a
 * public-view prediction of each recorded decision, scores and ranks the moments, and sends
 * the top ones plus a recall sample to a review model. The report holds moderator data: it is
 * written next to the run's research.json and never committed.
 */
export async function analyzeGame(options: AnalyzeOptions) {
  const connection = openDatabase(options.dbPath);
  try {
    const repository = new LabRepository(connection);
    const game = repository.getGame(options.gameId);
    if (!game) throw new Error(`Unknown game: ${options.gameId}`);
    new DecisionStore(repository).put(game.id, "analysis:ran", true);
    const sources = collectMoments(repository, new DecisionStore(repository), game);
    const moments = await publicViews(repository, game, sources, options.jev, options.jevModel);
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
      tokenBudget: options.tokenBudget ?? 200_000,
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
      usage: { jevCalls: sources.length, review: usage },
      moments: moments.map((moment) => ({
        id: moment.id,
        kind: moment.kind,
        actorId: moment.actorId,
        actual: moment.actual,
        class: moment.class,
        score: moment.score,
      })),
      reviews: items.map((item, index) => ({
        momentId: item.moment.id,
        class: item.moment.class,
        recall: item.recall,
        ...outcomes[index]!,
      })),
    };
    await mkdir(options.outDir, { recursive: true });
    await writeFile(join(options.outDir, "analysis.json"), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    await writeFile(join(options.outDir, "analysis.md"), markdown(report), { mode: 0o600 });
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
}): { kind: string; model: string } | null {
  if (!values.analyze) return null;
  if (!values["review-provider"] || !values["review-model"])
    throw new Error("--analyze requires --review-provider and --review-model");
  return { kind: values["review-provider"], model: values["review-model"] };
}

function markdown(report: AnalysisReport) {
  const lines = [
    `# Surprise analysis: game ${report.gameId}`,
    "",
    `Jev ${report.models.jev}; review ${report.models.review.provider}:${report.models.review.model}. ` +
      `${report.moments.length} moments, ${report.usage.review.calls} reviews, ` +
      `${report.usage.review.tokens} review tokens, $${report.usage.review.costUsd.toFixed(4)} reported cost.`,
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
  return lines.join("\n");
}

function usage(): never {
  console.error(
    "Usage: npm run game:analyze -- --db PATH --game ID --out DIR --review-provider KIND --review-model MODEL [--jev-model jev-latest] [--cap 12] [--recall 2] [--review-token-budget 200000] [--review-max-output 4000]\nOpens the database read-only. Calls Jev once per decision and the review model once per selected moment; both spend real credit.",
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
  const report = await analyzeGame({
    dbPath: resolve(values.db),
    gameId: values.game,
    outDir: resolve(values.out),
    jev: new AskJevProvider(),
    jevModel: values["jev-model"]!,
    review: { provider: createDecisionProvider(kind), kind, model: values["review-model"] },
    cap: Number(values.cap),
    recall: Number(values.recall),
    tokenBudget: Number(values["review-token-budget"]),
    maxOutputTokens: Number(values["review-max-output"]),
  });
  console.log(JSON.stringify({ gameId: report.gameId, usage: report.usage }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
