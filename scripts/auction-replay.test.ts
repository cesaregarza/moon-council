import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { rankSpeakerAuction } from "../packages/simulator/src/speaker-auction";
import {
  fixtureBids,
  frozenSchedule,
  intervene,
  replayAuction,
  structuralCases,
  summarizeReplays,
} from "./lib/auction-replay";
import { parseReplayInput } from "./lib/auction-replay-input";
import { replayStudy, replayReport } from "./auction-replay";
import { studyRuns, FOCUSED, RAMBLING, type StudyManifest } from "./lib/auction-study-design";
import { AUCTION_SCENARIOS } from "./lib/auction-study-scenarios";

const ids = ["p1", "p2", "p3", "p4"];
const bids = () => fixtureBids([0.4, 0.5, 0.2, 0.3], [0.4, 0.6, 0.2, 0.1]);
function auction(turn = 1, original = bids(), candidates = ids) {
  const scores = rankSpeakerAuction(candidates, original, 0.25, candidates);
  return {
    turn,
    original,
    effective: structuredClone(original),
    candidates,
    tieOrder: candidates,
    scores,
    selected: scores[0]?.playerId ?? null,
    unforcedWinner: scores[0]?.playerId ?? null,
  };
}
const checkpoint = () => ({
  run: { id: "test", targetId: "p1" },
  status: "complete",
  players: ids.map((id) => ({ id, journal: "PRIVATE-NOTES" })),
  journals: ["PRIVATE-NOTES"],
  auctions: [auction()],
});

describe("speaker auction mechanical interventions", () => {
  it("finds distinct urgency and outgoing-rating routes to winning without touching peers", () => {
    const original = bids();
    original[0]!.intent.willingnessToListen.find((r) => r.playerId === "p2")!.willingness = 1;
    original[2]!.intent.willingnessToListen.find((r) => r.playerId === "p2")!.willingness = 0.4;
    original[3]!.intent.willingnessToListen.find((r) => r.playerId === "p2")!.willingness = 0.4;
    const before = structuredClone(original);
    const s = { candidates: ["p1", "p2", "p3"], tieOrder: ids, original };
    const result = replayAuction(s, 0.25);
    expect(result.naturalWinner).toBe("p2");
    const actor = result.actors.find((a) => a.playerId === "p1")!;
    expect(actor.interventions.map((a) => a.selected)).toEqual(["p1", "p1", "p1", "p1"]);
    for (const mode of [
      "urge_only",
      "max_urgency",
      "zero_rival_ratings",
      "max_and_zero",
    ] as const) {
      const changed = intervene(original, "p1", mode);
      expect(changed.slice(1)).toEqual(original.slice(1));
    }
    expect(original).toEqual(before);
  });
  it("separates high urgency from willingness and never bypasses eligibility", () => {
    const original = bids();
    original[0]!.intent.wantsToSpeak = false;
    const s = { original, candidates: ids, tieOrder: ids };
    const a = replayAuction(s, 0.25).actors[0]!;
    expect(a.interventions.find((x) => x.mode === "urge_only")!.actorWins).toBe(false);
    expect(a.interventions.find((x) => x.mode === "max_urgency")!.actorWins).toBe(true);
    const excluded = replayAuction({ ...s, candidates: ids.slice(1) }, 0.25).actors[0]!;
    expect(excluded.eligible).toBe(false);
    expect(excluded.interventions.every((x) => !x.actorWins)).toBe(true);
  });
  it("covers rejection, all-zero fallback, and starvation despite no consecutive turns", () => {
    const cases = structuralCases();
    expect(cases.rejectedMaxUrgency.selected).toBe("p2");
    expect(cases.allZeroInterest.selected).toBe("p1");
    expect(cases.staticStarvation.selected).toEqual(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? "p2" : "p1")),
    );
    const none = bids().map((b) => ({ ...b, intent: { ...b.intent, wantsToSpeak: false } }));
    expect(frozenSchedule(none, 3)).toEqual([null, null, null]);
    expect(() => frozenSchedule(bids(), 0)).toThrow("turn count");
  });
  it("does not restore the previous speaker's eligibility after an empty auction", () => {
    const oneWilling = bids().map((b) => ({
      ...b,
      intent: { ...b.intent, wantsToSpeak: b.playerId === "p1" },
    }));
    expect(frozenSchedule(oneWilling, 4)).toEqual(["p1", null, null, null]);
  });
  it("cannot demote an existing winner by raising only its urgency or zeroing outgoing ratings", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 8, maxLength: 8 }),
        (values) => {
          const original = fixtureBids(
            values.slice(0, 4).map((v) => v / 100),
            values.slice(4).map((v) => v / 100),
          );
          const result = replayAuction({ original, candidates: ids, tieOrder: ids }, 0.25);
          const incumbent = result.actors.find((a) => a.playerId === result.naturalWinner)!;
          expect(incumbent.interventions.every((a) => a.actorWins)).toBe(true);
        },
      ),
      { seed: 20260929, numRuns: 200 },
    );
  });
  it("ignores self ratings and honors supplied tie order", () => {
    const original = fixtureBids([0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]);
    original[0]!.intent.willingnessToListen.push({ playerId: "p1", willingness: 1 });
    expect(rankSpeakerAuction(ids, original, 0.25, [...ids].reverse())[0]!.playerId).toBe("p4");
  });
  it("keeps missing observations missing and uses eligible recorded states as denominator", () => {
    expect(summarizeReplays([], ["p1"])[0]!.interventions.every((x) => x.wins === null)).toBe(true);
    const original = bids();
    const result = summarizeReplays(
      [
        replayAuction({ original, candidates: ids, tieOrder: ids }, 0.25),
        replayAuction({ original, candidates: ids.slice(1), tieOrder: ids }, 0.25),
      ],
      ids,
    )[0]!;
    expect(result.eligibleStates).toBe(1);
    expect(result.observedStates).toBe(2);
    expect(result.interventions.find((x) => x.mode === "max_urgency")!.wins).toBe(1);
  });
});

