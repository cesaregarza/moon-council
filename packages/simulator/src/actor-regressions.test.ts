import { afterEach, describe, expect, it, vi } from "vitest";
import { GameConfigV2Schema, emptyJournalV2, type DecisionOpportunityV1 } from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { createGameState, reduceGame } from "@werewolf/engine";
import { AskJevProvider, FakeDecisionProvider, openAIRequest, type DecisionRequest, type JevRequest } from "@werewolf/llm";
import { buildContextV2 } from "./context-v2";
import { DecisionExecutorV2 } from "./decisions-v2";
import { decisionRequestV31 } from "./request-v3-1";
import { V2GameOrchestrator } from "./orchestrator-v2";
import { acknowledgeSemanticAnomaly } from "./semantic-recovery";
import { actorConfig } from "./testing/actor-fixtures";
import { createActorHoldout } from "./testing/actor-holdouts";
import { holdoutVote } from "./testing/actor-execution";
import { journalTokens } from "./freeform-journal";
import { actorBriefing } from "./jev-actor";
import { assessActorChoice } from "./jev-semantics";
import { observerPayload } from "../../../apps/api/src/observer";

const connections: DatabaseConnection[] = [];
afterEach(()=>{ vi.restoreAllMocks(); while(connections.length) connections.pop()!.close(); });
function repository() { const db=openDatabase(":memory:"); connections.push(db); return new LabRepository(db); }
function votes(handles: string[]) {
  const requests: JevRequest[] = [];
  const provider=new AskJevProvider(async input=>{
    const request=JSON.parse(input) as JevRequest;
    requests.push(request);
    const handle=handles[Math.min(requests.length-1,handles.length-1)]!;
    const options=(request.questions.target as {criteria:Record<string,unknown>}).criteria;
    return JSON.stringify({model:"synthetic",usage:{input_tokens:1,output_tokens:1},answers:{target:{type:"choice",choice:handle,confidence:0.1,probabilities:Object.fromEntries(Object.keys(options).map(key=>[key,Number(key===handle)]))}}});
  });
  return {provider,requests};
}
function recorder(onCall?:()=>void) {
  const requests: DecisionRequest<unknown>[]=[];
  const fake=new FakeDecisionProvider();
  return {requests,provider:{decide:async<T>(request:DecisionRequest<T>)=>{requests.push(request);onCall?.();return fake.decide(request);}}};
}
function staged(repository:LabRepository,provider:ReturnType<typeof recorder>["provider"]) {
  const game=repository.createGame(actorConfig());
  const runner=new V2GameOrchestrator(repository,provider);
  runner.initialize(game.id);
  repository.appendEvent(game.id,{type:"phase.changed",day:2,phase:"day_vote",visibility:"public",payload:{to:"day_vote"}});
  new DecisionStore(repository).put(game.id,"stepUnit","decision");
  repository.updateGame(game.id,{status:"stepping"});
  return {game,runner};
}

