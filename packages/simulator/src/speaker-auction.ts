import type { SpeakerIntentV1 } from "@werewolf/contracts";

export interface SpeakerAuctionBid {
  playerId: string;
  intent: SpeakerIntentV1;
}
export interface SpeakerAuctionScore {
  playerId: string;
  urge: number;
  listenerInterest: number;
  normalizedListenerInterest: number;
  priority: number;
}
export function rankSpeakerAuction(
  candidates: string[],
  bids: SpeakerAuctionBid[],
  bias: number,
  tieOrder: string[],
): SpeakerAuctionScore[] {
  const byListener = new Map(bids.map((b) => [b.playerId, b.intent]));
  const willing = candidates.filter((playerId) => byListener.get(playerId)?.wantsToSpeak);
  const raw = new Map(
    willing.map((speaker) => {
      const ratings = bids
        .filter((b) => b.playerId !== speaker)
        .flatMap((b) => {
          const willingness = b.intent.willingnessToListen.find(
            (w) => w.playerId === speaker,
          )?.willingness;
          return willingness === undefined ? [] : [willingness];
        });
      return [
        speaker,
        ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0,
      ] as const;
    }),
  );
  const total = [...raw.values()].reduce((a, b) => a + b, 0);
  return willing
    .map((playerId) => {
      const listenerInterest = raw.get(playerId) ?? 0,
        normalizedListenerInterest =
          total > 0 ? listenerInterest / total : 1 / Math.max(1, willing.length);
      const urge = byListener.get(playerId)?.urge ?? 0;
      return {
        playerId,
        urge,
        listenerInterest,
        normalizedListenerInterest,
        priority: (bias + urge) * normalizedListenerInterest,
      };
    })
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        tieOrder.indexOf(a.playerId) - tieOrder.indexOf(b.playerId) ||
        a.playerId.localeCompare(b.playerId),
    );
}
