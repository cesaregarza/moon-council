import {z} from "zod";
import {afterEach,describe,expect,it} from "vitest";
import {GameConfigV2Schema,emptyJournalV2,type DecisionOpportunityV1,type PrivateJournalV2} from "@werewolf/contracts";
import {DecisionStore,LabRepository,openDatabase,type DatabaseConnection} from "@werewolf/db";
import {DOCTOR_V2,STARTER_ROLES,createGameState,createGameCreatedEvent,reduceGame} from "@werewolf/engine";
import type {DecisionProvider} from "@werewolf/llm";
import {buildContextV2,contentHash,estimatedTokens} from "./context-v2";
import {DecisionExecutorV2,type ExecuteDecisionOptions} from "./decisions-v2";
import {decisionRequestV31,normalizeV31Submission,validateV31Submission} from "./request-v3-1";
import {compactNotebookSchema,compactionByteBudget,journalCompactionRequest,journalTextDraft,materializeCompactedJournal,validateJournalCompaction} from "./journal-compaction";
import {auditGameV2} from "./audit-v2";

const dbs:DatabaseConnection[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
const candidate:PrivateJournalV2={...emptyJournalV2(),version:1,
 beliefs:[{playerId:"p1",probability:0,basis:"authorized_fact",note:"I am a villager.",sources:["facts:self"]}],
 hypotheses:[{id:"h1",statement:"Possibly a wolf; uncertain.",confidence:0.4,sources:["event:1"]}],
 attentionNotes:[{playerId:"p2",note:"They owe an answer.",sources:["event:1"]}],deceptionPlan:null};

describe("journal compaction",()=>{
 it("allows shorter prose and redundant hypothesis removal while protecting beliefs and provenance",()=>{
  const result={...structuredClone(candidate),hypotheses:[],attentionNotes:[{...candidate.attentionNotes![0]!,note:"Await reply."}]};
  expect(validateJournalCompaction(candidate,result,1200)).toEqual([]);
  expect(validateJournalCompaction(candidate,{...result,beliefs:[{...result.beliefs[0]!,probability:1}]},1200).join(" ")).toContain("belief values");
  expect(validateJournalCompaction(candidate,{...result,attentionNotes:[]},1200).join(" ")).toContain("every listening-note");
  expect(validateJournalCompaction(candidate,{...result,attentionNotes:[{...result.attentionNotes[0]!,sources:["forged"]}]},1200).join(" ")).toContain("provenance");
  expect(validateJournalCompaction(candidate,{...result,hypotheses:[{...candidate.hypotheses[0]!,id:"invented"}]},1200).join(" ")).toContain("invented");
  expect(validateJournalCompaction(candidate,result,10).join(" ")).toContain("still uses");
 });

 it("explains conservative byte accounting and reuses only structurally faithful repair drafts",()=>{
  const report={journalPatch:[]} as unknown as NonNullable<DecisionOpportunityV1["journalCompaction"]>["sourceReport"];
  const compaction={candidate,sourceReport:report,sourceSubmission:null,sourceAttemptId:"source"};
  const {schemaVersion:_schema,version:_version,...draft}=candidate;
  const prompt=journalCompactionRequest(compaction,1200,8192,"shorter",JSON.stringify(draft));
  expect(JSON.parse(prompt.prompt.input).previousSummary).toEqual(journalTextDraft(candidate));
  expect(compactionByteBudget(candidate,1200)).toMatchObject({maximumSerializedBytes:3600,targetSerializedBytes:2700});
  const corrupted={...draft,beliefs:[{...draft.beliefs[0]!,probability:1}]};
  expect(JSON.parse(journalCompactionRequest(compaction,1200,8192,"repair",JSON.stringify(corrupted)).prompt.input).previousSummary).toBeNull();
 });

 it("requires existing deception-plan text and prevents inventing a plan when none exists",()=>{
  const planned={...candidate,deceptionPlan:"Deflect suspicion."};
  const schema=compactNotebookSchema(planned,1200);
  expect(schema.safeParse(journalTextDraft(planned)).success).toBe(true);
  expect(schema.safeParse({...journalTextDraft(planned),deceptionPlan:null}).success).toBe(false);
  expect(compactNotebookSchema(candidate,1200).safeParse(journalTextDraft(planned)).success).toBe(false);
 });

 it("leaves an achievable soft prose target when protected metadata dominates",()=>{
  const source={...candidate,beliefs:[{...candidate.beliefs[0]!,sources:Array.from({length:50},(_,i)=>`event:${String(i).padStart(36,"0")}`)}]};
  const budget=compactionByteBudget(source,1200);
  expect(budget.metadataBytesWithAllHypotheses).toBeGreaterThan(2400);
  expect(budget.targetSerializedBytes).toBeGreaterThan(budget.metadataBytesWithAllHypotheses+300);
  expect(budget.targetSerializedBytes).toBeLessThan(budget.maximumSerializedBytes);
 });

 it("enforces short prose in the compaction schema instead of repeatedly asking for a smaller draft",()=>{
  const source={...structuredClone(candidate),attentionNotes:Array.from({length:7},(_,i)=>({playerId:`p${i+1}`,note:"long note",sources:["event:one","event:two"]})),hypotheses:Array.from({length:4},(_,i)=>({...candidate.hypotheses[0]!,id:`h${i}`}))};
  const schema=compactNotebookSchema(source,1200);
  const strings=(shape:Record<string,z.ZodType>,nullable=false)=>Object.fromEntries(Object.entries(shape).map(([id,field])=>[id,"x".repeat((nullable?(field as z.ZodNullable<z.ZodString>).unwrap():field as z.ZodString).maxLength!)]));
  const longest={beliefNotes:strings(schema.shape.beliefNotes.shape),attentionNotes:strings(schema.shape.attentionNotes.shape),hypotheses:strings(schema.shape.hypotheses.shape,true),
   strategy:"x".repeat(schema.shape.strategy.maxLength!),goals:Array(4).fill("x".repeat(schema.shape.goals.element.maxLength!)),unresolvedQuestions:Array(4).fill("x".repeat(schema.shape.unresolvedQuestions.element.maxLength!)),deceptionPlan:null};
  expect(schema.safeParse(longest).success).toBe(true);
  const compaction={candidate:source,sourceReport:{} as NonNullable<DecisionOpportunityV1["journalCompaction"]>["sourceReport"],sourceSubmission:null,sourceAttemptId:"source"};
  const materialized=materializeCompactedJournal(compaction,longest);
  expect(estimatedTokens(materialized)).toBeLessThanOrEqual(1200);
  expect(materialized.beliefs[0]).toMatchObject({playerId:"p1",probability:0,basis:"authorized_fact",sources:["facts:self"]});
  expect(schema.safeParse({...longest,strategy:longest.strategy+"x"}).success).toBe(false);
  expect(schema.safeParse({...longest,attentionNotes:{}}).success).toBe(false);
  expect(schema.safeParse({...longest,beliefNotes:{invented:"x"}}).success).toBe(false);
 });

 it.each([null,2_000_000])("checkpoints and commits compaction once, with output budgeting for total limit %s",async(maxTotalTokens)=>{
  const db=openDatabase(":memory:");dbs.push(db);const repository=new LabRepository(db);repository.seedRoles([...STARTER_ROLES,DOCTOR_V2]);
  const roleIds=["werewolf","werewolf","seer","doctor","villager","villager","villager","villager"];
  const seats=roleIds.map((_,i)=>({id:`p${i+1}`,name:`P${i+1}`}));
  const config=GameConfigV2Schema.parse({schemaVersion:"game_config_v2",name:"compact",seed:"compact",protocolVersion:"agent_v3_1",seats,roleDeck:roleIds.map(id=>id==="doctor"?DOCTOR_V2:STARTER_ROLES.find(r=>r.id===id)),modelSettings:Object.fromEntries(seats.map(s=>[s.id,{provider:"openai",model:"luna",reasoningEffort:"xhigh"}])),decisionEngine:{mode:"jev",workflow:"journal_v2"},discussion:{speakerSelection:"listener_auction"},deliberation:{maxJournalTokens:200},maxTotalTokens});
  const game=repository.createGame(config);repository.appendEvent(game.id,createGameCreatedEvent(createGameState(game.id,config)));repository.updateGame(game.id,{status:"running"});
  const state=reduceGame(game.id,repository.listEvents(game.id));
  const packet=buildContextV2(state,repository.listEvents(game.id),"p1",emptyJournalV2(),"compact","pass");
  const store=new DecisionStore(repository),task={type:"journal_update" as const,revision:"initial",sourceIds:[]};
  const op:DecisionOpportunityV1={id:"compact-op",gameId:game.id,playerId:"p1",kind:"pass",phase:state.phase,day:state.day,epoch:`${state.day}:${state.phase}`,viewId:contentHash(packet),baseJournalVersion:0,packet,status:"open",best:null,recovery:0,createdAt:new Date().toISOString(),taskType:"journal_update"};store.save(op);
  const kinds:string[]=[];
  const provider:DecisionProvider={decide:async request=>{
   kinds.push(request.schemaName);
   expect(request.reasoningEffort).toBe(request.schemaName === "journal_compaction" ? "low" : "xhigh");
   expect(request.maxOutputTokens).toBe(kinds.length > 1 && maxTotalTokens === null ? null : config.safety.maxOutputTokens);
   expect(request.timeoutMs).toBeLessThanOrEqual(config.deliberation.episodeTimeoutMs);
   if(kinds.length === 2 && maxTotalTokens === null)expect(request.timeoutMs).toBeGreaterThan(config.deliberation.requestTimeoutMs);
   else expect(request.timeoutMs).toBeLessThanOrEqual(config.deliberation.requestTimeoutMs);
   if(kinds.length === 1) {
    request.onUsage?.({inputTokens:10,outputTokens:100,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningTokens:90},{provider:"openai",model:"luna",outputLimitEnforced:true});
    throw new Error("OpenAI response incomplete: max_output_tokens");
   }
   let value:unknown;
   if(request.schemaName==="journal_update")value={memory:{attentionUpdate:seats.map(s=>({playerId:s.id,note:"Important observation. ".repeat(10),evidence:[]})),beliefs:[],hypotheses:[],strategyUpdate:{strategy:"Long strategy. ".repeat(35),goals:[]},questionsUpdate:null,deceptionUpdate:null},rationale:"Update based on the latest evidence."};
   else {
    const source=JSON.parse(request.preparedPrompt!.input).NOTEBOOK;
    expect(estimatedTokens(source)).toBeGreaterThan(200);
    value=journalTextDraft({...source,attentionNotes:source.attentionNotes.map((n:{playerId:string;sources:string[]})=>({...n,note:"Observe."})),strategy:"Compare evidence.",goals:[],unresolvedQuestions:[],deceptionPlan:null});
    repository.updateGame(game.id,{status:"paused"});
   }
   request.onUsage?.({inputTokens:10,outputTokens:10,totalTokens:20,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningTokens:0},{provider:"openai",model:"luna",outputLimitEnforced:request.maxOutputTokens!==null});
   return {data:request.schema.parse(value),provider:"fake",model:"luna",usage:{inputTokens:10,outputTokens:10,totalTokens:20}};
  }};
  const options:ExecuteDecisionOptions={opportunity:op,mandatoryRemaining:0,validateCurrent:()=>store.journal(game.id,"p1").version===0,eventsForCommit:()=>[{type:"journal.refreshed",phase:op.phase,day:op.day,visibility:"player",audienceIds:["p1"],payload:{playerId:"p1",revision:"initial",sourceIds:[]}}],requestForAttempt:(commit,previous,repair)=>({...decisionRequestV31(packet,task,commit,previous,repair),providerKind:"decision_v3_1",schemaName:task.type,normalize:value=>normalizeV31Submission(packet,task,value as never,op.id,true),validateSubmission:value=>validateV31Submission(packet,task,value as never)})};
  expect(await new DecisionExecutorV2(repository,provider).execute(options)).toBe(false);
  expect(kinds).toEqual(["journal_update","journal_update","journal_compaction"]);
  expect(store.journal(game.id,"p1").version).toBe(0);
  expect(store.get<DecisionOpportunityV1>(game.id,`decision:${op.id}`)?.journalCompaction?.result).toBeDefined();
  repository.updateGame(game.id,{status:"running"});
  expect(await new DecisionExecutorV2(repository,provider).execute(options)).toBe(true);
  expect(kinds).toHaveLength(3);
  expect(store.journal(game.id,"p1").version).toBe(1);
  expect(estimatedTokens(store.journal(game.id,"p1"))).toBeLessThanOrEqual(200);
  expect(repository.listEvents(game.id).filter(e=>e.type==="journal.refreshed")).toHaveLength(1);
  const compacted=repository.listEvents(game.id).filter(e=>e.type==="journal.compacted");
  expect(compacted).toHaveLength(1);expect(compacted[0]).toMatchObject({visibility:"player",audienceIds:["p1"]});
  expect(auditGameV2(repository,game.id).issues).toEqual([]);
 });
});
