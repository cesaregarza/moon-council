import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyJournalV2, type DecisionOpportunityV1 } from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase } from "@werewolf/db";
import { DOCTOR_V2, STARTER_ROLES, reduceGame } from "@werewolf/engine";
import { FakeDecisionProvider, type DecisionProvider, type JevRequest } from "@werewolf/llm";
import { buildContextV2 } from "../packages/simulator/src/context-v2";
import { actorBriefing } from "../packages/simulator/src/jev-actor";
import { V2GameOrchestrator } from "../packages/simulator/src/orchestrator-v2";
import { actorConfig, refreshFixtureBrief } from "../packages/simulator/src/testing/actor-fixtures";
import { analyzeGame, postGameAnalysisRequest } from "./game-analyze";
import type { MomentReview } from "./lib/analyze-review";

const directories: string[] = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

type Distribution = Record<string, number>;
interface ScriptedMoment {
  id: string;
  actor: "seer" | "villager" | "wolf" | "wolf2";
  /** A player ID, or "abstain". */
  actual: string;
  /** Jev's recorded distribution when the player decided. */
  privateView: Distribution;
  /**
   * Jev's public-record prediction, scripted for the analyzer's call; absent for a decision the
   * analyzer makes no call for (one call per kill night, none for other night roles).
   */
  publicView?: Distribution;
  /**
   * A night decision: a wolf's pack point (the kill, as real games record it) or another role's
   * night action. With `dawn`, the night resolves after it: the player found dead, or null.
   */
  night?: { point?: boolean; dawn?: string | null };
  /** The actor's current decision brief (what Jev was given as current reasoning). */
  brief?: string;
}

/**
 * A recorded game on disk: a seer who inspected a wolf, and committed ballots with recorded Jev
 * distributions, written straight into the store as the executor would have.
 */
function recordedGame(
  script: (ids: {
    wolf: string;
    other: string;
    villager: string;
    seer: string;
  }) => ScriptedMoment[],
) {
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
  const [wolf, wolf2] = state.players
    .filter((p) => p.role.alignment === "werewolf")
    .map((p) => p.id) as [string, string];
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
  const moments = script({ wolf, other, villager, seer });
  const ops: Record<string, DecisionOpportunityV1> = {};
  for (const moment of moments) {
    const actor = { seer, villager, wolf, wolf2 }[moment.actor];
    const events = repository.listEvents(game.id);
    const night = moment.night !== undefined;
    const point = moment.night?.point === true;
    const task = point
      ? { phase: "night_team", kind: "team_point", taskType: "team_point_choice" }
      : night
        ? { phase: "night_actions", kind: "night_action", taskType: "night_choice" }
        : { phase: "day_vote", kind: "vote", taskType: "vote_choice" };
    const phase = task.phase as "night_team" | "night_actions" | "day_vote";
    const kind = task.kind as "team_point" | "night_action" | "vote";
    state = { ...reduceGame(game.id, events), phase };
    const packet = buildContextV2(state, events, actor, emptyJournalV2(), moment.id, kind);
    if (moment.brief) refreshFixtureBrief(packet, moment.brief);
    const handle = (id: string) =>
      id === "abstain" ? "abstain" : String.fromCharCode(97 + packet.legalTargets.indexOf(id));
    const op = {
      id: moment.id,
      gameId: game.id,
      playerId: actor,
      kind,
      phase,
      day: 1,
      epoch: `1:${phase}`,
      viewId: moment.id,
      baseJournalVersion: 0,
      packet,
      status: "committed",
      best: null,
      recovery: 0,
      createdAt: "2026-10-22T00:00:00.000Z",
      taskType: task.taskType,
    } as DecisionOpportunityV1;
    store.save(op);
    ops[moment.id] = op;
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
          kind,
          targets:
            moment.actual === "abstain" ? null : { mode: "direct", playerIds: [moment.actual] },
        },
      },
    });
    if (moment.night?.dawn !== undefined) dawn(repository, game.id, moment.night.dawn);
  }
  connection.close();
  return { dbPath, gameId: game.id, directory, inspectionId, seer, villager, moments, ops };
}

