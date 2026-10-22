import type { GameEventV1 } from "@werewolf/contracts";
import { reduceGame } from "@werewolf/engine";
import { authorizedSources } from "../../packages/simulator/src/context-v2";

export interface ReviewCitations {
  citedEventIds: string[];
  knowledgeClaims: { claim: string; eventIds: string[] }[];
}

/**
 * Every cited event, in the explanation's citations and in knowledge claims, must be one the
 * player (for a kill, a wolf of the pack) could see before deciding. Visibility comes from the same authorized projection the
 * game builds player context from, so it cannot drift from what play allowed. Hidden facts
 * belong in the review's uncited ground-truth field.
 */
export function checkCitations(
  review: ReviewCitations,
  events: GameEventV1[],
  actorIds: string[],
  decisionSequence: number,
): { accepted: boolean; issues: string[] } {
  const known = new Set(events.map((event) => event.id));
  const before = events.filter((event) => event.sequence < decisionSequence);
  const state = reduceGame(events[0]?.gameId ?? "", before);
  const visible = new Set(
    actorIds.flatMap((actorId) =>
      authorizedSources(state, before, actorId).map((source) => source.id),
    ),
  );
  const issue = (label: string, id: string) =>
    !known.has(id)
      ? [`${label} cites unknown event ${id}`]
      : !visible.has(id)
        ? [`${label} cites ${id}, which ${actorIds.join(" and ")} could not see before deciding`]
        : [];
  const issues = [
    ...review.citedEventIds.flatMap((id) => issue("explanation", id)),
    ...review.knowledgeClaims.flatMap((claim) =>
      claim.eventIds.flatMap((id) => issue(`claim "${claim.claim}"`, id)),
    ),
  ];
  return { accepted: issues.length === 0, issues };
}
