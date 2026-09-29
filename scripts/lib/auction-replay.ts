import {
  rankSpeakerAuction,
  type SpeakerAuctionBid,
} from "../../packages/simulator/src/speaker-auction";

export const BID_INTERVENTIONS = [
  "urge_only",
  "max_urgency",
  "zero_rival_ratings",
  "max_and_zero",
] as const;
export type BidIntervention = (typeof BID_INTERVENTIONS)[number];
export interface AuctionSnapshot {
  candidates: string[];
  tieOrder: string[];
  original: SpeakerAuctionBid[];
}

/** One actor changes its own submission only. Incoming peer ratings and eligibility stay fixed. */
export function intervene(bids: SpeakerAuctionBid[], actor: string, mode: BidIntervention) {
  return bids.map((bid) => {
    if (bid.playerId !== actor) return structuredClone(bid);
    const maximize = mode !== "zero_rival_ratings";
    const suppress = mode === "zero_rival_ratings" || mode === "max_and_zero";
    return {
      playerId: actor,
      intent: {
        urge: maximize ? 1 : bid.intent.urge,
        wantsToSpeak:
          mode === "max_urgency" || mode === "max_and_zero" ? true : bid.intent.wantsToSpeak,
        willingnessToListen: bid.intent.willingnessToListen.map((rating) => ({
          ...rating,
          willingness: suppress ? 0 : rating.willingness,
        })),
      },
    };
  });
}
export function winner(snapshot: AuctionSnapshot, bids: SpeakerAuctionBid[], bias: number) {
  return (
    rankSpeakerAuction(snapshot.candidates, bids, bias, snapshot.tieOrder)[0]?.playerId ?? null
  );
}
export function replayAuction(snapshot: AuctionSnapshot, bias: number) {
  const naturalWinner = winner(snapshot, snapshot.original, bias);
  return {
    naturalWinner,
    actors: snapshot.original.map(({ playerId }) => ({
      playerId,
      eligible: snapshot.candidates.includes(playerId),
      originallyWilling: snapshot.original.find((bid) => bid.playerId === playerId)!.intent
        .wantsToSpeak,
      interventions: BID_INTERVENTIONS.map((mode) => {
        const selected = winner(snapshot, intervene(snapshot.original, playerId, mode), bias);
        return {
          mode,
          selected,
          changedWinner: selected !== naturalWinner,
          actorWins: selected === playerId,
        };
      }),
    })),
  };
}

/** Structural stress only: no speeches, journals, learning, or changing listener preferences. */
export function frozenSchedule(bids: SpeakerAuctionBid[], turns: number, bias = 0.25) {
  if (!Number.isInteger(turns) || turns < 1 || turns > 1000) throw new Error("Invalid turn count");
  const ids = bids.map((bid) => bid.playerId);
  const selected: Array<string | null> = [];
  let previous: string | null = null;
  for (let turn = 0; turn < turns; turn++) {
    const candidates = ids.filter((id) => id !== previous);
    const speaker = rankSpeakerAuction(candidates, bids, bias, ids)[0]?.playerId ?? null;
    selected.push(speaker);
    previous = speaker ?? previous;
  }
  return selected;
}

/** Synthetic ratings are experimental inputs, not claims about model beliefs or usefulness. */
export function fixtureBids(urges: number[], incoming: number[]) {
  return urges.map((urge, i) => ({
    playerId: `p${i + 1}`,
    intent: {
      urge,
      wantsToSpeak: true,
      willingnessToListen: incoming.flatMap((willingness, j) =>
        i === j ? [] : [{ playerId: `p${j + 1}`, willingness }],
      ),
    },
  }));
}
export function structuralCases() {
  const rejected = fixtureBids([1, 0.2, 0.3, 0.2], [0.05, 0.9, 0.3, 0.2]);
  const zero = fixtureBids([1, 0.2, 0.3, 0.2], [0, 0, 0, 0]);
  const fixed = fixtureBids([0.5, 0.5, 0.5, 0.5], [0.9, 0.8, 0.1, 0.05]);
  const select = (bids: SpeakerAuctionBid[]) =>
    rankSpeakerAuction(
      bids.map((b) => b.playerId),
      bids,
      0.25,
      bids.map((b) => b.playerId),
    )[0]!.playerId;
  return {
    rejectedMaxUrgency: { bids: rejected, selected: select(rejected) },
    allZeroInterest: { bids: zero, selected: select(zero) },
    staticStarvation: { bids: fixed, selected: frozenSchedule(fixed, 12) },
  };
}

export function summarizeReplays(
  snapshots: ReturnType<typeof replayAuction>[],
  playerIds: string[],
) {
  return playerIds.map((playerId) => {
    const observations = snapshots.map((s) => ({
      ...s.actors.find((a) => a.playerId === playerId)!,
      naturalWinner: s.naturalWinner,
    }));
    const eligible = observations.filter((a) => a.eligible);
    return {
      playerId,
      observedStates: observations.length,
      eligibleStates: eligible.length,
      naturalWins: eligible.filter((a) => a.naturalWinner === playerId).length,
      interventions: BID_INTERVENTIONS.map((mode) => {
        const choice = (a: (typeof observations)[number]) =>
          a.interventions.find((v) => v.mode === mode)!;
        return {
          mode,
          wins: eligible.length ? eligible.filter((a) => choice(a).actorWins).length : null,
          gainedWins: eligible.length
            ? eligible.filter((a) => choice(a).actorWins && a.naturalWinner !== playerId).length
            : null,
          changedWinnersAllStates: observations.length
            ? observations.filter((a) => choice(a).changedWinner).length
            : null,
        };
      }),
    };
  });
}
