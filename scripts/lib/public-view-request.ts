import type { GameRecord, LabRepository } from "@werewolf/db";
import type { JevRequest } from "@werewolf/llm";
import { observerPayload } from "../../apps/api/src/observer";

/**
 * Public-view Jev requests for the post-game surprise analyzer. Jev predicts as an observer
 * who sees only what public observers see at the sequence just before the decision. Building a
 * request makes no call; option maps translate Jev's handles back to player IDs (null: none).
 */
type PublicPlayer = { id: string; name: string; alive: boolean };

/**
 * observerPayload's `at` is a step through the viewer's visible events, not an event sequence.
 * Cut at the last public event recorded before the decision.
 */
function publicStepBefore(repository: LabRepository, gameId: string, decisionSequence: number) {
  const before = repository
    .listEvents(gameId)
    .filter((event) => event.visibility === "public" && event.sequence < decisionSequence);
  if (!before.length) throw new Error("No public record precedes this decision");
  return before.length - 1;
}

function publicRecord(repository: LabRepository, game: GameRecord, decisionSequence: number) {
  const at = publicStepBefore(repository, game.id, decisionSequence);
  const payload = observerPayload(repository, game, { kind: "public" }, at);
  return {
    day: payload.state.day,
    phase: payload.state.phase,
    players: payload.state.players as PublicPlayer[],
    events: payload.events,
  };
}

function request(
  model: string,
  state: ReturnType<typeof publicRecord>,
  instructions: string,
  criteria: Record<string, string>,
): JevRequest {
  return { model, state, questions: { prediction: { type: "choice", instructions, criteria } } };
}

/** A ballot, over the recorded decision's legal targets (same handles as the actor's) plus abstain. */
export function publicBallotRequest(
  repository: LabRepository,
  game: GameRecord,
  input: { actorId: string; decisionSequence: number; legalTargets: string[]; model: string },
) {
  const state = publicRecord(repository, game, input.decisionSequence);
  const name = (id: string) => state.players.find((player) => player.id === id)?.name ?? id;
  const options: Record<string, string | null> = {};
  const criteria: Record<string, string> = {};
  for (const [index, id] of input.legalTargets.entries()) {
    const handle = String.fromCharCode(97 + index);
    options[handle] = id;
    criteria[handle] = `Vote to eliminate ${name(id)} (${id}).`;
  }
  options.abstain = null;
  criteria.abstain = "Abstain from voting.";
  const instructions = `Using only this public record, predict what ${name(input.actorId)} will do in this vote.`;
  return { request: request(input.model, state, instructions, criteria), options };
}

/** A night action is private, so the public view predicts its public outcome at dawn instead. */
export function publicDawnRequest(
  repository: LabRepository,
  game: GameRecord,
  input: { decisionSequence: number; model: string },
) {
  const state = publicRecord(repository, game, input.decisionSequence);
  const options: Record<string, string | null> = {};
  const criteria: Record<string, string> = {};
  for (const [index, player] of state.players.filter((p) => p.alive).entries()) {
    const handle = String.fromCharCode(97 + index);
    options[handle] = player.id;
    criteria[handle] = `${player.name} (${player.id}) is found dead at dawn.`;
  }
  options.no_death = null;
  criteria.no_death = "No one dies tonight.";
  const instructions = "Using only this public record, predict who will be found dead at dawn.";
  return { request: request(input.model, state, instructions, criteria), options };
}
