import {describe,expect,it} from "vitest";
import {validTeamPointFields} from "./audit-v2";

describe("team point audit",()=>{
 it("accepts the frozen blind/round coordination fields but rejects shared reasoning",()=>{
  expect(validTeamPointFields({playerId:"p1",targetId:"p2"})).toBe(true);
  expect(validTeamPointFields({playerId:"p1",targetId:"p2",round:0,blind:true})).toBe(true);
  expect(validTeamPointFields({playerId:"p1",targetId:"p2",round:1,blind:false})).toBe(true);
  expect(validTeamPointFields({playerId:"p1",targetId:"p2",rationale:"private reasoning"})).toBe(false);
  expect(validTeamPointFields({playerId:"p1",targetId:"p2",round:"private reasoning",blind:true})).toBe(false);
 });
});
