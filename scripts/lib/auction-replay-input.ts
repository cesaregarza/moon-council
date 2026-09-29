import { z } from "zod";
import { SpeakerIntentV1Schema } from "@werewolf/contracts";
import { rankSpeakerAuction } from "../../packages/simulator/src/speaker-auction";
import { winner } from "./auction-replay";

const ids = z.array(z.string().min(1));
const bid = z.object({ playerId: z.string().min(1), intent: SpeakerIntentV1Schema });
const score = z.object({
  playerId: z.string(),
  urge: z.number(),
  listenerInterest: z.number(),
  normalizedListenerInterest: z.number(),
  priority: z.number(),
});
const auction = z.object({
  turn: z.number().int().positive(),
  candidates: ids,
  tieOrder: ids,
  original: z.array(bid),
  effective: z.array(bid),
  scores: z.array(score),
  selected: z.string().nullable(),
  unforcedWinner: z.string().nullable(),
});
const checkpoint = z.object({
  run: z.object({ id: z.string(), targetId: z.string(), obstructerId: z.string().optional() }),
  status: z.enum(["running", "complete", "failed"]),
  players: z.array(z.object({ id: z.string().min(1) })),
  auctions: z.array(auction),
});
export type ReplayInput = z.infer<typeof checkpoint>;
function sameIds(actual: string[], expected: string[]) {
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some((id) => !expected.includes(id))
  )
    throw new Error("Auction IDs do not match");
}
function checkBids(bids: z.infer<typeof bid>[], players: string[]) {
  sameIds(
    bids.map((b) => b.playerId),
    players,
  );
  for (const b of bids)
    sameIds(
      b.intent.willingnessToListen.map((r) => r.playerId),
      players.filter((id) => id !== b.playerId),
    );
}
function checkScores(a: z.infer<typeof auction>, bias: number) {
  const calculated = rankSpeakerAuction(a.candidates, a.effective, bias, a.tieOrder);
  if (calculated.length !== a.scores.length) throw new Error("Recorded score count mismatch");
  for (const [i, actual] of calculated.entries()) {
    const saved = a.scores[i]!;
    if (
      actual.playerId !== saved.playerId ||
      (["urge", "listenerInterest", "normalizedListenerInterest", "priority"] as const).some(
        (key) => Math.abs(actual[key] - saved[key]) > 1e-10,
      )
    )
      throw new Error("Recorded auction score mismatch");
  }
  if (
    (calculated[0]?.playerId ?? null) !== a.selected ||
    winner(a, a.original, bias) !== a.unforcedWinner
  )
    throw new Error("Recorded auction winner mismatch");
}

/** Project away journals/evidence and reject corrupt inputs before any counterfactual output. */
export function parseReplayInput(value: unknown, bias: number): ReplayInput {
  if (!Number.isFinite(bias) || bias < 0) throw new Error("Invalid auction bias");
  const state = checkpoint.parse(value);
  const players = state.players.map((p) => p.id);
  sameIds(players, players);
  if (
    players.length !== 4 ||
    !players.includes(state.run.targetId) ||
    (state.run.obstructerId && !players.includes(state.run.obstructerId))
  )
    throw new Error("Expected four study players");
  let previous: string | null = null;
  for (const [i, a] of state.auctions.entries()) {
    if (a.turn !== i + 1) throw new Error("Noncontiguous auction turns");
    sameIds(
      a.candidates,
      players.filter((id) => id !== previous),
    );
    sameIds(a.tieOrder, a.candidates);
    checkBids(a.original, players);
    checkBids(a.effective, players);
    checkScores(a, bias);
    previous = a.selected ?? previous;
  }
  return state;
}
