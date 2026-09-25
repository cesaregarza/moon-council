import { describe, expect, it } from "vitest";
import { discussionReady, selectFollowUp, type InitiativeCandidate } from "./index";

const journal = { beliefs: [], goals: [], strategy: "", unresolvedQuestions: [] };
const nullableContext = { replyToEventId: null, topic: null };

describe("bounded initiative scheduler", () => {
  it("prefers urgency, then the least recent speaker", () => {
    const candidates: InitiativeCandidate[] = [
      {
        playerId: "recent",
        lastSpokeAt: 10,
        followUpsUsed: 0,
        decision: {
          kind: "initiative",
          intent: "speak",
          urgency: "high",
          journal,
          ...nullableContext,
        },
      },
      {
        playerId: "waiting",
        lastSpokeAt: 1,
        followUpsUsed: 0,
        decision: {
          kind: "initiative",
          intent: "speak",
          urgency: "high",
          journal,
          ...nullableContext,
        },
      },
      {
        playerId: "low",
        lastSpokeAt: 0,
        followUpsUsed: 0,
        decision: {
          kind: "initiative",
          intent: "speak",
          urgency: "low",
          journal,
          ...nullableContext,
        },
      },
    ];
    expect(selectFollowUp(candidates, "seed", 2)?.playerId).toBe("waiting");
  });

  it("enforces per-player follow-up limits and readiness quorum", () => {
    const capped: InitiativeCandidate[] = [
      {
        playerId: "capped",
        lastSpokeAt: 0,
        followUpsUsed: 2,
        decision: {
          kind: "initiative",
          intent: "speak",
          urgency: "high",
          journal,
          ...nullableContext,
        },
      },
    ];
    expect(selectFollowUp(capped, "seed", 2)).toBeUndefined();
    expect(
      discussionReady(
        [
          {
            kind: "initiative",
            intent: "ready_to_vote",
            urgency: "low",
            journal,
            ...nullableContext,
          },
          {
            kind: "initiative",
            intent: "ready_to_vote",
            urgency: "low",
            journal,
            ...nullableContext,
          },
          { kind: "initiative", intent: "pass", urgency: "low", journal, ...nullableContext },
        ],
        3,
        2 / 3,
      ),
    ).toBe(true);
  });
});
