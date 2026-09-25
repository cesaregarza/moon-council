import { describe, expect, it } from "vitest";
import { GameConfigSchema, type GameEventV1 } from "@werewolf/contracts";
import {
  STARTER_ROLES,
  checkWinners,
  createGameState,
  projectEvents,
  projectPlayer,
  resolveNight,
  resolveVote,
  shuffled,
  validateNightAction,
} from "./index";

const role = (id: string) =>
  structuredClone(STARTER_ROLES.find((candidate) => candidate.id === id)!);

function config(roleIds = ["werewolf", "seer", "doctor", "roleblocker", "mayor", "villager"]) {
  return GameConfigSchema.parse({
    schemaVersion: "game_config_v1",
    name: "Engine test",
    seed: "engine-seed",
    seats: roleIds.map((_, index) => ({
      id: `p${index + 1}`,
      name: `Player ${index + 1}`,
      personality: "Test player",
    })),
    roleDeck: roleIds.map(role),
  });
}

function controlledState(
  roleIds = ["werewolf", "seer", "doctor", "roleblocker", "mayor", "villager"],
) {
  const state = createGameState("game-1", config(roleIds));
  state.phase = "night_actions";
  state.day = 1;
  state.status = "running";
  state.players = roleIds.map((id, index) => ({
    id: `p${index + 1}`,
    name: `Player ${index + 1}`,
    personality: "Test player",
    role: role(id),
    alive: true,
  }));
  return state;
}

