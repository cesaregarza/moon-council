import { describe, expect, it } from "vitest";
import { controlBid, permutations, runControlledDiscussion, SIGNALS } from "./lib/auction-control";
import {
  expectedCyclicCompletion,
  roster,
  runScaleCase,
  scaleJobs,
  scaleOrders,
  scaleSummary,
  type ScaleRun,
} from "./lib/auction-scale";

describe("speaker scheduling with larger rosters", () => {
  it("extends the shared rule without leaking peer clue ownership or targeting p4", () => {
    const ids = roster(12);
    const view = { playerId: "p12", own: null, publicSpeeches: [] };
    const bid = controlBid(view, "max-rambler", "observed-memory", ids);
    expect(bid.urge).toBe(1);
    expect(bid.willingnessToListen).toHaveLength(11);
    expect(bid.willingnessToListen.every((r) => r.willingness === 0.7)).toBe(true);
    expect(
      controlBid({ ...view, playerId: "p4" }, "max-rambler", "observed-memory", ids).urge,
    ).toBe(0.05);
    const privateRecord = { ...view, own: { id: "private", text: "My private fact" } };
    expect(
      controlBid(privateRecord, "cooperative", "observed-memory", ids).willingnessToListen,
    ).toEqual(bid.willingnessToListen);
  });
  it("uses reproducible bounded order samples rather than factorial enumeration", () => {
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
  it("reproduces the old four-player completion prefix with the shared bidding rule", () => {
    for (const order of scaleOrders(4))
      for (const signal of SIGNALS)
        for (const condition of ["cooperative", "max-rambler"] as const) {
          const old = runControlledDiscussion("auction", condition, signal, order);
          const current = runScaleCase({
            count: 4,
            holders: 3,
            condition,
            signal,
            policy: "auction",
            order,
          });
          expect(current.completion).toBe(old.completionTurn);
          expect(current.speakers).toEqual(
            old.speeches.slice(0, old.completionTurn!).map((s) => s.playerId),
          );
        }
  });
  it("matches the exact cyclic expectation over all four-player orders", () => {
    for (const holders of [1, 2, 3]) {
      const completions = scaleOrders(4).map(
        (order) =>
          runScaleCase({
            count: 4,
            holders,
            condition: "max-rambler",
            signal: "observed-memory",
            policy: "cyclic",
            order,
          }).completion!,
      );
      expect(completions.reduce((a, b) => a + b, 0) / completions.length).toBe(
        expectedCyclicCompletion(4, holders),
      );
    }
    expect(expectedCyclicCompletion(12, 3)).toBe(9.75);
    expect(expectedCyclicCompletion(12, 11)).toBeCloseTo(11.9166666667);
    expect(() => expectedCyclicCompletion(12, 0)).toThrow();
  });
  it("isolates density, respects eligibility, and reproduces the flat-interest ablation", () => {
    for (const order of scaleOrders(12).slice(0, 8))
      for (const holders of [3, 9, 11]) {
        const common = { count: 12, holders, condition: "max-rambler" as const, order };
        const auction = runScaleCase({ ...common, signal: "observed-memory", policy: "auction" });
        const urgency = runScaleCase({ ...common, signal: "observed-memory", policy: "urgency" });
        const flat = runScaleCase({ ...common, signal: "flat-interest", policy: "auction" });
        const cyclic = runScaleCase({ ...common, signal: "observed-memory", policy: "cyclic" });
        expect(auction.completion).toBe(holders + 1);
        expect(urgency.completion).toBe(2 * holders);
        expect(flat.speakers).toEqual(urgency.speakers);
        expect(cyclic.completion).toBe(
          1 + Math.max(...roster(holders).map((id) => order.indexOf(id))),
        );
        for (const run of [auction, urgency, flat, cyclic]) {
          expect(run.speakers.every((id, i) => id !== run.speakers[i - 1])).toBe(true);
          expect(run.disclosures.every((d) => d.turn !== null)).toBe(true);
        }
      }
  });
  it("reports censoring separately from the mean of completed runs", () => {
    const run: ScaleRun = {
      ...runScaleCase({
        count: 4,
        holders: 3,
        condition: "max-rambler",
        signal: "observed-memory",
        policy: "auction",
        order: roster(4),
      }),
      profile: "fixed-three",
    };
    const summary = scaleSummary([run, { ...run, completion: null }]);
    expect(summary[0]!.outcomes.auction).toEqual({ cases: 2, incomplete: 1, completedMean: 4 });
    expect(summary[0]!.outcomes.cyclic).toEqual({ cases: 0, incomplete: 0, completedMean: null });
  });
});
