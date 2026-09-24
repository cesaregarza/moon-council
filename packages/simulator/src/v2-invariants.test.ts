import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameConfigV2Schema, emptyJournalV2, reportSchema, type DecisionOpportunityV1, type GameEventV1 } from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { DOCTOR_V2, STARTER_ROLES, createGameCreatedEvent, createGameState, reduceGame, transition } from "@werewolf/engine";
import { FakeDecisionProvider } from "@werewolf/llm";
import { assertV2Budget, DecisionExecutorV2 } from "./decisions-v2";
import { buildContextV2, contentHash, validateReport, ContextLimitError } from "./context-v2";
import { recoverStaleWork } from "./recovery-v2";
import { nextDiscussionWork, responseDockets } from "./scheduler-v2";
const dbs: DatabaseConnection[] = [];
afterEach(() => { vi.restoreAllMocks(); while (dbs.length) dbs.pop()!.close(); });
const role = (id: string) => id === "doctor" ? structuredClone(DOCTOR_V2) : structuredClone(STARTER_ROLES.find((r) => r.id === id)!);
function config(overrides: Record<string, unknown> = {}) {
  const ids = ["werewolf", "werewolf", "seer", "doctor", "villager", "villager", "villager", "villager"];
  const seats = ids.map((_, i) => ({ id: "p" + (i + 1), name: "Player " + (i + 1), personality: "test" }));
  return GameConfigV2Schema.parse({ schemaVersion: "game_config_v2", name: "invariants", seed: "fixed-seed", seats, roleDeck: ids.map(role), modelSettings: Object.fromEntries(seats.map((s) => [s.id, { model: "fake-model", reasoningEffort: "medium", provider: "fake" }])), safety: { maxCycles: 4, maxModelCalls: 20, maxOutputTokens: 600, maxWallClockMs: 60_000 }, deliberation: { maxContextTokens: 8_000 }, ...overrides });
}
function createRepository() {
  const connection = openDatabase(":memory:"); dbs.push(connection);
  const repository = new LabRepository(connection); repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]); return repository;
}
function game(repository: LabRepository, overrides: Record<string, unknown> = {}) {
  const record = repository.createGame(config(overrides));
  repository.appendEvent(record.id, createGameCreatedEvent(createGameState(record.id, record.config)));
  repository.appendEvent(record.id, { type: "game.started", phase: "setup", day: 0, visibility: "public", payload: { startedAt: "2026-01-01T00:00:00.000Z" } });
  repository.appendEvent(record.id, transition(reduceGame(record.id, repository.listEvents(record.id)), "night_actions", 1));
  repository.updateGame(record.id, { status: "running" }); return record;
}
function event(type: string, phase: GameEventV1["phase"], day: number, payload: Record<string, unknown>, visibility: GameEventV1["visibility"] = "public", audienceIds: string[] = []): GameEventV1 {
  return { schemaVersion: "game_event_v1", id: type + "-" + day + "-" + JSON.stringify(payload).length, gameId: "game", sequence: 1, type, phase, day, visibility, audienceIds, payload, createdAt: "2026-01-01T00:00:00.000Z" };
}
function opportunity(repository: LabRepository, record: ReturnType<typeof game>, kind: DecisionOpportunityV1["kind"] = "vote") {
  const state = reduceGame(record.id, repository.listEvents(record.id)); const packet = buildContextV2(state, repository.listEvents(record.id), "p1", emptyJournalV2(), "invariant", kind);
  return { id: "invariant-decision", gameId: record.id, playerId: "p1", kind, phase: state.phase, day: state.day, epoch: state.day + ":" + state.phase, viewId: contentHash(packet), baseJournalVersion: 0, packet, status: "open", best: null, recovery: 0, createdAt: "2026-01-01T00:00:00.000Z" } satisfies DecisionOpportunityV1;
}
describe("V2 packet invariants", () => {
  it("is invariant to hidden opponent role descriptions and unrelated journals", () => {
    const state = createGameState("game", config()); state.phase = "day_discussion"; state.day = 2; const journal = { ...emptyJournalV2(), strategy: "private" }; const baseline = JSON.stringify(buildContextV2(state, [], "p1", journal, "same-key", "discussion"));
    fc.assert(fc.property(fc.string(), (description) => { const changed = structuredClone(state); changed.players[1]!.role.description = description; expect(JSON.stringify(buildContextV2(changed, [], "p1", journal, "same-key", "discussion"))).toBe(baseline); }), { numRuns: 20 });
  });
  it("keeps per-key ordering deterministic and strips global metadata", () => {
    const state = createGameState("game", config()); state.phase = "day_discussion"; state.day = 1; const source = event("speech.public", "day_discussion", 1, { playerId: "p2", playerName: "Player 2", text: "claim", acts: [], respondsTo: [], globalSeq: 77, seed: "secret", timestamp: "secret" }); const first = buildContextV2(state, [source], "p1", emptyJournalV2(), "stable-key", "discussion"); const second = buildContextV2(state, [source], "p1", emptyJournalV2(), "stable-key", "discussion");
    expect(first).toEqual(second); expect(JSON.stringify(first)).not.toMatch(/globalSeq|secret|timestamp/);
  });
  it("preserves semantic seeded intent while excluding event UUID and timestamp", () => {
    const state = createGameState("game", config()); state.phase = "day_discussion"; state.day = 1; const a = event("speech.public", "day_discussion", 1, { playerId: "p2", playerName: "Player 2", text: "claim", acts: [], respondsTo: [] }); const b = { ...a, id: "different-id", createdAt: "2030-01-01T00:00:00.000Z" }; const left = buildContextV2(state, [a], "p1", emptyJournalV2(), "intent-key", "discussion"); const right = buildContextV2(state, [b], "p1", emptyJournalV2(), "intent-key", "discussion"); const semantic = (value: typeof left) => value.sources.map(({ id: _id, ...source }) => source);
    expect(semantic(left)).toEqual(semantic(right));
  });
  it("enforces context limits on large authorized histories", () => {
    const state = createGameState("game", config()); state.phase = "day_discussion"; state.day = 1; const events = Array.from({ length: 40 }, () => event("speech.public", "day_discussion", 1, { playerId: "p1", playerName: "Player 1", text: "x".repeat(1200), acts: [], respondsTo: [] })); expect(() => buildContextV2(state, events, "p1", emptyJournalV2(), "limit-key", "discussion")).toThrow(ContextLimitError);
  });
  it("rejects citations not present in the delivered packet", async () => {
    const state = createGameState("game", config()); state.phase = "day_vote"; state.day = 1; const packet = buildContextV2(state, [], "p1", emptyJournalV2(), "citation-key", "vote"); const result = await new FakeDecisionProvider().decide({ kind: "decision_v2", model: "fake", schemaName: "vote", schema: reportSchema("vote"), maxOutputTokens: 600, contextV2: packet, proposalKind: "vote" }); const report = result.data as Parameters<typeof validateReport>[0];
    expect(validateReport({ ...report, observations: ["forged-source"] }, packet, 1200)).toContain("citations must reference delivered source IDs");
  });
});
describe("V2 checkpoint and budget invariants", () => {
  it("excludes operator pauses including in-flight response time from the durable active clock", () => {
    let now=1_000_000; vi.spyOn(Date,"now").mockImplementation(()=>now);
    const repository=createRepository(),record=game(repository),store=new DecisionStore(repository);
    now+=500; expect(store.activeRuntimeMs(record.id)).toBe(500);
    repository.updateGame(record.id,{status:"paused"});
    now+=120_000; expect(store.activeRuntimeMs(record.id)).toBe(500);
    repository.updateGame(record.id,{status:"running"}); now+=200;
    repository.updateGame(record.id,{status:"stepping"}); now+=100;
    repository.updateGame(record.id,{status:"completed"}); now+=1000;
    expect(store.activeRuntimeMs(record.id)).toBe(800);
  });
  it("rejects stale proposals and preserves atomic rollback", () => {
    const repository = createRepository(); const record = game(repository); const store = new DecisionStore(repository); const op = opportunity(repository, record); store.save({ ...op, viewId: "newer-view" });
    expect(() => store.commit(op, emptyJournalV2(), [{ type: "vote.cast", phase: op.phase, day: op.day, visibility: "player", audienceIds: ["p1"], payload: {} }])).toThrow("stale_decision"); expect(repository.listEvents(record.id).some((e) => e.type === "vote.cast")).toBe(false);
  });
  it("commits idempotently and retains the persisted report checkpoint", () => {
    const repository = createRepository(); const record = game(repository); const store = new DecisionStore(repository); const op = opportunity(repository, record); store.save(op); expect(store.commit(op, emptyJournalV2(), [])).toBe(true); expect(store.commit({ ...op, status: "committed" }, emptyJournalV2(), [])).toBe(false); expect(store.get<DecisionOpportunityV1>(record.id, "decision:" + op.id)?.status).toBe("committed"); expect(repository.listEvents(record.id).filter((e) => e.type === "decision.committed")).toHaveLength(1);
  });
  it("recovers expired work into a pause without starting a model call", () => {
    const repository = createRepository(); const record = game(repository); const job = repository.enqueueJob("game", record.id); repository.claimJob(); repository.connection.sqlite.prepare("UPDATE jobs SET updated_at=? WHERE id=?").run(new Date(Date.now() - 31_000).toISOString(), job.id); expect(recoverStaleWork(repository)).toBe(1); expect(repository.getGame(record.id)?.status).toBe("paused"); expect(new DecisionStore(repository).attempts(record.id)).toHaveLength(0);
  });
  it("admits unlimited token usage while retaining call and runtime limits", () => {
    const repository=createRepository(),record=game(repository,{maxTotalTokens:null}),store=new DecisionStore(repository),op=opportunity(repository,record);
    const attempt=store.beginAttempt(op,{model:"fake",provider:"fake",reasoningEffort:"medium",optional:false,request:{instructions:"",input:"",schema:{}}});
    attempt.usage.totalTokens=1_000_000_000;store.updateAttempt(attempt);
    expect(repository.getGame(record.id)?.config).toMatchObject({maxTotalTokens:null});
    expect(()=>assertV2Budget(store,record.id,record.config as ReturnType<typeof config>)).not.toThrow();
    for(let i=1;i<20;i++)store.beginAttempt(op,{model:"fake",provider:"fake",reasoningEffort:"medium",optional:false,request:{instructions:"",input:"",schema:{}}});
    expect(()=>assertV2Budget(store,record.id,record.config as ReturnType<typeof config>)).toThrow("model-call admission");
    const runtimeRecord=game(repository,{maxTotalTokens:null}),runtimeStore=new DecisionStore(repository);runtimeStore.put(runtimeRecord.id,"runtimeMs",60_000);
    expect(()=>assertV2Budget(runtimeStore,runtimeRecord.id,runtimeRecord.config as ReturnType<typeof config>)).toThrow("active-runtime");
    expect(config().maxTotalTokens).toBe(2_000_000);
  });
  it("enforces call, token, and runtime admission thresholds", () => {
    const repository = createRepository(); const record = game(repository); const store = new DecisionStore(repository); const op = opportunity(repository, record); for (let i = 0; i < 20; i += 1) store.beginAttempt(op, { model: "fake", provider: "fake", reasoningEffort: "medium", optional: false, request: { instructions: "", input: "", schema: {} } }); expect(() => assertV2Budget(store, record.id, record.config as ReturnType<typeof config>)).toThrow("model-call admission");
    const tokenRecord = game(repository, { maxTotalTokens: 1_000 }); const tokenStore = new DecisionStore(repository); const tokenOp = opportunity(repository, tokenRecord); tokenStore.beginAttempt(tokenOp, { model: "fake", provider: "fake", reasoningEffort: "medium", optional: false, request: { instructions: "", input: "x".repeat(5000), schema: {} } }); expect(() => assertV2Budget(tokenStore, tokenRecord.id, tokenRecord.config as ReturnType<typeof config>)).toThrow("total-token admission");
    const runtimeRecord = game(repository, { maxTotalTokens: 100_000 }); const runtimeStore = new DecisionStore(repository); runtimeStore.put(runtimeRecord.id, "runtimeMs", 60_000); expect(() => assertV2Budget(runtimeStore, runtimeRecord.id, runtimeRecord.config as ReturnType<typeof config>)).toThrow("active-runtime");
  });
});
describe("V2 executor policy and scheduler invariants", () => {
  it("bounds always-continue and compares single versus gated counts", async () => {
    const repository = createRepository(); const single = game(repository, { deliberation: { mode: "single", maxCalls: 3 } }); const gated = game(repository, { deliberation: { mode: "gated", maxCalls: 2 } }); const fake = new FakeDecisionProvider(); const singleExecutor = new DecisionExecutorV2(repository, fake); const gatedExecutor = new DecisionExecutorV2(repository, fake);
    await singleExecutor.execute({ opportunity: opportunity(repository, single), mandatoryRemaining: 1, eventsForCommit: () => [], validateCurrent: () => true }); await gatedExecutor.execute({ opportunity: opportunity(repository, gated), mandatoryRemaining: 1, eventsForCommit: () => [], validateCurrent: () => true }); expect(singleExecutor.store.attempts(single.id).length).toBe(1); expect(gatedExecutor.store.attempts(gated.id).length).toBeLessThanOrEqual(2);
  });
  it("keeps structured accusations and sealed ballots out of unauthorized views while preserving readiness", () => {
    const state = createGameState("game", config()); state.phase = "day_discussion"; state.day = 1; const accusation = event("speech.public", "day_discussion", 1, { playerId: "p1", playerName: "Player 1", text: "Player 2", acts: [{ kind: "accusation", targetId: "p2", claim: "claim" }], respondsTo: [], closing: false }); expect(responseDockets(state, [accusation]).p2).toContain(accusation.id);
    const vote = event("vote.cast", "day_vote", 1, { vote: { voterId: "p2", targetId: "p3" } }, "player", ["p2"]); const voteContext = buildContextV2({ ...state, phase: "day_vote" }, [vote], "p1", emptyJournalV2(), "vote-key", "vote"); expect(voteContext.sources.some((source) => source.type === "vote.cast")).toBe(false);
    const opening = state.players.map((player) => event("discussion.completed", "day_discussion", 1, { playerId: player.id, stage: "opening", ready: true, interests: [], docket: [], publicRevision: "initial" })); expect(nextDiscussionWork(state, opening)).toBeNull();
  });
});
