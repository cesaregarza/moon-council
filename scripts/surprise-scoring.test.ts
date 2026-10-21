import { describe, expect, it } from "vitest";
import {
  classifyMoment,
  contradictsOwnKnowledge,
  rankNoteworthy,
  scoreMoment,
  type SurpriseMoment,
} from "./lib/surprise-scoring";

// Scripted distributions; no provider is constructed. Options are player IDs or "abstain".
const moment = (
  id: string,
  actual: string,
  publicView: Record<string, number>,
  privateView: Record<string, number>,
  verified: SurpriseMoment["verified"] = [],
): SurpriseMoment => ({
  id,
  kind: "ballot",
  actorId: "seer",
  actorAlignment: "village",
  actual,
  publicView,
  privateView,
  verified,
});

const fixture = [
  // The public doubts the Seer's wolf call; the Seer votes the wolf it inspected.
  moment(
    "seer-votes-wolf",
    "wolf",
    { wolf: 0.05, villager: 0.8, abstain: 0.15 },
    { wolf: 0.9, villager: 0.05, abstain: 0.05 },
    [{ targetId: "wolf", alignment: "werewolf" }],
  ),
  // Fay pattern: abstains although the player's own inspection found a living wolf.
  moment(
    "fay-abstains",
    "abstain",
    { wolf: 0.1, villager: 0.2, abstain: 0.7 },
    { wolf: 0.3, villager: 0.1, abstain: 0.6 },
    [{ targetId: "wolf", alignment: "werewolf" }],
  ),
  // Neither the public record nor the recorded choice explains it.
  moment(
    "unexplained",
    "villager",
    { wolf: 0.7, villager: 0.1, abstain: 0.2 },
    { wolf: 0.8, villager: 0.1, abstain: 0.1 },
  ),
  moment(
    "routine-a",
    "wolf",
    { wolf: 0.8, villager: 0.1, abstain: 0.1 },
    { wolf: 0.85, villager: 0.1, abstain: 0.05 },
  ),
  moment(
    "routine-b",
    "villager",
    { wolf: 0.2, villager: 0.7, abstain: 0.1 },
    { wolf: 0.1, villager: 0.8, abstain: 0.1 },
  ),
];

const classified = () => fixture.map((m) => classifyMoment(m));

describe("surprise scoring", () => {
  it("scores public surprisal, private probability and own-knowledge contradictions", () => {
    const score = scoreMoment(fixture[0]!);
    expect(score.publicSurprisal).toBeCloseTo(-Math.log(0.05));
    expect(score.privateProbability).toBe(0.9);
    expect(score.contradictsOwnKnowledge).toBe(false);
    expect(scoreMoment(fixture[1]!).contradictsOwnKnowledge).toBe(true);
  });

  it("puts each fixture moment in its class", () => {
    expect(Object.fromEntries(fixture.map((m) => [m.id, classifyMoment(m).class]))).toEqual({
      "seer-votes-wolf": "private_knowledge",
      "fay-abstains": "herd_over_knowledge",
      unexplained: "noise_or_error",
      "routine-a": "routine",
      "routine-b": "routine",
    });
  });

  it("does not report routine moments and honors the review cap", () => {
    const ranked = rankNoteworthy(classified(), 12);
    expect(ranked.map((m) => m.id)).toEqual(["fay-abstains", "seer-votes-wolf", "unexplained"]);
    expect(rankNoteworthy(classified(), 1).map((m) => m.id)).toEqual(["fay-abstains"]);
  });

  it("treats a near-flat public prediction as no signal, not surprise", () => {
    const flat = moment(
      "flat",
      "villager",
      { wolf: 0.34, villager: 0.32, abstain: 0.34 },
      { wolf: 0.1, villager: 0.1, abstain: 0.8 },
    );
    expect(classifyMoment(flat).class).toBe("no_signal");
    expect(rankNoteworthy([classifyMoment(flat)], 12)).toEqual([]);
  });

  it("only tags contradictions a village actor's verified results establish", () => {
    const wolfFound = [{ targetId: "wolf", alignment: "werewolf" as const }];
    const villageFound = [{ targetId: "villager", alignment: "village" as const }];
    expect(contradictsOwnKnowledge({ ...fixture[0]!, actual: "wolf", verified: wolfFound })).toBe(
      false,
    );
    expect(
      contradictsOwnKnowledge({ ...fixture[0]!, actual: "villager", verified: villageFound }),
    ).toBe(true);
    expect(
      contradictsOwnKnowledge({
        ...fixture[0]!,
        actorAlignment: "werewolf",
        actual: "abstain",
        verified: wolfFound,
      }),
    ).toBe(false);
    expect(
      contradictsOwnKnowledge({ ...fixture[0]!, kind: "night_action", verified: villageFound }),
    ).toBe(false);
  });
});
