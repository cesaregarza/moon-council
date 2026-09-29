import { describe, it, expect } from "vitest";
import {
  IDS,
  CONDITIONS,
  SIGNALS,
  POLICIES,
  controlFacts,
  controlView,
  controlBid,
  controlJournal,
  controlStudy,
  runControlledDiscussion,
} from "./lib/auction-control";

describe("controlled speaker scheduling", () => {
  it("does not leak another actor's private record or an undelivered own record", () => {
    const facts = controlFacts(true);
    const view = controlView("p2", 3, facts, []);
    expect(view.own).toBeNull();
    expect(controlJournal(view)).not.toContain("K5 maps");
    const hidden = structuredClone(facts);
    hidden[2]!.text = "hidden counterfactual";
    expect(controlView("p1", 3, hidden, [])).toEqual(controlView("p1", 3, facts, []));
    expect(controlView("p2", 4, facts, []).own?.id).toBe("B");
  });
  it("keeps intervention scope to the designated urgency or outgoing ratings", () => {
    for (const id of IDS) {
      const view = controlView(id, 1, controlFacts(false), []);
      const plain = controlBid(view, "cooperative", "observed-memory");
      const zero = controlBid(view, "zero-rater", "observed-memory");
      expect(zero.urge).toBe(plain.urge);
      expect(zero.willingnessToListen).toEqual(
        id === "p2"
          ? plain.willingnessToListen.map((x) => ({ ...x, willingness: 0 }))
          : plain.willingnessToListen,
      );
      const max = controlBid(view, "max-rambler", "observed-memory");
      expect(max.urge).toBe(id === "p4" ? 1 : plain.urge);
      expect(max.willingnessToListen).toEqual(plain.willingnessToListen);
    }
  });
  it("enumerates all864 cells, respects arrival/eligibility, and accounts for service", () => {
    const runs = controlStudy();
    expect(runs).toHaveLength(864);
    for (const condition of CONDITIONS)
      for (const signal of SIGNALS)
        for (const policy of POLICIES)
          expect(
            runs.filter(
              (r) => r.condition === condition && r.signal === signal && r.policy === policy,
            ),
          ).toHaveLength(48);
    for (const run of runs) {
      expect(run.speeches).toHaveLength(12);
      const facts = controlFacts(run.staggered);
      const disclosed = run.speeches.flatMap((s) => (s.fact ? [s.fact.id] : []));
      expect(new Set(disclosed).size).toBe(disclosed.length);
      for (let i = 0; i < 12; i++) {
        const speech = run.speeches[i]!;
        expect(speech.playerId).not.toBe(run.speeches[i - 1]?.playerId);
        if (speech.fact)
          expect(speech.turn).toBeGreaterThanOrEqual(
            facts.find((f) => f.id === speech.fact!.id)!.available,
          );
      }
      for (const d of run.disclosures) {
        const fact = facts.find((f) => f.id === d.id)!;
        const opportunities = run.auctions.filter(
          (a) =>
            a.turn >= d.available && a.turn <= (d.turn ?? 12) && a.candidates.includes(fact.owner),
        ).length;
        expect(d.eligibleOpportunities).toBe(opportunities);
        expect(d.eligiblePassovers).toBe(d.censored ? null : opportunities - 1);
      }
    }
  });
  it("equals urgency-only scheduling when sincere listener scores are flat", () => {
    for (const run of controlStudy().filter(
      (r) => r.policy === "auction" && r.signal === "flat-interest" && r.condition !== "zero-rater",
    )) {
      const baseline = runControlledDiscussion(
        "urgency",
        run.condition,
        run.signal,
        run.order,
        run.staggered,
      );
      expect(run.speeches).toEqual(baseline.speeches);
    }
  });
  it("cyclic scheduling actually rotates its cursor instead of selecting a fixed earliest eligible seat", () => {
    const order = ["p3", "p1", "p4", "p2"];
    const run = runControlledDiscussion("cyclic", "max-rambler", "observed-memory", order);
    expect(run.speeches.map((s) => s.playerId)).toEqual([...order, ...order, ...order]);
    expect(() =>
      runControlledDiscussion("auction", "cooperative", "flat-interest", ["p1", "p1"]),
    ).toThrow("seat order");
  });
});
