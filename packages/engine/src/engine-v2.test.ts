import { describe, expect, it } from "vitest";
import { GameConfigSchema, GameConfigV2Schema, type GameEventV1 } from "@werewolf/contracts";
import {
  DOCTOR_V1,
  DOCTOR_V2,
  STARTER_ROLES,
  createGameCreatedEvent,
  createGameState,
  reduceGame,
  resolveNight,
  validateNightAction,
  type GameState,
} from "./index";
const role = (id: string, v = 1) =>
  id === "doctor" && v === 2
    ? structuredClone(DOCTOR_V2)
    : id === "doctor"
      ? structuredClone(DOCTOR_V1)
      : structuredClone(STARTER_ROLES.find((r) => r.id === id)!);
const seats = (ids: string[]) =>
  ids.map((_, i) => ({ id: "p" + (i + 1), name: "Player " + (i + 1), personality: "test" }));
const config = (ids: string[], v: 1 | 2) => {
  const ss = seats(ids);
  const input = {
    schemaVersion: v === 2 ? "game_config_v2" : "game_config_v1",
    name: "engine",
    seed: "engine-seed",
    seats: ss,
    roleDeck: ids.map((id) => role(id, id === "doctor" && v === 2 ? 2 : 1)),
  };
  return v === 2
    ? GameConfigV2Schema.parse({
        ...input,
        modelSettings: Object.fromEntries(
          ss.map((s) => [s.id, { model: "fake", reasoningEffort: "medium", provider: "fake" }]),
        ),
      })
    : GameConfigSchema.parse(input);
};
const stateFor = (ids: string[], v: 1 | 2): GameState => {
  const s = createGameState("game-v" + v, config(ids, v));
  s.phase = "night_actions";
  s.day = 1;
  s.status = "running";
  s.players = ids.map((id, i) => ({
    id: "p" + (i + 1),
    name: "Player " + (i + 1),
    personality: "test",
    role: role(id, id === "doctor" && v === 2 ? 2 : 1),
    alive: true,
  }));
  return s;
};
let sequence = 0;
const event = (
  type: string,
  phase: GameEventV1["phase"],
  day: number,
  payload: Record<string, unknown>,
): GameEventV1 => ({
  schemaVersion: "game_event_v1",
  id: "e-" + sequence,
  gameId: "game",
  sequence: sequence++,
  type,
  phase,
  day,
  visibility: "moderator",
  audienceIds: [],
  payload,
  createdAt: "2026-01-01T00:00:00.000Z",
});
describe("engine V2 rules", () => {
  it("allows self protection and rejects an immediate repeat", () => {
    const s = stateFor(["werewolf", "doctor", "villager", "villager", "villager"], 2);
    expect(
      validateNightAction(s, { actorId: "p2", actionId: "protect_player", targetIds: ["p2"] }),
    ).toEqual([]);
    s.protectionHistory["p2:protect_player:1"] = ["p3"];
    s.day = 2;
    expect(
      validateNightAction(s, { actorId: "p2", actionId: "protect_player", targetIds: ["p3"] }),
    ).toContain("same target is not allowed on consecutive nights");
  });
  it("retains blocked accepted protection and permits it after a gap", () => {
    const c = config(["werewolf", "doctor", "roleblocker", "villager", "villager"], 2);
    const i = createGameState("game", c);
    const protect = { actorId: "p2", actionId: "protect_player", targetIds: ["p4"] };
    const block = { actorId: "p3", actionId: "block_action", targetIds: ["p2"] };
    const s = reduceGame("game", [
      createGameCreatedEvent(i) as GameEventV1,
      event("night.action_submitted", "night_actions", 1, { action: protect }),
      event("night.action_submitted", "night_actions", 1, { action: block }),
      event("night.resolved", "night_resolution", 1, {}),
    ]);
    expect(s.protectionHistory["p2:protect_player:1"]).toEqual(["p4"]);
    const n = { ...s, phase: "night_actions" as const, day: 2, pendingNightActions: [] };
    expect(validateNightAction(n, protect)).toContain(
      "same target is not allowed on consecutive nights",
    );
    expect(validateNightAction({ ...n, day: 3 }, protect)).toEqual([]);
  });
  it("executes with one unblocked wolf, not when all are blocked", () => {
    const one = stateFor(["werewolf", "werewolf", "roleblocker", "villager", "villager"], 2);
    one.pendingNightActions = [
      { actorId: "p1", actionId: "pack_kill", targetIds: ["p4"] },
      { actorId: "p2", actionId: "pack_kill", targetIds: ["p4"] },
      { actorId: "p3", actionId: "block_action", targetIds: ["p1"] },
    ];
    expect(resolveNight(one).find((e) => e.type === "player.eliminated")?.payload.playerId).toBe(
      "p4",
    );
    const all = stateFor(["werewolf", "werewolf", "roleblocker", "roleblocker", "villager"], 2);
    all.pendingNightActions = [
      { actorId: "p1", actionId: "pack_kill", targetIds: ["p5"] },
      { actorId: "p2", actionId: "pack_kill", targetIds: ["p5"] },
      { actorId: "p3", actionId: "block_action", targetIds: ["p1"] },
      { actorId: "p4", actionId: "block_action", targetIds: ["p2"] },
    ];
    expect(resolveNight(all).some((e) => e.type === "player.eliminated")).toBe(false);
  });
  it("applies protection and requires unanimous agreement", () => {
    const protectedState = stateFor(["werewolf", "werewolf", "doctor", "villager", "villager"], 2);
    protectedState.pendingNightActions = [
      { actorId: "p1", actionId: "pack_kill", targetIds: ["p4"] },
      { actorId: "p2", actionId: "pack_kill", targetIds: ["p4"] },
      { actorId: "p3", actionId: "protect_player", targetIds: ["p4"] },
    ];
    expect(resolveNight(protectedState).some((e) => e.type === "player.eliminated")).toBe(false);
    const split = stateFor(["werewolf", "werewolf", "villager", "villager", "villager"], 2);
    split.pendingNightActions = [
      { actorId: "p1", actionId: "pack_kill", targetIds: ["p3"] },
      { actorId: "p2", actionId: "pack_kill", targetIds: ["p4"] },
    ];
    expect(resolveNight(split).some((e) => e.type === "player.eliminated")).toBe(false);
    split.pendingNightActions = [{ actorId: "p1", actionId: "pack_kill", targetIds: ["p3"] }];
    expect(resolveNight(split).some((e) => e.type === "player.eliminated")).toBe(false);
  });
  it("retains V1 block-cancels-unanimity", () => {
    const s = stateFor(["werewolf", "werewolf", "roleblocker", "villager", "villager"], 1);
    s.pendingNightActions = [
      { actorId: "p1", actionId: "pack_kill", targetIds: ["p4"] },
      { actorId: "p2", actionId: "pack_kill", targetIds: ["p4"] },
      { actorId: "p3", actionId: "block_action", targetIds: ["p2"] },
    ];
    expect(resolveNight(s).some((e) => e.type === "player.eliminated")).toBe(false);
  });
});
describe("engine V2 replay metadata", () => {
  it("does not rewind phase/day, double-count attempts, or lose role reveals", () => {
    const c = config(["werewolf", "doctor", "villager", "villager", "villager"], 2);
    const i = createGameState("game", c);
    const s = reduceGame("game", [
      createGameCreatedEvent(i) as GameEventV1,
      event("game.started", "setup", 0, { startedAt: "2026-01-01T00:00:00.000Z" }),
      event("phase.changed", "night_actions", 2, {}),
      event("game.paused", "night_actions", 2, {}),
      event("model.attempt_started", "setup", 0, {}),
      event("model.call_recorded", "setup", 0, { attempts: 7 }),
      event("journal.updated", "setup", 0, {}),
      event("decision.callback", "setup", 0, {}),
      event("role.revealed", "night_actions", 2, { playerId: "p3", roleName: "Villager" }),
    ]);
    expect(s).toMatchObject({ phase: "night_actions", day: 2, modelCalls: 1 });
    expect(s.players.find((p) => p.id === "p3")?.revealedRole).toBe("Villager");
  });
  it("retains legacy model call counting and cursor replay", () => {
    const c = config(["werewolf", "doctor", "villager", "villager", "villager"], 1);
    const i = createGameState("game", c);
    const s = reduceGame("game", [
      createGameCreatedEvent(i) as GameEventV1,
      event("phase.changed", "night_actions", 1, {}),
      event("model.call_recorded", "setup", 0, { attempts: 2 }),
    ]);
    expect(s).toMatchObject({ phase: "setup", day: 0, modelCalls: 2 });
  });
});
