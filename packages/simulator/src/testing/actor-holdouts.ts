import { emptyJournalV2, type PlayerContextV2 } from "@werewolf/contracts";
import { DecisionStore, type LabRepository } from "@werewolf/db";
import { createGameCreatedEvent, createGameState, reduceGame, type EngineEventInput } from "@werewolf/engine";
import { buildContextV2 } from "../context-v2";
import { journalEvidenceRevision } from "../player-brief";
import { actorConfig } from "./actor-fixtures";

// Authored after the 27e0161 prompt freeze. No prompt tuning on these outcomes.
export const HOLDOUT_LABELS = ["uncertain-last-wolf", "cleared-target-preference", "no-preference", "doubt-dominated"] as const;
export type HoldoutLabel = typeof HOLDOUT_LABELS[number];

/** Real reducer state, coherent role counts and private results; synthetic data only. */
export function createActorHoldout(repository: LabRepository, label: HoldoutLabel, workflow: "journal_v3" | "journal_v4" = "journal_v4", maxCalls = 3) {
  const config = actorConfig();
  config.decisionEngine.workflow = workflow;
  config.deliberation.maxCalls = maxCalls;
  const game = repository.createGame(config);
  const initial = createGameState(game.id, config);
  const actor = initial.players.find(player => player.role.id === "seer")!;
  const wolves = initial.players.filter(player => player.role.alignment === "werewolf");
  const target = wolves[0]!;
  const cleared = initial.players.find(player => player.role.id === "villager")!;
  const endgame = label !== "cleared-target-preference";
  const inputs: EngineEventInput[] = [createGameCreatedEvent(initial)];
  if (endgame) inputs.push({type:"player.eliminated", day:1, phase:"day_resolution", visibility:"public", payload:{playerId:wolves[1]!.id, playerName:wolves[1]!.name, cause:"vote"}});
  const inspected = endgame ? target : cleared;
  inputs.push({type:"inspection.delivered", day:1, phase:"night_resolution", visibility:"player", audienceIds:[actor.id], payload:{actorId:actor.id, targetId:inspected.id, targetName:inspected.name, result:inspected.role.alignment}});
  const doubts = [
    `We cannot establish that ${target.name} is a wolf from public speeches. We should demand proof.`,
    `A mistaken execution would be costly. I prefer waiting rather than trusting someone's private claim.`,
    `I still doubt the accusation against ${target.name}. An abstention keeps our options open.`,
  ];
  for (const [index, text] of doubts.entries()) inputs.push({type:"speech.public", day:2, phase:"day_discussion", visibility:"public", payload:{playerId:initial.players.filter(player=>player.id!==actor.id&&player.id!==wolves[1]!.id)[index]!.id, text, acts:[], respondsTo:[]}});
  inputs.push({type:"phase.changed", day:2, phase:"day_vote", visibility:"public", payload:{from:"day_discussion",to:"day_vote"}});
  repository.appendEvents(game.id, inputs);
  const events = repository.listEvents(game.id);
  const state = reduceGame(game.id, events);
  const actions: Record<HoldoutLabel,string> = {
    "uncertain-last-wolf": `I lean toward abstaining. Public doubt about ${target.name} is strong and I worry that voting without public consensus may be rash. My private inspection reported ${target.name} werewolf, but I am treating the lack of public corroboration as a reason to wait.`,
    "cleared-target-preference": `I prefer voting to eliminate ${cleared.name} (${cleared.id}). Their hesitant speech felt evasive and a vote could expose the group dynamics. I inspected them village last night, but their style still bothers me. There are two wolves alive; this would not be a terminal vote.`,
    "no-preference": `I have not chosen a vote or ranked any candidate. I distinguish my own inspection from public guesses. My role is Seer and my goal is to eliminate the wolves. I leave the immediate ballot decision open.`,
    "doubt-dominated": `${doubts.join(" ")} ${doubts.join(" ")} I fear making a public mistake. An isolated claim can damage credibility, and several players oppose a rushed vote. I am inclined to abstain until the group agrees. My own inspection returned ${target.name} (${target.id}) werewolf. ${doubts.join(" ")} I keep returning to the risk of acting too early.`,
  };
  const packet = buildContextV2(state, events, actor.id, emptyJournalV2(), "post-review-vote", "vote");
  const action = actions[label];
  const attention = `Hear ${target.name}'s response to the accusation. The other speakers are repeating public doubt; I have private evidence that could add information.`;
  const revision = journalEvidenceRevision(packet.sources);
  if (workflow === "journal_v4") packet.rules.journalRevision = revision;
  packet.journal = {...packet.journal, text:`Day 1: I kept my identity private. Day 2: ${action}\nListening: ${attention}`, decisionBrief:{playerId:actor.id, evidenceRevision:revision, action, attention}};
  const store = new DecisionStore(repository);
  repository.updateGame(game.id,{status:"running"});
  return {game, config, actor, target, cleared, packet, store, inputs,
    rubric: endgame ? "Vote for the privately verified last wolf despite an uncertain or neutral preference." : "Do not execute the actor-cleared villager merely because the brief prefers it; no unique alternative is required.",
    expectedTarget: endgame ? target.id : undefined,
    forbiddenTarget: endgame ? undefined : cleared.id};
}

export function handleTarget(packet: PlayerContextV2, handle: string | undefined) {
  return handle === "abstain" ? null : handle?.length === 1 ? packet.legalTargets[handle.charCodeAt(0)-97] : undefined;
}
