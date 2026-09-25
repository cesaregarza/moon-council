import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AskJevProvider, FakeDecisionProvider } from "@werewolf/llm";
import { LabRepository, openDatabase } from "@werewolf/db";
import { DecisionExecutorV2 } from "@werewolf/simulator";
import { createActorHoldout } from "../../../packages/simulator/src/testing/actor-holdouts";
import { holdoutVote } from "../../../packages/simulator/src/testing/actor-execution";
import { buildApi } from "./app";

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{while(cleanups.length)await cleanups.pop()!();});
async function paused(repository:LabRepository) {
  const fixture=createActorHoldout(repository,"uncertain-last-wolf"),options=holdoutVote(repository,fixture);
  let calls=0;
  const provider=new AskJevProvider(async input=>{
    calls++;
    const request=JSON.parse(input),keys=Object.keys(request.questions.target.criteria);
    return JSON.stringify({model:"synthetic",usage:{input_tokens:1,output_tokens:1},answers:{target:{type:"choice",choice:"abstain",confidence:1,probabilities:Object.fromEntries(keys.map(key=>[key,Number(key==="abstain")]))}}});
  });
  await expect(new DecisionExecutorV2(repository,new FakeDecisionProvider(),provider).execute(options)).rejects.toThrow("one reconsideration");
  repository.updateGame(fixture.game.id,{status:"paused"});
  return {...fixture,decisionId:options.opportunity.id,calls:()=>calls};
}
describe("operator semantic acknowledgment",()=>{
  it("validates the API action, commits the recorded abstention, and requires a separate resume",async()=>{
    const built=await buildApi({databaseUrl:":memory:"});cleanups.push(()=>built.app.close());
    const fixture=await paused(built.repository),url=`/api/v1/games/${fixture.game.id}/control`;
    const missing=await built.app.inject({method:"POST",url,payload:{action:"acknowledge_semantic_anomaly",decisionId:fixture.decisionId}});
    expect(missing.statusCode).toBe(400);
    const response=await built.app.inject({method:"POST",url,payload:{action:"acknowledge_semantic_anomaly",decisionId:fixture.decisionId,note:"Keep the model's recorded anomaly for this experiment"}});
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json()).toMatchObject({ok:true,status:"committed",gameStatus:"paused"});
    expect(built.repository.getGame(fixture.game.id)?.status).toBe("paused");
    expect(fixture.calls()).toBe(2);
    expect(built.repository.listEvents(fixture.game.id).filter(event=>event.type==="vote.cast").map(event=>event.payload.vote)).toEqual([{voterId:fixture.actor.id,targetId:null}]);
  });
  it("supports the documented pilot flag without credentials or a new provider call",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"moon-council-ack-"));cleanups.push(()=>rm(directory,{recursive:true,force:true}));
    const path=join(directory,"game.db"),db=openDatabase(path),repository=new LabRepository(db);
    const fixture=await paused(repository);db.close();
    const root=fileURLToPath(new URL("../../../",import.meta.url));
    const script=fileURLToPath(new URL("../../../scripts/pilot.ts",import.meta.url));
    const output=execFileSync(process.execPath,["--import","tsx",script,"--db",path,"--game",fixture.game.id,"--acknowledge-semantic",fixture.decisionId,"--operator-note","Reviewed the final model receipt"],{cwd:root,encoding:"utf8",timeout:20000,env:{PATH:process.env.PATH,LLM_PROVIDER:"fake"}});
    expect(JSON.parse(output)).toMatchObject({status:"committed",gameStatus:"paused"});
    const reopened=openDatabase(path);
    try {expect(new LabRepository(reopened).getGame(fixture.game.id)?.status).toBe("paused");} finally {reopened.close();}
  });
});
