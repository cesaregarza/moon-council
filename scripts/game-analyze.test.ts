import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { symlinkSync } from "node:fs";
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
import { writeReportAtomically } from "./lib/analyze-output";
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
  const moments = script({ wolf, other, villager, seer });
  const ops: Record<string, DecisionOpportunityV1> = {};
  // Ballots only: pack nights come from the real orchestrator (game-analyze-pack.test.ts).
  for (const moment of moments) {
    const actor = moment.actor === "seer" ? seer : villager;
    const events = repository.listEvents(game.id);
    state = { ...reduceGame(game.id, events), phase: "day_vote" };
    const packet = buildContextV2(state, events, actor, emptyJournalV2(), moment.id, "vote");
    if (moment.brief) refreshFixtureBrief(packet, moment.brief);
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
          kind: "vote",
          targets:
            moment.actual === "abstain" ? null : { mode: "direct", playerIds: [moment.actual] },
        },
      },
    });
  }
  connection.close();
  return { dbPath, gameId: game.id, directory, inspectionId, seer, villager, moments, ops };
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

type Claim = MomentReview["knowledgeClaims"][number];
/** A knowledge claim about one player (`subjectId`), or about the whole pack when null. */
const claim = (text: string, eventIds: string[], subjectId: string | null = null) =>
  ({ claim: text, eventIds, subjectId }) as Claim;

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
          knowledgeClaims: [claim("The seer inspected the wolf.", [game.inspectionId])],
        };
      if (momentId === "fay-abstains")
        return { ...plain(), citedEventIds: ["event-that-never-happened"] };
      // The villager cannot see the seer's private inspection.
      return {
        ...plain(),
        knowledgeClaims: [claim("They knew the wolf.", [game.inspectionId])],
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

  it("keeps accounting finite when a provider reports non-finite usage", async () => {
    // halcyon's control: a NaN total must not switch the budget off. With a 6,000-token cap and
    // a 12,000-token budget, the second review's worst case can no longer fit.
    const game = recordedGame(fixture);
    const reviewer = scriptedReviewer(plain, {
      outputTokens: Number.NaN,
      outputLimitEnforced: true,
    });
    const report = await run(game, reviewer, { tokenBudget: 12_000, maxOutputTokens: 6_000 });
    expect(Number.isFinite(report.usage.review.tokens)).toBe(true);
    expect(report.usage.review.tokens).toBeGreaterThan(6_000);
    expect(reviewer.calls).toHaveLength(1);
  });

  it("removes its temporary file when the rename fails, so a retry is not blocked", () => {
    const directory = mkdtempSync(join(tmpdir(), "analyze-output-"));
    directories.push(directory);
    const target = join(directory, "analysis.json");
    mkdirSync(join(target, "occupied"), { recursive: true }); // rename onto it fails
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => writeReportAtomically(target, "{}\n")).toThrow();
      expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }
  });

  it("keeps an unenforced output cap sticky when a later callback reports it enforced", async () => {
    // halcyon's control: false then true must still fail the review and stop admission.
    const game = recordedGame(fixture);
    const calls: string[] = [];
    const flipping: DecisionProvider = {
      decide: async (request) => {
        calls.push(JSON.parse(request.preparedPrompt!.input).moment.id);
        const usage = {
          inputTokens: 900,
          outputTokens: 100,
          totalTokens: 1_000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          reasoningTokens: null,
        };
        request.onUsage?.(usage, { provider: "fake", model: "review", outputLimitEnforced: false });
        request.onUsage?.(usage, { provider: "fake", model: "review", outputLimitEnforced: true });
        return { data: plain() as never, provider: "fake", model: "review", usage };
      },
    };
    const report = await run(game, { provider: flipping, calls, dossiers: [] });
    expect(calls).toHaveLength(1);
    expect(report.reviews[0]).toMatchObject({ status: "failed" });
  });

  it("never removes a temporary file it did not create", () => {
    // halcyon's forced collision: the temporary name already exists and belongs to someone else.
    const directory = mkdtempSync(join(tmpdir(), "analyze-output-"));
    directories.push(directory);
    const target = join(directory, "analysis.json");
    writeFileSync(`${target}.collision.tmp`, "not ours\n");
    const write = writeReportAtomically as (
      path: string,
      text: string,
      name?: () => string,
    ) => void;
    expect(() => write(target, "{}\n", () => "collision")).toThrow();
    expect(readFileSync(`${target}.collision.tmp`, "utf8")).toBe("not ours\n");
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
