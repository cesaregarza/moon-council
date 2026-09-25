import { GameConfigV2Schema, emptyJournalV2, type PlayerContextV2, type V3TaskKind } from "@werewolf/contracts";
import { createGameState, DOCTOR_V2, STARTER_ROLES } from "@werewolf/engine";
import { buildContextV2 } from "../context-v2";
import { journalEvidenceRevision } from "../player-brief";

/** Synthetic fixtures only; never load real game exports or credentials. */
export function actorConfig() {
  const roles=["werewolf","werewolf","seer","doctor","villager","villager","villager","villager"];
  const seats=roles.map((_,i)=>({id:`p${i+1}`,name:["Arden","Briar","Cato","Delta","Ember","Finch","Gale","Hollis"][i]!}));
  return GameConfigV2Schema.parse({schemaVersion:"game_config_v2",protocolVersion:"agent_v3_2",name:"Synthetic actor evaluation",seed:"actor-fixture",seats,roleDeck:roles.map(id=>id==="doctor"?DOCTOR_V2:STARTER_ROLES.find(r=>r.id===id)),modelSettings:Object.fromEntries(seats.map(s=>[s.id,{provider:"fake",model:"fake",reasoningEffort:"low"}])),decisionEngine:{mode:"jev",workflow:"journal_v4"},discussion:{speakerSelection:"listener_auction"},deliberation:{maxJournalTokens:16000,maxContextTokens:32000},safety:{maxModelCalls:500,maxWallClockMs:60000}});
}
export function actorPacket(roleId="seer",actorId="p1"):PlayerContextV2 {
  const state=createGameState("synthetic-actor",actorConfig());state.phase="day_vote";state.day=3;
  state.players.find(p=>p.id===actorId)!.role=structuredClone(roleId==="doctor"?DOCTOR_V2:STARTER_ROLES.find(r=>r.id===roleId)!);
  const packet=buildContextV2(state,[],actorId,emptyJournalV2(),"synthetic","vote");
  packet.players=actorConfig().seats.map(p=>({...p,alive:p.id!=="p8",...(p.id==="p8"?{revealedRole:"Werewolf"}:{})}));
  packet.legalTargets=packet.players.filter(p=>p.alive&&p.id!==actorId).map(p=>p.id);
  packet.sources.push({id:"own-inspection",type:"inspection.delivered",scope:"player",day:2,data:{actorId,targetId:"p3",targetName:"Cato",result:"werewolf"}});
  refreshFixtureBrief(packet);
  return packet;
}
export function refreshFixtureBrief(packet:PlayerContextV2,action="My own inspection identified Cato (p3) as a werewolf. Hollis died and was publicly revealed Werewolf; Cato is the last wolf. Voting to eliminate Cato wins for my village. I have kept this result private; that does not weaken my knowledge.",attention="I want to hear Delta answer Briar's accusation; a defense matters even from a suspect. I have new private evidence and should speak soon.") {
  const revision=journalEvidenceRevision(packet.sources);
  packet.rules.journalRevision=revision;
  packet.journal={...packet.journal,text:"Earlier public discussion contained uncertain accusations. I distinguish public claims from my own knowledge. ".repeat(80)+"\nCurrent assessment: "+action+"\nListening: "+attention,decisionBrief:{playerId:packet.self.id,evidenceRevision:revision,action,attention}};
  return packet;
}
export interface ActorFixture { label:string;packet:PlayerContextV2;task:V3TaskKind;expectedTarget?:string|null;rubric:string }
export function actorFixtures():ActorFixture[] {
  const certain=actorPacket();
  const other=actorPacket("seer","p4");other.self.name="Iris";other.players.find(p=>p.id==="p3")!.name="Juniper";
  refreshFixtureBrief(other,"My verified result says Juniper (p3) is the only remaining wolf. Eliminating them satisfies my own terminal objective, even though nobody else knows my result.");
  const uncertain=actorPacket("villager");uncertain.sources=[];
  refreshFixtureBrief(uncertain,"Day 1: no claims or results distinguish the candidates. Abstaining avoids an arbitrary elimination; I currently prefer abstention but have no certainty.");
  const wolf=actorPacket("werewolf");wolf.sources=[];wolf.knownAllies=[{id:"p3",name:"Cato"}];
  wolf.players.find(p=>p.id==="p8")!.revealedRole="Villager";
  refreshFixtureBrief(wolf,"Cato is my known pack ally. We are both unexposed. Briar (p2) is credibly suspected and is not in our pack. Eliminating Briar brings us closer to parity but does not yet win. Voting for Briar is my current plan; exposing Cato would sacrifice our advantage.");
  const protector=actorPacket("doctor");protector.sources=[];protector.phase="night_actions";protector.legalTargets=["p2","p3","p4"];protector.legalActions=[{actionId:"protect_player",min:1,max:1,targets:[...protector.legalTargets]}];
  refreshFixtureBrief(protector,"Briar (p2) is the claimed Seer who gave the confirmed result on yesterday's eliminated wolf. They are the likely pack target tonight. Protecting Briar is my strongest available defensive action; the other candidates have no special claim.");
  const pack=actorPacket("werewolf");pack.sources=[];pack.phase="night_actions";pack.knownAllies=[{id:"p4",name:"Delta"}];pack.legalTargets=["p2","p3","p5"];pack.legalActions=[{actionId:"pack_kill",min:1,max:1,targets:[...pack.legalTargets]}];
  pack.players.find(p=>p.id==="p8")!.revealedRole="Villager";
  pack.sources.push({id:"pack-point",type:"team.point",scope:"team",day:3,data:{playerId:"p4",targetId:"p2"}});
  refreshFixtureBrief(pack,"Briar (p2) is an exposed Seer and is the strongest kill. Delta and I discussed no alternatives; their current point at Briar is visible. Agreeing now secures our attack; changing targets risks a failed consensus.");
  const inspector=actorPacket("seer");inspector.sources=[];inspector.phase="night_actions";inspector.legalTargets=["p2","p3","p4"];inspector.legalActions=[{actionId:"divine_alignment",min:1,max:1,targets:[...inspector.legalTargets]}];
  inspector.sources.push(...["p2","p3"].map((targetId,index)=>({id:`clear-${targetId}`,type:"inspection.delivered",scope:"player" as const,day:index+1,data:{actorId:inspector.self.id,targetId,targetName:inspector.players.find(p=>p.id===targetId)!.name,result:"village"}})));
  refreshFixtureBrief(inspector,"Briar and Cato have already been inspected village. Delta (p4) is the untested disputed role claimant; an inspection of Delta resolves the only active dispute. Rechecking Briar or Cato provides no new information.");
  const listening=actorPacket("villager");listening.sources=[];
  refreshFixtureBrief(listening,"I have weak suspicions but no decisive result.","Delta has been directly accused and has not answered. I want to hear their defense urgently. Briar has repeated the same argument several times and dominated; little new value is expected from them. I have no new contribution myself.");
  return [
    {label:"private-certainty",packet:certain,task:"vote_choice",expectedTarget:"p3",rubric:"Uses own verified result despite absence of public proof."},
    {label:"renamed-other-seat",packet:other,task:"vote_choice",expectedTarget:"p3",rubric:"Same private-certainty decision from another seat and names."},
    {label:"legitimate-abstention",packet:uncertain,task:"vote_choice",expectedTarget:null,rubric:"Abstention remains possible when evidence is genuinely uninformative."},
    {label:"wolf-vote",packet:wolf,task:"vote_choice",expectedTarget:"p2",rubric:"Acts for the wolf's parity objective, not neutral truth adjudication."},
    {label:"protection",packet:protector,task:"night_choice",expectedTarget:"p2",rubric:"Protects the useful likely victim with legal role-specific action."},
    {label:"pack-consensus",packet:pack,task:"team_point_choice",expectedTarget:"p2",rubric:"Uses allies' current points to finish the pack's attack."},
    {label:"inspection",packet:inspector,task:"night_choice",expectedTarget:"p4",rubric:"Chooses the unresolved investigation rather than redundant known results."},
    {label:"listening-defense",packet:listening,task:"discussion_score",rubric:"Delta listening score exceeds repetitive Briar; no forced topic."},
  ];
}
