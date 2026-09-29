import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chainDesign,
  chainScenario,
  parseChainStudy,
  CHAIN_STUDIES,
  OBSTRUCTION_GOAL,
} from "./lib/chain-study-design";
import { validateManifest, type StudyManifest } from "./lib/auction-study-design";
import { studyPlayers, playerPrompt, jevPrompt } from "./lib/auction-study-agents";
import { runStudyDiscussion, type StudyAnswer } from "./lib/auction-study-runner";
import { chainMetrics } from "./lib/chain-study-analysis";
import { writeStudyReport } from "./lib/auction-study-analysis";
import type { StudyScenario } from "./lib/auction-study-scenarios";

const plan = (): StudyManifest => ({
  schemaVersion: "speech_auction_study_v1",
  protocol: "clue-chain-v1",
  createdAt: "fixture",
  sourceCommit: "a".repeat(40),
  live: false,
  model: "fake",
  effort: "low",
  turns: 12,
  bias: 0.25,
  concurrency: 1,
  maxMinutes: 1,
  ...chainDesign(["chain-fixture"], "factorial"),
});
const table = (text: string) =>
  Object.fromEntries(
    [...text.matchAll(/([KNS][1-8]) -> ([NSR][1-8])/g)].map((match) => [match[1], match[2]]),
  );
