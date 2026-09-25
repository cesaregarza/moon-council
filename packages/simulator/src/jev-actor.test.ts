import { afterEach, describe, expect, it } from "vitest";
import { type DecisionOpportunityV1, type PlayerContextV2 } from "@werewolf/contracts";
import { LabRepository, DecisionStore, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { AskJevProvider, FakeDecisionProvider, type JevRequest } from "@werewolf/llm";
import {
  actorPacket,
  actorConfig,
  actorFixtures,
  refreshFixtureBrief,
} from "./testing/actor-fixtures";
import { actorBriefing, prepareActorJevAction } from "./jev-actor";
import { assessActorChoice } from "./jev-semantics";
import { DecisionExecutorV2, type ExecuteDecisionOptions } from "./decisions-v2";
import { decisionRequestV31, normalizeV31Submission, validateV31Submission } from "./request-v3-1";
import { applyJournalV2 } from "./context-v2";
import { currentDecisionBrief, journalEvidenceRevision } from "./player-brief";
import { journalTokens } from "./freeform-journal";
import {
  journalCompactionRequest,
  materializeCompactedJournal,
  validateJournalCompaction,
} from "./journal-compaction";
import { V2GameOrchestrator } from "./orchestrator-v2";
import { observerPayload, decisionDetail } from "../../../apps/api/src/observer";
import type { V3TaskSpec } from "./request-v3";

const dbs: DatabaseConnection[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
});
function setup(packet = actorPacket()) {
  const db = openDatabase(":memory:");
  dbs.push(db);
  const repository = new LabRepository(db),
    game = repository.createGame(actorConfig());
  new V2GameOrchestrator(repository, new FakeDecisionProvider()).initialize(game.id);
  repository.appendEvent(game.id, {
    type: "phase.changed",
    day: packet.day,
    phase: packet.phase,
    visibility: "public",
    payload: { phase: packet.phase, day: packet.day },
  });
  repository.updateGame(game.id, { status: "running" });
  const op: DecisionOpportunityV1 = {
    id: "actor-vote",
    gameId: game.id,
    playerId: packet.self.id,
    kind: "vote",
    phase: packet.phase,
    day: packet.day,
    epoch: `${packet.day}:${packet.phase}`,
    viewId: "test",
    baseJournalVersion: 0,
    packet,
    status: "open",
    best: null,
    recovery: 0,
    createdAt: new Date().toISOString(),
    taskType: "vote_choice",
  };
  const store = new DecisionStore(repository);
  store.save(op);
  const task: V3TaskSpec = { type: "vote_choice", proposalKind: "vote" };
  const options: ExecuteDecisionOptions = {
    opportunity: op,
    mandatoryRemaining: 0,
    validateCurrent: () => true,
    eventsForCommit: () => [],
    requestForAttempt: (commitOnly, previous, repair) => ({
      ...decisionRequestV31(packet, task, commitOnly, previous, repair),
      schemaName: task.type,
      providerKind: "decision_v3_1",
      normalize: (v) => normalizeV31Submission(packet, task, v as never, op.id, commitOnly),
      validateSubmission: (v) => validateV31Submission(packet, task, v as never),
    }),
  };
  return { repository, game, op, store, options };
}
function provider(targets: string[], requests: JevRequest[] = [], hook?: () => void) {
  return new AskJevProvider(async (input) => {
    const r = JSON.parse(input) as JevRequest;
    requests.push(r);
    hook?.();
    const target = targets[Math.min(requests.length - 1, targets.length - 1)]!;
    return JSON.stringify({
      model: "synthetic",
      usage: { input_tokens: 50, output_tokens: 10 },
      answers: {
        target: {
          type: "choice",
          choice: target,
          confidence: 0.1,
          probabilities: Object.fromEntries(
            Object.keys((r.questions.target as { criteria: object }).criteria).map((k) => [
              k,
              Number(k === target),
            ]),
          ),
        },
      },
    });
  });
}
describe("actor perspective Jev workflow", () => {
  it.each(actorFixtures())("builds task-specific private actions: $label", ({ packet, task }) => {
    const op = { packet, playerId: packet.self.id, taskType: task };
    const state = actorBriefing(op),
      text = JSON.stringify(state);
    expect(text).toContain(packet.self.name);
    expect(text).not.toContain("Day 1 I wondered");
    expect(state.currentReasoning).toBe(
      task === "discussion_score"
        ? packet.journal.decisionBrief!.attention
        : packet.journal.decisionBrief!.action,
    );
    const spec = {
      type: task,
      proposalKind:
        task === "night_choice"
          ? "night_action"
          : task === "team_point_choice"
            ? "team_point"
            : "vote",
    } as V3TaskSpec;
    const base = {
      ...decisionRequestV31(packet, spec, true, null, null),
      schemaName: task,
      normalize: (v: unknown) => normalizeV31Submission(packet, spec, v as never, "fixture", true),
    };
    const stage = prepareActorJevAction(op, actorConfig(), base);
    const request = JSON.parse(stage.prepared.prompt.input);
    expect(stage.prepared.promptVersion).toBe("jev_actions_v4");
    if (task === "vote_choice") {
      expect(request.questions.target.instructions).not.toContain("listening");
      expect(request.questions.target.criteria.abstain).toBe("Abstain from voting.");
      packet.legalTargets.forEach((id, i) =>
        expect(request.questions.target.criteria[String.fromCharCode(97 + i)]).toContain(`(${id})`),
      );
    }
  });
  it("rejects stale, missing and cross-seat briefs without making calls", async () => {
    for (const change of [
      (p: PlayerContextV2) => {
        delete p.journal.decisionBrief;
      },
      (p: PlayerContextV2) => {
        p.journal.decisionBrief!.playerId = "p2";
      },
      (p: PlayerContextV2) => {
        p.rules.journalRevision = "new-evidence";
      },
    ]) {
      const packet = actorPacket();
      change(packet);
      expect(currentDecisionBrief(packet)).toBeUndefined();
      const { repository, options, store, game } = setup(packet);
      await expect(
        new DecisionExecutorV2(repository, new FakeDecisionProvider(), provider(["a"])).execute(
          options,
        ),
      ).rejects.toThrow("brief");
      expect(store.attempts(game.id)).toHaveLength(0);
    }
  });
  it("uses only owner inspections and does not inject speech or teammate journals as authority", () => {
    const packet = actorPacket();
    packet.sources.push(
      {
        id: "foreign",
        type: "inspection.delivered",
        scope: "player",
        day: 3,
        data: { actorId: "p2", targetId: "p5", result: "OTHER_PRIVATE_RESULT" },
      },
      {
        id: "public",
        type: "speech.public",
        scope: "public",
        day: 3,
        data: { text: "PUBLIC_PROMPT_INJECTION", playerId: "p2" },
      },
    );
    refreshFixtureBrief(packet);
    const text = JSON.stringify(
      actorBriefing({ packet, playerId: packet.self.id, taskType: "vote_choice" }),
    );
    expect(text).not.toContain("OTHER_PRIVATE_RESULT");
    expect(text).not.toContain("PUBLIC_PROMPT_INJECTION");
    expect(text).toContain("verified inspection");
    expect(journalEvidenceRevision(packet.sources)).not.toBe(
      journalEvidenceRevision(packet.sources.slice(0, 1)),
    );
  });
  it("refreshes the brief on a no-change reflection and retains it through compaction", () => {
    const packet = actorPacket();
    const task: V3TaskSpec = {
      type: "journal_update",
      revision: String(packet.rules.journalRevision),
      sourceIds: [],
    };
    const submission = {
      memory: {
        journalUpdate: null,
        decisionBrief: {
          action: "New private assessment.",
          attention: "Hear the unanswered defense.",
        },
      },
      rationale: "Update current view.",
    };
    const request = decisionRequestV31(packet, task, true, null, null);
    expect(request.schema.safeParse(submission).success).toBe(true);
    expect(validateV31Submission(packet, task, submission)).toEqual([]);
    const report = normalizeV31Submission(packet, task, submission, "refresh", true);
    const candidate = applyJournalV2(packet.journal, report, 16000);
    expect(candidate.decisionBrief).toMatchObject({
      ...submission.memory.decisionBrief,
      playerId: packet.self.id,
      evidenceRevision: packet.rules.journalRevision,
    });
    expect(
      validateV31Submission(packet, task, {
        ...submission,
        memory: { journalUpdate: null, decisionBrief: null },
      }),
    ).not.toEqual([]);
    const compaction = {
      candidate,
      sourceReport: report,
      sourceSubmission: submission,
      sourceAttemptId: "one",
    };
    const compact = journalCompactionRequest(compaction, 500, 8192, null);
    const summary = materializeCompactedJournal(compaction, {
      text: "Earlier suspicion was superseded by my own verified result.",
    });
    expect(summary.decisionBrief).toEqual(candidate.decisionBrief);
    expect(journalTokens(summary)).toBeLessThan(500);
    expect(JSON.parse(compact.prompt.input).maximumTokens).toBeLessThan(500);
    expect(
      validateJournalCompaction(candidate, { ...summary, decisionBrief: undefined }, 500),
    ).toContain("Compaction must preserve the current decision brief and its owner/revision");
  });
  it("reconsiders a provable contradiction once and commits only the corrected Jev action", async () => {
    const { repository, options, store, game, op } = setup();
    const requests: JevRequest[] = [];
    const target = String.fromCharCode(97 + op.packet.legalTargets.indexOf("p3"));
    await new DecisionExecutorV2(
      repository,
      new FakeDecisionProvider(),
      provider(["abstain", target], requests),
    ).execute(options);
    expect(requests).toHaveLength(2);
    expect(
      (requests[1]!.state as { reconsideration: { issues: string[] } }).reconsideration.issues[0],
    ).toContain("sole remaining werewolf");
    expect(
      store.get<DecisionOpportunityV1>(game.id, `decision:${op.id}`)?.bestSubmission,
    ).toMatchObject({ mode: "direct", choiceHandles: [target] });
    expect(store.attempts(game.id).every((a) => a.status === "valid")).toBe(true);
    const assessments = repository
      .listEvents(game.id)
      .filter((e) => e.type === "decision.semantic_assessed");
    expect(assessments).toHaveLength(2);
    expect(assessments[0]!.payload.issues).toHaveLength(1);
    expect(assessments[1]!.payload.issues).toEqual([]);
    expect(
      JSON.stringify(observerPayload(repository, repository.getGame(game.id)!, { kind: "public" })),
    ).not.toContain("sole remaining werewolf");
    expect(
      decisionDetail(repository, game.id, op.id, { kind: "player", playerId: "p2" }),
    ).toBeUndefined();
  });
  it("pauses persistent contradiction and prevents an unbounded resume/retry loop", async () => {
    const { repository, options, store, game, op } = setup();
    const requests: JevRequest[] = [];
    const executor = new DecisionExecutorV2(
      repository,
      new FakeDecisionProvider(),
      provider(["abstain"], requests),
    );
    await expect(executor.execute(options)).rejects.toThrow("one reconsideration");
    expect(store.get<DecisionOpportunityV1>(game.id, `decision:${op.id}`)).toMatchObject({
      status: "paused",
      best: null,
      jevState: { semanticRejected: true },
    });
    await expect(executor.execute(options)).rejects.toThrow("review exhausted");
    expect(requests).toHaveLength(2);
    expect(repository.listEvents(game.id).some((e) => e.type === "decision.committed")).toBe(false);
  });
  it("resumes the single reconsideration checkpoint without repeating the initial attempt", async () => {
    const { repository, options, game, op } = setup();
    const requests: JevRequest[] = [];
    const target = String.fromCharCode(97 + op.packet.legalTargets.indexOf("p3"));
    const jev = provider(["abstain", target], requests, () => {
      if (requests.length === 1) repository.updateGame(game.id, { status: "paused" });
    });
    expect(
      await new DecisionExecutorV2(repository, new FakeDecisionProvider(), jev).execute(options),
    ).toBe(false);
    repository.updateGame(game.id, { status: "running" });
    expect(
      await new DecisionExecutorV2(repository, new FakeDecisionProvider(), jev).execute(options),
    ).toBe(true);
    expect(requests).toHaveLength(2);
  });
  it("allows uncertain abstention and does not impose village objectives on a wolf", async () => {
    for (const packet of [
      actorFixtures().find((f) => f.label === "legitimate-abstention")!.packet,
      actorPacket("werewolf"),
    ]) {
      expect(assessActorChoice(packet, "vote_choice", "abstain")).toMatchObject({
        applicable: false,
        issues: [],
      });
      const { repository, options, store, game } = setup(packet);
      await new DecisionExecutorV2(
        repository,
        new FakeDecisionProvider(),
        provider(["abstain"]),
      ).execute(options);
      expect(store.attempts(game.id)).toHaveLength(1);
      expect(store.opportunities(game.id)[0]?.bestSubmission).toMatchObject({ mode: "abstain" });
    }
  });
  it("does not treat a public accusation, unknown death role, or multiple remaining wolves as proof", () => {
    for (const mutate of [
      (p: PlayerContextV2) => {
        p.sources[0]!.scope = "public";
        p.sources[0]!.type = "speech.public";
      },
      (p: PlayerContextV2) => {
        delete p.players.find((x) => !x.alive)!.revealedRole;
      },
      (p: PlayerContextV2) => {
        p.players.find((x) => !x.alive)!.revealedRole = "Villager";
      },
    ]) {
      const p = actorPacket();
      p.sources = p.sources.filter((s) => s.type === "inspection.delivered");
      mutate(p);
      expect(assessActorChoice(p, "vote_choice", "abstain").issues).toEqual([]);
    }
  });
  it("reflects for every seat before the first auction and after speeches without topic routing", async () => {
    const db = openDatabase(":memory:");
    dbs.push(db);
    const repository = new LabRepository(db),
      game = repository.createGame(actorConfig());
    const tasks: string[] = [];
    const fake = new FakeDecisionProvider();
    const llm = {
      decide: async <T>(r: import("@werewolf/llm").DecisionRequest<T>) => {
        tasks.push(r.schemaName);
        return fake.decide(r);
      },
    };
    const requests: JevRequest[] = [];
    const jev = new AskJevProvider(async (input) => {
      const r = JSON.parse(input) as JevRequest;
      requests.push(r);
      return JSON.stringify({
        model: "fake",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: Object.fromEntries(
          Object.entries(r.questions).map(([key, q]) => [
            key,
            q.type === "noul"
              ? { type: "noul", noul: 0 }
              : q.type === "score"
                ? {
                    type: "score",
                    score: 3,
                    confidence: 1,
                    probabilities: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0 },
                  }
                : {
                    type: "choice",
                    choice: Object.keys(q.criteria)[0],
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      Object.keys(q.criteria).map((k, i) => [k, Number(i === 0)]),
                    ),
                  },
          ]),
        ),
      });
    });
    const runner = new V2GameOrchestrator(repository, llm, jev);
    runner.initialize(game.id);
    new DecisionStore(repository).put(game.id, "stepUnit", "decision");
    repository.updateGame(game.id, { status: "stepping" });
    for (
      let i = 0;
      i < 16 &&
      (!tasks.includes("discussion_free_speech") ||
        tasks.filter((t) => t === "journal_update").length < 24);
      i++
    )
      await runner.runGameStep(game.id);
    expect(tasks.filter((t) => t === "journal_update").length).toBeGreaterThanOrEqual(24);
    expect(tasks).toContain("discussion_free_speech");
    expect(
      tasks.every((t) =>
        ["journal_update", "discussion_free_speech", "closing_response"].includes(t),
      ),
    ).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => !r.questions.plan && !r.questions.needs_reasoning)).toBe(true);
    expect(
      new DecisionStore(repository)
        .opportunities(game.id)
        .filter((o) => o.taskType === "discussion_score")
        .every((o) => currentDecisionBrief(o.packet)),
    ).toBe(true);
  });
});