describe("v4 review regressions",()=>{
  it.each(["jev","llm"] as const)("keeps the rules cache stable across seats, speech and private results (%s)",mode=>{
    const repo=repository();
    const config=actorConfig(); config.decisionEngine.mode=mode;
    const game=repo.createGame(config), runner=new V2GameOrchestrator(repo,new FakeDecisionProvider());
    runner.initialize(game.id);
    const frames=[];
    for(const event of [undefined,"speech.public","inspection.delivered"]){
      if(event) repo.appendEvent(game.id,{type:event,phase:"day_discussion",day:1,visibility:event==="speech.public"?"public":"player",audienceIds:["p1"],payload:{playerId:"p2",text:"A fresh accusation",actorId:"p1",targetId:"p2",result:"werewolf"}});
      for(const playerId of ["p1","p2"]){
        const events=repo.listEvents(game.id), state=reduceGame(game.id,events);
        const packet=buildContextV2(state,events,playerId,emptyJournalV2(),"reflection","pass");
        const prepared=decisionRequestV31(packet,{type:"journal_update",revision:String(packet.rules.journalRevision??""),sourceIds:[]},true,null,null);
        const wire=openAIRequest({kind:"decision_v3_1",model:"gpt-6-luna",gameId:game.id,schemaName:"journal_update",schema:prepared.schema,apiResponseFormat:prepared.apiResponseFormat,preparedPrompt:prepared.prompt,maxOutputTokens:8192});
        frames.push({rules:JSON.stringify(Array.isArray(wire.input)?wire.input.slice(0,2):wire.input),key:wire.prompt_cache_key,revision:packet.rules.journalRevision});
      }
    }
    expect(new Set(frames.map(frame=>frame.rules)).size).toBe(1);
    expect(new Set(frames.map(frame=>frame.key)).size).toBe(1);
    if(mode==="llm") expect(frames.every(frame=>frame.revision===undefined)).toBe(true);
    else expect(new Set(frames.map(frame=>frame.revision)).size).toBeGreaterThan(1);
  });
  it("rejects undersized actor journals and reserves prose space even for worst-case escaping",()=>{
    for(const limit of [200,1200,8500,15999]) {
      const config=actorConfig();config.deliberation.maxJournalTokens=limit;
      expect(()=>GameConfigV2Schema.parse(config)).toThrow("maximum current brief and prose headroom");
      config.decisionEngine.mode="llm";
      expect(GameConfigV2Schema.safeParse(config).success).toBe(true);
    }
    const journal={...emptyJournalV2(),text:"x".repeat(3000),decisionBrief:{playerId:"\u0000".repeat(120),evidenceRevision:"a".repeat(64),action:"\u0000".repeat(4000),attention:"\u0000".repeat(3000)}};
    expect(journalTokens(journal)).toBeLessThan(16000);
  });
  it.each(["inspection.delivered","vote.resolved"])("reflects on %s alone and carries the new evidence",async type=>{
    const repo=repository(), llm=recorder(),{game,runner}=staged(repo,llm.provider);
    await runner.runGameStep(game.id);
    expect(llm.requests).toHaveLength(8);
    llm.requests.length=0;
    const event=repo.appendEvent(game.id,{type,phase:"day_vote",day:2,visibility:type==="inspection.delivered"?"player":"public",audienceIds:["p1"],payload:type==="inspection.delivered"?{actorId:"p1",targetId:"p2",result:"werewolf"}:{ballots:[{voterId:"p1",targetId:null}],targetId:null,tally:{},tied:[]}});
    await runner.runGameStep(game.id);
    expect(llm.requests).toHaveLength(type==="inspection.delivered"?1:8);
    for(const request of llm.requests){
      expect(request.schemaName).toBe("journal_update");
      expect(request.contextV2!.sources.some(source=>source.id===event.id)).toBe(true);
      expect(request.preparedPrompt!.input).toContain('sourceIds');
    }
    expect(repo.listEvents(game.id).filter(e=>e.type==="journal.refreshed").every(e=>typeof e.payload.reviewedThroughSequence==="number"&&!e.payload.sourceIds)).toBe(true);
  });
  it("pauses during reflection without falling into a missing-brief error and resumes the pending work",async()=>{
    const repo=repository();let gameId="", paused=false;
    const llm=recorder(()=>{if(!paused){paused=true;repo.updateGame(gameId,{status:"paused"});}});
    const {game,runner}=staged(repo,llm.provider);gameId=game.id;
    await runner.runGameStep(game.id);
    expect(repo.getGame(game.id)?.status).toBe("paused");
    expect(repo.getGame(game.id)?.error).toBeFalsy();
    expect(llm.requests).toHaveLength(1);
    repo.updateGame(game.id,{status:"stepping"});
    await runner.runGameStep(game.id);
    expect(repo.listEvents(game.id).filter(e=>e.type==="journal.refreshed")).toHaveLength(8);
    expect(llm.requests).toHaveLength(8);
  });
  it("keeps sealed votes and another player's private inspection out of every v4 peer context",()=>{
    const repo=repository(), fixture=createActorHoldout(repo,"uncertain-last-wolf");
    const {game,actor,packet}=fixture;
    repo.appendEvent(game.id,{type:"vote.cast",day:2,phase:"day_vote",visibility:"player",audienceIds:[actor.id],payload:{vote:{voterId:actor.id,targetId:fixture.target.id}}});
    const events=repo.listEvents(game.id),state=reduceGame(game.id,events);
    for(const player of state.players.filter(player=>player.id!==actor.id)) {
      const peer=buildContextV2(state,events,player.id,emptyJournalV2(),"vote","vote");
      expect(peer.sources.some(source=>source.type==="inspection.delivered"||source.type==="vote.cast")).toBe(false);
      expect(JSON.stringify(peer)).not.toContain(packet.journal.decisionBrief!.action);
    }
  });
  it("keeps a wolf's deception distinct from private pack knowledge",()=>{
    const repo=repository(),fixture=createActorHoldout(repo,"cleared-target-preference"),events=repo.listEvents(fixture.game.id),state=reduceGame(fixture.game.id,events);
    const wolf=state.players.find(player=>player.role.alignment==="werewolf")!;
    const packet=buildContextV2(state,events,wolf.id,emptyJournalV2(),"vote","vote");
    packet.journal.decisionBrief={playerId:wolf.id,evidenceRevision:String(packet.rules.journalRevision),action:"I will falsely claim Seer to frame a villager. I know my pack ally is a wolf; my public story is a bluff.",attention:"Hear the real Seer."};
    expect(actorBriefing({packet,playerId:wolf.id,taskType:"vote_choice"}).currentReasoning).toContain("bluff");
    expect(packet.knownAllies).toHaveLength(1);
    expect(assessActorChoice(packet,"vote_choice","abstain")).toMatchObject({applicable:false,issues:[]});
  });
  it("records exactly one reconsideration for the incident shape with doubting public speeches",async()=>{
    const repo=repository(),fixture=createActorHoldout(repo,"doubt-dominated"),options=holdoutVote(repo,fixture);
    const expected=String.fromCharCode(97+fixture.packet.legalTargets.indexOf(fixture.target.id));
    const jev=votes(["abstain",expected]);
    await new DecisionExecutorV2(repo,new FakeDecisionProvider(),jev.provider).execute(options);
    expect(jev.requests).toHaveLength(2);
    expect(reduceGame(fixture.game.id,repo.listEvents(fixture.game.id)).votes).toContainEqual({voterId:fixture.actor.id,targetId:fixture.target.id});
  });
  it("explains a pending reconsideration at maxCalls=1 and resumes exactly that review",async()=>{
    const repo=repository(),fixture=createActorHoldout(repo,"uncertain-last-wolf","journal_v4",1),options=holdoutVote(repo,fixture);
    const expected=String.fromCharCode(97+fixture.packet.legalTargets.indexOf(fixture.target.id)),jev=votes(["abstain",expected]);
    const executor=new DecisionExecutorV2(repo,new FakeDecisionProvider(),jev.provider);
    await expect(executor.execute(options)).rejects.toThrow("semantic reconsideration is pending");
    expect(jev.requests).toHaveLength(1);
    await executor.execute(options);
    expect(jev.requests).toHaveLength(2);
  });
  it("acknowledges and commits only the final recorded ballot, stays paused, and is idempotent",async()=>{
    const repo=repository(),fixture=createActorHoldout(repo,"uncertain-last-wolf"),options=holdoutVote(repo,fixture),jev=votes(["abstain"]);
    await expect(new DecisionExecutorV2(repo,new FakeDecisionProvider(),jev.provider).execute(options)).rejects.toThrow("one reconsideration");
    repo.updateGame(fixture.game.id,{status:"paused"});
    expect(acknowledgeSemanticAnomaly(repo,fixture.game.id,options.opportunity.id,"Accept this recorded anomaly for the experiment")).toMatchObject({status:"committed",gameStatus:"paused",alreadyAcknowledged:false});
    expect(acknowledgeSemanticAnomaly(repo,fixture.game.id,options.opportunity.id,"Repeat")).toMatchObject({alreadyAcknowledged:true});
    expect(jev.requests).toHaveLength(2);
    const events=repo.listEvents(fixture.game.id);
    expect(events.filter(e=>e.type==="vote.cast")).toHaveLength(1);
    expect(reduceGame(fixture.game.id,events).votes).toContainEqual({voterId:fixture.actor.id,targetId:null});
    expect(events.filter(e=>e.type==="decision.semantic_acknowledged")).toHaveLength(1);
    expect(JSON.stringify(observerPayload(repo,repo.getGame(fixture.game.id)!,{kind:"public"}))).not.toContain("Accept this recorded anomaly");
  });
  it("refuses acknowledgment after relevant evidence changes",async()=>{
    const repo=repository(),fixture=createActorHoldout(repo,"uncertain-last-wolf"),options=holdoutVote(repo,fixture),jev=votes(["abstain"]);
    await expect(new DecisionExecutorV2(repo,new FakeDecisionProvider(),jev.provider).execute(options)).rejects.toThrow();
    repo.updateGame(fixture.game.id,{status:"paused"});
    repo.appendEvent(fixture.game.id,{type:"speech.public",day:2,phase:"day_vote",visibility:"public",payload:{playerId:"p2",text:"New evidence",acts:[],respondsTo:[]}});
    expect(()=>acknowledgeSemanticAnomaly(repo,fixture.game.id,options.opportunity.id,"Reviewed")).toThrow("stale");
    expect(repo.listEvents(fixture.game.id).some(e=>e.type==="vote.cast")).toBe(false);
  });
  it("rolls back the semantic assessment together with a failed checkpoint write",async()=>{
    const repo=repository(),fixture=createActorHoldout(repo,"uncertain-last-wolf"),options=holdoutVote(repo,fixture),jev=votes(["abstain"]);
    // Failure happens after the private event insert, inside the same transaction.
    repo.connection.sqlite.exec("CREATE TRIGGER fail_semantic BEFORE INSERT ON events WHEN NEW.type = 'decision.jev_stage' BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END");
    await expect(new DecisionExecutorV2(repo,new FakeDecisionProvider(),jev.provider).execute(options)).rejects.toThrow();
    const op=fixture.store.get<DecisionOpportunityV1>(fixture.game.id,`decision:${options.opportunity.id}`)!;
    expect(repo.listEvents(fixture.game.id).filter(e=>e.type==="decision.semantic_assessed")).toHaveLength(0);
    expect(op.jevState).toBeUndefined();
  });
});
