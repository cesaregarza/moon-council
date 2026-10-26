import type { GameEventV1 } from "@werewolf/contracts";
import { shuffled, type GameState } from "@werewolf/engine";

/**
 * CES-1575: the auction-every-turn discussion mode. Every turn, every living player bids or
 * declines, and the speaker auction alone picks the speaker. A speech may end by formally
 * accusing a living player; the other living players are polled on seconding it, and a seconded
 * accusation goes to a public yes/no ballot of every living player. These are the mode's pure
 * rules; the orchestrator runs the decisions and records the events.
 */
export const isEveryTurn = (config: GameState["config"]): boolean =>
  config.schemaVersion === "game_config_v2" && config.discussion.mode === "auction_every_turn";

/** Whether `text` names `name` as a whole word: the seat "Eli" is not named by "believe". */
export function namesWholeWord(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

const today = (state: GameState, events: GameEventV1[]) =>
  events.filter((event) => event.day === state.day);

/** Where today's discussion stands: turns completed, and whether the last one was all-decline. */
export function everyTurnStatus(state: GameState, events: GameEventV1[]) {
  const day = today(state, events);
  const turns = day.filter(
    (event) =>
      event.type === "speech.public" ||
      (event.type === "discussion.auction_resolved" && event.payload.selectedPlayerId === null),
  );
  const living = state.players.filter((player) => player.alive).length;
  const factor =
    state.config.schemaVersion === "game_config_v2"
      ? state.config.discussion.turnBudgetFactor
      : undefined;
  return {
    round: turns.length,
    lastAllDeclined: turns.at(-1)?.type === "discussion.auction_resolved",
    budget: Math.ceil(living * (factor ?? 0)),
  };
}

export interface Accusation {
  id: string;
  /** The accusation event's sequence number: unlike its ID, the same in every seeded replay. */
  sequence: number;
  accuserId: string;
  targetId: string;
}

/** Today's accusation awaiting its seconding or its lynch vote, if any. */
export function pendingAccusation(state: GameState, events: GameEventV1[]): Accusation | null {
  const day = today(state, events);
  const raised = day.findLast((event) => event.type === "accusation.raised");
  if (!raised) return null;
  const settled = day.some(
    (event) =>
      (event.type === "accusation.unseconded" || event.type === "lynch.resolved") &&
      event.payload.accusationId === raised.id,
  );
  return settled
    ? null
    : {
        id: raised.id,
        sequence: raised.sequence,
        accuserId: String(raised.payload.accuserId),
        targetId: String(raised.payload.targetId),
      };
}

/**
 * The seconder among several yes answers: the highest urgency, ties broken by the seeded order
 * of the sorted respondents (the same seeded shuffle the speaker auction uses).
 */
export function chooseSeconder(
  urgencies: ReadonlyMap<string, number>,
  seed: string,
  day: number,
  accusationSequence: number,
): string {
  const order = shuffled(
    [...urgencies.keys()].sort(),
    `${seed}:discussion:${day}:second:${accusationSequence}`,
  );
  return order.reduce((best, playerId) =>
    urgencies.get(playerId)! > urgencies.get(best)! ? playerId : best,
  );
}

/** A lynch vote passes only on a strict majority of the living: yes > living / 2. */
export function lynchOutcome(ballots: Record<string, "yes" | "no">) {
  const values = Object.values(ballots);
  const yes = values.filter((ballot) => ballot === "yes").length;
  return { yes, no: values.length - yes, living: values.length, passed: yes > values.length / 2 };
}
