import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { GameConfigSchema, emptyJournalV2, type DecisionOpportunityV1, type GameEventV1, type PrivateJournalV2 } from "@werewolf/contracts";
import { DecisionStore } from "@werewolf/db";
import { STARTER_ROLES } from "@werewolf/engine";
import { buildApi } from "./app";

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const seats = Array.from({ length: 8 }, (_, index) => ({ id: `p${index + 1}`, name: `Player ${index + 1}`, personality: "Fixture" }));
const baseInput = {
  name: "Observer V2",
  seed: "observer-seed",
  seats,
  roleRefs: ["werewolf", "werewolf", "seer", "doctor", "villager", "villager", "villager", "villager"].map((id) => ({ id })),
  revealRolesOnDeath: true,
  moderatorNarration: false,
  discussion: { readyQuorum: 2 / 3, maxFollowUpsPerPlayer: 2, maxFollowUpSlotsFactor: 0.5 },
  safety: { maxCycles: 8, maxModelCalls: 500, maxOutputTokens: 600, maxWallClockMs: 1_800_000 },
  speedMs: 0,
  preset: "standard-8-v2" as const,
  deliberation: { mode: "gated" as const, maxCalls: 3, optionalDayCalls: 4, optionalNightCalls: 2, requestTimeoutMs: 120_000, episodeTimeoutMs: 300_000, maxContextTokens: 8_000, maxJournalTokens: 1_200 },
  maxTotalTokens: 2_000_000,
  reasoningEffort: "xhigh",
};

async function createV2() {
  const built = await buildApi({ databaseUrl: ":memory:" });
  apps.push(built.app);
  const response = await built.app.inject({ method: "POST", url: "/api/v1/games", payload: baseInput });
  expect(response.statusCode).toBe(201);
  return { built, id: response.json<{ game: { id: string } }>().game.id };
}

function appendFixtureDecisions(repository: Awaited<ReturnType<typeof buildApi>>["repository"], gameId: string) {
  const store = new DecisionStore(repository);
  const journal: PrivateJournalV2 = { ...emptyJournalV2(), version: 1, strategy: "interim journal" };
  const report = { observations: ["public-1"], inferences: [], alternatives: [{ id: "wait", description: "Wait for one more clue", advantage: "less exposure", drawback: "less information" }], selectedAlternativeId: "wait", proposal: { kind: "pass", reason: "Preserve position" }, confidence: 0.6, summary: "Interim report", journalPatch: [], control: { kind: "continue", question: "What changed?", reason: "resolve_conflict" } };
  const opportunity = { id: "decision-p1-1", gameId, playerId: "p1", kind: "discussion", phase: "day_discussion", day: 1, epoch: "1:day_discussion", viewId: "view-1", baseJournalVersion: 0, packet: { schemaVersion: "player_context_v2", phase: "day_discussion", day: 1, self: { id: "p1", name: "Player 1", role: STARTER_ROLES.find((role) => role.id === "villager")! }, players: seats.map((seat) => ({ id: seat.id, name: seat.name, alive: true })), knownAllies: [], rules: {}, sources: [], legalActions: [], legalTargets: [], journal: emptyJournalV2(), responseDocket: [], closing: false }, status: "open", best: null, bestSubmission:{rationale:"future submission"}, taskType:"discussion_bid", recovery: 0, createdAt: "2026-01-01T00:00:00.000Z" } as DecisionOpportunityV1;
  store.save(opportunity);
  const attempt=store.beginAttempt(opportunity,{model:"fixture",provider:"fake",reasoningEffort:"medium",optional:false,request:{instructions:"stable",input:"dynamic",schema:{type:"object"}},promptVersion:"player_prompt_v3",schemaVersion:"discussion_bid_v3"});
  repository.appendEvent(gameId, { type: "message.public", phase: "day_discussion", day: 1, visibility: "public", payload: { text: "A public clue." } });
  repository.appendEvent(gameId, { type: "decision.reported", phase: "day_discussion", day: 1, visibility: "player", audienceIds: ["p1"], payload: { playerId:"p1",decisionId: opportunity.id, report, submission:{rationale:"interim submission"},taskType:"discussion_bid",attemptId:attempt.id,recovery: 1, continuation: "continue", verdict: "accepted" } });
  repository.appendEvent(gameId, { type: "journal.v2_updated", phase: "day_discussion", day: 1, visibility: "player", audienceIds: ["p1"], payload: { playerId: "p1", decisionId: opportunity.id, journal, patch: [] } });
  repository.appendEvent(gameId, { type: "decision.committed", phase: "day_discussion", day: 1, visibility: "player", audienceIds: ["p1"], payload: { decisionId: opportunity.id, proposal: report.proposal } });
  repository.appendEvent(gameId, { type: "journal.v2_updated", phase: "day_discussion", day: 1, visibility: "player", audienceIds: ["p1"], payload: { playerId: "p1", decisionId: opportunity.id, journal: { ...journal, version: 2, strategy: "final journal" }, patch: [] } });
  const initial=repository.listEvents(gameId)[0]!.payload.players as {id:string;role:{alignment:string}}[];
  const wolves=initial.filter(p=>p.role.alignment === "werewolf").map(p=>p.id);
  repository.appendEvent(gameId, { type: "team.point", phase: "night_team", day: 1, visibility: "team", audienceIds: wolves, payload: { playerId: wolves[0], targetId: "p2" } });
  attempt.status="valid";attempt.response='{"rationale":"future response"}';attempt.endedAt="2026-01-01T00:01:00.000Z";attempt.latencyMs=1_000;store.updateAttempt(attempt);
  return opportunity;
}