describe("frozen input integrity", () => {
  it("projects away private content and fails closed on corrupted winners, scores, and IDs", () => {
    const base = checkpoint();
    expect(JSON.stringify(parseReplayInput(base, 0.25))).not.toContain("PRIVATE-NOTES");
    const wrongWinner = structuredClone(base);
    wrongWinner.auctions[0]!.selected = "p4";
    expect(() => parseReplayInput(wrongWinner, 0.25)).toThrow("winner mismatch");
    const wrongScore = structuredClone(base);
    wrongScore.auctions[0]!.scores[0]!.priority += 0.1;
    expect(() => parseReplayInput(wrongScore, 0.25)).toThrow("score mismatch");
    const duplicate = structuredClone(base);
    duplicate.auctions[0]!.original[0]!.playerId = "p2";
    expect(() => parseReplayInput(duplicate, 0.25)).toThrow("IDs");
    const missingRating = structuredClone(base);
    missingRating.auctions[0]!.original[0]!.intent.willingnessToListen.pop();
    expect(() => parseReplayInput(missingRating, 0.25)).toThrow("IDs");
  });
  it("preserves the last actual speaker exclusion across silent auctions", () => {
    const base = checkpoint();
    const candidates = ids.filter((id) => id !== base.auctions[0]!.selected);
    const silent = bids().map((b) => ({ ...b, intent: { ...b.intent, wantsToSpeak: false } }));
    base.auctions.push(auction(2, silent, candidates), auction(3, bids(), candidates));
    expect(parseReplayInput(base, 0.25).auctions).toHaveLength(3);
    base.auctions[2] = auction(3);
    expect(() => parseReplayInput(base, 0.25)).toThrow("IDs");
  });
  it("replays a study without altering source files, preserving failures and unstarted runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "auction-replay-"));
    try {
      const manifest: StudyManifest = {
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
        runs: studyRuns(["replay-test"], ["incident"]),
        scenarios: AUCTION_SCENARIOS,
        personalities: { focused: FOCUSED, rambling: RAMBLING },
      };
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
      const directory = join(root, manifest.runs[0]!.id);
      await mkdir(directory);
      const input = { ...checkpoint(), run: manifest.runs[0]!, status: "failed" };
      const raw = JSON.stringify(input);
      await writeFile(join(directory, "checkpoint.json"), raw);
      const output = await replayStudy(root);
      expect(output.runs[0]!.status).toBe("failed");
      expect(output.runs.slice(1).every((r) => r.status === "not_started")).toBe(true);
      expect(output.runs[0]!.snapshots).toHaveLength(1);
      expect(JSON.stringify(output)).not.toContain("PRIVATE-NOTES");
      expect(await readFile(join(directory, "checkpoint.json"), "utf8")).toBe(raw);
      expect(replayReport([output])).toContain("NOT simulated conversation floor shares");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
