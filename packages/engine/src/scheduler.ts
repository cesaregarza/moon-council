import type { InitiativeDecisionSchema } from "@werewolf/contracts";
import type { z } from "zod";
import { hashSeed } from "./random";

export type InitiativeDecisionV1 = z.infer<typeof InitiativeDecisionSchema>;

export interface InitiativeCandidate {
  playerId: string;
  decision: InitiativeDecisionV1;
  lastSpokeAt: number;
  followUpsUsed: number;
}

const urgencyRank = { high: 3, medium: 2, low: 1 } as const;

export function selectFollowUp(
  candidates: readonly InitiativeCandidate[],
  seed: string,
  maxPerPlayer: number,
): InitiativeCandidate | undefined {
  return candidates
    .filter(
      (candidate) =>
        candidate.decision.intent === "speak" && candidate.followUpsUsed < maxPerPlayer,
    )
    .sort((left, right) => {
      const urgency = urgencyRank[right.decision.urgency] - urgencyRank[left.decision.urgency];
      if (urgency !== 0) return urgency;
      if (left.lastSpokeAt !== right.lastSpokeAt) return left.lastSpokeAt - right.lastSpokeAt;
      return hashSeed(`${seed}:${left.playerId}`) - hashSeed(`${seed}:${right.playerId}`);
    })[0];
}

export function discussionReady(
  decisions: readonly InitiativeDecisionV1[],
  livingPlayers: number,
  quorum: number,
): boolean {
  const ready = decisions.filter((decision) => decision.intent === "ready_to_vote").length;
  const speakers = decisions.filter((decision) => decision.intent === "speak").length;
  return speakers === 0 && ready >= Math.ceil(livingPlayers * quorum);
}
