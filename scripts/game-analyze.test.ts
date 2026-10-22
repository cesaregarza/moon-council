import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyJournalV2, type DecisionOpportunityV1 } from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase } from "@werewolf/db";
import { DOCTOR_V2, STARTER_ROLES, reduceGame } from "@werewolf/engine";
import { FakeDecisionProvider, type DecisionProvider, type JevRequest } from "@werewolf/llm";
import { buildContextV2 } from "../packages/simulator/src/context-v2";
import { V2GameOrchestrator } from "../packages/simulator/src/orchestrator-v2";
import { actorConfig } from "../packages/simulator/src/testing/actor-fixtures";
import { analyzeGame, postGameAnalysisRequest } from "./game-analyze";
import type { MomentReview } from "./lib/analyze-review";

const directories: string[] = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

type Distribution = Record<string, number>;
interface ScriptedMoment {
  id: string;
  actor: "seer" | "villager";
  /** A player ID, or "abstain". */
  actual: string;
  /** Jev's recorded distribution when the player decided. */
  privateView: Distribution;
  /** Jev's public-record prediction, scripted for the analyzer's call. */
  publicView: Distribution;
}

/**
 * A recorded game on disk: a seer who inspected a wolf, and committed ballots with recorded Jev
 * distributions, written straight into the store as the executor would have.
 */
function recordedGame(script: (ids: { wolf: string; other: string }) => ScriptedMoment[]) {
  const directory = mkdtempSync(join(tmpdir(), "game-analyze-"));
  directories.push(directory);
  const dbPath = join(directory, "game.db");
  const connection = openDatabase(dbPath);
  const repository = new LabRepository(connection);
  repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
  const game = repository.createGame(actorConfig());
  new V2GameOrchestrator(repository, new FakeDecisionProvider()).initialize(game.id);
  let state = reduceGame(game.id, repository.listEvents(game.id));
  const seer = state.players.find((p) => p.role.id === "seer")!.id;
  const villager = state.players.find((p) => p.role.id === "villager")!.id;
  const wolf = state.players.find((p) => p.role.alignment === "werewolf")!.id;
  const other = state.players.find((p) => p.role.id === "villager" && p.id !== villager)!.id;
  const at = { day: 1, phase: "day_vote" as const };
  repository.appendEvent(game.id, {
    ...at,
    type: "speech.public",
    visibility: "public",
    payload: {
      playerId: other,
      text: "I trust everyone.",
      acts: [],
      respondsTo: [],
      closing: false,
    },
  });
  repository.appendEvent(game.id, {
    ...at,
    type: "inspection.delivered",
    visibility: "player",
    audienceIds: [seer],
    payload: { actorId: seer, targetId: wolf, targetName: "wolf", result: "werewolf" },
  });
  const inspectionId = repository.listEvents(game.id).at(-1)!.id;
  const store = new DecisionStore(repository);
  const moments = script({ wolf, other });
  for (const moment of moments) {
    const actor = moment.actor === "seer" ? seer : villager;
    const events = repository.listEvents(game.id);
    state = { ...reduceGame(game.id, events), phase: "day_vote" };
    const packet = buildContextV2(state, events, actor, emptyJournalV2(), moment.id, "vote");
    const handle = (id: string) =>
      id === "abstain" ? "abstain" : String.fromCharCode(97 + packet.legalTargets.indexOf(id));
    const op = {
      id: moment.id,
      gameId: game.id,
      playerId: actor,
      kind: "vote",
      phase: "day_vote",
      day: 1,
      epoch: "1:day_vote",
      viewId: moment.id,
      baseJournalVersion: 0,
      packet,
      status: "committed",
      best: null,
      recovery: 0,
      createdAt: "2026-10-22T00:00:00.000Z",
      taskType: "vote_choice",
    } as DecisionOpportunityV1;
    store.save(op);
    const attempt = store.beginAttempt(op, {
      model: "jev-latest",
      provider: "jev",
      reasoningEffort: "none",
      optional: false,
      request: { instructions: "", input: "{}", schema: {} },
    });
    const probabilities = Object.fromEntries(
      Object.entries(moment.privateView).map(([id, p]) => [handle(id), p]),
    );
    store.updateAttempt({
      ...attempt,
      status: "valid",
      response: JSON.stringify({
        model: "jev-latest",
        answers: {
          target: { type: "choice", choice: handle(moment.actual), confidence: 1, probabilities },
        },
      }),
    });
    repository.appendEvent(game.id, {
      ...at,
      type: "decision.committed",
      visibility: "player",
      audienceIds: [actor],
      payload: {
        playerId: actor,
        decisionId: moment.id,
        proposal: {
          kind: "vote",
          targets:
            moment.actual === "abstain" ? null : { mode: "direct", playerIds: [moment.actual] },
        },
      },
    });
  }
  connection.close();
  return { dbPath, gameId: game.id, directory, inspectionId, seer, villager, moments };
}

