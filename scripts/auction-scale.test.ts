import { describe, expect, it } from "vitest";
import { permutations } from "./lib/auction-control";
import { DEPENDENCY_SIGNALS } from "./lib/auction-dependency";
import {
  expectedOrderedCyclicCompletion,
  roster,
  runScaleCase,
  scaleJobs,
  scaleOrders,
  scaleSummary,
  type ScaleRun,
} from "./lib/auction-scale";

describe("ordered dependency scheduling", () => {
  it("retains reproducible bounded seat samples and matched jobs", () => {
    expect(scaleOrders(4)).toEqual(permutations(roster(4)));
    for (const count of [8, 12, 16]) {
      const orders = scaleOrders(count);
      expect(orders).toHaveLength(96);
      expect(new Set(orders.map((x) => x.join(","))).size).toBe(96);
      expect(orders).toEqual(scaleOrders(count));
      for (const order of orders) expect([...order].sort()).toEqual(roster(count).sort());
    }
    expect(scaleJobs()).toHaveLength(11232);
    expect(() => scaleOrders(5)).toThrow();
  });
  it("requires a third cyclic pass in a concrete C-B-A-D order", () => {
    const run = runScaleCase({
      count: 4,
      holders: 3,
      condition: "max-rambler",
      signal: "conditional-memory",
      policy: "cyclic",
      order: ["p3", "p2", "p1", "p4"],
    });
    expect(run.completion).toBe(9);
    expect(run.slotBudget).toBe(12);
    expect(run.events.filter((e) => e.result).map((e) => [e.result!.id, e.turn])).toEqual([
      ["A", 3],
      ["B", 6],
      ["C", 9],
    ]);
    expect(run.events[0]).toMatchObject({
      playerId: "p3",
      kind: "waiting",
      waitingFor: "B",
      result: null,
    });
    expect(run.events[4]).toMatchObject({
      playerId: "p3",
      kind: "waiting",
      waitingFor: "B",
      result: null,
    });
    expect(run.disclosures.map((d) => [d.readyAt, d.eligiblePassovers])).toEqual([
      [1, 2],
      [4, 2],
      [7, 2],
    ]);
  });
  it("allows enough cycles for the reverse twelve-player chain", () => {
    const run = runScaleCase({
      count: 12,
      holders: 11,
      condition: "cooperative",
      signal: "conditional-memory",
      policy: "cyclic",
      order: roster(12).reverse(),
    });
    expect(run.completion).toBe(122);
    expect(run.slotBudget).toBe(132);
    expect(run.disclosures.every((d) => !d.censored)).toBe(true);
    expect(run.events.at(-1)?.result?.id).toBe("K");
  });
  it("matches an independent cyclic-position recurrence and the exhaustive mean", () => {
    for (const holders of [1, 2, 3]) {
      const completions = scaleOrders(4).map((order) => {
        const run = runScaleCase({
          count: 4,
          holders,
          condition: "max-rambler",
          signal: "conditional-memory",
          policy: "cyclic",
          order,
        });
        const positions = roster(holders).map((id) => order.indexOf(id));
        let expected = positions[0]! + 1;
        for (let i = 1; i < positions.length; i++)
          expected += (positions[i]! - positions[i - 1]! + 4) % 4;
        expect(run.completion).toBe(expected);
        return run.completion!;
      });
      expect(completions.reduce((a, b) => a + b, 0) / completions.length).toBe(
        expectedOrderedCyclicCompletion(4, holders),
      );
    }
    expect(expectedOrderedCyclicCompletion(12, 3)).toBe(18.5);
    expect(expectedOrderedCyclicCompletion(12, 11)).toBe(66.5);
    expect(() => expectedOrderedCyclicCompletion(12, 0)).toThrow();
  });
  it("enforces identical gates across policies and only completes ordered public derivations", () => {
    for (const order of scaleOrders(12).slice(0, 8))
      for (const signal of DEPENDENCY_SIGNALS)
        for (const policy of ["auction", "urgency", "cyclic"] as const) {
          const run = runScaleCase({
            count: 12,
            holders: 9,
            condition: "max-rambler",
            signal,
            policy,
            order,
          });
          const results = run.events.filter((e) => e.result);
          expect(results.map((e) => e.result!.id)).toEqual([
            "A",
            "B",
            "C",
            "D",
            "E",
            "F",
            "G",
            "H",
            "I",
          ]);
          for (let i = 1; i < results.length; i++) {
            expect(results[i]!.result!.input).toEqual({
              id: results[i - 1]!.result!.id,
              value: results[i - 1]!.result!.value,
            });
            expect(results[i]!.turn).toBeGreaterThan(results[i - 1]!.turn);
          }
          expect(run.speakers.every((id, i) => id !== run.speakers[i - 1])).toBe(true);
          expect(run.completion).toBe(results.at(-1)!.turn);
        }
  });
  it("retains urgency-only as a flat-interest ablation", () => {
    for (const order of scaleOrders(12).slice(0, 8)) {
      const common = {
        count: 12,
        holders: 11,
        condition: "max-rambler" as const,
        signal: "flat-interest" as const,
        order,
      };
      expect(runScaleCase({ ...common, policy: "auction" }).events).toEqual(
        runScaleCase({ ...common, policy: "urgency" }).events,
      );
    }
  });
  it("reports revisits and censoring rather than dropping incomplete runs", () => {
    const run: ScaleRun = {
      ...runScaleCase({
        count: 4,
        holders: 3,
        condition: "max-rambler",
        signal: "conditional-memory",
        policy: "cyclic",
        order: ["p3", "p2", "p1", "p4"],
      }),
      profile: "fixed-three",
    };
    const summary = scaleSummary([run, { ...run, completion: null }]);
    expect(summary[0]!.outcomes.cyclic).toEqual({
      cases: 2,
      incomplete: 1,
      completedMean: 9,
      overOneCycle: 1,
      overTwoCycles: 1,
      maxCompletion: 9,
    });
    expect(summary[0]!.outcomes.auction).toEqual({
      cases: 0,
      incomplete: 0,
      completedMean: null,
      overOneCycle: 0,
      overTwoCycles: 0,
      maxCompletion: null,
    });
  });
});
