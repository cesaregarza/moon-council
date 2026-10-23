import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
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
import * as analysis from "./game-analyze";
import { analyzeGame, postGameAnalysisRequest } from "./game-analyze";
import { checkCitations } from "./lib/analyze-citations";
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
  const { kind = "fake", maxSpendUsd = 20, ...rest } = options;
  return analyzeGame({
    dbPath: game.dbPath,
    gameId: game.gameId,
    outDir: join(game.directory, "analysis"),
    jev: scriptedJev(game.moments),
    jevModel: "jev-latest",
    review: { provider: reviewer.provider, kind, model: "review" },
    maxSpendUsd,
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
    // An accepted review kind (anthropic is refused until analysis has a USD cap, CES-1040).
    expect(
      postGameAnalysisRequest({
        analyze: true,
        "review-provider": "openai",
        "review-model": "gpt-6-luna",
      }),
    ).toEqual({ kind: "openai", model: "gpt-6-luna" });
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

  it("reports a review cost total that overflows as unknown, never Infinity", async () => {
    // halcyon's control: each call reports the largest finite cost.
    const game = recordedGame(fixture);
    const reviewer = scriptedReviewer(plain);
    const reporting: DecisionProvider = {
      decide: (request) =>
        reviewer.provider.decide({
          ...request,
          onProviderMetadata: (metadata) =>
            request.onProviderMetadata?.({ ...metadata, costUsd: Number.MAX_VALUE }),
        }),
    };
    const report = await run(game, { ...reviewer, provider: reporting });
    expect(report.usage.review.costUsd).toBeNull();
    const markdown = readFileSync(join(game.directory, "analysis", "analysis.md"), "utf8");
    expect(markdown).not.toContain("Infinity");
    expect(markdown).toContain("unknown reported cost");
  });

  it.each([
    ["an invalid cost followed by $0.02", [-1, 0.02]],
    ["the largest finite cost", [Number.MAX_VALUE]],
  ])("keeps Jev's cost unknown after %s", async (_label, costs) => {
    // halcyon's control: a later valid callback must not clear an earlier unknown cost.
    const game = recordedGame(fixture);
    const jev = scriptedJev(game.moments);
    const reporting: DecisionProvider = {
      decide: async (request) => {
        const result = await jev.decide(request);
        for (const costUsd of costs) request.onProviderMetadata?.({ costUsd });
        return result;
      },
    };
    const report = await analyzeGame({
      dbPath: game.dbPath,
      gameId: game.gameId,
      outDir: join(game.directory, "analysis"),
      jev: reporting,
      jevModel: "jev-latest",
      review: { provider: scriptedReviewer(plain).provider, kind: "fake", model: "review" },
      maxSpendUsd: 20,
    });
    const jevUsage = (
      report.usage as unknown as { jev: { costUsd: unknown; perCall: { costUsd: unknown }[] } }
    ).jev;
    expect(jevUsage.costUsd).toBeNull();
    expect(costs.length > 1 ? jevUsage.perCall.map((call) => call.costUsd) : []).toEqual(
      costs.length > 1 ? jevUsage.perCall.map(() => null) : [],
    );
  });

  it("rejects citations checked against no deciders or a duplicated decider", () => {
    const game = recordedGame(fixture);
    const connection = openDatabase(game.dbPath);
    const events = new LabRepository(connection).listEvents(game.gameId);
    connection.close();
    const review = { citedEventIds: [game.inspectionId], knowledgeClaims: [] };
    expect(checkCitations(review, events, []).accepted).toBe(false);
    const late = events.at(-1)!.sequence + 1;
    expect(
      checkCitations(review, events, [
        { actorId: game.seer, decisionSequence: 0 },
        { actorId: game.seer, decisionSequence: late },
      ]).accepted,
    ).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01])(
    "records a reported review cost of %s as unknown, never as a number",
    async (costUsd) => {
      const game = recordedGame(fixture);
      const reviewer = scriptedReviewer(plain);
      const reporting: DecisionProvider = {
        decide: (request) =>
          reviewer.provider.decide({
            ...request,
            onProviderMetadata: (metadata) =>
              request.onProviderMetadata?.({ ...metadata, costUsd }),
          }),
      };
      const report = await run(game, { ...reviewer, provider: reporting });
      expect(report.usage.review.costUsd).toBeNull();
    },
  );

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

/**
 * CES-1564: one USD cap bounds the whole analysis run. Before the first paid call, the worst case
 * (every Jev request at its byte size, at the Jev rate with margin, plus the review token budget
 * at the review model's highest price) must fit under it; Claude reviews then reserve against
 * what the cap leaves after Jev's worst case, and stop by name when a call would not fit.
 */
describe("analysis spend cap", () => {
  interface SpendCap {
    allow(usd: number): void;
    reserve(id: string, usd: number): void;
    settle(id: string, usd: number): void;
  }
  // Read through a cast so this file compiles before the analyzer exports these (tests first).
  const api = analysis as unknown as {
    ReviewSpendCap?: new (ledger: Pick<SpendCap, "reserve" | "settle">) => SpendCap;
    ReviewSpendLimitError?: new (message: string) => Error;
  };
  interface Spend {
    capUsd: number;
    estimateUsd: { jev: number; review: number; total: number };
    actualUsd: { jev: number | null; review: number | null };
  }
  const spendOf = (report: unknown) => (report as { spend: Spend }).spend;
  const options = (fields: Record<string, unknown>) =>
    fields as unknown as Parameters<typeof analyzeGame>[0];

  /** Counts Jev's calls and keeps each request exactly as the analyzer sent it. */
  function countedJev(game: ReturnType<typeof recordedGame>) {
    const jev = scriptedJev(game.moments);
    const inputs: string[] = [];
    const provider: DecisionProvider = {
      decide: (request) => {
        inputs.push(request.preparedPrompt!.input);
        return jev.decide(request);
      },
    };
    return { provider, inputs };
  }
  const monthly = () => ({ reserve: () => undefined, settle: () => undefined });
  function haikuRun(game: ReturnType<typeof recordedGame>, maxSpendUsd: number | undefined) {
    expect(api.ReviewSpendCap).toBeTypeOf("function");
    const jev = countedJev(game);
    const reviewer = scriptedReviewer(plain);
    const spendCap = new api.ReviewSpendCap!(monthly());
    const run = analyzeGame(
      options({
        dbPath: game.dbPath,
        gameId: game.gameId,
        outDir: join(game.directory, "analysis"),
        jev: jev.provider,
        jevModel: "jev-latest",
        review: {
          provider: reviewer.provider,
          kind: "anthropic",
          model: "claude-haiku-5-5",
          spendCap,
        },
        tokenBudget: 200_000,
        ...(maxSpendUsd === undefined ? {} : { maxSpendUsd }),
      }),
    );
    return { run, jev, reviewer, spendCap };
  }
  /**
   * The bound: a Jev call's billed input tokens never exceed the UTF-8 bytes of the full request
   * as the client sends it, plus a fixed framing allowance. ask-jev re-sends the request with
   * Python's ", " and ": " separators; the same JSON with a one-space indent is never shorter.
   */
  const JEV_FRAMING_TOKENS = 512;
  const requestCeiling = (input: string) =>
    Buffer.byteLength(JSON.stringify(JSON.parse(input), null, 1), "utf8") + JEV_FRAMING_TOKENS;
  // $0.042 per million input tokens (~/.claude/skills/jev/scripts/jev.py:182), with 1.5x margin.
  const JEV_USD_PER_TOKEN = (0.042 * 1.5) / 1_000_000;
  // Haiku 5.5's highest rate is $2.50/M (long-context output); each review may be sent three
  // times (one attempt plus the SDK's two retries).
  const HAIKU_MAX_USD_PER_TOKEN = 2.5 / 1_000_000;
  const CLAUDE_MAX_ATTEMPTS = 3;

  it("estimates the worst case from each Jev request's ceiling and every review attempt", async () => {
    const game = recordedGame(fixture);
    const { run, jev, spendCap } = haikuRun(game, 20);
    const report = await run;
    const spend = spendOf(report);
    expect(jev.inputs).toHaveLength(7);
    const tokens = jev.inputs.reduce((total, input) => total + requestCeiling(input), 0);
    expect(spend.capUsd).toBe(20);
    expect(spend.estimateUsd.jev).toBeCloseTo(tokens * JEV_USD_PER_TOKEN, 12);
    expect(spend.estimateUsd.review).toBeCloseTo(
      200_000 * HAIKU_MAX_USD_PER_TOKEN * CLAUDE_MAX_ATTEMPTS,
      12,
    );
    expect(spend.estimateUsd.total).toBeCloseTo(
      spend.estimateUsd.jev + spend.estimateUsd.review,
      12,
    );
    // Actual usage sits next to the estimate: Jev's reported input tokens at the rate, no margin.
    expect(spend.actualUsd.jev).toBeCloseTo((7 * 10 * 0.042) / 1_000_000, 15);
    expect(spend.actualUsd.review).toBe(report.usage.review.costUsd);
    const markdown = readFileSync(join(game.directory, "analysis", "analysis.md"), "utf8");
    expect(markdown).toContain(`$${spend.estimateUsd.total.toFixed(4)} worst case`);
    // Reviews may reserve only what the cap leaves after Jev's worst case.
    const left = 20 - spend.estimateUsd.jev;
    expect(() => spendCap.reserve("over", left + 1e-9)).toThrow();
    expect(() => spendCap.reserve("under", left - 1e-9)).not.toThrow();
  });

  it("refuses a cap one cent below the worst case before any Jev or review call", async () => {
    const first = haikuRun(recordedGame(fixture), 20);
    const worst = spendOf(await first.run).estimateUsd.total;
    const game = recordedGame(fixture);
    const { run, jev, reviewer } = haikuRun(game, worst - 0.01);
    await expect(run).rejects.toMatchObject({ name: "AnalysisSpendCapError" });
    expect(jev.inputs).toHaveLength(0);
    expect(reviewer.calls).toHaveLength(0);
    expect(existsSync(join(game.directory, "analysis", "analysis.json"))).toBe(false);
  });

  it("refuses a run without a cap by name before any call", async () => {
    const game = recordedGame(fixture);
    const { run, jev, reviewer } = haikuRun(game, undefined);
    await expect(run).rejects.toMatchObject({ name: "MissingAnalysisSpendCapError" });
    expect(jev.inputs).toHaveLength(0);
    expect(reviewer.calls).toHaveLength(0);
  });

  it("refuses Claude reviews that do not reserve through the run's cap", async () => {
    const game = recordedGame(fixture);
    const jev = countedJev(game);
    const reviewer = scriptedReviewer(plain);
    const run = analyzeGame(
      options({
        dbPath: game.dbPath,
        gameId: game.gameId,
        outDir: join(game.directory, "analysis"),
        jev: jev.provider,
        jevModel: "jev-latest",
        review: { provider: reviewer.provider, kind: "anthropic", model: "claude-haiku-5-5" },
        maxSpendUsd: 20,
      }),
    );
    await expect(run).rejects.toMatchObject({ name: "UncappedReviewSpendError" });
    expect(jev.inputs).toHaveLength(0);
    expect(reviewer.calls).toHaveLength(0);
  });

  it("stops reviewing by name once a call would pass the cap", async () => {
    expect(api.ReviewSpendLimitError).toBeTypeOf("function");
    const game = recordedGame(fixture);
    const reviewer = scriptedReviewer(plain);
    const capped: DecisionProvider = {
      decide: (request) => {
        if (reviewer.calls.length === 1) {
          reviewer.calls.push("refused");
          throw new api.ReviewSpendLimitError!("Analysis review cap reached");
        }
        return reviewer.provider.decide(request);
      },
    };
    const report = await run(game, { ...reviewer, provider: capped });
    expect(reviewer.calls).toHaveLength(2);
    expect(report.usage.review.calls).toBe(1);
    const statuses = report.reviews.map((review) => review.status as string);
    expect(statuses[0]).toBe("accepted");
    expect(statuses.slice(1)).toEqual(statuses.slice(1).map(() => "skipped_spend_cap"));
    expect(report.reviews[1]).toMatchObject({ error: expect.stringContaining("cap reached") });
  });
});