/** Answers each public-view request from the script, translating player IDs to handles. */
function scriptedJev(moments: ScriptedMoment[]): DecisionProvider {
  const queue = [...moments];
  return {
    decide: async (request) => {
      const jevRequest = JSON.parse(request.preparedPrompt!.input) as JevRequest;
      const criteria = (jevRequest.questions.prediction as { criteria: Record<string, string> })
        .criteria;
      const view = queue.shift()!.publicView;
      const handles = Object.keys(criteria);
      // "*" scripts a uniform prediction over every option the question offers.
      const probabilities = Object.fromEntries(
        Object.entries(criteria).map(([handle, text]) => {
          const id = handle === "abstain" ? "abstain" : (/\(([^)]+)\)/.exec(text)?.[1] ?? handle);
          return [handle, "*" in view ? 1 / handles.length : (view[id] ?? 0)];
        }),
      );
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
      return {
        data: {
          model: "jev-latest",
          answers: { prediction: { type: "choice", choice, confidence: 1, probabilities } },
        } as never,
        provider: "jev",
        model: "jev-latest",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    },
  };
}

/** A review model whose citations the test controls per moment. */
function scriptedReviewer(reviews: (momentId: string) => MomentReview) {
  const calls: string[] = [];
  const provider: DecisionProvider = {
    decide: async (request) => {
      const momentId = JSON.parse(request.preparedPrompt!.input).moment.id as string;
      calls.push(momentId);
      request.onUsage?.(
        {
          inputTokens: 900,
          outputTokens: 100,
          totalTokens: 1_000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          reasoningTokens: null,
        },
        { provider: "fake", model: "review", outputLimitEnforced: true },
      );
      request.onProviderMetadata?.({ costUsd: 0.01 });
      return {
        data: reviews(momentId) as never,
        provider: "fake",
        model: "review",
        usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 },
      };
    },
  };
  return { provider, calls };
}

const plain = (): MomentReview => ({
  explanation: "Routine.",
  citedEventIds: [],
  knowledgeClaims: [],
  regressionCandidate: false,
});

/** The CES-1040 fixture: three noteworthy moments, three routine ones and one flat prediction. */
const fixture = ({ wolf, other }: { wolf: string; other: string }): ScriptedMoment[] => [
  {
    id: "seer-votes-doubted-wolf",
    actor: "seer",
    actual: wolf,
    privateView: { [wolf]: 0.9, abstain: 0.1 },
    publicView: { [wolf]: 0.05, [other]: 0.8, abstain: 0.15 },
  },
  {
    id: "fay-abstains",
    actor: "seer",
    actual: "abstain",
    privateView: { abstain: 0.6, [wolf]: 0.4 },
    publicView: { abstain: 0.7, [wolf]: 0.1, [other]: 0.2 },
  },
  {
    id: "unexplained-vote",
    actor: "villager",
    actual: other,
    privateView: { [other]: 0.1, [wolf]: 0.8, abstain: 0.1 },
    publicView: { [other]: 0.1, [wolf]: 0.7, abstain: 0.2 },
  },
  ...[1, 2, 3].map((n) => ({
    id: `routine-${n}`,
    actor: "villager" as const,
    actual: wolf,
    privateView: { [wolf]: 0.85, abstain: 0.15 },
    publicView: { [wolf]: 0.8, abstain: 0.2 },
  })),
  {
    id: "flat-public",
    actor: "villager",
    actual: other,
    privateView: { [other]: 0.1, abstain: 0.9 },
    publicView: { "*": 1 },
  },
];

async function run(
  game: ReturnType<typeof recordedGame>,
  reviewer: ReturnType<typeof scriptedReviewer>,
  options: { cap?: number; tokenBudget?: number } = {},
) {
  return analyzeGame({
    dbPath: game.dbPath,
    gameId: game.gameId,
    outDir: join(game.directory, "analysis"),
    jev: scriptedJev(game.moments),
    jevModel: "jev-latest",
    review: { provider: reviewer.provider, kind: "fake", model: "review" },
    ...options,
  });
}

