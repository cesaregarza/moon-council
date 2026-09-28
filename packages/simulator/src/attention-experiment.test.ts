import { describe, expect, it } from "vitest";
import {
  GameConfigV2Schema,
  PERSONALITY_PRESETS,
  emptyJournalV2,
  clonedAttentionExperiment,
} from "@werewolf/contracts";
import { LabRepository, DecisionStore, openDatabase } from "@werewolf/db";
import { createGameState } from "@werewolf/engine";
import { FakeDecisionProvider } from "@werewolf/llm";
import { attentionConfigs, syntheticAttentionJev } from "../../../scripts/lib/attention-experiment";
import { observerPayload } from "../../../apps/api/src/observer";
import { summarizeGameAudit, summarizeGameProgress } from "../../../scripts/game-audit";
import { experimentSpeakerIntent } from "./urgency-experiment";
import { V2GameOrchestrator } from "./orchestrator-v2";
import { buildContextV2 } from "./context-v2";

const configs = () =>
  attentionConfigs({
    model: "fake",
    effort: "low",
    seed: "attention-test",
    live: false,
    maxCalls: 500,
    maxMinutes: 1,
  });
const original = {
  urge: 0.25,
  wantsToSpeak: false,
  willingnessToListen: [{ playerId: "p2", willingness: 0.7 }],
};

describe("personality and urgency experiments", () => {
  it("pairs roles/settings and keeps other personalities and intervention out of player contexts", () => {
    const { control, treatment, targetId } = configs();
    const first = createGameState("control", control),
      second = createGameState("treatment", treatment);
    expect(first.players.map((p) => p.role)).toEqual(second.players.map((p) => p.role));
    expect(
      treatment.seats
        .filter((seat) => seat.personality !== PERSONALITY_PRESETS.rational.text)
        .map((seat) => seat.id),
    ).toEqual([targetId]);
    expect(second.players.find((p) => p.id === targetId)!.role.id).toBe("villager");
    expect(control).not.toHaveProperty("experiment");
    const other = control.seats.find((seat) => seat.id !== targetId)!;
    const packet = buildContextV2(second, [], other.id, emptyJournalV2(), "reflection", "pass");
    expect(JSON.stringify(packet)).not.toContain(PERSONALITY_PRESETS.rambler.text);
    expect(JSON.stringify(packet)).not.toContain("forcedUrgency");
    expect(
      buildContextV2(second, [], targetId, emptyJournalV2(), "reflection", "pass").self.personality,
    ).toBe(PERSONALITY_PRESETS.rambler.text);
  });

  it("remaps forced settings to cloned seats and drops removed seats", () => {
    expect(
      clonedAttentionExperiment(
        {
          seats: [{ id: "old" }, { id: "removed" }],
          experiment: { forcedUrgency: { old: 1, removed: 0 } },
        },
        [{ id: "new" }],
      ),
    ).toEqual({ forcedUrgency: { new: 1 } });
    expect(clonedAttentionExperiment(undefined, [{ id: "new" }])).toBeUndefined();
  });

  it("validates targets, range and supported workflow", () => {
    const { treatment } = configs();
    for (const forcedUrgency of [{ missing: 1 }, { p1: -0.01 }, { p1: 1.01 }])
      expect(
        GameConfigV2Schema.safeParse({ ...treatment, experiment: { forcedUrgency } }).success,
      ).toBe(false);
    expect(
      GameConfigV2Schema.safeParse({ ...treatment, decisionEngine: { mode: "llm" } }).success,
    ).toBe(false);
  });

  it("preserves original decisions, listener preferences and ineligible seats", () => {
    const { control, treatment, targetId } = configs();
    expect(experimentSpeakerIntent(control, targetId, true, original)).toEqual({
      intent: original,
    });
    expect(experimentSpeakerIntent(treatment, targetId, false, original)).toEqual({
      intent: original,
    });
    const result = experimentSpeakerIntent(treatment, targetId, true, original);
    expect(result.intent).toEqual({ ...original, urge: 1, wantsToSpeak: true });
    expect(result.urgencyOverride).toMatchObject({
      originalUrge: 0.25,
      originalWantsToSpeak: false,
      forcedUrge: 1,
    });
    expect(original.urge).toBe(0.25);
    expect(experimentSpeakerIntent(treatment, "constructor", true, original)).toEqual({
      intent: original,
    });
    treatment.experiment!.forcedUrgency[targetId] = 0;
    expect(experimentSpeakerIntent(treatment, targetId, true, original).intent.wantsToSpeak).toBe(
      false,
    );
  });

  it("applies every eligible auction, preserves Jev attempts and exports config without leaking notes in status", async () => {
    const db = openDatabase(":memory:");
    try {
      const { treatment, targetId } = configs();
      const repository = new LabRepository(db),
        store = new DecisionStore(repository);
      const game = repository.createGame(treatment);
      const runner = new V2GameOrchestrator(
        repository,
        new FakeDecisionProvider(),
        syntheticAttentionJev(),
      );
      runner.initialize(game.id);
      repository.updateGame(game.id, { status: "running" });
      await runner.runGameStep(game.id);
      await runner.runGameStep(game.id);
      const current = repository.getGame(game.id)!;
      expect(current.error).toBeUndefined();
      const events = repository.listEvents(game.id);
      const bids = events.filter(
        (e) =>
          e.type === "discussion.bid_submitted" &&
          e.payload.playerId === targetId &&
          e.payload.eligible,
      );
      expect(bids.length).toBeGreaterThan(1);
      for (const bid of bids) {
        expect(bid.payload.intent).toMatchObject({ urge: 1, wantsToSpeak: true });
        expect(bid.payload.urgencyOverride).toMatchObject({ originalUrge: 0.5, forcedUrge: 1 });
        // Committed submission remains the unmodified provider result.
        expect(bid.payload.submission).toMatchObject({ urge: 0.5 });
      }
      const attempts = store.attempts(game.id);
      const scores = attempts.filter(
        (attempt) =>
          attempt.playerId === targetId &&
          attempt.provider === "jev" &&
          attempt.response?.includes('"urge"'),
      );
      expect(scores.length).toBeGreaterThan(1);
      for (const score of scores) expect(JSON.parse(score.response!).answers.urge.score).toBe(2);
      const payload = observerPayload(repository, current, { kind: "moderator" });
      expect(payload.game.config).toMatchObject({ experiment: treatment.experiment });
      expect(
        observerPayload(repository, current, { kind: "public" }).game.config,
      ).not.toHaveProperty("experiment");
      const audit = summarizeGameAudit(
        { ...current, error: current.error ?? null },
        events,
        attempts,
      );
      expect(audit.discussion.attention.experiment).toEqual(treatment.experiment);
      const status = summarizeGameProgress(audit);
      expect(status).not.toHaveProperty("discussion");
      expect(status).not.toHaveProperty("attention");
    } finally {
      db.close();
    }
  }, 30000);
});
