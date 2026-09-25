import {describe,expect,it} from "vitest";
import {summarizeGameAudit,summarizeGameProgress,summarizeJournalWorkflow,type AuditAttempt,type AuditEvent,type AuditGame} from "../../../scripts/game-audit";

const game:AuditGame={id:"g",name:"audit",status:"completed",error:null,createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:10.000Z"};
const event=(sequence:number,type:string,payload:Record<string,unknown>,day=1):AuditEvent=>({sequence,type,phase:type==="game.ended"?"ended":"day_discussion",day,visibility:"moderator",payload,createdAt:`2026-01-01T00:00:${String(sequence).padStart(2,"0")}.000Z`});
const attempt=(id:string,status:string,cached:number):AuditAttempt=>({id,playerId:"p1",status,schemaVersion:"discussion_bid_v3",provider:"codex",model:"luna",reasoningEffort:"medium",latencyMs:100,usage:{inputTokens:1_000,outputTokens:100,totalTokens:1_100,cachedInputTokens:cached,reasoningTokens:50}});

describe("game audit",()=>{
  it("summarizes outcomes, auctions, private suspicion, and provider usage",()=>{
    const events=[
      event(0,"game.created",{players:[{id:"p1",name:"Ada",role:{name:"Villager",alignment:"village"}},{id:"p2",name:"Bruno",role:{name:"Werewolf",alignment:"werewolf"}}]}),
      event(1,"game.started",{}),
      event(2,"journal.v2_updated",{playerId:"p2",journal:{beliefs:[{playerId:"p1",probability:0.8}]}}),
      event(3,"discussion.auction_resolved",{stage:"opening",round:0,selectedPlayerId:"p1",scores:[{playerId:"p1",urge:0.9,listenerInterest:0.8,normalizedListenerInterest:0.7,priority:0.77},{playerId:"p2",urge:0.2,listenerInterest:0.3,normalizedListenerInterest:0.3,priority:0.21}]}),
      event(4,"discussion.speaker_selected",{playerId:"p1"}),
      event(5,"speech.public",{playerId:"p1",text:"Ben, what changed?",closing:false,acts:[{kind:"accusation",targetId:"p2"}]}),
      event(6,"vote.resolved",{ballots:[{voterId:"p1",targetId:"p2"},{voterId:"p2",targetId:"p1"}]}),
      event(7,"player.eliminated",{playerId:"p2",playerName:"Bruno",roleName:"Werewolf",cause:"vote"}),
      event(8,"game.ended",{winnerAlignments:["village"],winnerPlayerIds:["p1"],reason:"village win condition satisfied"}),
    ];
    const summary=summarizeGameAudit(game,events,[attempt("a","valid",500),attempt("b","invalid",0)]);
    expect(summary.game).toMatchObject({status:"completed",latestSequence:8,latestDay:1});
    expect(summary.discussion).toMatchObject({auctions:1,selectedSpeakers:1,publicSpeeches:1,selectedWithMaximumPrivateSuspicion:1});
    expect(summary.discussion.byPlayer[0]).toMatchObject({playerName:"Ada",auctionSelections:1,formalAccusationsReceived:0,meanPrivateSuspicionWhenSelected:0.8});
    expect(summary.discussion.transcript).toMatchObject([{sequence:5,playerId:"p1",text:"Ben, what changed?"}]);
    expect(summary.provider.invalidDetails).toMatchObject([{id:"b",error:null}]);
    expect(summary.mechanics).toMatchObject({villageVotesForWolves:1,villageVotingAccuracy:1});
    expect(summary.provider.usage).toMatchObject({cachePercent:25});
    expect(summary.provider).toMatchObject({models:{"codex:luna":2},reasoningEfforts:{medium:2}});
    expect(summary.provider.latency).toMatchObject({medianMs:100,p95Ms:100});
    const progress=summarizeGameProgress(summary);
    expect(progress).toMatchObject({game:{status:"completed"},speeches:1,provider:{attempts:2,knownTokens:2200}});
    expect(progress).not.toHaveProperty("roster");
    expect(progress).not.toHaveProperty("discussion.auctionDetails");
    expect(summary.provider.byDayPhase).toEqual([{day:null,phase:"unknown",attempts:2,valid:1,invalid:1,inputTokens:2_000,outputTokens:200,cachedInputTokens:500,cachePercent:25,medianLatencyMs:100}]);
  });

  it("separates reasoning efforts and includes timeouts without inventing their usage",()=>{
    const timedOut={...attempt("timeout","unknown",0),reasoningEffort:"low",latencyMs:120_000,error:"request timeout",usage:{inputTokens:null,outputTokens:null,totalTokens:null,cachedInputTokens:null,reasoningTokens:null}};
    const summary=summarizeGameAudit(game,[],[{...attempt("high","valid",0),reasoningEffort:"xhigh",latencyMs:1000},{...attempt("low","valid",0),reasoningEffort:"low",latencyMs:200},timedOut]);
    expect(summary.provider.byTask[0]!.byEffort).toMatchObject([
      {reasoningEffort:"low",attempts:2,valid:1,unknown:1,medianLatencyMs:60_100,outputTokens:{knownTotal:100,unknownAttempts:1}},
      {reasoningEffort:"xhigh",attempts:1,valid:1,unknown:0,medianLatencyMs:1000},
    ]);
    expect(summarizeGameProgress(summary).recentFailures).toMatchObject([{id:"timeout",status:"unknown",reasoningEffort:"low",latencyMs:120_000,error:"request timeout"}]);
  });

  it("keeps absent usage and sparse private beliefs explicit",()=>{
    const events=[event(0,"game.created",{players:[{id:"p1",name:"Ada",role:{name:"Villager",alignment:"village"}}]}),event(1,"game.started",{})];
    const summary=summarizeGameAudit({...game,status:"running"},events,[{...attempt("a","started",0),latencyMs:null,usage:{inputTokens:null,outputTokens:null,totalTokens:null,cachedInputTokens:null,reasoningTokens:null}}]);
    expect(summary.game.ending).toBeNull();
    expect(summary.provider.usage.inputTokens).toEqual({knownTotal:0,unknownAttempts:1});
    expect(summary.provider.latency.medianMs).toBeNull();
  });
});


describe("journal workflow audit",()=>{
  const roster=event(0,"game.created",{players:[{id:"p1",name:"Ada",role:{name:"Villager",alignment:"village"}},{id:"p2",name:"Ben",role:{name:"Werewolf",alignment:"werewolf"}}]});
  const speech={...event(1,"speech.public",{playerId:"p1",text:"A statement"}),id:"speech-1"};
  const reflected=(sequence:number,playerId:string,sourceIds=["speech-1"])=>event(sequence,"journal.refreshed",{playerId,sourceIds});
  const start=event(4,"model.attempt_started",{attemptId:"jev-1"});
  const jev={...attempt("jev-1","valid",0),provider:"jev",model:"jev-1"};
  it("requires all living players to have read the specific speech before Jev starts",()=>{
    const complete=summarizeJournalWorkflow([roster,speech,reflected(2,"p1"),reflected(3,"p2"),start],[jev]);
    expect(complete).toMatchObject({observed:true,reflections:2,verifiedSpeeches:1,gaps:[]});
    const stale=summarizeJournalWorkflow([roster,speech,reflected(2,"p1"),reflected(3,"p2",["older-speech"]),start,reflected(5,"p2")],[jev]);
    expect(stale.gaps).toHaveLength(1);
    expect(stale.gaps[0]).toMatchObject({missingPlayerIds:["p2"],nextJevSequence:4});
  });
  it("recognizes v4 review watermarks while retaining legacy source-ID coverage",()=>{
    const watermark=(sequence:number,playerId:string,reviewedThroughSequence:number)=>event(sequence,"journal.refreshed",{playerId,reviewedThroughSequence});
    const complete=summarizeJournalWorkflow([roster,speech,watermark(2,"p1",1),watermark(3,"p2",1),start],[jev]);
    expect(complete).toMatchObject({verifiedSpeeches:1,gaps:[]});
    const mixed=summarizeJournalWorkflow([roster,speech,reflected(2,"p1"),watermark(3,"p2",1),start],[jev]);
    expect(mixed).toMatchObject({verifiedSpeeches:1,gaps:[]});
    for(const reviewedThroughSequence of [0,3,Infinity,1.5]){
      const invalid=summarizeJournalWorkflow([roster,speech,watermark(2,"p1",1),watermark(3,"p2",reviewedThroughSequence),start],[jev]);
      expect(invalid.gaps[0]).toMatchObject({missingPlayerIds:["p2"]});
    }
    const late=summarizeJournalWorkflow([roster,speech,watermark(2,"p1",1),start,watermark(5,"p2",1)],[jev]);
    expect(late.gaps[0]).toMatchObject({missingPlayerIds:["p2"]});
  });
  it("counts free-form writes separately from archived listening-note operations",()=>{
    const summary=summarizeJournalWorkflow([event(0,"journal.v2_updated",{patch:[{op:"write_text",mode:"append",text:"A useful note."}]})],[]);
    expect(summary).toMatchObject({proseUpdates:1,attentionUpdates:0});
  });
  it("does not treat an in-progress reflection batch as a violation",()=>{
    const summary=summarizeJournalWorkflow([roster,speech,reflected(2,"p1")],[]);
    expect(summary).toMatchObject({pendingSpeeches:1,verifiedSpeeches:0,gaps:[]});
  });
  it("excludes players eliminated before the next decision and distinguishes legacy evidence",()=>{
    const summary=summarizeJournalWorkflow([roster,speech,reflected(2,"p1"),event(3,"player.eliminated",{playerId:"p2"}),start],[jev]);
    expect(summary.checks[0]).toMatchObject({expectedPlayers:1,status:"verified"});
    expect(summarizeJournalWorkflow([roster,speech,start],[jev])).toMatchObject({observed:false,checks:[]});
  });
});
