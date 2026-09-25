import type { DecisionOpportunityV1 } from "@werewolf/contracts";
import type { LabRepository } from "@werewolf/db";
import { contentHash } from "../context-v2";
import type { ExecuteDecisionOptions } from "../decisions-v2";
import { decisionRequestV31, normalizeV31Submission, validateV31Submission } from "../request-v3-1";
import type { V3TaskSpec } from "../request-v3";
import type { createActorHoldout } from "./actor-holdouts";

export function holdoutVote(repository: LabRepository, fixture: ReturnType<typeof createActorHoldout>): ExecuteDecisionOptions {
  const {game, packet, actor, store} = fixture;
  const opportunity: DecisionOpportunityV1 = {
    id:"post-review-vote", gameId:game.id, playerId:actor.id, kind:"vote", phase:packet.phase,
    day:packet.day, epoch:`${packet.day}:${packet.phase}`, viewId:contentHash(packet),
    baseJournalVersion:0, packet, status:"open", best:null, recovery:0,
    createdAt:new Date().toISOString(), taskType:"vote_choice",
  };
  store.save(opportunity);
  const task: V3TaskSpec = {type:"vote_choice", proposalKind:"vote"};
  return {
    opportunity, mandatoryRemaining:0, validateCurrent:()=>true,
    eventsForCommit:report=>[{
      type:"vote.cast", day:packet.day, phase:packet.phase, visibility:"player", audienceIds:[actor.id],
      payload:{vote:{voterId:actor.id,targetId:report.proposal.kind==="vote"?report.proposal.targets?.playerIds[0]??null:null}},
    }],
    requestForAttempt:(commitOnly,previous,repair)=>({
      ...decisionRequestV31(packet,task,commitOnly,previous,repair),
      schemaName:task.type, providerKind:"decision_v3_1",
      normalize:value=>normalizeV31Submission(packet,task,value as never,opportunity.id,commitOnly),
      validateSubmission:value=>validateV31Submission(packet,task,value as never),
    }),
  };
}