describe("V2 observer projections", () => {
  it("keeps V1 replay/export and legacy controls intact", async () => {
    const built = await buildApi({ databaseUrl: ":memory:" }); apps.push(built.app);
    const legacy = built.repository.createGame(GameConfigSchema.parse({ schemaVersion: "game_config_v1", name: "Legacy", seed: "legacy-seed", seats: seats.slice(0, 5), roleDeck: [STARTER_ROLES[1], STARTER_ROLES[2], STARTER_ROLES[3], STARTER_ROLES[0], STARTER_ROLES[0]], revealRolesOnDeath: true, moderatorNarration: false, speedMs: 0 }));
    const control = await built.app.inject({ method: "POST", url: `/api/v1/games/${legacy.id}/control`, payload: { action: "resume" } });
    expect(control.statusCode).toBe(409);
    const replay = await built.app.inject({ method: "GET", url: `/api/v1/games/${legacy.id}?view=public&at=0` });
    expect(replay.statusCode).toBe(200);
    const exported = await built.app.inject({ method: "GET", url: `/api/v1/games/${legacy.id}/export?view=public&format=json` });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({ schemaVersion: "werewolf_research_bundle_v1" });
    expect(built.repository.listEvents(legacy.id)).toEqual([]);
  });

  it("creates the standard V2 doctor version and keeps public/player/team views safe", async () => {
    const { built, id } = await createV2();
    const moderator = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}?view=moderator` });
    expect(moderator.json().game.config.roleDeck.find((role: { id: string }) => role.id === "doctor").version).toBe(2);
    expect(moderator.json()).not.toHaveProperty("attempts");
    expect(moderator.json().state).not.toHaveProperty("events");
    appendFixtureDecisions(built.repository, id);
    const publicView = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}?view=public` });
    const publicJson = publicView.json();
    expect(publicJson.game.config.seed).toBeUndefined();
    expect(publicJson.state.players.some((player: { role?: unknown }) => player.role)).toBe(false);
    expect(publicJson.events.some((event: GameEventV1) => event.type === "decision.reported")).toBe(false);
    const player = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}?view=player&playerId=p1` });
    expect(player.json().state.players.find((candidate: { id: string }) => candidate.id === "p1").role).toBeDefined();
    expect(player.json().state.players.find((candidate: { id: string }) => candidate.id === "p2").role).toBeUndefined();
    const team = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}?view=team&teamId=werewolves` });
    expect(team.json().events.some((event: GameEventV1) => event.type === "decision.reported")).toBe(false);
    expect(team.json().events.some((event: GameEventV1) => event.type === "team.point")).toBe(true);
    const publicEvents = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}/events?view=public` });
    const playerEvents = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}/events?view=player&playerId=p1` });
    const teamEvents = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}/events?view=team&teamId=werewolves` });
    const moderatorEvents = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}/events?view=moderator` });
    expect(publicEvents.json().some((event: GameEventV1) => event.type === "decision.reported")).toBe(false);
    expect(playerEvents.json().some((event: GameEventV1) => event.type === "decision.reported")).toBe(true);
    expect(teamEvents.json().some((event: GameEventV1) => event.type === "team.point")).toBe(true);
    expect(moderatorEvents.json().some((event: GameEventV1) => event.type === "decision.reported")).toBe(true);
    const publicDecisions = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}/decisions?view=public` });
    const teamDecisions = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}/decisions?view=team&teamId=werewolves` });
    expect(publicDecisions.json()).toEqual([]); expect(teamDecisions.json()).toEqual([]);
  });

  it("reconstructs a local replay cursor with an interim journal/report and gates decision visibility", async () => {
    const { built, id } = await createV2();
    const opportunity = appendFixtureDecisions(built.repository, id);
    const full = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}?view=player&playerId=p1` });
    const events = full.json().events as GameEventV1[];
    const reportAt = events.find((event) => event.type === "decision.reported")!.sequence + 1;
    const historical = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}?view=player&playerId=p1&at=${reportAt}` });
    const historicalJson = historical.json();
    expect(historicalJson.events.some((event: GameEventV1) => event.type === "decision.reported")).toBe(true);
    expect(historicalJson.events.some((event: GameEventV1) => event.type === "decision.committed")).toBe(false);
    expect(historicalJson.state.journals.p1.strategy).toBe("interim journal");
    const decisions = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}/decisions?view=player&playerId=p1&at=${reportAt}` });
    expect(decisions.json()[0]).toMatchObject({ id: opportunity.id, status: "pending" });
    expect(decisions.json()[0]).not.toHaveProperty("packet");
    expect(decisions.json()[0]).not.toHaveProperty("best");
    const detail = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}/decisions/${opportunity.id}?view=player&playerId=p1&at=${reportAt}` });
    expect(detail.json()).toMatchObject({ opportunity: { id: opportunity.id, status: "pending", best: { summary: "Interim report" },bestSubmission:{rationale:"interim submission"} } });
    const hidden = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}/decisions/${opportunity.id}?view=player&playerId=p2` });
    expect(hidden.statusCode).toBe(404);
    const moderatorEvents=(await built.app.inject({method:"GET",url:`/api/v1/games/${id}/events?view=moderator`})).json<GameEventV1[]>();
    const startedAt=moderatorEvents.find(event=>event.type==="model.attempt_started")!.sequence;
    const preResponse=await built.app.inject({method:"GET",url:`/api/v1/games/${id}/decisions/${opportunity.id}?view=moderator&at=${startedAt}`});
    expect(preResponse.json().attempts[0]).toMatchObject({status:"started",response:null});
  });

  it("exports each V3.1 attempt once and retains the exact requested response",async()=>{
    const {built,id}=await createV2();appendFixtureDecisions(built.repository,id);
    const exported=await built.app.inject({method:"GET",url:`/api/v1/games/${id}/export?view=moderator&format=json`});
    const body=exported.json();
    expect(body.schemaVersion).toBe("werewolf_research_bundle_v3_1");
    expect(body.decisions[0]).toMatchObject({attemptIds:[body.attempts[0].id]});
    expect(body.decisions[0]).not.toHaveProperty("attempts");
    expect(body.attempts[0]).toMatchObject({response:'{"rationale":"future response"}',promptVersion:"player_prompt_v3",schemaVersion:"discussion_bid_v3"});
  });

  it("does not put seeds or opponent journals into a public export", async () => {
    const { built, id } = await createV2(); appendFixtureDecisions(built.repository, id);
    const exported = await built.app.inject({ method: "GET", url: `/api/v1/games/${id}/export?view=public&format=json` });
    const text = JSON.stringify(exported.json());
    expect(text).not.toContain("observer-seed");
    expect(exported.json().journals).toEqual({});
    expect(text).not.toContain("final journal");
  });
});
