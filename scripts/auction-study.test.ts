import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  studyRuns,
  FOCUSED,
  RAMBLING,
  validateManifest,
  type StudyManifest,
} from "./lib/auction-study-design";
import { AUCTION_SCENARIOS } from "./lib/auction-study-scenarios";
import { studyPlayers, playerPrompt, jevPrompt } from "./lib/auction-study-agents";
import { runStudyDiscussion } from "./lib/auction-study-runner";
import {
  discussionMetrics,
  factorialEffects,
  writeStudyReport,
} from "./lib/auction-study-analysis";
import { studyStatus } from "./auction-study";
import { rankSpeakerAuction } from "../packages/simulator/src/speaker-auction";

const manifest = (): StudyManifest => ({
  schemaVersion: "speech_auction_study_v1",
  protocol: "free-floor-v1",
  createdAt: "fixture",
  sourceCommit: "a".repeat(40),
  live: false,
  model: "fake",
  effort: "low",
  turns: 8,
  bias: 0.25,
  concurrency: 1,
  maxMinutes: 1,
  runs: studyRuns(["fixture"], ["incident"]),
  scenarios: AUCTION_SCENARIOS,
  personalities: { focused: FOCUSED, rambling: RAMBLING },
});
describe("general speech auction study", () => {
  it("matches assignments within four factorial cells and rejects tampered manifests", () => {
    const plan = manifest();
    expect(validateManifest(plan)).toEqual(plan);
    expect(new Set(plan.runs.map((run) => JSON.stringify(run.evidenceOrder))).size).toBe(1);
    expect(new Set(plan.runs.map((run) => run.condition)).size).toBe(4);
    expect(studyRuns(["fixture"], ["incident"])).toEqual(plan.runs);
    expect(() => studyRuns(["x", "x"], ["supplier"])).toThrow();
    expect(() => studyRuns(["x"], ["../private"])).toThrow();
    const changed = structuredClone(plan);
    changed.runs[0]!.targetId = "p99";
    expect(() => validateManifest(changed)).toThrow();
  });
  it("isolates private evidence and journals, hides solutions and treatments, and preserves actor perspective", () => {
    const plan = manifest(),
      run = plan.runs.find((run) => run.condition === "rambling-forced")!;
    const scenario = plan.scenarios.find((item) => item.id === run.scenarioId)!;
    const players = studyPlayers(run, scenario);
    for (const player of players) player.journal = `SECRET-JOURNAL-${player.id}`;
    const actor = players.find((player) => player.id === run.witnessId)!;
    const prompt = playerPrompt(actor, players, scenario, [], "journal", plan.turns);
    const jev = jevPrompt(actor, players, scenario, [], false, plan);
    const text = JSON.stringify([prompt, jev]);
    expect(text).toContain(actor.journal);
    expect(text).toContain(actor.evidence[0]);
    for (const other of players.filter((player) => player.id !== actor.id)) {
      expect(text).not.toContain(other.journal);
      expect(text).not.toContain(other.evidence[0]);
    }
    expect(text).not.toContain(scenario.lateEvidence!.text);
    expect(text).not.toContain(scenario.decisiveEvidence);
    expect(text).not.toContain(RAMBLING);
    expect(text).not.toContain(run.condition);
    expect(String(jev.state)).toContain(`FOR ${actor.name}`);
    expect(String(jevPrompt(actor, players, scenario, [], false, plan, 3).state)).toContain(
      "Completed auction turns: 3/8",
    );
    expect(prompt.instructions).not.toContain("Werewolf");
  });
  it("retains the existing auction arithmetic independently of game scheduling", () => {
    const bids = [
      {
        playerId: "a",
        intent: {
          urge: 0.2,
          wantsToSpeak: true,
          willingnessToListen: [{ playerId: "b", willingness: 0.8 }],
        },
      },
      {
        playerId: "b",
        intent: {
          urge: 0.8,
          wantsToSpeak: true,
          willingnessToListen: [{ playerId: "a", willingness: 0.2 }],
        },
      },
    ];
    const ranked = rankSpeakerAuction(["a", "b"], bids, 0.25, ["a", "b"]);
    expect(ranked[0]!.playerId).toBe("b");
    expect(ranked[0]!.priority).toBeCloseTo(0.84);
    expect(ranked[1]!.priority).toBeCloseTo(0.09);
  });
  it("runs all four mechanics cells, delivers late evidence privately, records genuine originals and complete reflections", async () => {
    const root = await mkdtemp(join(tmpdir(), "auction-study-"));
    try {
      const plan = manifest();
      const rows = [];
      for (const run of plan.runs) {
        const state = await runStudyDiscussion(join(root, run.id), plan, run);
        expect(state.status).toBe("complete");
        expect(state.speeches).toHaveLength(8);
        expect(state.journals).toHaveLength(4 + 8 * 4 + 1);
        expect(state.answers).toHaveLength(4);
        expect(state.initialAnswers).toHaveLength(4);
        expect(state.lateEvidenceDelivered).toBe(true);
        expect(
          state.players.filter((player) => player.evidence.length > 1).map((player) => player.id),
        ).toEqual([run.witnessId]);
        for (const auction of state.auctions) {
          const original = auction.original.find((bid) => bid.playerId === run.targetId)!.intent;
          const effective = auction.effective.find((bid) => bid.playerId === run.targetId)!.intent;
          expect(original.urge).toBe(0.5);
          expect(effective.willingnessToListen).toEqual(original.willingnessToListen);
          expect(effective.urge).toBe(
            run.condition.endsWith("forced") && auction.candidates.includes(run.targetId) ? 1 : 0.5,
          );
        }
        for (let i = 1; i < state.speeches.length; i++)
          expect(state.speeches[i]!.playerId).not.toBe(state.speeches[i - 1]!.playerId);
        const row = discussionMetrics(state, plan);
        rows.push(row);
        expect(row.metrics.floorShare).toBe(
          state.speeches.filter((speech) => speech.playerId === run.targetId).length / 8,
        );
        const lines = (await readFile(join(root, run.id, "attempts.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(lines.filter((line) => line.stage === "started")).toHaveLength(4 + 8 * 9 + 1 + 8);
        const before = await readFile(join(root, run.id, "checkpoint.json"));
        await studyStatus(root, plan);
        expect(await readFile(join(root, run.id, "checkpoint.json"))).toEqual(before);
      }
      expect(factorialEffects(rows)[0]!.complete).toBe(true);
      expect(factorialEffects(rows.slice(1))[0]!.complete).toBe(false);
      expect(await writeStudyReport(root, plan)).toEqual({ complete: 4, expected: 4 });
      expect(await readFile(join(root, "report.md"), "utf8")).toContain("OFFLINE MECHANICS ONLY");
      const coding = await readFile(join(root, "coding-packet.json"), "utf8");
      expect(coding).not.toContain("condition");
      await writeStudyReport(root, plan);
      expect(await readFile(join(root, "coding-packet.json"), "utf8")).toEqual(coding);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
