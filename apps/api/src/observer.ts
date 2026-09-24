import { emptyJournalV2, type DecisionOpportunityV1, type GameEventV1, type PrivateJournalV1 } from "@werewolf/contracts";
import { DecisionStore, LabRepository, type GameRecord } from "@werewolf/db";
import { createGameCreatedEvent, createGameState, emptyJournal, reduceGame, type Viewer } from "@werewolf/engine";
import { publicPayload } from "@werewolf/simulator";
import { unknownUsage } from "@werewolf/contracts";
function historicalAttempts(store:DecisionStore,id:string,events:GameEventV1[],at?:number,decisionId?:string) {
  return store.attempts(id,decisionId).filter(a=>events.some(e=>e.type === "model.attempt_started" && e.payload.attemptId === a.id)).map(a=>{
    if(at === undefined) return a;
    const receipt=events.findLast(e=>e.type === "decision.usage_received" && e.payload.attemptId === a.id);
    const verdict=events.findLast(e=>["decision.reported","decision.narration_reported","decision.submission_rejected","decision.report_rejected","decision.attempt_failed"].includes(e.type) && e.payload.attemptId === a.id);
    const valid=verdict && ["decision.reported","decision.narration_reported"].includes(verdict.type);
    const validationError=Array.isArray(verdict?.payload.errors)?verdict.payload.errors.join("; "):verdict?.payload.error;
    return {...a,response:verdict ? a.response ?? null : null,usage:receipt?.payload.usage as typeof a.usage ?? unknownUsage(),status:valid ? "valid" as const : verdict ? "invalid" as const : receipt ? "received" as const : "started" as const,error:validationError as string ?? null,latencyMs:receipt?.payload.latencyMs as number ?? null,endedAt:receipt?.createdAt ?? null};
  });
}