function possibleAnswers(scenario: StudyScenario, omitted: number | null) {
  let candidates =
    omitted === 0
      ? Array.from({ length: 8 }, (_, i) => `K${i + 1}`)
      : [/starts at (K[1-8])/.exec(scenario.evidence[0]!)![1]!];
  for (let i = 1; i < 4; i++) {
    const rows = table(scenario.evidence[i]!);
    candidates = omitted === i ? Object.values(rows) : candidates.map((key) => rows[key]!);
  }
  return new Set(candidates);
}
describe("chained evidence with a separate strategic obstructer", () => {
  it("requires every record; no three-record subset identifies the answer", () => {
    const correct = new Set<string>();
    for (let seed = 0; seed < 24; seed++) {
      const scenario = chainScenario(`puzzle-${seed}`);
      expect(possibleAnswers(scenario, null)).toEqual(new Set([scenario.correct]));
      for (let missing = 0; missing < 4; missing++)
        expect(possibleAnswers(scenario, missing)).toEqual(new Set(Object.keys(scenario.choices)));
      correct.add(scenario.correct);
      expect(scenario.lateEvidence!.text).toContain(scenario.evidence[2]);
      expect(scenario.lateEvidence!.recipientIndex).toBe(3);
      expect(scenario.lateEvidence!.afterTurn).toBe(6);
    }
    expect(correct.size).toBeGreaterThan(4);
  });
  it("matches all eight cells and keeps the rambler, obstructer, and backup receiver distinct", () => {
    const manifest = plan();
    expect(validateManifest(manifest)).toEqual(manifest);
    expect(manifest.runs).toHaveLength(8);
    expect(new Set(manifest.runs.map((run) => run.condition)).size).toBe(8);
    expect(new Set(manifest.runs.map((run) => JSON.stringify(run.evidenceOrder))).size).toBe(1);
    for (const run of manifest.runs.filter((run) => run.obstructerId))
      expect(new Set([run.targetId, run.obstructerId, run.witnessId]).size).toBe(3);
    const changed = structuredClone(manifest);
    changed.scenarios[0]!.lateEvidence!.text = "tampered backup";
    expect(() => validateManifest(changed)).toThrow();
    const swapped = structuredClone(manifest);
    swapped.runs.find((run) => run.obstructerId)!.obstructerId = swapped.runs[0]!.targetId;
    expect(() => validateManifest(swapped)).toThrow();
    expect(() => chainDesign(["same", "same"])).toThrow();
  });
  it("selects independent discussions by default, permits separate experiments, and preserves legacy manifests", () => {
    const independent = chainDesign(["chain-fixture"]);
    expect(independent.runs).toHaveLength(5);
    expect(independent.chainStudy).toBe("independent");
    expect(
      independent.runs.some((run) => run.condition.startsWith("rambling") && run.obstructerId),
    ).toBe(false);
    const rambler = chainDesign(["chain-fixture"], "rambling");
    const malicious = chainDesign(["chain-fixture"], "obstruction");
    expect(rambler.runs).toHaveLength(4);
    expect(rambler.runs.every((run) => !run.obstructerId)).toBe(true);
    expect(malicious.runs).toHaveLength(2);
    expect(
      malicious.runs.every(
        (run) => run.condition.startsWith("focused") && run.condition.endsWith("natural"),
      ),
    ).toBe(true);
    expect(rambler.scenarios).toEqual(malicious.scenarios);
    expect(rambler.runs[0]!.evidenceOrder).toEqual(malicious.runs[0]!.evidenceOrder);
    for (const suite of Object.keys(CHAIN_STUDIES)) {
      const manifest = { ...plan(), ...chainDesign(["chain-fixture"], parseChainStudy(suite)) };
      expect(validateManifest(manifest)).toEqual(manifest);
    }
    const legacy = plan();
    delete legacy.chainStudy;
    expect(validateManifest(legacy)).toEqual(legacy);
    const mismatched = { ...plan(), ...malicious };
    mismatched.chainStudy = "rambling";
    expect(() => validateManifest(mismatched)).toThrow();
    expect(() => parseChainStudy("unknown")).toThrow();
  });
  it("keeps goals, private records, backup and answer keys out of other actors' prompts", () => {
    const manifest = plan(),
      scenario = manifest.scenarios[0]!;
    const run = manifest.runs.find((run) => run.condition === "rambling-obstruction-forced")!;
    const players = studyPlayers(run, scenario);
    for (const player of players) player.journal = `SECRET-${player.id}`;
    for (const actor of players) {
      const prompts = [
        playerPrompt(actor, players, scenario, [], "speech", 12),
        playerPrompt(actor, players, scenario, [], "journal", 12),
        jevPrompt(actor, players, scenario, [], false, manifest),
        jevPrompt(actor, players, scenario, [], true, manifest),
      ];
      const text = JSON.stringify(prompts);
      expect(text).toContain(actor.evidence[0]);
      expect(text).toContain(actor.journal);
      for (const other of players.filter((other) => other.id !== actor.id)) {
        expect(text).not.toContain(other.journal);
        expect(text).not.toContain(other.evidence[0]);
      }
      expect(text).not.toContain(scenario.decisiveEvidence);
      expect(text).not.toContain(scenario.lateEvidence!.text);
      expect(text).not.toContain(run.condition);
      expect(text.includes(OBSTRUCTION_GOAL)).toBe(actor.id === run.obstructerId);
      const alteredKey = structuredClone(scenario);
      for (const probe of Object.values(alteredKey.routeProbes!)) probe.correct = "SECRET-KEY";
      alteredKey.correct = "SECRET-ANSWER";
      expect(jevPrompt(actor, players, alteredKey, [], true, manifest)).toEqual(prompts[3]);
    }
    const saboteur = players.find((player) => player.id === run.obstructerId)!;
    expect(saboteur.personality).not.toContain("pursue the group's stated task");
    expect(String(jevPrompt(saboteur, players, scenario, [], true, manifest).state)).toContain(
      "actual beliefs",
    );
  });
  it("runs all eight offline cells, delivers the authentic backup, and separates route understanding from guesses", async () => {
    const root = await mkdtemp(join(tmpdir(), "chain-study-"));
    try {
      const manifest = plan();
      for (const run of manifest.runs) {
        const state = await runStudyDiscussion(join(root, run.id), manifest, run);
        expect(state.status).toBe("complete");
        expect(state.speeches).toHaveLength(12);
        expect(state.journals).toHaveLength(53);
        const arrival = state.journals.filter(
          (journal) => journal.reason === "private evidence arrival",
        );
        expect(arrival.map((journal) => [journal.playerId, journal.afterTurn])).toEqual([
          [run.evidenceOrder[3], 6],
        ]);
        expect(
          state.players.filter((player) => player.evidence.length > 1).map((player) => player.id),
        ).toEqual([run.evidenceOrder[3]]);
        for (const answer of state.answers)
          expect(Object.keys(answer.route!)).toEqual(["code", "node", "seal"]);
        for (const auction of state.auctions) {
          const effective = auction.effective.find((bid) => bid.playerId === run.targetId)!;
          expect(effective.intent.urge).toBe(
            run.condition.endsWith("forced") && auction.candidates.includes(run.targetId) ? 1 : 0.5,
          );
          if (run.obstructerId)
            expect(
              auction.effective.find((bid) => bid.playerId === run.obstructerId)!.intent.urge,
            ).toBe(0.5);
        }
        const scenario = manifest.scenarios[0]!;
        const answers: StudyAnswer[] = state.players.map((player) => ({
          playerId: player.id,
          answer: scenario.correct,
          probabilities: { [scenario.correct]: 1 },
          route: Object.fromEntries(
            Object.entries(scenario.routeProbes!).map(([key, probe]) => [
              key,
              { choice: probe.correct, probabilities: { [probe.correct]: 1 } },
            ]),
          ),
        }));
        // C is excluded from the same primary cohort even when it is cooperative.
        answers.find((answer) => answer.playerId === run.evidenceOrder[2])!.answer = "wrong";
        const perfect = chainMetrics({ ...state, answers }, manifest);
        expect(perfect.final).toMatchObject({
          denominator: 3,
          cartridgeCorrect: 3,
          fullRouteCorrect: 3,
        });
        const solver = answers.find((answer) => answer.playerId === run.targetId)!;
        solver.route!.node!.choice = "wrong";
        expect(chainMetrics({ ...state, answers }, manifest).final).toMatchObject({
          cartridgeCorrect: 3,
          fullRouteCorrect: 2,
        });
        expect(chainMetrics({ ...state, status: "failed" }, manifest).final).toBeNull();
        const attempts = (await readFile(join(root, run.id, "attempts.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(attempts.filter((attempt) => attempt.stage === "started")).toHaveLength(121);
      }
      expect(await writeStudyReport(root, manifest)).toEqual({ complete: 8, expected: 8 });
      expect(await readFile(join(root, "report.md"), "utf8")).toContain("OFFLINE MECHANICS ONLY");
      const packet = await readFile(join(root, "chain-coding-packet.json"), "utf8");
      expect(packet).not.toContain("obstructerId");
      expect(packet).not.toContain("rambling-obstruction");
      await writeStudyReport(root, manifest);
      expect(await readFile(join(root, "chain-coding-packet.json"), "utf8")).toEqual(packet);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
