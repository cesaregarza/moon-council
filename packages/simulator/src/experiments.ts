import { randomUUID } from "node:crypto";
import {
  ExperimentSummarySchema,
  type ExperimentSummaryV1,
  type StoredExperimentSpec,
  type StoredGameConfig,
  type ExperimentSummaryV2,
} from "@werewolf/contracts";
import { DecisionStore, LabRepository, type GameRecord } from "@werewolf/db";
import { reduceGame } from "@werewolf/engine";
import { resolveDefaultModel, type DecisionProvider } from "@werewolf/llm";
import { GameOrchestrator } from "./orchestrator";
import { V2GameOrchestrator } from "./orchestrator-v2";

export type ExperimentSummary = ExperimentSummaryV2;

async function mapConcurrent<T>(items: readonly T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await task(items[index]!);
      }
    }),
  );
}

export async function runExperiment(
  repository: LabRepository,
  provider: DecisionProvider,
  experimentId: string,
  defaultModel = resolveDefaultModel(),
): Promise<ExperimentSummary> {
  const experiment = repository.getExperiment(experimentId);
  if (!experiment) throw new Error(`Unknown experiment ${experimentId}`);
  const store = new DecisionStore(repository);
  const indices = Array.from({ length: experiment.spec.runs }, (_, index) => index);
  const resuming = experiment.status === "paused" || indices.some((index) => {
    const gameId = store.runGame(experimentId, index);
    return gameId ? repository.getGame(gameId)?.status === "paused" : false;
  });
  repository.updateExperiment(experimentId, { status: "running", error: null });
  const isV2 = experiment.spec.schemaVersion === "experiment_v2";
  const legacyOrchestrator = isV2 ? undefined : new GameOrchestrator(repository, provider, defaultModel);
  const v2Orchestrator = isV2 ? new V2GameOrchestrator(repository, provider) : undefined;
  const owner = randomUUID();
  let admissionOpen = true;

  const ensureRun = (index: number): GameRecord | undefined => {
    return store.atomic(() => {
      const existingId = store.runGame(experimentId, index);
      if (existingId) return repository.getGame(existingId);
      const config = {
        ...experiment.spec.baseConfig,
        name: `${experiment.spec.name} · run ${index + 1}`,
        seed: `${experiment.spec.baseSeed}:${index}`,
        speedMs: 0,
      } as StoredGameConfig;
      const game = repository.createGame(config, experimentId);
      store.registerRun(experimentId, index, game.id);
      return game;
    });
  };

  const runV2ToCompletion = async (gameId: string): Promise<void> => {
    for (let step = 0; step < 100; step += 1) {
      const game = repository.getGame(gameId);
      if (!game || ["completed", "aborted", "budget_exhausted", "failed"].includes(game.status)) return;
      if (game.status === "paused") return;
      if (["queued", "lobby"].includes(game.status)) repository.updateGame(gameId, { status: "running" });
      if (!(["running", "stepping"].includes(repository.getGame(gameId)?.status ?? ""))) return;
      await v2Orchestrator!.runGameStep(gameId);
    }
    throw new Error(`Game ${gameId} exceeded the batch step limit`);
  };

  const resumeIndices = indices.filter((index) => {
    const gameId = store.runGame(experimentId, index);
    return gameId ? repository.getGame(gameId)?.status === "paused" : false;
  });
  const initialIndices = resuming && resumeIndices.length > 0 ? resumeIndices : indices;
  const remainingIndices = resuming && resumeIndices.length > 0 ? indices.filter((index) => !resumeIndices.includes(index)) : [];
  const runIndex = async (index: number): Promise<void> => {
      if (!admissionOpen || repository.getExperiment(experimentId)?.status === "paused") { admissionOpen=false; return; }
      const game = ensureRun(index);
      if (!game) return;
      if (["completed", "aborted", "budget_exhausted", "failed"].includes(game.status)) return;
      const resumePaused = resuming && game.status === "paused";
      if (["paused", "running", "stepping", "queued"].includes(game.status) && repository.listEvents(game.id).length > 0 && !resumePaused) {
        admissionOpen = false;
        return;
      }
      if (resumePaused) repository.updateGame(game.id, { status: "running", error: null });
      if (!store.acquire(game.id, owner)) {
        admissionOpen = false;
        return;
      }
      const renewTimer = setInterval(() => store.renew(game.id, owner), 10_000);
      try {
        if (isV2) {
          await runV2ToCompletion(game.id);
        } else {
          legacyOrchestrator!.initializeGame(game);
          repository.updateGame(game.id, { status: "running" });
          try {
            await legacyOrchestrator!.runToCompletion(game.id);
          } catch (error) {
            if (repository.getGame(game.id)?.status !== "paused") throw error;
          }
        }
        if (repository.getGame(game.id)?.status === "paused") admissionOpen = false;
      } finally {
        clearInterval(renewTimer);
        store.release(game.id, owner);
      }
  };

  try {
    await mapConcurrent(initialIndices, experiment.spec.concurrency, runIndex);
    if (admissionOpen && remainingIndices.length > 0) {
      await mapConcurrent(remainingIndices, experiment.spec.concurrency, runIndex);
    }
    const summary = summarizeExperiment(repository, experimentId, experiment.spec);
    repository.updateExperiment(experimentId, { status: !admissionOpen || summary.interrupted > 0 || repository.listGames(100,experimentId).length < experiment.spec.runs ? "paused" : "completed", summary });
    return summary;
  } catch (error) {
    repository.updateExperiment(experimentId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function summarizeExperiment(
  repository: LabRepository,
  experimentId: string,
  spec: StoredExperimentSpec,
): ExperimentSummary {
  const games = repository.listGames(100, experimentId);
  const completed = games.filter((game) => game.status === "completed");
  const interrupted = games.filter((game) => ["paused", "aborted", "running", "stepping", "queued", "lobby"].includes(game.status));
  const failedGames = games.filter((game) => game.status === "failed");
  const budgetTruncated = games.filter((game) => game.status === "budget_exhausted");
  const decisionStore = new DecisionStore(repository);
  const winsByAlignment: Record<string, number> = {};
  const winsByRole: Record<string, number> = {};
  const survivalByRole: Record<string, { survived: number; total: number }> = {};
  let cycles = 0;
  let messages = 0;
  let followUps = 0;
  let failures = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let durations = 0;
  let accurateVotes = 0;
  let validVotes = 0;

  for (const game of completed) {
    const events = repository.listEvents(game.id);
    const state = reduceGame(game.id, events);
    cycles += state.day;
    const ended = events.findLast((event) => event.type === "game.ended");
    for (const alignment of (ended?.payload.winnerAlignments as string[] | undefined) ?? []) {
      winsByAlignment[alignment] = (winsByAlignment[alignment] ?? 0) + 1;
    }
    for (const playerId of (ended?.payload.winnerPlayerIds as string[] | undefined) ?? []) {
      const role = state.players.find((player) => player.id === playerId)?.role.name;
      if (role) winsByRole[role] = (winsByRole[role] ?? 0) + 1;
    }
    for (const player of state.players) {
      const stats = survivalByRole[player.role.name] ?? { survived: 0, total: 0 };
      stats.total += 1;
      if (player.alive) stats.survived += 1;
      survivalByRole[player.role.name] = stats;
    }
    const publicMessages = events.filter((event) => ["message.public", "speech.public"].includes(event.type));
    messages += publicMessages.length;
    followUps += publicMessages.filter((event) => event.payload.followUp === true).length + events.filter(e=>e.type === "discussion.completed" && e.payload.stage === "followup").length;
    const started = events.find((event) => event.type === "game.started");
    const terminal = events.findLast((event) =>
      ["game.ended", "game.budget_exhausted", "game.aborted"].includes(event.type),
    );
    if (game.config.schemaVersion === "game_config_v2") durations += decisionStore.activeRuntimeMs(game.id);
    else if (started && terminal) durations += Date.parse(terminal.createdAt) - Date.parse(started.createdAt);

    for (const event of events.filter((candidate) => candidate.type === "vote.cast")) {
      const vote = event.payload.vote as { voterId: string; targetId: string | null };
      if (!vote.targetId) continue;
      validVotes += 1;
      if (state.players.find((player) => player.id === vote.targetId)?.role.alignment === "werewolf") accurateVotes += 1;
    }

  }

  // Usage includes every attempt, even for incomplete games. Cache and reasoning
  // counters are subsets of input/output and must not be added a second time.
  for (const game of games) {
    failures += repository.listEvents(game.id).filter((event) => ["model.failure", "decision.attempt_failed"].includes(event.type)).length;
    for (const row of repository.usageForGame(game.id)) {
      inputTokens += row.inputTokens;
      outputTokens += row.outputTokens;
      const pricing = spec.pricingPerMillionTokens[row.model];
      if (pricing) cost += (row.inputTokens * pricing.input + row.outputTokens * pricing.output) / 1_000_000;
    }
    if (game.config.schemaVersion !== "game_config_v2") continue;
    for (const attempt of decisionStore.attempts(game.id)) {
      const input = attempt.usage.inputTokens;
      const output = attempt.usage.outputTokens;
      if (input !== null) inputTokens += input;
      if (output !== null) outputTokens += output;
      const pricing = spec.pricingPerMillionTokens[attempt.model];
      if (pricing) cost += ((input ?? 0) * pricing.input + (output ?? 0) * pricing.output) / 1_000_000;
    }
  }

  const divisor = completed.length || 1;
  const allAttempts=games.flatMap(game=>decisionStore.attempts(game.id));
  const base = ExperimentSummarySchema.parse({
    runsRequested: spec.runs,
    runsCompleted: completed.length,
    winsByAlignment,
    winsByRole,
    survivalByRole,
    voteAccuracy: validVotes > 0 ? accurateVotes / validVotes : 0,
    averageCycles: cycles / divisor,
    averageMessages: messages / divisor,
    averageDurationMs: durations / divisor,
    followUps,
    modelFailures: failures,
    inputTokens,
    outputTokens,
    estimatedCost: cost,
  });
  return {
    ...base,
    schemaVersion:"experiment_summary_v2",
    completed: completed.length,
    interrupted: interrupted.length,
    failed: failedGames.length,
    budgetTruncated: budgetTruncated.length,
    validOutcomeDenominator: completed.length,
    cachedInputTokens:allAttempts.reduce((n,a)=>n+(a.usage.cachedInputTokens ?? 0),0), reasoningTokens:allAttempts.reduce((n,a)=>n+(a.usage.reasoningTokens ?? 0),0),
    unknownUsageAttempts:allAttempts.filter(a=>a.usage.totalTokens === null).length,totalAttempts:allAttempts.length,
    estimatedCostIsLowerBound:allAttempts.some(a=>a.usage.inputTokens === null || a.usage.outputTokens === null || !spec.pricingPerMillionTokens[a.model]),
    factionWinRates:Object.fromEntries(Object.entries(winsByAlignment).map(([faction,wins])=>[faction,wins/divisor])),
    roleWinRates:Object.fromEntries(Object.entries(survivalByRole).map(([role,stats])=>[role,(winsByRole[role] ?? 0)/(stats.total || 1)])),
  };
}