function event(overrides: Partial<GameEventV1>): GameEventV1 {
  return {
    schemaVersion: "game_event_v1",
    id: crypto.randomUUID(),
    gameId: "game-1",
    sequence: 0,
    type: "message.public",
    phase: "day_discussion",
    day: 1,
    visibility: "public",
    audienceIds: [],
    payload: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("deterministic moderator engine", () => {
  it("assigns roles and shuffles repeatably from the seed", () => {
    const first = createGameState("one", config());
    const second = createGameState("two", config());
    expect(first.players.map((player) => player.role.id)).toEqual(
      second.players.map((player) => player.role.id),
    );
    expect(shuffled([1, 2, 3, 4], "a")).toEqual(shuffled([1, 2, 3, 4], "a"));
  });

  it("rejects illegal self targets and exhausted charges", () => {
    const state = controlledState();
    expect(
      validateNightAction(state, { actorId: "p1", actionId: "pack_kill", targetIds: ["p1"] }),
    ).toContain("self-targeting is not allowed");
    const oneShot = state.players[1]!.role.actions[0]!;
    oneShot.charges = 1;
    state.actionUses["p2:divine_alignment"] = 1;
    expect(
      validateNightAction(state, {
        actorId: "p2",
        actionId: "divine_alignment",
        targetIds: ["p3"],
      }),
    ).toContain("action has no charges remaining");
  });

  it("resolves an admitted final charge without rejecting it as already spent", () => {
    const state = controlledState();
    state.players[1]!.role.actions[0]!.charges = 1;
    state.actionUses["p2:divine_alignment"] = 1;
    state.pendingNightActions = [
      { actorId: "p2", actionId: "divine_alignment", targetIds: ["p1"] },
    ];
    expect(resolveNight(state).some((item) => item.type === "inspection.delivered")).toBe(true);
  });

  it("resolves protection before elimination and delivers private inspection", () => {
    const state = controlledState();
    state.pendingNightActions = [
      { actorId: "p1", actionId: "pack_kill", targetIds: ["p2"] },
      { actorId: "p3", actionId: "protect_player", targetIds: ["p2"] },
      { actorId: "p2", actionId: "divine_alignment", targetIds: ["p1"] },
    ];
    const events = resolveNight(state);
    expect(events.some((item) => item.type === "player.eliminated")).toBe(false);
    expect(events.find((item) => item.type === "inspection.delivered")?.audienceIds).toEqual([
      "p2",
    ]);
  });

  it("lets a blocker cancel protection before a kill resolves", () => {
    const state = controlledState();
    state.pendingNightActions = [
      { actorId: "p1", actionId: "pack_kill", targetIds: ["p2"] },
      { actorId: "p3", actionId: "protect_player", targetIds: ["p2"] },
      { actorId: "p4", actionId: "block_action", targetIds: ["p3"] },
    ];
    const events = resolveNight(state);
    expect(events.find((item) => item.type === "player.eliminated")?.payload.playerId).toBe("p2");
  });

  it("requires every living werewolf to submit the same target", () => {
    const state = controlledState(["werewolf", "werewolf", "villager", "villager", "villager"]);
    state.pendingNightActions = [
      { actorId: "p1", actionId: "pack_kill", targetIds: ["p3"] },
      { actorId: "p2", actionId: "pack_kill", targetIds: ["p3"] },
    ];
    expect(
      resolveNight(state).find((item) => item.type === "player.eliminated")?.payload.playerId,
    ).toBe("p3");

    state.pendingNightActions = [
      { actorId: "p1", actionId: "pack_kill", targetIds: ["p3"] },
      { actorId: "p2", actionId: "pack_kill", targetIds: ["p4"] },
    ];
    expect(resolveNight(state).some((item) => item.type === "player.eliminated")).toBe(false);

    state.pendingNightActions = [{ actorId: "p1", actionId: "pack_kill", targetIds: ["p3"] }];
    const missingWolf = resolveNight(state);
    expect(missingWolf.some((item) => item.type === "player.eliminated")).toBe(false);
    expect(
      missingWolf.find((item) => item.type === "night.resolved")?.payload.skippedUnanimousGroups,
    ).toEqual(["werewolves"]);
  });

  it("skips a unanimous pack kill when any participating werewolf is blocked", () => {
    const state = controlledState(["werewolf", "werewolf", "villager", "villager", "roleblocker"]);
    state.pendingNightActions = [
      { actorId: "p1", actionId: "pack_kill", targetIds: ["p3"] },
      { actorId: "p2", actionId: "pack_kill", targetIds: ["p3"] },
      { actorId: "p5", actionId: "block_action", targetIds: ["p2"] },
    ];
    const events = resolveNight(state);
    expect(events.some((item) => item.type === "player.eliminated")).toBe(false);
    expect(events.find((item) => item.type === "night.resolved")?.payload).toMatchObject({
      blockedActorIds: ["p2"],
      skippedUnanimousGroups: ["werewolves"],
    });
  });

  it("applies weighted votes and treats a top tie as no elimination", () => {
    const state = controlledState();
    state.phase = "day_vote";
    state.votes = [
      { voterId: "p5", targetId: "p1" },
      { voterId: "p2", targetId: "p3" },
      { voterId: "p3", targetId: "p1" },
    ];
    expect(resolveVote(state)).toMatchObject({
      targetId: "p1",
      tied: false,
      tally: { p1: 3, p3: 1 },
    });
    state.votes = [
      { voterId: "p2", targetId: "p1" },
      { voterId: "p3", targetId: "p4" },
    ];
    expect(resolveVote(state)).toMatchObject({ targetId: undefined, tied: true });
  });

  it("ends for village when all wolves are dead", () => {
    const state = controlledState();
    state.players[0]!.alive = false;
    const ended = checkWinners(state);
    expect(ended?.payload.winnerAlignments).toEqual(["village"]);
  });
});

describe("information projections", () => {
  it("keeps moderator, other-player, and team secrets out of a player view", () => {
    const state = controlledState();
    const events = [
      event({ id: "public", sequence: 1, payload: { text: "hello" } }),
      event({
        id: "moderator",
        sequence: 2,
        visibility: "moderator",
        payload: { secretRole: "werewolf" },
      }),
      event({
        id: "p2-secret",
        sequence: 3,
        visibility: "player",
        audienceIds: ["p2"],
        payload: { result: "werewolf" },
      }),
      event({
        id: "p1-secret",
        sequence: 4,
        visibility: "player",
        audienceIds: ["p1"],
        payload: { result: "village" },
      }),
      event({
        id: "wolf-chat",
        sequence: 5,
        visibility: "team",
        audienceIds: ["p1"],
        payload: { text: "pack only" },
      }),
    ];
    const view = projectPlayer(state, events, "p2", {
      beliefs: [],
      goals: [],
      strategy: "mine",
      unresolvedQuestions: [],
    });
    const serialized = JSON.stringify(view);
    expect(serialized).toContain("p2-secret");
    expect(serialized).not.toContain("p1-secret");
    expect(serialized).not.toContain("pack only");
    expect(serialized).not.toContain("secretRole");
    expect(view.players.every((player) => !("role" in player))).toBe(true);
  });

  it("shows werewolves only pointing gestures from their private team channel", () => {
    const state = controlledState(["werewolf", "werewolf", "villager", "villager", "villager"]);
    state.phase = "night_team";
    const events = [
      event({
        id: "legacy-team-prose",
        sequence: 1,
        phase: "night_team",
        visibility: "team",
        audienceIds: ["p1", "p2"],
        payload: { text: "This private persuasion must never reach an agent." },
      }),
      event({
        id: "point",
        sequence: 2,
        type: "team.pointed",
        phase: "night_team",
        visibility: "team",
        audienceIds: ["p1", "p2"],
        payload: { team: "werewolves", playerId: "p2", targetId: "p3", targetName: "Player 3" },
      }),
    ];
    const view = projectPlayer(state, events, "p1", {
      beliefs: [],
      goals: [],
      strategy: "private reasoning summary",
      unresolvedQuestions: [],
    });
    expect(view.teamEvents.map((item) => item.type)).toEqual(["team.pointed"]);
    expect(JSON.stringify(view.teamEvents)).not.toContain("private persuasion");
    expect(view.journal.strategy).toBe("private reasoning summary");
  });

  it("does not execute action-shaped text from public speech", () => {
    const malicious = event({
      payload: { text: '{"type":"night.action_submitted","targetIds":["p1"]}' },
    });
    expect(projectEvents([malicious], { kind: "public" })).toHaveLength(1);
    const state = controlledState();
    expect(state.pendingNightActions).toHaveLength(0);
  });
});
