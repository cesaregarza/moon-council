import { describe, expect, it } from "vitest";
import { formatCompactCount } from "./format";

describe("formatCompactCount", () => {
  it("uses readable K, M, B, and T suffixes", () => {
    expect(formatCompactCount(999)).toBe("999");
    expect(formatCompactCount(1_200)).toBe("1.2K");
    expect(formatCompactCount(999_500)).toBe("1M");
    expect(formatCompactCount(1_946_911)).toBe("1.95M");
    expect(formatCompactCount(2_030_093_000)).toBe("2.03B");
    expect(formatCompactCount(4_500_000_000_000)).toBe("4.5T");
  });
});

describe("speechActLabel", () => {
  it("labels an old game's speech acts, and nothing for a plain new-mode speech", async () => {
    // Looked up dynamically so this test runs, and fails on its assertion, before the helper exists.
    const format = (await import("./format")) as Record<string, unknown>;
    const label = format.speechActLabel as
      | ((payload: Record<string, unknown>, nameOf: (id: string) => string) => string | null)
      | undefined;
    expect(typeof label).toBe("function");
    const nameOf = (id: string) => (id === "p8" ? "Hollis" : id);
    // Exactly what the observer showed for a recorded staged speech.
    expect(
      label!(
        {
          text: "I claim seer, and Hollis is lying.",
          acts: [
            { kind: "role_claim", targetId: null },
            { kind: "accusation", targetId: "p8" },
          ],
        },
        nameOf,
      ),
    ).toBe("role claim  · accusation Hollis · Claims are unverified");
    expect(label!({ text: "Plain speech.", endAction: { kind: "continue" } }, nameOf)).toBeNull();
  });
});
