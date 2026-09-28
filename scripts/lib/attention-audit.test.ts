import { expect, it } from "vitest";
import { spearman } from "./attention-audit";

it("handles tied ranks, insufficient data and constant series", () => {
  expect(
    spearman([
      [0, 3],
      [1, 2],
    ]),
  ).toBeNull();
  expect(
    spearman([
      [0, 3],
      [0, 2],
      [0, 1],
    ]),
  ).toBeNull();
  expect(
    spearman([
      [1, 2],
      [1, 2],
      [3, 4],
      [4, 5],
    ]),
  ).toBe(1);
  expect(
    spearman([
      [1, 3],
      [1, 2],
      [3, 1],
    ]),
  ).toBeCloseTo(-Math.sqrt(3) / 2);
});
