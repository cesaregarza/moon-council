import { describe,it,expect } from "vitest";
import { inspectResearchBundle } from "./audit-bundle-v2";

const attempt={id:"a",status:"valid",optional:false,latencyMs:10,model:"fixture",reasoningEffort:"high",usage:{inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:80,reasoningTokens:null}};
const event={id:"e",day:2,phase:"day_discussion",type:"journal.v2_updated",payload:{playerId:"actor",patch:[{op:"set_strategy",strategy:"Zoë supported René."}]}};
const bundle={schemaVersion:"werewolf_research_bundle_v2",attempts:[attempt],events:[event]};
describe("offline bundle inspection",()=>{
  it("keeps component usage separate, unknowns explicit, and attempts unique",()=>{
    const result=inspectResearchBundle({...bundle,attempts:[attempt,attempt,{...attempt,id:"b",status:"invalid",optional:true,latencyMs:30,usage:{}}]});
    expect(result.attempts).toBe(2);expect(result.latency.medianMs).toBe(20);expect(result.latency.optionalMs).toBe(30);
    expect(result.usage.totalTokens).toEqual({knownTotal:120,unknownAttempts:1});expect(result.usage.reasoningTokens?.unknownAttempts).toBe(2);
  });
  it("matches literal Unicode text, selects day and preserves source IDs",()=>{
    expect(inspectResearchBundle(bundle,{matches:["ZOË"],day:2}).records[0]?.eventId).toBe("e");
    expect(inspectResearchBundle(bundle,{matches:[".*"]}).matchedRecords).toBe(0);
    expect(inspectResearchBundle(bundle,{matches:["Zoë"],day:1}).matchedRecords).toBe(0);
    expect(inspectResearchBundle(bundle,{matches:["Zoë"],offset:1}).records).toEqual([]);
  });
  it("does not emit private records without an explicit search",()=>expect(inspectResearchBundle(bundle).records).toEqual([]));
  it("accepts V3 bundles and searches the small submitted response",()=>{
    const v3={...bundle,schemaVersion:"werewolf_research_bundle_v3",events:[{...event,type:"decision.reported",payload:{playerId:"actor",decisionId:"d",taskType:"vote_choice",submission:{rationale:"René's vote was inconsistent."},report:{summary:"app record",journalPatch:[]},continuation:"committed_by_player"}}]};
    expect(inspectResearchBundle(v3,{matches:["inconsistent"]}).records[0]).toMatchObject({decisionId:"d",content:{taskType:"vote_choice"}});
  });
  it("rejects malformed input and invalid filters",()=>{
    expect(()=>inspectResearchBundle({})).toThrow();expect(()=>inspectResearchBundle(bundle,{matches:[""]})).toThrow();expect(()=>inspectResearchBundle(bundle,{limit:0})).toThrow();
  });
});