export function ensureInitialized(repository: LabRepository, game: GameRecord): void {
  if (game.config.schemaVersion === "game_config_v2" && !repository.listEvents(game.id).length) repository.appendEvent(game.id, createGameCreatedEvent(createGameState(game.id, game.config)));
}
function allowed(repository: LabRepository, id: string, viewer: Viewer, event: GameEventV1): boolean {
  if (viewer.kind === "moderator" || event.visibility === "public") return true;
  if (viewer.kind === "player") return (event.visibility === "player" || event.visibility === "team") && event.audienceIds.includes(viewer.playerId);
  if (viewer.kind === "team" && event.visibility === "team") {
    const game = repository.getGame(id)!;
    const initial=repository.listEvents(id).slice(0,1);
    const state = initial.length ? reduceGame(id,initial) : createGameState(id,game.config);
    const members = state.players.filter(p => p.role.passives.teamChannel === viewer.teamId).map(p => p.id);
    return ["team.point","team.pointed","team.consensus_reached","team.consensus_failed"].includes(event.type) && members.some(member => event.audienceIds.includes(member));
  }
  return false;
}
export function replaySlice(repository: LabRepository, id: string, viewer: Viewer, at?: number): GameEventV1[] {
  let all = repository.listEvents(id);
  const game=repository.getGame(id)!;
  if(!all.length && game.config.schemaVersion==="game_config_v1") {
    // An unstarted legacy lobby has no historical events. Project setup in memory only.
    const setup=createGameCreatedEvent(createGameState(id,game.config));
    all=[{...setup,schemaVersion:"game_event_v1",id:`${id}:legacy-setup`,gameId:id,sequence:0,audienceIds:[],createdAt:game.createdAt}];
  }
  if (at === undefined) return all;
  const visible = all.filter(e => allowed(repository,id,viewer,e));
  const end = visible[Math.min(at, visible.length - 1)]?.sequence ?? 0;
  return all.filter(e => e.sequence <= end);
}
export function observerEvents(repository: LabRepository, id: string, viewer: Viewer, at?: number): GameEventV1[] {
  const game = repository.getGame(id)!;
  const events = replaySlice(repository,id,viewer,at).filter(e => allowed(repository,id,viewer,e));
  if (viewer.kind === "moderator") return events;
  return events.map((event, sequence) => {
    let payload = event.payload;
    if (event.type === "speech.public" || ["player.eliminated","role.revealed","vote.resolved","moderator.announcement","phase.changed","game.ended"].includes(event.type)) payload = publicPayload(event);
    if (event.type === "game.paused") payload = { reason: "Paused by operator or unresolved decision; private details require spoiler access." };
    if (event.type === "game.started") payload = {};
    if (event.type === "team.point") payload = { playerId: event.payload.playerId, targetId: event.payload.targetId };
    return { ...event, sequence, payload, audienceIds: viewer.kind === "player" ? [viewer.playerId] : viewer.kind === "team" ? [viewer.teamId] : [], createdAt: "1970-01-01T00:00:00.000Z" };
  });
}
function journalsAt(repository: LabRepository, game: GameRecord, events: GameEventV1[], ids: string[]) {
  const store = new DecisionStore(repository);
  const at = events.at(-1)?.sequence ?? 0;
  return Object.fromEntries(ids.map(id => {
    if (game.config.schemaVersion === "game_config_v2") return [id, store.journal(game.id,id,at)];
    const event = events.findLast(e => e.type === "journal.updated" && e.payload.playerId === id);
    return [id, (event?.payload.journal as PrivateJournalV1 | undefined) ?? emptyJournal()];
  }));
}
export function observerPayload(repository: LabRepository, game: GameRecord, viewer: Viewer, at?: number, options: { includeAttempts?: boolean } = {}) {
  ensureInitialized(repository, game);
  const canonical = replaySlice(repository,game.id,viewer,at);
  const state = reduceGame(game.id,canonical);
  const events = observerEvents(repository,game.id,viewer,at);
  const journalIds = viewer.kind === "moderator" ? state.players.map(p => p.id) : viewer.kind === "player" ? [viewer.playerId] : [];
  const journals = journalsAt(repository,game,canonical,journalIds);
  const config = game.config;
  const safeConfig = { schemaVersion: config.schemaVersion, ...(config.schemaVersion === "game_config_v2" ? { preset: config.preset, protocolVersion: config.protocolVersion, deliberation: config.deliberation, maxTotalTokens: config.maxTotalTokens } : {}), discussion: config.discussion, safety: config.safety };
  const calls = historicalAttempts(new DecisionStore(repository),game.id,canonical,at).filter(a => viewer.kind === "moderator" || viewer.kind === "player" && a.playerId === viewer.playerId);
  const usage = viewer.kind === "public" || viewer.kind === "team" ? [] : config.schemaVersion === "game_config_v2" ? calls.map(a => ({ ...a.usage, model: a.model, provider: a.provider, reasoningEffort: a.reasoningEffort, latencyMs: a.latencyMs, outputLimitEnforced: a.outputLimitEnforced })) : repository.usageForGame(game.id).filter(row => viewer.kind === "moderator" || viewer.kind === "player" && row.playerId === viewer.playerId);
  const historicalStatus = at === undefined ? game.status : state.status;
  return {
    game: viewer.kind === "moderator" ? { ...game, status: historicalStatus, legacyReplayOnly: config.schemaVersion !== "game_config_v2" } : { id: game.id, name: game.name, status: historicalStatus, config: safeConfig, speedMs: game.speedMs, createdAt: game.createdAt, legacyReplayOnly: config.schemaVersion !== "game_config_v2" },
    state: { ...(viewer.kind === "moderator" ? state : { gameId: state.gameId, phase: state.phase, day: state.day, winnerAlignments: state.winnerAlignments, outcomeReason: state.outcomeReason }), status: historicalStatus,
      players: state.players.map(p => viewer.kind === "moderator" || viewer.kind === "player" && p.id === viewer.playerId ? p : { id: p.id, name: p.name, alive: p.alive, ...(p.revealedRole ? { revealedRole: p.revealedRole } : {}) }), journals, events: undefined },
    events, usage, ...(options.includeAttempts ? { attempts: calls } : {}), at: at ?? null, view: viewer.kind,
  };
}
export function decisionRecords(repository: LabRepository, id: string, viewer: Viewer, at?: number): DecisionOpportunityV1[] {
  if (viewer.kind === "public" || viewer.kind === "team") return [];
  const events = replaySlice(repository,id,viewer,at);
  return new DecisionStore(repository).opportunities(id).filter(op => (viewer.kind === "moderator" || op.playerId === viewer.playerId) && (at === undefined || events.some(e => e.payload.decisionId === op.id))).map(op => {
    if (at === undefined) return op;
    const report = events.findLast(e => e.type === "decision.reported" && e.payload.decisionId === op.id);
    const committed = events.some(e => e.type === "decision.committed" && e.payload.decisionId === op.id);
    const superseded = events.some(e => e.type === "decision.superseded" && e.payload.decisionId === op.id);
    return { ...op, best: report?.payload.report as DecisionOpportunityV1["best"] ?? null, bestSubmission: report?.payload.submission, taskType: report?.payload.taskType as DecisionOpportunityV1["taskType"] ?? op.taskType, status: committed ? "committed" : superseded ? "superseded" : report ? "pending" : "open", recovery: Number(report?.payload.recovery ?? 0) };
  });
}
export function decisionSummaries(repository: LabRepository, id: string, viewer: Viewer, at?: number) {
  return decisionRecords(repository,id,viewer,at).map(({packet: _packet,best: _best,bestSubmission: _bestSubmission,...opportunity}) => opportunity);
}
export function decisionDetail(repository: LabRepository, id: string, decisionId: string, viewer: Viewer, at?: number) {
  const opportunity = decisionRecords(repository,id,viewer,at).find(op => op.id === decisionId);
  if (!opportunity) return undefined;
  const canonical = replaySlice(repository,id,viewer,at);
  const events = observerEvents(repository,id,viewer,at).filter(e => e.payload.decisionId === decisionId);
  const attempts = historicalAttempts(new DecisionStore(repository),id,canonical,at,decisionId);
  return { opportunity, attempts, turns: events.filter(e => e.type === "decision.reported").map(e => e.payload), events };
}
