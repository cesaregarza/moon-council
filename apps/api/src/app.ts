import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { CreateGameV2RequestSchema, GameConfigV2Schema, PRESET_ROSTERS, rosterRoleVersion, StoredExperimentSpecSchema } from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { BODYGUARD, DOCTOR_V2, reduceGame, STARTER_ROLES, type Viewer } from "@werewolf/engine";
import { describeProviderConfiguration, resolveDefaultModel, resolveModeratorModel, selectedProviderKind } from "@werewolf/llm";
import { acknowledgeSemanticAnomaly, summarizeExperiment } from "@werewolf/simulator";
import { z } from "zod";
import { decisionDetail, decisionRecords, decisionSummaries, ensureInitialized, observerEvents, observerPayload, replaySlice } from "./observer";

const Params = z.object({ id: z.string().min(1) });
const Query = z.object({ after: z.coerce.number().int().min(-1).default(-1), at: z.coerce.number().int().min(0).optional(), view: z.enum(["public","moderator","player","team"]).default("public"), playerId: z.string().optional(), teamId: z.string().optional(), format: z.enum(["json","jsonl"]).default("json") });
const Control = z.object({
  action: z.enum(["start","pause","resume","step","step_decision","abort","speed","extend_budget","acknowledge_semantic_anomaly"]),
  decisionId: z.string().min(1).optional(),
  note: z.string().trim().min(1).max(1_000).optional(),
  speedMs: z.number().int().min(0).max(30_000).optional(),
  maxTotalTokens: z.number().int().min(1_000).max(100_000_000).nullable().optional(),
  maxWallClockMs: z.number().int().min(60_000).max(86_400_000).optional(),
  maxContextTokens: z.number().int().min(1_000).max(32_000).optional(),
});
function viewer(query: z.infer<typeof Query>): Viewer {
  if (query.view === "player") {
    if (!query.playerId) throw Object.assign(new Error("playerId required"),{ statusCode:400 });
    return { kind:"player",playerId:query.playerId };
  }
  if (query.view === "team") {
    if (!query.teamId) throw Object.assign(new Error("teamId required"),{ statusCode:400 });
    return { kind:"team",teamId:query.teamId };
  }
  return { kind:query.view };
}
export interface ApiOptions { databaseUrl?: string; logger?: boolean }
export async function buildApi(options: ApiOptions = {}): Promise<{app:FastifyInstance;repository:LabRepository;connection:DatabaseConnection}> {
  const app = Fastify({logger:options.logger ?? false});
  const connection = openDatabase(options.databaseUrl);
  const repository = new LabRepository(connection);
  const store = new DecisionStore(repository);
  repository.seedRoles([...STARTER_ROLES,DOCTOR_V2,BODYGUARD]);
  await app.register(cors,{origin:/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/});
  app.setErrorHandler((error,_request,reply) => {
    if (error instanceof z.ZodError) return reply.status(400).send({error:"validation_error",issues:error.issues});
    const status = typeof (error as {statusCode?:unknown}).statusCode === "number" ? (error as {statusCode:number}).statusCode : 500;
    return reply.status(status).send({error:status >= 500 ? "internal_error" : "request_error",message:error instanceof Error ? error.message : String(error)});
  });
  app.get("/api/v1/health",async () => ({ok:true,...describeProviderConfiguration()}));
  app.get("/api/v1/roles",async () => repository.listRoles());
  app.post("/api/v1/roles",async (request,reply) => reply.status(201).send(repository.createRole(request.body)));
  app.get("/api/v1/games",async () => repository.listGames(100).map(game => observerPayload(repository,game,{kind:"public"})));
  app.post("/api/v1/games",async (request,reply) => {
    const input = CreateGameV2RequestSchema.parse(request.body);
    if (input.roleRefs.length !== input.seats.length) return reply.status(400).send({error:"role_count_mismatch"});
    const roster = PRESET_ROSTERS[input.preset];
    const refs = roster ? roster.map(id => ({id,version:rosterRoleVersion(id)})) : input.roleRefs;
    if (roster && input.seats.length !== 8) return reply.status(400).send({error:"standard_preset_requires_eight_seats"});
    const roleDeck = refs.map(ref => {
      const role = repository.getRole(ref.id,ref.version);
      if (!role) throw Object.assign(new Error(`Unknown role ${ref.id}`),{statusCode:400});
      return role;
    });
    const provider = selectedProviderKind();
    const defaultModel = resolveDefaultModel(provider);
    const effort = input.reasoningEffort ?? (provider === "codex" ? process.env.CODEX_REASONING_EFFORT : process.env.OPENAI_REASONING_EFFORT) ?? "medium";
    // V3.1 stays the default; V3.2's delivery ladder is opt-in until an A/B pilot
    // shows abridged records do not cost play quality.
    const config = GameConfigV2Schema.parse({...input,schemaVersion:"game_config_v2",protocolVersion:input.protocolVersion==="agent_v3_2"?"agent_v3_2":"agent_v3_1",rules:{packExecution:"any_unblocked",revealBallots:true,firstCycle:"day_first"},discussion:{...input.discussion,speakerSelection:"listener_auction"},deliberation:{...input.deliberation,bidReasoningEffort:input.deliberation.bidReasoningEffort??"medium"},roleDeck,moderatorModel:input.moderatorModel ?? resolveModeratorModel(defaultModel,provider),modelSettings:Object.fromEntries(input.seats.map(seat => [seat.id,{model:seat.model ?? defaultModel,reasoningEffort:effort,provider}]))});
    const game = repository.createGame(config);
    ensureInitialized(repository,game);
    return reply.status(201).send(observerPayload(repository,game,{kind:"moderator"}));
  });
  app.get("/api/v1/games/:id",async (request,reply) => {
    const {id} = Params.parse(request.params); const query=Query.parse(request.query); const game=repository.getGame(id);
    if (!game) return reply.status(404).send({error:"not_found"});
    return observerPayload(repository,game,viewer(query),query.at);
  });
  app.post("/api/v1/games/:id/control",async (request,reply) => {
    const {id}=Params.parse(request.params); const input=Control.parse(request.body); const game=repository.getGame(id);
    if (!game) return reply.status(404).send({error:"not_found"});
    if (game.config.schemaVersion !== "game_config_v2") return reply.status(409).send({error:"legacy_replay_only",message:"Create a new V2 game using the legacy configuration; original logs remain unchanged."});
    if (input.action === "acknowledge_semantic_anomaly") {
      if (!input.decisionId || !input.note) {
        return reply.status(400).send({ error: "decisionId_and_note_required" });
      }
      return { ok: true, ...acknowledgeSemanticAnomaly(repository, id, input.decisionId, input.note) };
    }
    const currentConfig=game.config;
    if (input.action === "extend_budget") {
      const contextLimited=game.status==="paused"&&game.error?.startsWith("context_limit:");
      if (game.status !== "budget_exhausted"&&!contextLimited) return reply.status(409).send({error:"game_has_no_extendable_limit"});
      if (input.maxTotalTokens === undefined || input.maxWallClockMs === undefined) return reply.status(400).send({error:"extended_budgets_required"});
      const nextContextTokens=input.maxContextTokens??currentConfig.deliberation.maxContextTokens;
      if ((input.maxTotalTokens !== null && (currentConfig.maxTotalTokens === null || input.maxTotalTokens < currentConfig.maxTotalTokens)) || input.maxWallClockMs < currentConfig.safety.maxWallClockMs || nextContextTokens < currentConfig.deliberation.maxContextTokens) return reply.status(400).send({error:"limit_extension_cannot_reduce_limits"});
      const events=repository.listEvents(id);
      const interrupted=contextLimited?events.findLast(event=>event.type==="game.paused"&&String(event.payload.reason??"").startsWith("context_limit:")):events.findLast(event=>event.type==="game.budget_exhausted");
      if(!interrupted) return reply.status(409).send({error:"missing_limit_event"});
      const config=GameConfigV2Schema.parse({...currentConfig,maxTotalTokens:input.maxTotalTokens,safety:{...currentConfig.safety,maxWallClockMs:input.maxWallClockMs},deliberation:{...currentConfig.deliberation,maxContextTokens:nextContextTokens}});
      store.atomic(()=>{
        repository.updateGameConfig(id,config);
        repository.appendEvent(id,{type:"game.budget_extended",phase:interrupted.phase,day:interrupted.day,visibility:"moderator",payload:{previousMaxTotalTokens:currentConfig.maxTotalTokens,maxTotalTokens:config.maxTotalTokens,previousMaxWallClockMs:currentConfig.safety.maxWallClockMs,maxWallClockMs:config.safety.maxWallClockMs,previousMaxContextTokens:currentConfig.deliberation.maxContextTokens,maxContextTokens:config.deliberation.maxContextTokens,resumedFromSequence:interrupted.sequence,reason:contextLimited?"operator context extension":"operator budget extension"}});
        store.put(id,"stepUnit","phase");
        repository.updateGame(id,{status:"running",error:null});
        repository.enqueueJob("game",id);
      });
      return {ok:true,status:"running",maxTotalTokens:config.maxTotalTokens,maxWallClockMs:config.safety.maxWallClockMs,maxContextTokens:config.deliberation.maxContextTokens};
    }
    if (["completed","aborted","budget_exhausted","failed"].includes(game.status)) return reply.status(409).send({error:"game_is_terminal"});
    ensureInitialized(repository,game);
    const state=reduceGame(id,repository.listEvents(id));
    if (input.action === "speed") { if(input.speedMs === undefined) return reply.status(400).send({error:"speedMs_required"}); repository.updateGame(id,{speedMs:input.speedMs}); return {ok:true,status:game.status}; }
    const status = input.action === "abort" ? "aborted" : input.action === "pause" ? "paused" : input.action.startsWith("step") ? "stepping" : "running";
    store.atomic(() => {
      const type = status === "aborted" ? "game.aborted" : status === "paused" ? "game.paused" : "game.resumed";
      repository.appendEvent(id,{type,phase:status === "aborted" ? "ended" : state.phase,day:state.day,visibility:"public",payload:{reason:`operator ${input.action}`}});
      store.put(id,"stepUnit",input.action === "step_decision" ? "decision" : "phase");
      repository.updateGame(id,{status,error:null});
      if (status === "running" || status === "stepping") repository.enqueueJob("game",id);
    });
    return {ok:true,status};
  });
  app.get("/api/v1/games/:id/events",async (request,reply) => {
    const {id}=Params.parse(request.params); const query=Query.parse(request.query);
    if (!repository.getGame(id)) return reply.status(404).send({error:"not_found"});
    return observerEvents(repository,id,viewer(query),query.at).filter(e=>e.sequence>query.after);
  });
  app.get("/api/v1/games/:id/events/stream",async (request,reply) => {
    const {id}=Params.parse(request.params); const query=Query.parse(request.query);
    if (!repository.getGame(id)) return reply.status(404).send({error:"not_found"});
    const perspective=viewer(query); let last=query.after;
    reply.hijack(); reply.raw.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache",connection:"keep-alive","x-accel-buffering":"no"});
    const send=()=>{for(const event of observerEvents(repository,id,perspective,query.at).filter(e=>e.sequence>last)){ reply.raw.write(`id: ${event.sequence}\nevent: game_event\ndata: ${JSON.stringify(event)}\n\n`); last=event.sequence;} reply.raw.write(": heartbeat\n\n");};
    send(); const timer=setInterval(send,500); request.raw.on("close",()=>clearInterval(timer)); return reply;
  });
  app.get("/api/v1/games/:id/decisions",async (request,reply)=>{
    const {id}=Params.parse(request.params); const query=Query.parse(request.query);
    if(!repository.getGame(id)) return reply.status(404).send({error:"not_found"});
    return decisionSummaries(repository,id,viewer(query),query.at);
  });
  app.get("/api/v1/games/:id/decisions/:decisionId",async (request,reply)=>{
    const {id,decisionId}=Params.extend({decisionId:z.string()}).parse(request.params); const query=Query.parse(request.query);
    if(!repository.getGame(id)) return reply.status(404).send({error:"not_found"});
    const detail=decisionDetail(repository,id,decisionId,viewer(query),query.at);
    return detail ?? reply.status(404).send({error:"not_found"});
  });
  app.get("/api/v1/games/:id/export",async(request,reply)=>{
    const {id}=Params.parse(request.params); const query=Query.parse(request.query); const game=repository.getGame(id);
    if(!game) return reply.status(404).send({error:"not_found"});
    const perspective=viewer(query); const payload=observerPayload(repository,game,perspective,query.at,{includeAttempts:true});
    const decisions=decisionRecords(repository,id,perspective,query.at).map(op=>decisionDetail(repository,id,op.id,perspective,query.at));
    const protocol=game.config.schemaVersion==="game_config_v2"?game.config.protocolVersion:null;
    const split=protocol==="agent_v3"||protocol==="agent_v3_1"||protocol==="agent_v3_2";
    const exportDecisions=split?decisions.map(detail=>detail?{...detail,attemptIds:detail.attempts.map(attempt=>attempt.id),attempts:undefined}:detail):decisions;
    const bundle={schemaVersion:protocol==="agent_v3_2"?"werewolf_research_bundle_v3_2":protocol==="agent_v3_1"?"werewolf_research_bundle_v3_1":protocol==="agent_v3"?"werewolf_research_bundle_v3":game.config.schemaVersion === "game_config_v2" ? "werewolf_research_bundle_v2" : "werewolf_research_bundle_v1",perspective:query.view,exportedAt:new Date().toISOString(),...payload,attempts:payload.attempts ?? [],journals:payload.state.journals,decisions:exportDecisions};
    reply.header("content-disposition",`attachment; filename="${id}-${query.view}.${query.format}"`);
    if(query.format === "jsonl") {reply.type("application/x-ndjson");return [JSON.stringify({kind:"metadata",schemaVersion:bundle.schemaVersion,perspective:bundle.perspective,game:bundle.game}),...bundle.events.map(event=>JSON.stringify({kind:"event",event})),...Object.entries(bundle.journals).map(([playerId,journal])=>JSON.stringify({kind:"journal",playerId,journal})),...exportDecisions.map(decision=>JSON.stringify({kind:"decision",decision})),...bundle.attempts.map(attempt=>JSON.stringify({kind:"attempt",attempt})),...bundle.usage.map(usage=>JSON.stringify({kind:"usage",usage}))].join("\n");}
    return bundle;
  });
  app.get("/api/v1/experiments",async()=>repository.listExperiments());
  app.post("/api/v1/experiments",async(request,reply)=>{
    const spec=StoredExperimentSpecSchema.parse(request.body);
    if(spec.schemaVersion !== "experiment_v2") return reply.status(409).send({error:"legacy_replay_only"});
    const experiment=repository.createExperiment(spec);repository.enqueueJob("experiment",experiment.id);return reply.status(201).send(experiment);
  });
  app.get("/api/v1/experiments/:id",async(request,reply)=>{
    const {id}=Params.parse(request.params);const experiment=repository.getExperiment(id);
    if(!experiment) return reply.status(404).send({error:"not_found"});
    return {experiment:{...experiment,summary:summarizeExperiment(repository,id,experiment.spec)},games:repository.listGames(100,id)};
  });
  app.post("/api/v1/experiments/:id/control",async(request,reply)=>{
    const {id}=Params.parse(request.params);const {action}=z.object({action:z.enum(["pause","resume"])}).parse(request.body);const experiment=repository.getExperiment(id);
    if(!experiment) return reply.status(404).send({error:"not_found"});
    if(experiment.spec.schemaVersion !== "experiment_v2") return reply.status(409).send({error:"legacy_replay_only"});
    repository.updateExperiment(id,{status:action === "pause" ? "paused" : "queued",error:null});
    for(const game of repository.listGames(100,id)) if(action === "pause" && ["running","stepping"].includes(game.status)) repository.updateGame(game.id,{status:"paused"});
    if(action === "resume") repository.enqueueJob("experiment",id);
    return {ok:true,status:action === "pause" ? "paused" : "queued"};
  });
  const webRoot=fileURLToPath(new URL("../../web/dist",import.meta.url));
  if(existsSync(webRoot)){await app.register(fastifyStatic,{root:webRoot,wildcard:false});app.get("/*",async(_request,reply)=>reply.sendFile("index.html"));}
  app.addHook("onClose",async()=>connection.close());
  return {app,repository,connection};
}
