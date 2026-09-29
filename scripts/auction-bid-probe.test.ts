import { describe, it, expect } from "vitest";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "@werewolf/llm";
import {
  bidRequest,
  journalRequest,
  MAX_CALLS,
  PAIRS,
  orderedContexts,
} from "./lib/auction-bid-design";
import {
  BidCalls,
  probeContext,
  runBidJobs,
  compareJournals,
  type BidObservation,
} from "./lib/auction-bid-runner";
import { expectedBidScore, summarizeBids } from "./lib/auction-bid-report";

class FixtureProvider implements DecisionProvider {
  calls = 0;
  constructor(private failAt = 0) {}
  async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    if (++this.calls === this.failAt) throw new Error("deliberate fixture failure");
    const value =
      request.kind === "jev"
        ? {
            model: "fixture",
            answers: Object.fromEntries(
              ["urge", "listen_p2", "listen_p3", "listen_p4"].map((key) => [
                key,
                {
                  type: "score",
                  score: 2,
                  confidence: 1,
                  probabilities: { "0": 0, "1": 0, "2": 1, "3": 0, "4": 0 },
                },
              ]),
            ),
          }
        : { journal: "Fictional updated journal from the event." };
    return {
      data: request.schema.parse(value),
      model: "fixture",
      provider: "fake",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}
describe("paired bid protocol", () => {
  it("isolates the journals and preserves the actor protocol on both objective variants", () => {
    const pair = PAIRS.find((p) => p.id === "strategic_objective")!;
    const a = bidRequest(pair.a, pair.a.authoredJournal),
      b = bidRequest(pair.b, pair.b.authoredJournal);
    expect(a.questions).toEqual(b.questions);
    expect(String(b.state)).toContain("prevent the other three participants");
    const prompt = journalRequest(pair.b);
    expect(prompt.privateInput).toContain(pair.b.priorJournal);
    expect(prompt.privateInput).not.toContain(pair.b.authoredJournal);
    expect(prompt.privateInput).not.toContain("pursue the group's task");
    expect(prompt.instructions).not.toContain("R7 is correct");
    expect(prompt.publicInput).toContain("4. Dax:");
  });
  it("does not expose pending backup values in the record or prior journal", () => {
    const pair = PAIRS.find((p) => p.id === "received_record")!;
    expect(pair.b.records.join(" ")).toContain("NOT arrived");
    expect(pair.b.records.join(" ")).not.toContain("N4 -> S5");
    expect(pair.b.priorJournal).not.toContain("N4 -> S5");
    expect(pair.a.records.join(" ")).toContain("N4 -> S5");
  });
  it("has one deterministic context per pair and variant with equal speaking opportunities", () => {
    const jobs = orderedContexts();
    expect(jobs).toEqual(orderedContexts());
    expect(new Set(jobs.map((j) => j.id)).size).toBe(16);
    expect(MAX_CALLS).toBe(48);
    for (const pair of PAIRS) {
      expect(pair.a.speeches.map((s) => s.playerId)).toEqual(
        pair.b.speeches.map((s) => s.playerId),
      );
      expect(pair.a.speeches.at(-1)?.playerId).toBe("p4");
    }
  });
  it("uses the full distribution and normalizes rounded mass", () => {
    expect(
      expectedBidScore({
        type: "score",
        score: 0,
        confidence: 0,
        probabilities: { "0": 0.25, "4": 0.75 },
      }),
    ).toBe(0.75);
    expect(
      expectedBidScore({ type: "score", score: 4, confidence: 0, probabilities: { "4": 0.99 } }),
    ).toBe(1);
  });
  it("keeps an authored scoring failure without retrying or preventing the independent Luna lane", async () => {
    const jev = new FixtureProvider(1),
      luna = new FixtureProvider();
    const events: Record<string, unknown>[] = [];
    const results = await probeContext(
      new BidCalls({ jev, luna }, (event) => events.push(event)),
      orderedContexts()[0]!,
    );
    expect(results.map((r) => r.status)).toEqual(["failed", "complete"]);
    expect(jev.calls).toBe(2);
    expect(luna.calls).toBe(1);
    expect(events.filter((e) => e.event === "failed")).toHaveLength(1);
  });
  it("records a missing derived score after a journal failure and still completes the other context", async () => {
    const jev = new FixtureProvider(),
      luna = new FixtureProvider(1);
    const saved: number[] = [];
    const results = await runBidJobs(
      new BidCalls({ jev, luna }, () => {}),
      orderedContexts().slice(0, 2),
      async (items) => {
        saved.push(items.length);
      },
    );
    expect(results).toHaveLength(4);
    expect(results.filter((r) => r.status === "skipped")).toHaveLength(1);
    expect(jev.calls).toBe(3);
    expect(luna.calls).toBe(2);
    expect(saved).toEqual([4]);
    expect(summarizeBids(results).every((r) => r.delta === null || Number.isFinite(r.delta))).toBe(
      true,
    );
  });
  it("rejects duplicate cells and does not turn absent results into zero scores", () => {
    const cell: BidObservation = {
      id: "new_clue-a",
      mode: "authored",
      status: "failed",
      journal: null,
      response: null,
      error: "failure",
    };
    expect(() => summarizeBids([cell, cell])).toThrow("Duplicate");
    expect(summarizeBids([cell])[0]).toMatchObject({
      a: null,
      b: null,
      delta: null,
      direction: "missing",
    });
  });
  it("compares fresh journal policies with independent priors and no authored-score calls", async () => {
    const jev = new FixtureProvider(),
      luna = new FixtureProvider();
    const events: Record<string, unknown>[] = [];
    const results = await compareJournals(
      new BidCalls({ jev, luna }, (e) => events.push(e), 20, 64),
      orderedContexts()[0]!,
    );
    expect(results.map((r) => r.mode).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      "luna",
      "memory-v2",
    ]);
    expect(jev.calls).toBe(2);
    expect(luna.calls).toBe(2);
    expect(
      events
        .filter((e) => e.event === "started")
        .map((e) => e.stage)
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(["journal", "journal-memory-v2", "luna", "memory-v2"]);
  });
  it("stops at the shared attempt ceiling", async () => {
    const jev = new FixtureProvider(),
      luna = new FixtureProvider();
    const calls = new BidCalls({ jev, luna }, () => {});
    const job = orderedContexts()[0]!;
    for (let i = 0; i < 16; i++) await probeContext(calls, job);
    const excess = await probeContext(calls, job);
    expect(jev.calls + luna.calls).toBe(MAX_CALLS);
    expect(excess.map((r) => r.status)).toEqual(["failed", "skipped"]);
  });
});
