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