describe("post-game surprise analyzer", () => {
  it("classes the fixture moments and reviews the noteworthy ones plus a recall sample", async () => {
    const game = recordedGame(fixture);
    const reviewer = scriptedReviewer(plain);
    const report = await run(game, reviewer);
    expect(Object.fromEntries(report.moments.map((m) => [m.id, m.class]))).toMatchObject({
      "seer-votes-doubted-wolf": "private_knowledge",
      "fay-abstains": "herd_over_knowledge",
      "unexplained-vote": "noise_or_error",
      "routine-1": "routine",
      "flat-public": "no_signal",
    });
    const reviewed = report.reviews.filter((review) => !review.recall).map((r) => r.momentId);
    expect(reviewed).toEqual(["fay-abstains", "seer-votes-doubted-wolf", "unexplained-vote"]);
    const recall = report.reviews.filter((review) => review.recall);
    expect(recall).toHaveLength(2);
    expect(recall.every((review) => review.class === "routine")).toBe(true);
    expect(reviewer.calls).toHaveLength(5);
    expect(report.usage.review).toMatchObject({ calls: 5, tokens: 5_000 });
    expect(report.usage.review.costUsd).toBeCloseTo(0.05);
    expect(
      JSON.parse(readFileSync(join(game.directory, "analysis", "analysis.json"), "utf8")),
    ).toMatchObject({ gameId: game.gameId });
  });

  it("rejects and marks fabricated citations and claims the player could not have known", async () => {
    const game = recordedGame(fixture);
    const reviewer = scriptedReviewer((momentId) => {
      if (momentId === "seer-votes-doubted-wolf")
        return {
          ...plain(),
          knowledgeClaims: [
            { claim: "The seer inspected the wolf.", eventIds: [game.inspectionId] },
          ],
        };
      if (momentId === "fay-abstains")
        return { ...plain(), citedEventIds: ["event-that-never-happened"] };
      // The villager cannot see the seer's private inspection.
      return {
        ...plain(),
        knowledgeClaims: [{ claim: "They knew the wolf.", eventIds: [game.inspectionId] }],
      };
    });
    const report = await run(game, reviewer, { cap: 3 });
    const status = Object.fromEntries(
      report.reviews.filter((r) => !r.recall).map((r) => [r.momentId, r]),
    );
    expect(status["seer-votes-doubted-wolf"]).toMatchObject({ status: "accepted", issues: [] });
    expect(status["fay-abstains"]).toMatchObject({ status: "rejected_citation" });
    expect(JSON.stringify(status["fay-abstains"])).toContain(
      "unknown event event-that-never-happened",
    );
    expect(status["unexplained-vote"]).toMatchObject({ status: "rejected_citation" });
    expect(JSON.stringify(status["unexplained-vote"])).toContain("could not see before deciding");
  });

  it("enforces the review cap and token budget, and never writes the database", async () => {
    const game = recordedGame(fixture);
    const hash = () => createHash("sha256").update(readFileSync(game.dbPath)).digest("hex");
    const before = hash();
    const capped = scriptedReviewer(plain);
    const report = await run(game, capped, { cap: 1 });
    expect(report.reviews.filter((review) => !review.recall).map((r) => r.momentId)).toEqual([
      "fay-abstains",
    ]);
    expect(capped.calls).toHaveLength(3); // one capped review plus the two recall checks
    const starved = scriptedReviewer(plain);
    const skipped = await run(game, starved, { tokenBudget: 100 });
    expect(starved.calls).toHaveLength(0);
    expect(skipped.reviews.every((review) => review.status === "skipped_budget")).toBe(true);
    expect(hash()).toBe(before);
  });

  it("keeps the automatic post-game run off unless asked, and then needs a review model", () => {
    expect(postGameAnalysisRequest({})).toBeNull();
    expect(() => postGameAnalysisRequest({ analyze: true })).toThrow(/--review-provider/);
    expect(
      postGameAnalysisRequest({
        analyze: true,
        "review-provider": "anthropic",
        "review-model": "claude-opus-5-5",
      }),
    ).toEqual({ kind: "anthropic", model: "claude-opus-5-5" });
  });
});
