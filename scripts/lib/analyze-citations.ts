import type { GameEventV1 } from "@werewolf/contracts";
import { reduceGame } from "@werewolf/engine";
import { authorizedSources } from "../../packages/simulator/src/context-v2";

export interface ReviewCitations {
  citedEventIds: string[];
  knowledgeClaims: { claim: string; eventIds: string[] }[];
}

/**
 * A review may cite any recorded event, but a claim about what the player knew must cite an
 * event the player could see before deciding. Visibility comes from the same authorized
 * projection the game builds player context from, so it cannot drift from what play allowed.
 */
export function checkCitations(
  review: ReviewCitations,
  events: GameEventV1[],
  actorId: string,
  decisionSequence: number,
): { accepted: boolean; issues: string[] } {
  const known = new Set(events.map((event) => event.id));
  const before = events.filter((event) => event.sequence < decisionSequence);
  const visible = new Set(
    authorizedSources(reduceGame(events[0]?.gameId ?? "", before), before, actorId).map(
      (source) => source.id,
    ),
  );
  const issues = [
    ...review.citedEventIds.filter((id) => !known.has(id)).map((id) => `cites unknown event ${id}`),
    ...review.knowledgeClaims.flatMap((claim) =>
      claim.eventIds.flatMap((id) =>
        !known.has(id)
          ? [`claim "${claim.claim}" cites unknown event ${id}`]
          : !visible.has(id)
            ? [`claim "${claim.claim}" cites ${id}, which ${actorId} could not see before deciding`]
            : [],
      ),
    ),
  ];
  return { accepted: issues.length === 0, issues };
}
