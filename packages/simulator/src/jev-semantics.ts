import type { PlayerContextV2, V3TaskKind } from "@werewolf/contracts";

export interface SemanticAssessment { rule: string; applicable: boolean; issues: string[] }
/** A deliberately narrow invariant, not a general strategy oracle or confidence threshold. */
export function assessActorChoice(packet:PlayerContextV2,task:V3TaskKind|undefined,choice:string|null):SemanticAssessment {
  const result:SemanticAssessment={rule:"verified_last_wolf_ballot_v1",applicable:false,issues:[]};
  const role=packet.self.role,predicate=role.winCondition.predicate;
  if(task!=="vote_choice"||!role.winCondition.terminal||predicate.kind!=="alignment_eliminated"||predicate.alignment!=="werewolf"||role.passives.voteWeight<=0)return result;
  // The public role deck plus publicly revealed deaths must prove exactly one wolf remains.
  const catalog=packet.rules.roles as {name:string;alignment:string}[]|undefined;
  const counts=packet.rules.roleCounts as Record<string,number>|undefined;
  if(!catalog||!counts)return result;
  const wolfRoles=catalog.filter(r=>r.alignment==="werewolf").map(r=>r.name);
  const starting=wolfRoles.reduce((n,name)=>n+(counts[name]??0),0);
  const dead=packet.players.filter(p=>!p.alive);
  if(dead.some(p=>!p.revealedRole)||starting-dead.filter(p=>wolfRoles.includes(p.revealedRole!)).length!==1)return result;
  const known=new Set(packet.sources.filter(s=>s.type==="inspection.delivered"&&s.scope==="player"&&s.data.actorId===packet.self.id&&(s.data.result==="werewolf"||wolfRoles.includes(String(s.data.result)))).map(s=>s.data.targetId).filter((id):id is string=>typeof id==="string"&&packet.legalTargets.includes(id)));
  if(known.size!==1)return result;
  const target=[...known][0]!,handle=String.fromCharCode(97+packet.legalTargets.indexOf(target));
  result.applicable=true;
  if(choice!==handle)result.issues.push(`Your own verified inspection identifies ${target} as the sole remaining werewolf. Eliminating all werewolves is your terminal win condition and voting for ${target} is legal. This ballot instead ${choice==="abstain"?"abstains":"targets someone else"}. Reconsider using your private knowledge, even if it is not publicly known.`);
  return result;
}
