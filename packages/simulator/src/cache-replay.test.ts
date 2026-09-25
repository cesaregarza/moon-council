import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { GameConfigV2Schema, emptyJournalV2, unknownUsage } from "@werewolf/contracts";
import { DOCTOR_V2, STARTER_ROLES, createGameState } from "@werewolf/engine";
import { buildContextV2 } from "./context-v2";
import { decisionRequestV31 } from "./request-v3-1";
import { archivedCacheCases, cacheReceiptSummary, prefixComparison } from "./cache-replay";

const directories:string[]=[];
afterEach(()=>{for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),"cache-replay-test-"));directories.push(directory);
  const path=join(directory,"test.db"),db=new Database(path);
  db.exec("CREATE TABLE provider_attempts(game_id TEXT,id TEXT,value_json TEXT); CREATE TABLE agent_records(game_id TEXT,record_key TEXT,value_json TEXT)");
  const roleIds=["werewolf","werewolf","seer","doctor","villager","villager","villager","villager"];
  const seats=roleIds.map((_,i)=>({id:`p${i}`,name:`P${i}`}));
  const config=GameConfigV2Schema.parse({schemaVersion:"game_config_v2",protocolVersion:"agent_v3_1",name:"fixture",seed:"cache",seats,roleDeck:roleIds.map(id=>id==="doctor"?DOCTOR_V2:STARTER_ROLES.find(r=>r.id===id)),modelSettings:Object.fromEntries(seats.map(s=>[s.id,{provider:"codex",model:"gpt-6-luna"}])),decisionEngine:{mode:"jev",workflow:"journal_v2"},discussion:{speakerSelection:"listener_auction"}});
  const state=createGameState("game",config),packet=buildContextV2(state,[],"p0",emptyJournalV2(),"fixture","discussion");
  const prepared=decisionRequestV31(packet,{type:"journal_update",sourceIds:[],revision:"one"},true,null,null);
  const attempt={id:"attempt",decisionId:"decision",playerId:"p0",provider:"codex",status:"valid",model:"gpt-6-luna",reasoningEffort:"xhigh",request:{...prepared.prompt,schema:prepared.jsonSchema}};
  db.prepare("INSERT INTO provider_attempts VALUES(?,?,?)").run("game","attempt",JSON.stringify(attempt));
  db.prepare("INSERT INTO agent_records VALUES(?,?,?)").run("game","decision:decision",JSON.stringify({id:"decision",packet}));db.close();
  return {path,attempt};
}

describe("recorded cache replay",()=>{
  it("keeps the exact source prompt/model/effort, uses the stable API envelope, and leaves the source unchanged",()=>{
    const {path,attempt}=fixture();
    const before=new Database(path,{readonly:true});const count=before.prepare("SELECT count(*) AS n FROM provider_attempts").get();before.close();
    const [entry]=archivedCacheCases(path,"game",["attempt"]);
    expect(entry!.request.preparedPrompt).toEqual(attempt.request);
    expect(entry!.request).toMatchObject({model:"gpt-6-luna",reasoningEffort:"xhigh",schemaName:"journal_update",apiResponseFormat:{name:"moon_council_reflection_speech_v1"}});
    const after=new Database(path,{readonly:true});expect(after.prepare("SELECT count(*) AS n FROM provider_attempts").get()).toEqual(count);after.close();
    expect(()=>archivedCacheCases(path,"other-game",["attempt"])).toThrow("Attempt not found");
  });
  it("rejects archive/schema drift instead of silently changing the replay",()=>{
    const {path,attempt}=fixture();const db=new Database(path);
    db.prepare("UPDATE provider_attempts SET value_json=?").run(JSON.stringify({...attempt,request:{...attempt.request,schema:{type:"object",properties:{}}}}));db.close();
    expect(()=>archivedCacheCases(path,"game",["attempt"])).toThrow("Archived schema differs");
  });
  it("distinguishes shared messages from incompatible schema settings",()=>{
    const a={input:[{role:"developer",content:"same"}],text:{name:"journal"},reasoning:{effort:"xhigh"}};
    expect(prefixComparison(a,{...a,text:{name:"speech"}})).toMatchObject({equalLeadingMessages:1,schemaEqual:false,reasoningEqual:true});
  });
  it("accounts for read/write/input categories once, and does not turn missing usage into zero cost",()=>{
    const usage={...unknownUsage(),inputTokens:1000,outputTokens:100,cachedInputTokens:500,cacheWriteInputTokens:200};
    expect(cacheReceiptSummary([{usage,latencyMs:10}])).toMatchObject({cacheReadFraction:0.5,inputRateEquivalentTokens:600});
    expect(cacheReceiptSummary([{latencyMs:10}]).inputRateEquivalentTokens).toBeNull();
  });
});
