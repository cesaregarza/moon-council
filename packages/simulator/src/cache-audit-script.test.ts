import {describe,expect,it} from "vitest";
import {canonicalJson,summarizeAttempts,type CacheAttempt} from "../../../scripts/cache-audit";

const attempt=(id:string,decisionId:string,cached:number,status="valid",schemaVersion="vote_v3",schema:unknown={type:"object"}):CacheAttempt=>({
  id,decisionId,status,startedAt:id,schemaVersion,usage:{inputTokens:1_000,cachedInputTokens:cached,cacheWriteInputTokens:0},request:{instructions:"stable",schema,cache:{mode:"explicit"},sharedInput:id},
});

describe("cache audit",()=>{
  it("canonicalizes object key ordering without changing array ordering",()=>{
    expect(canonicalJson({b:2,a:{d:4,c:3}})).toBe(canonicalJson({a:{c:3,d:4},b:2}));
    expect(canonicalJson([2,1])).not.toBe(canonicalJson([1,2]));
  });

  it("summarizes cache use, retry ordinals, and structural schema variants",()=>{
    const summary=summarizeAttempts([
      attempt("1","d1",0),
      attempt("2","d1",500,"invalid","vote_v3",{required:["b","a"],properties:{b:{},a:{}}}),
      attempt("3","d2",250,"valid","vote_v3",{properties:{a:{},b:{}},required:["b","a"]}),
    ]);
    expect(summary.total).toMatchObject({calls:3,inputTokens:3_000,cachedInputTokens:750,cachePercent:25,hitCalls:2,invalidCalls:1});
    expect(summary.byAttemptOrdinal).toMatchObject([{key:1,calls:2,cachedInputTokens:250},{key:2,calls:1,cachedInputTokens:500}]);
    expect(summary.prefixVariants[0]).toMatchObject({instructions:1,schemas:3,canonicalSchemas:2,cacheMetadata:1,briefings:3});
  });
  it("keeps unknown Jev cache use out of the hit-rate denominator and separates write costs",()=>{
    const summary=summarizeAttempts([
      {...attempt("1","d1",500),provider:"openai",model:"gpt-6-luna",usage:{inputTokens:1000,cachedInputTokens:500,cacheWriteInputTokens:200},providerMetadata:{cacheDiagnostics:{type:"cache_miss",reason:"input_changed"}}},
      {...attempt("2","d2",0),provider:"jev",model:"jev-latest",usage:{inputTokens:9000,cachedInputTokens:null,cacheWriteInputTokens:null}},
    ]);
    expect(summary.total).toMatchObject({inputTokens:10000,knownCacheInputTokens:1000,cachePercent:50,knownUncachedInputTokens:300,unknownCacheCalls:1,unknownWriteCalls:1,unknownBreakdownCalls:1});
    expect(summary.byProvider.find(row=>row.key==="jev:jev-latest")?.cachePercent).toBeNull();
    expect(summary.diagnostics).toEqual({"cache_miss:input_changed":1,not_reported:1});
  });

});
