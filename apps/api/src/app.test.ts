import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { reduceGame } from "@werewolf/engine";
import { buildApi } from "./app";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (apps.length) await apps.pop()!.close();
});

describe("HTTP control surface", () => {
  it("seeds roles, creates a snapshotted game, controls it, and exports research JSON", async () => {
    const built = await buildApi({ databaseUrl: ":memory:" });
    apps.push(built.app);
    const rolesResponse = await built.app.inject({ method: "GET", url: "/api/v1/roles" });
    expect(rolesResponse.statusCode).toBe(200);
    const roles = rolesResponse.json<Array<{ id: string }>>();
    expect(roles.map((role) => role.id)).toContain("werewolf");

    const ids = [
      "werewolf",
      "werewolf",
      "seer",
      "doctor",
      "roleblocker",
      "mayor",
      "villager",
      "villager",
    ];
    const created = await built.app.inject({
      method: "POST",
      url: "/api/v1/games",
      payload: {
        name: "API game",
        deliberation: { maxContextTokens: 8000 },
        seed: "api-seed",
        seats: ids.map((_, index) => ({ id: `p${index}`, name: `P${index}`, personality: "Test" })),
        roleRefs: ids.map((id) => ({ id })),
        revealRolesOnDeath: true,
        moderatorNarration: false,
        discussion: { readyQuorum: 0.67, maxFollowUpsPerPlayer: 2, maxFollowUpSlotsFactor: 0.5 },
        safety: {
          maxCycles: 8,
          maxModelCalls: 500,
          maxOutputTokens: 600,
          maxWallClockMs: 1_800_000,
        },
        speedMs: 0,
        maxTotalTokens: 2_000_000,
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json<{ game: { id: string; config: Record<string, unknown> } }>();
    const gameId = createdBody.game.id;
    expect(createdBody.game.config).toMatchObject({
      protocolVersion: "agent_v3_1",
      rules: { firstCycle: "day_first", revealBallots: true },
      discussion: {
        speakerSelection: "listener_auction",
        speakerBias: 0.25,
        maxParallelDecisions: 4,
      },
      deliberation: { bidReasoningEffort: "medium" },
    });

    const publicView = await built.app.inject({
      method: "GET",
      url: `/api/v1/games/${gameId}?view=public`,
    });
    expect(JSON.stringify(publicView.json())).not.toContain('"role":{"schemaVersion"');

    const control = await built.app.inject({
      method: "POST",
      url: `/api/v1/games/${gameId}/control`,
      payload: { action: "step" },
    });
    expect(control.json()).toMatchObject({ ok: true, status: "stepping" });

    const exported = await built.app.inject({
      method: "GET",
      url: `/api/v1/games/${gameId}/export?format=json`,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({
      schemaVersion: "werewolf_research_bundle_v3_1",
      perspective: "public",
    });

    const interrupted = reduceGame(gameId, built.repository.listEvents(gameId));
    built.repository.appendEvent(gameId, {
      type: "game.budget_exhausted",
      phase: interrupted.phase,
      day: interrupted.day,
      visibility: "public",
      payload: { reason: "total-token admission threshold reached" },
    });
    built.repository.updateGame(gameId, {
      status: "budget_exhausted",
      error: "total-token admission threshold reached",
    });
    const extended = await built.app.inject({
      method: "POST",
      url: `/api/v1/games/${gameId}/control`,
      payload: { action: "extend_budget", maxTotalTokens: 100_000_000, maxWallClockMs: 21_600_000 },
    });
    expect(extended.statusCode).toBe(200);
    expect(extended.json()).toMatchObject({
      ok: true,
      status: "running",
      maxTotalTokens: 100_000_000,
      maxWallClockMs: 21_600_000,
    });
    expect(built.repository.getGame(gameId)?.config).toMatchObject({
      maxTotalTokens: 100_000_000,
      safety: { maxWallClockMs: 21_600_000 },
    });
    expect(reduceGame(gameId, built.repository.listEvents(gameId))).toMatchObject({
      status: "running",
      phase: interrupted.phase,
      config: { maxTotalTokens: 100_000_000, safety: { maxWallClockMs: 21_600_000 } },
    });
    expect(
      (
        built.repository.listEvents(gameId).find((event) => event.type === "game.created")!.payload
          .config as { maxTotalTokens: number }
      ).maxTotalTokens,
    ).toBe(2_000_000);

    const resumed = reduceGame(gameId, built.repository.listEvents(gameId));
    built.repository.appendEvent(gameId, {
      type: "game.paused",
      phase: resumed.phase,
      day: resumed.day,
      visibility: "public",
      payload: { reason: "context_limit: essential authorized facts cannot fit" },
    });
    built.repository.updateGame(gameId, {
      status: "paused",
      error: "context_limit: essential authorized facts cannot fit",
    });
    const contextExtended = await built.app.inject({
      method: "POST",
      url: `/api/v1/games/${gameId}/control`,
      payload: {
        action: "extend_budget",
        maxTotalTokens: 100_000_000,
        maxWallClockMs: 21_600_000,
        maxContextTokens: 16_000,
      },
    });
    expect(contextExtended.statusCode).toBe(200);
    expect(contextExtended.json()).toMatchObject({
      ok: true,
      status: "running",
      maxContextTokens: 16_000,
    });
    expect(reduceGame(gameId, built.repository.listEvents(gameId))).toMatchObject({
      status: "running",
      phase: resumed.phase,
      config: { deliberation: { maxContextTokens: 16_000 } },
    });
  });

  it("freezes Jev selection independently of the player model and rejects invalid thresholds", async () => {
    const built = await buildApi({ databaseUrl: ":memory:" });
    apps.push(built.app);
    const ids = [
      "werewolf",
      "werewolf",
      "seer",
      "doctor",
      "villager",
      "villager",
      "villager",
      "villager",
    ];
    const payload = {
      name: "Jev API",
      seed: "jev-api",
      preset: "standard-8-v2",
      seats: ids.map((_, i) => ({ id: `p${i}`, name: `P${i}` })),
      roleRefs: ids.map((id) => ({ id })),
      decisionEngine: { mode: "jev", model: "jev-latest", reasoningThreshold: 0.6 },
    };
    const created = await built.app.inject({ method: "POST", url: "/api/v1/games", payload });
    expect(created.statusCode).toBe(201);
    expect(created.json().game.config.decisionEngine).toEqual({
      ...payload.decisionEngine,
      workflow: "journal_v4",
    });
    expect(created.json().game.config.modelSettings.p0.model).toBe("fake-model");
    const invalid = await built.app.inject({
      method: "POST",
      url: "/api/v1/games",
      payload: {
        ...payload,
        decisionEngine: { ...payload.decisionEngine, reasoningThreshold: 1.1 },
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("freezes API-backed Luna and a reasoning-inclusive output budget for new games", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OPENAI_MODEL", "gpt-6-luna");
    vi.stubEnv("OPENAI_REASONING_EFFORT", "xhigh");
    const built = await buildApi({ databaseUrl: ":memory:" });
    apps.push(built.app);
    const ids = [
      "werewolf",
      "werewolf",
      "seer",
      "doctor",
      "villager",
      "villager",
      "villager",
      "villager",
    ];
    const response = await built.app.inject({
      method: "POST",
      url: "/api/v1/games",
      payload: {
        name: "API Luna",
        seed: "api-luna",
        preset: "standard-8-v2",
        seats: ids.map((_, i) => ({ id: `p${i}`, name: `P${i}` })),
        roleRefs: ids.map((id) => ({ id })),
        decisionEngine: { mode: "jev" },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().game.config).toMatchObject({
      maxTotalTokens: null,
      deliberation: { maxContextTokens: 32000, maxJournalTokens: 16000 },
      safety: { maxOutputTokens: 8192 },
      modelSettings: { p0: { provider: "openai", model: "gpt-6-luna", reasoningEffort: "xhigh" } },
      decisionEngine: { mode: "jev", workflow: "journal_v4" },
    });
  });

  it("removes a finite token ceiling without rewriting history, and preserves unlimited on replay", async () => {
    const built = await buildApi({ databaseUrl: ":memory:" });
    apps.push(built.app);
    const ids = [
      "werewolf",
      "werewolf",
      "seer",
      "doctor",
      "villager",
      "villager",
      "villager",
      "villager",
    ];
    const created = await built.app.inject({
      method: "POST",
      url: "/api/v1/games",
      payload: {
        name: "Unlimited",
        seed: "unlimited",
        maxTotalTokens: 1_000,
        seats: ids.map((_, i) => ({ id: `p${i}`, name: `P${i}` })),
        roleRefs: ids.map((id) => ({ id })),
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().game.id;
    await built.app.inject({
      method: "POST",
      url: `/api/v1/games/${id}/control`,
      payload: { action: "start" },
    });
    const state = reduceGame(id, built.repository.listEvents(id));
    built.repository.appendEvent(id, {
      type: "game.budget_exhausted",
      phase: state.phase,
      day: state.day,
      visibility: "public",
      payload: { reason: "total-token admission threshold reached" },
    });
    built.repository.updateGame(id, {
      status: "budget_exhausted",
      error: "total-token admission threshold reached",
    });
    const extended = await built.app.inject({
      method: "POST",
      url: `/api/v1/games/${id}/control`,
      payload: { action: "extend_budget", maxTotalTokens: null, maxWallClockMs: 1_800_000 },
    });
    expect(extended.statusCode).toBe(200);
    expect(built.repository.getGame(id)?.config).toMatchObject({ maxTotalTokens: null });
    expect(reduceGame(id, built.repository.listEvents(id)).config).toMatchObject({
      maxTotalTokens: null,
    });
    expect(
      (
        built.repository.listEvents(id).find((event) => event.type === "game.created")!.payload
          .config as { maxTotalTokens: number }
      ).maxTotalTokens,
    ).toBe(1_000);
    built.repository.appendEvent(id, {
      type: "game.budget_exhausted",
      phase: state.phase,
      day: state.day,
      visibility: "public",
      payload: { reason: "active-runtime limit reached" },
    });
    built.repository.updateGame(id, { status: "budget_exhausted" });
    const reduced = await built.app.inject({
      method: "POST",
      url: `/api/v1/games/${id}/control`,
      payload: { action: "extend_budget", maxTotalTokens: 100_000_000, maxWallClockMs: 3_600_000 },
    });
    expect(reduced.statusCode).toBe(400);
    expect(reduced.json().error).toBe("limit_extension_cannot_reduce_limits");
  });

  it("rejects invalid role counts", async () => {
    const built = await buildApi({ databaseUrl: ":memory:" });
    apps.push(built.app);
    const response = await built.app.inject({
      method: "POST",
      url: "/api/v1/games",
      payload: {
        name: "Bad",
        seed: "bad",
        seats: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, name: `P${index}` })),
        roleRefs: [{ id: "werewolf" }],
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