/** The engine's night resolution: a public death (or none), then the moderator's summary. */
function dawn(repository: LabRepository, gameId: string, dead: string | null) {
  const at = { day: 1, phase: "night_resolution" as const };
  if (dead)
    repository.appendEvent(gameId, {
      ...at,
      type: "player.eliminated",
      visibility: "public",
      payload: { playerId: dead, cause: "night" },
    });
  repository.appendEvent(gameId, {
    ...at,
    type: "night.resolved",
    visibility: "moderator",
    payload: {
      blockedActorIds: [],
      protectedPlayerIds: [],
      eliminatedPlayerIds: dead ? [dead] : [],
      skippedUnanimousGroups: [],
    },
  });
}

/** Answers each public-view request from the script, translating player IDs to handles. */
function scriptedJev(moments: ScriptedMoment[]): DecisionProvider {
  const queue = moments.filter((moment) => moment.publicView);
  return {
    decide: async (request) => {
      const jevRequest = JSON.parse(request.preparedPrompt!.input) as JevRequest;
      const criteria = (jevRequest.questions.prediction as { criteria: Record<string, string> })
        .criteria;
      const view = queue.shift()!.publicView!;
      const handles = Object.keys(criteria);
      // "*" scripts a uniform prediction over every option the question offers.
      const scripted = Object.entries(criteria).map(([handle, text]) => {
        const id = handle === "abstain" ? "abstain" : (/\(([^)]+)\)/.exec(text)?.[1] ?? handle);
        return [handle, "*" in view ? 1 / handles.length : (view[id] ?? 0)] as const;
      });
      // Renormalized over the offered options, so a view scripted for another moment (when an
      // analyzer calls Jev for a decision the script did not expect) still parses as Jev output.
      const total = scripted.reduce((sum, [, p]) => sum + p, 0);
      const probabilities = Object.fromEntries(
        scripted.map(([handle, p]) => [handle, total > 0 ? p / total : 1 / handles.length]),
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
function scriptedReviewer(
  reviews: (momentId: string) => MomentReview,
  reported = { outputTokens: 100, outputLimitEnforced: true },
) {
  const calls: string[] = [];
  const dossiers: Record<string, unknown>[] = [];
  const provider: DecisionProvider = {
    decide: async (request) => {
      const dossier = JSON.parse(request.preparedPrompt!.input);
      const momentId = dossier.moment.id as string;
      calls.push(momentId);
      dossiers.push(dossier);
      request.onUsage?.(
        {
          inputTokens: 900,
          outputTokens: reported.outputTokens,
          totalTokens: 900 + reported.outputTokens,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          reasoningTokens: null,
        },
        { provider: "fake", model: "review", outputLimitEnforced: reported.outputLimitEnforced },
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
  return { provider, calls, dossiers };
}

// Cast so the fixture compiles against a schema without groundTruth (tests-first commit).
const plain = (): MomentReview =>
  ({
    explanation: "Routine.",
    citedEventIds: [],
    knowledgeClaims: [],
    groundTruth: "",
    regressionCandidate: false,
  }) as MomentReview;

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
  options: Partial<Parameters<typeof analyzeGame>[0]> & { kind?: string } = {},
) {
  const { kind = "fake", ...rest } = options;
  return analyzeGame({
    dbPath: game.dbPath,
    gameId: game.gameId,
    outDir: join(game.directory, "analysis"),
    jev: scriptedJev(game.moments),
    jevModel: "jev-latest",
    review: { provider: reviewer.provider, kind, model: "review" },
    ...rest,
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
    // A configured review model alone never turns the run on. Checked first, so an always-on
    // mutant fails this assertion instead of throwing below.
    expect(
      postGameAnalysisRequest({
        "review-provider": "anthropic",
        "review-model": "claude-opus-5-5",
      }),
    ).toBeNull();
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

// halcyon's controls from the PR #23 review (CES-1040, 03:25Z), as regression tests.
describe("post-game analyzer safety and accounting", () => {
  const dbHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

  it("refuses to run when a report path is the database, and leaves it unchanged", async () => {
    const game = recordedGame(fixture);
    const outDir = join(game.directory, "analysis");
    mkdirSync(outDir);
    const dbPath = join(outDir, "analysis.json");
    renameSync(game.dbPath, dbPath);
    const before = dbHash(dbPath);
    const reviewer = scriptedReviewer(plain);
    await expect(run({ ...game, dbPath }, reviewer)).rejects.toThrow(/database/);
    expect(dbHash(dbPath)).toBe(before);
    expect(reviewer.calls).toHaveLength(0);
  });

  it("refuses a report path that links to the database or its -wal file", async () => {
    const game = recordedGame(fixture);
    const outDir = join(game.directory, "analysis");
    mkdirSync(outDir);
    const before = dbHash(game.dbPath);
    symlinkSync(game.dbPath, join(outDir, "analysis.json"));
    await expect(run(game, scriptedReviewer(plain))).rejects.toThrow(/analysis\.json/);
    rmSync(join(outDir, "analysis.json"));
    symlinkSync(`${game.dbPath}-wal`, join(outDir, "analysis.md"));
    await expect(run(game, scriptedReviewer(plain))).rejects.toThrow(/analysis\.md/);
    expect(dbHash(game.dbPath)).toBe(before);
  });

  it("never overwrites a file that is not a previous report", async () => {
    const game = recordedGame(fixture);
    const outDir = join(game.directory, "analysis");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "analysis.md"), "my notes\n");
    await expect(run(game, scriptedReviewer(plain))).rejects.toThrow(/previous report/);
    expect(readFileSync(join(outDir, "analysis.md"), "utf8")).toBe("my notes\n");
  });

  it("refuses a review provider that does not enforce the output cap", async () => {
    const game = recordedGame(fixture);
    const reviewer = scriptedReviewer(plain);
    const refused = run(game, reviewer, { kind: "codex" });
    await expect(refused).rejects.toMatchObject({ name: "UnenforcedOutputLimitError" });
    expect(reviewer.calls).toHaveLength(0);
  });

  it("stops reviewing when a provider reports an unenforced cap, settling its reported usage", async () => {
    // halcyon's control: a 10,000-token budget, a 100-token cap, and a call reporting 21,000.
    const game = recordedGame(fixture);
    const reviewer = scriptedReviewer(plain, {
      outputTokens: 20_100,
      outputLimitEnforced: false,
    });
    const report = await run(game, reviewer, { tokenBudget: 10_000, maxOutputTokens: 100 });
    expect(reviewer.calls).toHaveLength(1);
    expect(report.reviews[0]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/output limit/),
    });
    expect(report.reviews.slice(1).every((review) => review.status === "skipped_budget")).toBe(
      true,
    );
    expect(report.usage.review.tokens).toBe(21_000);
  });

  it.each([
    ["tokenBudget", Number.NaN],
    ["tokenBudget", -1],
    ["cap", Number.NaN],
    ["cap", -3],
    ["recall", 1.5],
    ["maxOutputTokens", Number.POSITIVE_INFINITY],
  ])("refuses to start with %s = %s", async (flag, value) => {
    const game = recordedGame(fixture);
    const reviewer = scriptedReviewer(plain);
    const options = { [flag]: value } as Partial<Parameters<typeof analyzeGame>[0]>;
    await expect(run(game, reviewer, options)).rejects.toThrow(flag);
    expect(reviewer.calls).toHaveLength(0);
  });

  it("rejects a cited event the actor could not see, even with no knowledge claims", async () => {
    const game = recordedGame(fixture);
    const reviewer = scriptedReviewer((momentId) =>
      momentId === "unexplained-vote"
        ? {
            ...plain(),
            explanation: "The villager knew the wolf from the seer's inspection.",
            citedEventIds: [game.inspectionId],
          }
        : plain(),
    );
    const report = await run(game, reviewer, { cap: 3 });
    const review = report.reviews.find((r) => r.momentId === "unexplained-vote");
    expect(review).toMatchObject({ status: "rejected_citation" });
    expect(JSON.stringify(review)).toContain("could not see before deciding");
  });

  it("rejects a citation of an event after the decision", async () => {
    const game = recordedGame(fixture);
    const connection = openDatabase(game.dbPath);
    const repository = new LabRepository(connection);
    repository.appendEvent(game.gameId, {
      day: 2,
      phase: "day_discussion",
      type: "speech.public",
      visibility: "public",
      payload: { playerId: game.seer, text: "Later.", acts: [], respondsTo: [], closing: false },
    });
    const futureId = repository.listEvents(game.gameId).at(-1)!.id;
    connection.close();
    const reviewer = scriptedReviewer((momentId) =>
      momentId === "seer-votes-doubted-wolf" ? { ...plain(), citedEventIds: [futureId] } : plain(),
    );
    const report = await run(game, reviewer, { cap: 3 });
    const review = report.reviews.find((r) => r.momentId === "seer-votes-doubted-wolf");
    expect(review).toMatchObject({ status: "rejected_citation" });
    expect(JSON.stringify(review)).toContain(`${futureId}, which`);
  });

  it("keeps hidden ground truth in its own field, outside the cited evidence", async () => {
    const game = recordedGame(fixture);
    const reviewer = scriptedReviewer((momentId) => ({
      ...plain(),
      groundTruth: momentId === "unexplained-vote" ? "The voted player was a villager." : "",
    }));
    const report = await run(game, reviewer, { cap: 3 });
    expect(report.reviews.find((r) => r.momentId === "unexplained-vote")).toMatchObject({
      status: "accepted",
      review: { groundTruth: "The voted player was a villager." },
    });
  });

  it("gives the reviewer the actor's decision-time briefing exactly as Jev received it", async () => {
    const brief = "BRIEF-CANARY: the seer's own inspection found the wolf.";
    const game = recordedGame((ids) =>
      fixture(ids).map((moment) =>
        moment.id === "seer-votes-doubted-wolf" ? { ...moment, brief } : moment,
      ),
    );
    const reviewer = scriptedReviewer(plain);
    await run(game, reviewer, { cap: 3 });
    const dossier = reviewer.dossiers.find(
      (d) => (d.moment as { id: string }).id === "seer-votes-doubted-wolf",
    )!;
    const expected = actorBriefing(game.ops["seer-votes-doubted-wolf"]!);
    expect(expected.currentReasoning).toBe(brief);
    expect(dossier.actorBriefing).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("records Jev's tokens per call alongside the review usage", async () => {
    const game = recordedGame(fixture);
    const report = await run(game, scriptedReviewer(plain));
    expect(report.usage).toMatchObject({
      jev: { calls: 7, inputTokens: 70, outputTokens: 35, totalTokens: 105, costUsd: null },
    });
    const perCall = (report.usage as unknown as { jev: { perCall: unknown[] } }).jev.perCall;
    expect(perCall).toHaveLength(7);
    expect(perCall[0]).toEqual({
      momentId: "seer-votes-doubted-wolf",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: null,
    });
  });
});

describe("post-game analyzer night moments", () => {
  // Felix's ruling on finding 2: the pack's kill point is the night moment, one per night,
  // scored on the public dawn outcome.
  const nights = ({ other, villager, seer }: { other: string; villager: string; seer: string }) => [
    // Night 1: both wolves point at the villager, who is found dead.
    {
      id: "kill-matches-dawn",
      actor: "wolf" as const,
      actual: villager,
      privateView: { [villager]: 0.9, [other]: 0.1 },
      night: { point: true },
    },
    {
      id: "kill-matches-dawn-2",
      actor: "wolf2" as const,
      actual: villager,
      privateView: { [villager]: 0.7, [other]: 0.3 },
      publicView: { [villager]: 0.05, [other]: 0.15, no_death: 0.8 },
      night: { point: true, dawn: villager },
    },
    // Night 2: a unanimous point at another villager, saved.
    {
      id: "kill-saved",
      actor: "wolf" as const,
      actual: other,
      privateView: { [other]: 0.95 },
      night: { point: true },
    },
    {
      id: "kill-saved-2",
      actor: "wolf2" as const,
      actual: other,
      privateView: { [other]: 0.95 },
      publicView: { [other]: 0.1, no_death: 0.9 },
      night: { point: true, dawn: null },
    },
    // Night 3: the wolves disagree, so no kill.
    {
      id: "no-unanimity",
      actor: "wolf" as const,
      actual: other,
      privateView: { [other]: 0.6, [seer]: 0.4 },
      night: { point: true },
    },
    {
      id: "no-unanimity-2",
      actor: "wolf2" as const,
      actual: seer,
      privateView: { [seer]: 0.8, [other]: 0.2 },
      publicView: { [other]: 0.2, [seer]: 0.2, no_death: 0.6 },
      night: { point: true },
    },
    // halcyon's control: a Seer inspects and nobody dies; the public expects no death.
    {
      id: "seer-inspects",
      actor: "seer" as const,
      actual: other,
      privateView: { [other]: 1 },
      night: { dawn: null },
    },
  ];

  it("scores a unanimous kill on the dawn and marks a saved or split night no_signal", async () => {
    const game = recordedGame(nights);
    const report = await run(game, scriptedReviewer(plain));
    const byId = Object.fromEntries(report.moments.map((m) => [m.id, m]));
    // One moment per night, named for the pack's first point; none for the seer.
    expect(Object.keys(byId).sort((a, b) => a.localeCompare(b))).toEqual([
      "kill-matches-dawn",
      "kill-saved",
      "no-unanimity",
    ]);
    expect(byId["kill-matches-dawn"]).toMatchObject({
      kind: "night_action",
      actual: game.villager,
      selected: game.villager,
      class: "private_knowledge",
      score: { publicProbability: 0.05 },
    });
    // The pack's private probability is the mean of each wolf's recorded value.
    const killed = byId["kill-matches-dawn"] as unknown as {
      score: { privateProbability: number };
      wolfProbabilities: Record<string, number>;
    };
    expect(killed.score.privateProbability).toBeCloseTo(0.8, 10);
    expect(Object.values(killed.wolfProbabilities).sort((a, b) => a - b)).toEqual([0.7, 0.9]);
    expect(byId["kill-saved"]).toMatchObject({
      actual: "no_death",
      selected: expect.any(String),
      class: "no_signal",
      noSignalReason: expect.stringContaining("dawn"),
    });
    expect(byId["no-unanimity"]).toMatchObject({
      class: "no_signal",
      noSignalReason: expect.stringContaining("unanim"),
    });
  });

  it("gives the reviewer every living wolf's decision-time briefing for a kill", async () => {
    const game = recordedGame((ids) =>
      nights(ids)
        .slice(0, 2)
        .map((moment, index) => ({ ...moment, brief: `PACK-BRIEF-${index}: the villager.` })),
    );
    const reviewer = scriptedReviewer(plain);
    await run(game, reviewer);
    const dossier = reviewer.dossiers.find(
      (d) => (d.moment as { id: string }).id === "kill-matches-dawn",
    );
    expect(dossier).toBeDefined();
    const briefings = dossier!.actorBriefings as Record<string, { currentReasoning: string }>;
    expect(Object.values(briefings).map((b) => b.currentReasoning)).toEqual([
      "PACK-BRIEF-0: the villager.",
      "PACK-BRIEF-1: the villager.",
    ]);
    for (const id of ["kill-matches-dawn", "kill-matches-dawn-2"]) {
      const op = game.ops[id]!;
      expect(briefings[op.playerId]).toEqual(JSON.parse(JSON.stringify(actorBriefing(op))));
    }
  });
});
