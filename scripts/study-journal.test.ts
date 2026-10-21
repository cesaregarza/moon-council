import { describe, it, expect } from "vitest";
import { PAIRS, journalRequest, bidRequest } from "./lib/auction-bid-design";
import { journalInstructions, parseJournalPolicy } from "./lib/study-journal";
import { playerPrompt } from "./lib/auction-study-agents";
import { playersFor, TASK } from "./lib/auction-bid-design";

describe("versioned journal guidance", () => {
  it("changes only the reflection instruction on exactly matched actor inputs", () => {
    for (const pair of PAIRS)
      for (const context of [pair.a, pair.b]) {
        const old = journalRequest(context),
          next = journalRequest(context, "memory-v2");
        expect(old.input).toBe(journalInstructions("legacy"));
        expect(next.input).not.toBe(old.input);
        expect({ ...next, input: old.input }).toEqual(old);
        const players = playersFor(context, context.priorJournal);
        expect(
          playerPrompt(players[0]!, players, TASK, context.speeches, "speech", 12, "memory-v2"),
        ).toEqual(playerPrompt(players[0]!, players, TASK, context.speeches, "speech", 12));
        const request = bidRequest(context, "same factual journal");
        expect(JSON.stringify(request)).not.toContain("memory-v2");
      }
  });
  it("defaults archived manifests to legacy and rejects unknown policies", () => {
    expect(parseJournalPolicy()).toBe("legacy");
    expect(() => parseJournalPolicy("invented")).toThrow("journal policy");
  });
});
