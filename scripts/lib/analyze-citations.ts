import type { GameEventV1 } from "@werewolf/contracts";
import { reduceGame } from "@werewolf/engine";
import { authorizedSources } from "../../packages/simulator/src/context-v2";

export interface ReviewCitations {
  citedEventIds: string[];
  /** `subjectId` names the player whose knowledge the claim states; null means every decider. */
  knowledgeClaims: { claim: string; eventIds: string[]; subjectId: string | null }[];
}

/** A player who made the decision, and the sequence of their own commit. */
export interface Decider {
  actorId: string;
  decisionSequence: number;
}

/**
 * Every cited event must be one each relevant decider could see before their own decision: the
 * claim's subject, or, for an uncited subject and for the explanation's citations, every
 * decider (knowledge the whole pack shared). Visibility is never pooled across deciders.
 * It comes from the same authorized projection the game builds player context from, so it
 * cannot drift from what play allowed. Hidden facts belong in the uncited ground-truth field.
 */
export function checkCitations(
  review: ReviewCitations,
  events: GameEventV1[],
  deciders: Decider[],
): { accepted: boolean; issues: string[] } {
  const actorIds = deciders.map(({ actorId }) => actorId);
  if (!actorIds.length || new Set(actorIds).size !== actorIds.length)
    return {
      accepted: false,
      issues: [actorIds.length ? "duplicated decider" : "no deciders to check citations against"],
    };
  const known = new Set(events.map((event) => event.id));
  const views = new Map(
    deciders.map(({ actorId, decisionSequence }) => {
      const before = events.filter((event) => event.sequence < decisionSequence);
      const state = reduceGame(events[0]?.gameId ?? "", before);
      return [actorId, new Set(authorizedSources(state, before, actorId).map((s) => s.id))];
    }),
  );
  const issue = (label: string, id: string, scope: string[]) => {
    if (!known.has(id)) return [`${label} cites unknown event ${id}`];
    const blind = scope.filter((actorId) => !views.get(actorId)?.has(id));
    return blind.length
      ? [`${label} cites ${id}, which ${blind.join(" and ")} could not see before deciding`]
      : [];
  };
  const everyone = [...views.keys()];
  const issues = [
    ...review.citedEventIds.flatMap((id) => issue("explanation", id, everyone)),
    ...review.knowledgeClaims.flatMap(({ claim, eventIds, subjectId }) =>
      subjectId !== null && !views.has(subjectId)
        ? [`claim "${claim}" names ${subjectId}, who did not make this decision`]
        : eventIds.flatMap((id) =>
            issue(`claim "${claim}"`, id, subjectId === null ? everyone : [subjectId]),
          ),
    ),
  ];
  return { accepted: issues.length === 0, issues };
}
