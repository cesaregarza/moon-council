import { describe, expect, it } from "vitest";
import { ClaudeWarmGate } from "./claude-warm-gate";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Each entrant records when it was admitted; the test decides when the writer streams. */
function crowd(gate: ClaudeWarmGate, key: string, size: number) {
  const admitted: number[] = [];
  const releases: ((streamed: boolean) => void)[] = [];
  const entries = Array.from({ length: size }, (_, index) =>
    gate.enter(key).then((release) => {
      admitted.push(index);
      releases[index] = release;
    }),
  );
  return { admitted, releases, entries };
}

describe("Claude warm gate", () => {
  it("sends exactly one request first and releases the rest at its first streamed token", async () => {
    const gate = new ClaudeWarmGate();
    const { admitted, releases, entries } = crowd(gate, "day-1", 4);
    await tick();
    expect(admitted).toEqual([0]);
    releases[0]!(true);
    await Promise.all(entries);
    expect([...admitted].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    // The prefix is warm now: later requests are not held.
    await gate.enter("day-1");
  });

  it("lets the next waiter write when the first request fails, without deadlock", async () => {
    const gate = new ClaudeWarmGate();
    const { admitted, releases, entries } = crowd(gate, "day-2", 3);
    await tick();
    releases[0]!(false);
    await tick();
    expect(admitted).toEqual([0, 1]);
    releases[1]!(true);
    await Promise.all(entries);
    expect(admitted).toHaveLength(3);
  });

  it("stops waiting on its own abort, and never past maxWaitMs", async () => {
    const gate = new ClaudeWarmGate(20);
    const writer = await gate.enter("day-3");
    const controller = new AbortController();
    const aborted = gate.enter("day-3", controller.signal);
    controller.abort();
    await expect(aborted).rejects.toThrow(/aborted/);
    // The writer never streams or fails: a waiter proceeds after maxWaitMs.
    await expect(gate.enter("day-3")).resolves.toBeTypeOf("function");
    writer(false);
  });

  it("keeps different prefixes independent", async () => {
    const gate = new ClaudeWarmGate();
    await gate.enter("a");
    const other = await Promise.race([gate.enter("b").then(() => "b"), tick().then(() => "held")]);
    expect(other).toBe("b");
  });
});
