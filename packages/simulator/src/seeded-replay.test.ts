import { afterEach, describe, expect, it } from "vitest";
import { GameConfigV2Schema, type GameEventV1 } from "@werewolf/contracts";
import { LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { AskJevProvider, FakeDecisionProvider, type JevRequest } from "@werewolf/llm";
import { V2GameOrchestrator } from "./orchestrator-v2";
import { actorConfig } from "./testing/actor-fixtures";

/**
 * CES-1558: a seeded game replays identically when its providers are scripted. The speaker
 * auction breaks ties with a seeded order, so a tied auction must be decided by the seed and the
 * game's own history, never by a random event ID.
 */
const connections: DatabaseConnection[] = [];
afterEach(() => {
  while (connections.length) connections.pop()!.close();
});

const AUCTIONS = 3;

/**
 * Jev answering every question the same way for every seat: each score at the same level, so
 * every speaker's urge and every listener's interest tie, and each choice is the first option.
 */
const tiedJev = () =>
  new AskJevProvider(async (input) => {
    const request = JSON.parse(input) as JevRequest;
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([key, q]) => {
        if (q.type === "noul") return [key, { type: "noul", noul: 0 }];
        if (q.type === "score")
          return [
            key,
            {
              type: "score",
              score: 3,
              confidence: 1,
              probabilities: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0 },
            },
          ];
        const handles = Object.keys(q.criteria as Record<string, unknown>);
        const probabilities = Object.fromEntries(
          handles.map((h, i) => [h, i === 0 ? 0.9 : 0.1 / (handles.length - 1)]),
        );
        return [key, { type: "choice", choice: handles[0], confidence: 1, probabilities }];
      }),
    );
    return JSON.stringify({ model: "fake", usage: { input_tokens: 1, output_tokens: 1 }, answers });
  });

/** Plays the seeded game from the start until it has resolved AUCTIONS speaker auctions. */
async function play(): Promise<GameEventV1[]> {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  const repository = new LabRepository(connection);
  const game = repository.createGame(actorConfig());
  new V2GameOrchestrator(repository, new FakeDecisionProvider()).initialize(game.id);
  const runner = new V2GameOrchestrator(repository, new FakeDecisionProvider(), tiedJev());
  repository.updateGame(game.id, { status: "running" });
  const auctions = () =>
    repository.listEvents(game.id).filter((e) => e.type === "discussion.auction_resolved").length;
  for (let step = 0; step < 200 && auctions() < AUCTIONS; step += 1)
    await runner.runGameStep(game.id);
  return repository.listEvents(game.id);
}

/** Random IDs: UUIDs and 32-hex IDs. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{32}\b/g;
/** A view ID hashes a packet that holds source event IDs, so it differs with them; masked by name. */
const VIEW_ID = /"viewId":"([0-9a-f]{64})"/g;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** Measured wall-clock durations, which no two runs share. */
const DURATION = /"(latencyMs|elapsedMs|durationMs)":\d+/g;

/**
 * The run's events with every random ID and view ID renamed by first appearance (so two runs
 * compare equal exactly when they differ only in those), and wall-clock times and durations
 * masked. Other hashes, such as journal evidence revisions, are compared as they are.
 */
function apartFromIds(events: GameEventV1[]) {
  const names = new Map<string, string>();
  const text = JSON.stringify(
    events.map(({ id, gameId, createdAt: _createdAt, ...event }) => ({ id, gameId, ...event })),
  )
    .replace(UUID, (raw) => {
      if (!names.has(raw)) names.set(raw, `id${names.size}`);
      return names.get(raw)!;
    })
    .replace(VIEW_ID, (_match, raw: string) => {
      if (!names.has(raw)) names.set(raw, `view${names.size}`);
      return `"viewId":"${names.get(raw)!}"`;
    })
    .replace(TIME, "<time>")
    .replace(DURATION, '"$1":0');
  return JSON.parse(text) as unknown[];
}

/**
 * Plays the seeded game to its end: a win, or its one day/night cycle (a night, a day of
 * reflection, speeches and auctions, and a vote). Both are decided by the game itself; the
 * wall-clock limit is raised so elapsed time can never stop one run early.
 */
async function playToEnd(): Promise<{ events: GameEventV1[]; ended: boolean }> {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  const repository = new LabRepository(connection);
  const config = GameConfigV2Schema.parse({
    ...actorConfig(),
    safety: {
      ...actorConfig().safety,
      maxCycles: 1,
      maxModelCalls: 10_000,
      maxWallClockMs: 86_400_000,
    },
  });
  const game = repository.createGame(config);
  new V2GameOrchestrator(repository, new FakeDecisionProvider()).initialize(game.id);
  const runner = new V2GameOrchestrator(repository, new FakeDecisionProvider(), tiedJev());
  repository.updateGame(game.id, { status: "running" });
  const ended = () =>
    repository
      .listEvents(game.id)
      .some((e) => e.type === "game.ended" || e.type === "game.budget_exhausted");
  for (let step = 0; step < 2_000 && !ended(); step += 1) await runner.runGameStep(game.id);
  return { events: repository.listEvents(game.id), ended: ended() };
}

const resolved = (events: GameEventV1[]) =>
  events.filter((e) => e.type === "discussion.auction_resolved");

describe("seeded replay", () => {
  it("decides tied speaker auctions the same way in two runs of one seeded game", async () => {
    const first = await play();
    const second = await play();
    const auctions = resolved(first);
    expect(auctions.length).toBeGreaterThanOrEqual(AUCTIONS);
    // The script ties the auction: the two best candidates have the same priority.
    const scores = auctions[0]!.payload.scores as { playerId: string; priority: number }[];
    expect(scores.length).toBeGreaterThan(1);
    expect(scores[0]!.priority).toBe(scores[1]!.priority);
    // The same winners, auction by auction.
    const winners = (events: GameEventV1[]) =>
      resolved(events).map((e) => e.payload.selectedPlayerId);
    expect(winners(second)).toEqual(winners(first));
    // And the same game, event by event, apart from IDs.
    expect(apartFromIds(second)).toEqual(apartFromIds(first));
  }, 180_000);

  it("replays the whole seeded game identically, apart from IDs, times and durations", async () => {
    const first = await playToEnd();
    const second = await playToEnd();
    expect(first.ended).toBe(true);
    expect(second.ended).toBe(true);
    expect(apartFromIds(second.events)).toEqual(apartFromIds(first.events));
  }, 600_000);
});
