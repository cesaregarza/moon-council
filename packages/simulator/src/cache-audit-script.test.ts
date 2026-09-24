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
});
