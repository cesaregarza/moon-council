import {describe,expect,it} from "vitest";
import {summarizeGameAudit,type AuditAttempt,type AuditEvent,type AuditGame} from "../../../scripts/game-audit";

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
      event(5,"speech.public",{playerId:"p1",closing:false,acts:[{kind:"accusation",targetId:"p2"}]}),
      event(6,"vote.resolved",{ballots:[{voterId:"p1",targetId:"p2"},{voterId:"p2",targetId:"p1"}]}),
      event(7,"player.eliminated",{playerId:"p2",playerName:"Bruno",roleName:"Werewolf",cause:"vote"}),
      event(8,"game.ended",{winnerAlignments:["village"],winnerPlayerIds:["p1"],reason:"village win condition satisfied"}),
    ];
    const summary=summarizeGameAudit(game,events,[attempt("a","valid",500),attempt("b","invalid",0)]);
    expect(summary.game).toMatchObject({status:"completed",latestSequence:8,latestDay:1});
    expect(summary.discussion).toMatchObject({auctions:1,selectedSpeakers:1,publicSpeeches:1,selectedWithMaximumPrivateSuspicion:1});
    expect(summary.discussion.byPlayer[0]).toMatchObject({playerName:"Ada",auctionSelections:1,formalAccusationsReceived:0,meanPrivateSuspicionWhenSelected:0.8});
    expect(summary.mechanics).toMatchObject({villageVotesForWolves:1,villageVotingAccuracy:1});
    expect(summary.provider.usage).toMatchObject({cachePercent:25});
    expect(summary.provider).toMatchObject({models:{"codex:luna":2},reasoningEfforts:{medium:2}});
    expect(summary.provider.latency).toMatchObject({medianMs:100,p95Ms:100});
    expect(summary.provider.byDayPhase).toEqual([{day:null,phase:"unknown",attempts:2,valid:1,invalid:1,inputTokens:2_000,outputTokens:200,cachedInputTokens:500,cachePercent:25,medianLatencyMs:100}]);
  });

  it("keeps absent usage and sparse private beliefs explicit",()=>{
    const events=[event(0,"game.created",{players:[{id:"p1",name:"Ada",role:{name:"Villager",alignment:"village"}}]}),event(1,"game.started",{})];
    const summary=summarizeGameAudit({...game,status:"running"},events,[{...attempt("a","started",0),latencyMs:null,usage:{inputTokens:null,outputTokens:null,totalTokens:null,cachedInputTokens:null,reasoningTokens:null}}]);
    expect(summary.game.ending).toBeNull();
    expect(summary.provider.usage.inputTokens).toEqual({knownTotal:0,unknownAttempts:1});
    expect(summary.provider.latency.medianMs).toBeNull();
  });
});
