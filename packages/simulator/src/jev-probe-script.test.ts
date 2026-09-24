import { expect, it, vi } from "vitest";
import { parseProbeCases, describeProbeCase, evaluateProbeCase } from "../../../scripts/jev-probe";
const fixture=()=>({label:"synthetic",request:{model:"jev-test",state:{journal:"Known result: Zoë is a wolf.\nVote Zoë."},questions:{target:{type:"choice" as const,instructions:"Select a ballot",criteria:{a:"Vote Zoë",abstain:"Abstain"}}}}});
it("rejects ambiguous labels and malformed question sets before live calls",()=>{
  for(const value of [[],[fixture(),fixture()],[{...fixture(),label:"../escape"}],[{...fixture(),request:{...fixture().request,questions:{}}}]]) expect(()=>parseProbeCases(value)).toThrow();
});
it("preserves Unicode context and matches the exact choice mapping",async()=>{
  const row=parseProbeCases([fixture()])[0]!;
  expect(describeProbeCase(row).stateFieldBytes?.journal).toBe(Buffer.byteLength(fixture().request.state.journal));
  const run=vi.fn(async(_input:string)=>JSON.stringify({model:"jev-test",answers:{target:{type:"choice",choice:"a",probabilities:{a:0.9,abstain:0.1},confidence:0.8}}}));
  const result=await evaluateProbeCase(row,run);
  expect(JSON.parse(run.mock.calls[0]![0] as string)).toEqual(fixture().request);
  expect(result.error).toBeNull();
  expect(result.response?.answers.target).toMatchObject({choice:"a"});
});
it("retains malformed raw responses and never retries transport failures",async()=>{
  const row=parseProbeCases([fixture()])[0]!;
  expect(await evaluateProbeCase(row,async()=>'{bad')).toMatchObject({raw:'{bad',response:null,error:expect.any(String)});
  const run=vi.fn(async()=>{throw new Error("offline");});
  await expect(evaluateProbeCase(row,run)).rejects.toThrow("offline");
  expect(run).toHaveBeenCalledTimes(1);
});
