import { describe, expect, it } from "vitest";
import { complexityBaseline, complexityRegressions } from "./check-complexity";

describe("complexity budget", () => {
  it("allows improvement but rejects new debt, increases, and extra anonymous functions", () => {
    const baseline = { "file: function a": [30], "file: arrow function": [26, 22] };
    expect(complexityRegressions({ "file: function a": [23] }, baseline)).toEqual([]);
    expect(complexityRegressions({ "file: function a": [31] }, baseline)).toHaveLength(1);
    expect(complexityRegressions({ "file: new function": [21] }, baseline)).toHaveLength(1);
    expect(complexityRegressions({ "file: arrow function": [26, 22, 21] }, baseline)).toHaveLength(
      1,
    );
  });

  it("produces a stable baseline independent of diagnostic order and rejects unknown output", () => {
    const make = (score: number) => ({
      filename: "file",
      code: "eslint(complexity)",
      message: `arrow function has a complexity of ${score}. Maximum allowed is 20.`,
    });
    expect(complexityBaseline({ diagnostics: [make(21), make(30)] })).toEqual({
      "file: arrow function": [30, 21],
    });
    expect(() =>
      complexityBaseline({ diagnostics: [{ ...make(21), code: "parse-error" }] }),
    ).toThrow();
    expect(() => complexityBaseline({})).toThrow();
  });
});
