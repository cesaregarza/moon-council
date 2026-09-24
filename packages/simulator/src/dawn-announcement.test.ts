import { describe, expect, it } from "vitest";
import type { GameEventV1 } from "@werewolf/contracts";
import { overnightEliminations } from "./orchestrator-v2";

function elimination(day: number, phase: string, playerId: string): GameEventV1 {
  return {
    schemaVersion: "game_event_v1", id: `${phase}-${day}-${playerId}`, gameId: "game", sequence: day * 10,
    type: "player.eliminated", phase: phase as GameEventV1["phase"], day, visibility: "public", audienceIds: [],
    payload: { playerId, playerName: playerId, roleName: "Villager", cause: phase === "day_vote" ? "vote" : "night" },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("dawn announcement", () => {
  // The live pilot reported "Dawn: nobody died overnight" after both nights that had a
  // kill, because the day counter advances before the announcement is built.
  it("finds a day-first night kill under the previous day", () => {
    const events = [elimination(4, "night_resolution", "p3")];
    const found = overnightEliminations(events, 5, "day_first");
    expect(found.map((event) => event.payload.playerId)).toEqual(["p3"]);
  });

  it("finds a night-first kill under the same day", () => {
    const events = [elimination(4, "night_resolution", "p3")];
    expect(overnightEliminations(events, 4, "night_first").map((e) => e.payload.playerId)).toEqual(["p3"]);
    expect(overnightEliminations(events, 5, "night_first")).toEqual([]);
  });

  it("never reports the day's own vote as an overnight death", () => {
    const events = [elimination(4, "day_vote", "p8"), elimination(4, "night_resolution", "p3")];
    const found = overnightEliminations(events, 5, "day_first");
    expect(found.map((event) => event.payload.playerId)).toEqual(["p3"]);
  });

  it("reports a quiet night as empty", () => {
    expect(overnightEliminations([elimination(2, "night_resolution", "p7")], 5, "day_first")).toEqual([]);
  });
});
