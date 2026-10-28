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

const today = (state: GameState, events: GameEventV1[]) =>
  events.filter((event) => event.day === state.day);

/** A completed turn: a speech, or an auction in which every bidder declined. */
const completesTurn = (event: GameEventV1) =>
  event.type === "speech.public" ||
  (event.type === "discussion.auction_resolved" && event.payload.selectedPlayerId === null);

/**
 * Where today's discussion stands: the turns completed (the post-second window's included),
 * whether they have reached the day limit (CES-1581), and whether the last turn was an all-decline
 * round of the ordinary auction, which ends the day.
 */
export function everyTurnStatus(state: GameState, events: GameEventV1[]) {
  const turns = today(state, events).filter(completesTurn);
  const limit =
    state.config.schemaVersion === "game_config_v2" ? state.config.discussion.maxDayTurns : 0;
  const last = turns.at(-1);
  return {
    round: turns.length,
    limitReached: turns.length >= (limit ?? 0),
    lastAllDeclined: last?.type === "discussion.auction_resolved" && last.payload.stage === "turn",
  };
}

/** The turns after a second before its ballot (CES-1575). */
export const WINDOW_TURNS = 3;

/** The post-second window's turns completed since the accusation was seconded. */
export function windowTurnsDone(events: GameEventV1[], secondedSequence: number): number {
  return events.filter((event) => event.sequence > secondedSequence && completesTurn(event)).length;
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

/**
 * A lynch vote passes only on a strict majority of the living: yes > living / 2. The denominator
 * is the living roster, never the ballots at hand: a missing or extra ballot is refused, so a
 * partial count can never carry the vote.
 */
export function lynchOutcome(ballots: Record<string, "yes" | "no">, livingPlayerIds: string[]) {
  const voters = Object.keys(ballots).sort();
  if (JSON.stringify(voters) !== JSON.stringify([...livingPlayerIds].sort()))
    throw new Error("lynch ballots must be exactly one per living player");
  const yes = voters.filter((voter) => ballots[voter] === "yes").length;
  const living = livingPlayerIds.length;
  return { yes, no: living - yes, living, passed: yes > living / 2 };
}
