import { describe, expect, it } from "vitest";
import {
  dependencyPackets,
  dependencyView,
  dependencyBid,
  dependencySpeech,
  dependencyInterest,
  validateDependencyPublication,
  type DependencySpeech,
} from "./lib/auction-dependency";

const ids = ["p1", "p2", "p3", "p4"];
const packets = dependencyPackets(ids.slice(0, 3));
function speak(playerId: string, events: DependencySpeech[]) {
  const packet = packets.find((p) => p.owner === playerId);
  const speech = dependencySpeech(
    dependencyView(playerId, packet, events),
    events.length + 1,
    null,
  );
  validateDependencyPublication(speech, packet, events);
  events.push(speech);
  return speech;
}
describe("causal private results", () => {
  it("cannot pre-disclose B or C and does not retroactively credit a blocked turn", () => {
    const events: DependencySpeech[] = [];
    expect(speak("p2", events)).toMatchObject({ kind: "waiting", result: null, waitingFor: "A" });
    expect(speak("p3", events)).toMatchObject({ kind: "waiting", result: null, waitingFor: "B" });
    const a = speak("p1", events);
    expect(a.result?.id).toBe("A");
    expect(events.filter((e) => e.result).map((e) => e.result!.id)).toEqual(["A"]);
    expect(dependencyView("p2", packets[1], events).ready?.input).toEqual({
      id: "A",
      value: a.result!.value,
    });
    expect(dependencyView("p3", packets[2], events).ready).toBeNull();
    const b = speak("p2", events);
    const c = speak("p3", events);
    expect(b.result?.input?.value).toBe(a.result!.value);
    expect(c.result?.input?.value).toBe(b.result!.value);
    expect(events.filter((e) => e.result).map((e) => e.result!.id)).toEqual(["A", "B", "C"]);
  });
  it("hides future output and foreign packets and binds the derived result to the actual predecessor", () => {
    const changed = { ...packets[1]!, privateInput: "a different private transform" };
    expect(dependencyView("p2", changed, [])).toEqual(dependencyView("p2", packets[1], []));
    expect(() => dependencyView("p4", packets[1], [])).toThrow("Foreign private packet");
    const events: DependencySpeech[] = [];
    speak("p1", events);
    expect(dependencyView("p2", changed, events).ready?.value).not.toBe(
      dependencyView("p2", packets[1], events).ready?.value,
    );
    const changedParent = structuredClone(events);
    changedParent[0]!.result!.value = "different actual predecessor value";
    expect(dependencyView("p2", packets[1], changedParent).ready?.value).not.toBe(
      dependencyView("p2", packets[1], events).ready?.value,
    );
  });
  it("rejects premature, forged, duplicate, and wrongly attributed publications", () => {
    const events: DependencySpeech[] = [];
    const a = speak("p1", events);
    const b = dependencySpeech(dependencyView("p2", packets[1], events), 2, null);
    expect(() => validateDependencyPublication(b, packets[1], [])).toThrow();
    expect(() =>
      validateDependencyPublication(
        { ...b, result: { ...b.result!, value: "forged" } },
        packets[1],
        events,
      ),
    ).toThrow();
    expect(() =>
      validateDependencyPublication({ ...b, playerId: "p3" }, packets[1], events),
    ).toThrow();
    expect(() => validateDependencyPublication(a, packets[0], events)).toThrow();
    expect(() =>
      validateDependencyPublication({ ...b, kind: "waiting" }, packets[1], events),
    ).toThrow();
  });
  it("reopens a public waiting condition only when its own prerequisite arrives", () => {
    const events: DependencySpeech[] = [];
    speak("p2", events);
    speak("p3", events);
    expect(dependencyInterest("p2", events, "conditional-memory")).toBe(0.05);
    expect(
      dependencyBid(
        dependencyView("p2", packets[1], events),
        ids,
        "cooperative",
        "conditional-memory",
      ).urge,
    ).toBe(0.05);
    speak("p1", events);
    expect(dependencyInterest("p2", events, "conditional-memory")).toBe(0.7);
    expect(dependencyInterest("p3", events, "conditional-memory")).toBe(0.05);
    expect(
      dependencyBid(
        dependencyView("p2", packets[1], events),
        ids,
        "cooperative",
        "conditional-memory",
      ).urge,
    ).toBe(0.8);
    speak("p2", events);
    expect(dependencyInterest("p2", events, "conditional-memory")).toBe(0.05);
    expect(dependencyInterest("p3", events, "conditional-memory")).toBe(0.7);
  });
  it("keeps listener scores public and maximum urgency private to the rambler", () => {
    const ready = dependencyView("p1", packets[0], []);
    const waiting = dependencyView("p2", packets[1], []);
    const observer = dependencyView("p4", undefined, []);
    for (const view of [ready, waiting, observer]) {
      const normal = dependencyBid(view, ids, "cooperative", "conditional-memory");
      const intervention = dependencyBid(view, ids, "max-rambler", "conditional-memory");
      expect(intervention.willingnessToListen).toEqual(normal.willingnessToListen);
      expect(normal.willingnessToListen.every((p) => p.willingness === 0.7)).toBe(true);
      expect(intervention.urge).toBe(view.playerId === "p4" ? 1 : normal.urge);
    }
  });
});
