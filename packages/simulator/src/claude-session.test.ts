import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GameConfigV2Schema,
  emptyJournalV2,
  type GameEventV1,
  type PrivateJournalV2,
} from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { createGameState, DOCTOR_V2, STARTER_ROLES } from "@werewolf/engine";
import {
  AnthropicMessagesProvider,
  ClaudeSpendLedger,
  FakeDecisionProvider,
  claudeRequest,
} from "@werewolf/llm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduceGame } from "@werewolf/engine";
import { DecisionExecutorV2, type ExecuteDecisionOptions } from "./decisions-v2";
import { V2GameOrchestrator } from "./orchestrator-v2";
import { normalizeV31Submission, validateV31Submission } from "./request-v3-1";
import type { DecisionOpportunityV1 } from "@werewolf/contracts";
import { claudeSessionAccounting } from "../../../scripts/cache-audit";
import { ClaudeSessions } from "./claude-session";
import { buildContextV2 } from "./context-v2";
import { decisionRequestV32, v31ApiResponseFormat } from "./request-v3-1";
import type { V3TaskSpec } from "./request-v3";
import { actorConfig } from "./testing/actor-fixtures";

const connections: DatabaseConnection[] = [];
afterEach(() => {
  vi.useRealTimers();
  while (connections.length) connections.pop()!.close();
});

const CANARY = {
  inspection: "CANARY-INSPECTION-41c",
  team: "CANARY-TEAM-83f",
  journal: "CANARY-JOURNAL-5d2",
  public: "CANARY-PUBLIC-0e9",
};
const MODEL = "claude-haiku-5-5";

function sessionConfig(overrides: Record<string, unknown> = {}) {
  return GameConfigV2Schema.parse({
    ...actorConfig(),
    protocolVersion: "agent_claude_session_v1",
    maxSpendUsd: 5,
    modelSettings: Object.fromEntries(
      actorConfig().seats.map((seat) => [
        seat.id,
        { model: MODEL, provider: "anthropic", reasoningEffort: "medium" },
      ]),
    ),
    ...overrides,
  });
}

/** A two-day game written event by event, with private canaries for the seer and the wolves. */
function scriptedGame() {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  const repository = new LabRepository(connection);
  repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
  const config = sessionConfig();
  const game = repository.createGame(config);
  const state = createGameState(game.id, config);
  const seer = state.players.find((p) => p.role.id === "seer")!.id;
  const wolves = state.players.filter((p) => p.role.alignment === "werewolf").map((p) => p.id);
  const villager = state.players.find((p) => p.role.id === "villager")!.id;
  const events: GameEventV1[] = [];
  const push = (
    type: string,
    payload: Record<string, unknown>,
    day: number,
    visibility: GameEventV1["visibility"] = "public",
    audienceIds: string[] = [],
  ) =>
    events.push({
      schemaVersion: "game_event_v1",
      id: `e${events.length + 1}`,
      gameId: game.id,
      sequence: events.length + 1,
      type,
      phase: "day_discussion",
      day,
      visibility,
      audienceIds,
      payload,
      createdAt: "2026-10-22T00:00:00.000Z",
    });
  const speech = (playerId: string, day: number, text = "I have a read.") =>
    push("speech.public", { playerId, text, acts: [], respondsTo: [], closing: false }, day);
  return {
    repository,
    store: new DecisionStore(repository),
    gameId: game.id,
    state,
    events,
    seer,
    wolves,
    villager,
    speech,
    secrets() {
      push(
        "inspection.delivered",
        { actorId: seer, targetId: wolves[0], targetName: CANARY.inspection, result: "werewolf" },
        1,
        "player",
        [seer],
      );
      push("team.point", { playerId: wolves[0], targetId: CANARY.team }, 1, "team", wolves);
    },
  };
}
type Game = ReturnType<typeof scriptedGame>;

/** One reflection call: the v3.2 request re-packed by the session, sent through claudeRequest. */
function call(
  game: Game,
  sessions: ClaudeSessions,
  seat: string,
  day: number,
  options: { effort?: string; journal?: PrivateJournalV2 } = {},
) {
  game.state.day = day;
  game.state.phase = "day_discussion";
  const packet = buildContextV2(
    game.state,
    game.events,
    seat,
    options.journal ?? emptyJournalV2(),
    `k${game.events.length}`,
    "pass",
  );
  const task: V3TaskSpec = { type: "journal_update", revision: "r", sourceIds: [] };
  const prepared = decisionRequestV32(packet, task, true, null, null);
  const format = v31ApiResponseFormat(packet, task)!;
  const turn = sessions.begin({
    gameId: game.gameId,
    playerId: seat,
    packet,
    model: MODEL,
    effort: options.effort ?? "medium",
    kind: "journal_update_v3_2",
    instructions: prepared.prompt.instructions,
    formatInstructions: format.instructions,
    requestInput: prepared.prompt.input,
  });
  const body = claudeRequest(
    {
      kind: "decision_v3_1",
      model: MODEL,
      schemaName: "journal_update",
      schema: format.schema,
      apiResponseFormat: format,
      maxOutputTokens: 4_000,
      reasoningEffort: turn.effort,
      claudeHarness: turn.harness,
    },
    16_000,
  );
  return { turn, body, text: JSON.stringify(body) };
}

let replies = 0;
function answer(turn: ReturnType<typeof call>["turn"], inputTokens = 2_000) {
  replies += 1;
  turn.commit({
    content: [
      { type: "thinking", thinking: "", signature: `signature-${replies}` },
      { type: "text", text: `{"reply":${replies}}`, citations: null },
    ],
    stopReason: "end_turn",
    usage: {
      inputTokens,
      outputTokens: 120,
      totalTokens: inputTokens + 120,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: null,
    },
  });
}

/** Moving cache markers are not part of the cached prefix; strip them before comparing. */
function unmarked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unmarked);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, unmarked(item)]),
  );
}
const settings = (body: ReturnType<typeof call>["body"]) => ({
  model: body.model,
  max_tokens: body.max_tokens,
  thinking: body.thinking,
  output_config: body.output_config,
  cache_control: body.cache_control,
});
const lastTurn = (body: ReturnType<typeof call>["body"]) => {
  const content = body.messages.at(-1)!.content as { text: string }[];
  return content[0]!.text;
};

describe("Claude session harness", () => {
  it("keeps each request an exact prefix of the next within a session, in event order", () => {
    const game = scriptedGame();
    const sessions = new ClaudeSessions(game.store);
    game.speech(game.wolves[0]!, 1);
    const bodies: ReturnType<typeof call>["body"][] = [];
    for (let i = 0; i < 3; i += 1) {
      const step = call(game, sessions, game.villager, 1);
      bodies.push(step.body);
      answer(step.turn);
      game.speech(game.seer, 1, `point ${i}`);
      game.speech(game.wolves[1]!, 1, `reply ${i}`);
    }
    for (let i = 1; i < bodies.length; i += 1) {
      const earlier = bodies[i - 1]!,
        later = bodies[i]!;
      expect(settings(later)).toEqual(settings(earlier));
      expect(unmarked(later.system)).toEqual(unmarked(earlier.system));
      const head = later.messages.slice(0, earlier.messages.length);
      expect(JSON.stringify(unmarked(head))).toBe(JSON.stringify(unmarked(earlier.messages)));
    }
    // New records arrive oldest first: handles rise within each turn.
    for (const body of bodies.slice(1)) {
      const records = JSON.parse(lastTurn(body).split("\n")[0]!).NEW_RECORDS as {
        handle: string;
      }[];
      const numbers = records.map((record) => Number(record.handle.slice(1)));
      expect(records.length).toBeGreaterThan(1);
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    }
    // Day 2 opens a new session: the history does not carry over.
    const nextDay = call(game, sessions, game.villager, 2).body;
    expect(nextDay.messages).toHaveLength(2);
  });

  it("shares both system blocks across seats, and changes block 2 only at day start", () => {
    const game = scriptedGame();
    const sessions = new ClaudeSessions(game.store);
    const dayOne = [game.villager, game.seer].map((seat) => call(game, sessions, seat, 1).body);
    expect(dayOne[0]!.system).toEqual(dayOne[1]!.system);
    game.speech(game.villager, 1, "Day one ends.");
    const dayTwo = [game.villager, game.seer].map((seat) => call(game, sessions, seat, 2).body);
    expect(dayTwo[0]!.system).toEqual(dayTwo[1]!.system);
    const [oneA, oneB] = dayOne[0]!.system as { text: string }[];
    const [twoA, twoB] = dayTwo[0]!.system as { text: string }[];
    expect(twoA).toEqual(oneA);
    expect(twoB).not.toEqual(oneB);
    expect(twoB!.text).toContain("Day one ends.");
  });

  it("never shows another seat's inspection, pack points or journal; public records appear", () => {
    const game = scriptedGame();
    const sessions = new ClaudeSessions(game.store);
    game.secrets();
    game.speech(game.wolves[0]!, 1, CANARY.public);
    const seerJournal = { ...emptyJournalV2(), text: CANARY.journal };
    const seerTurn = call(game, sessions, game.seer, 1, { journal: seerJournal });
    answer(seerTurn.turn);
    const villagerTexts = [call(game, sessions, game.villager, 1).text];
    game.state.day = 2;
    villagerTexts.push(call(game, sessions, game.villager, 2).text);
    for (const text of villagerTexts) {
      expect(text).not.toContain(CANARY.inspection);
      expect(text).not.toContain(CANARY.team);
      expect(text).not.toContain(CANARY.journal);
    }
    expect(villagerTexts[0]).toContain(CANARY.public);
    expect(seerTurn.text).toContain(CANARY.inspection);
    expect(seerTurn.text).toContain(CANARY.journal);
    expect(JSON.stringify(seerTurn.body.system)).not.toContain(CANARY.inspection);
  });

  it("pins thinking, effort and the output schema for the whole session", () => {
    const game = scriptedGame();
    const sessions = new ClaudeSessions(game.store);
    const ids: string[] = [];
    const bodies = ["medium", "high", "low"].map((effort) => {
      const step = call(game, sessions, game.villager, 1, { effort });
      answer(step.turn);
      ids.push(step.turn.metadata.id);
      game.speech(game.seer, 1);
      return step.body;
    });
    for (const body of bodies) expect(settings(body)).toEqual(settings(bodies[0]!));
    expect(bodies[0]!.output_config?.effort).toBe("medium");
    expect(new Set(ids).size).toBe(1);
  });

  it("opens a new session at day start, after a compaction and at the size threshold", () => {
    const game = scriptedGame();
    const sessions = new ClaudeSessions(game.store);
    const journal = (text: string) => ({ ...emptyJournalV2(), text });
    const first = call(game, sessions, game.villager, 1, { journal: journal("day one notes") });
    answer(first.turn);
    const id = () => sessions.load(game.gameId, game.villager)!.id;
    expect(id()).toBe(`${game.villager}:d1:s1`);

    sessions.close(game.gameId, game.villager);
    const afterCompaction = call(game, sessions, game.villager, 1, { journal: journal("compact") });
    expect(id()).toBe(`${game.villager}:d1:s2`);
    expect(JSON.stringify(afterCompaction.body.messages[0])).toContain("compact");

    answer(afterCompaction.turn, 89_900);
    const overSize = call(game, sessions, game.villager, 1, { journal: journal("near limit") });
    expect(id()).toBe(`${game.villager}:d1:s3`);
    expect(JSON.stringify(overSize.body.messages[0])).toContain("near limit");

    const dayTwo = call(game, sessions, game.villager, 2, { journal: journal("day two") });
    expect(id()).toBe(`${game.villager}:d2:s4`);
    expect(JSON.stringify(dayTwo.body.messages[0])).toContain("day two");
  });

  it("rebuilds the same request bytes from the database after a pause", () => {
    const game = scriptedGame();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
    const live = new ClaudeSessions(game.store);
    answer(call(game, live, game.villager, 1).turn);
    game.speech(game.seer, 1);
    const before = call(game, live, game.villager, 1).text;
    vi.setSystemTime(new Date("2026-10-22T10:20:00Z"));
    const resumed = new ClaudeSessions(new DecisionStore(game.repository));
    expect(call(game, resumed, game.villager, 1).text).toBe(before);
  });

  it("counts a session call that reads less than the previous prompt as a miss", () => {
    const attempt = (id: string, cached: number, expectedCacheRead: number | null) => ({
      id,
      decisionId: id,
      status: "valid",
      startedAt: id,
      schemaVersion: "journal_update_v3_2",
      provider: "anthropic",
      model: MODEL,
      usage: { inputTokens: 10_000, cachedInputTokens: cached, cacheWriteInputTokens: 500 },
      providerMetadata: { claudeSession: { id: "s", turn: 1, expectedCacheRead } },
    });
    expect(
      claudeSessionAccounting([
        attempt("1", 0, null),
        attempt("2", 9_000, 9_000),
        attempt("3", 1_200, 9_500),
      ]),
    ).toEqual([
      {
        key: "journal_update_v3_2",
        calls: 3,
        inputTokens: 30_000,
        readTokens: 10_200,
        writeTokens: 1_500,
        misses: 1,
      },
    ]);
  });

  it("refuses any provider other than anthropic and any workflow other than journal_v4", () => {
    expect(() =>
      sessionConfig({
        modelSettings: Object.fromEntries(
          actorConfig().seats.map((seat) => [seat.id, { model: "gpt", provider: "openai" }]),
        ),
      }),
    ).toThrow(/agent_claude_session_v1/);
    expect(() =>
      sessionConfig({ decisionEngine: { mode: "jev", workflow: "journal_v3" } }),
    ).toThrow(/agent_claude_session_v1/);
    expect(() => sessionConfig({ decisionEngine: { mode: "llm" } })).toThrow(
      /agent_claude_session_v1/,
    );
    expect(sessionConfig().protocolVersion).toBe("agent_claude_session_v1");
  });
});

describe("Claude session repairs through the executor", () => {
  it("answers a wrong-kind reply with a repair turn and keeps the invalid reply in history", async () => {
    const connection = openDatabase(":memory:");
    connections.push(connection);
    const repository = new LabRepository(connection);
    repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
    const game = repository.createGame(sessionConfig());
    new V2GameOrchestrator(repository, new FakeDecisionProvider()).initialize(game.id);
    repository.updateGame(game.id, { status: "running" });
    const events = repository.listEvents(game.id);
    const state = reduceGame(game.id, events);
    const packet = buildContextV2(state, events, "p1", emptyJournalV2(), "reflect", "pass");
    const op: DecisionOpportunityV1 = {
      id: "reflection",
      gameId: game.id,
      playerId: "p1",
      kind: "pass",
      phase: state.phase,
      day: state.day,
      epoch: `${state.day}:${state.phase}`,
      viewId: "view",
      baseJournalVersion: 0,
      packet,
      status: "open",
      best: null,
      recovery: 0,
      createdAt: "2026-10-22T00:00:00.000Z",
      taskType: "journal_update",
    };
    new DecisionStore(repository).save(op);
    const task: V3TaskSpec = { type: "journal_update", revision: "r", sourceIds: [] };
    const options: ExecuteDecisionOptions = {
      opportunity: op,
      mandatoryRemaining: 1,
      validateCurrent: () => true,
      eventsForCommit: () => [],
      requestForAttempt: (commitOnly, previous, repair) => ({
        ...decisionRequestV32(packet, task, commitOnly, previous, repair),
        schemaName: task.type,
        providerKind: "decision_v3_1",
        normalize: (value) =>
          normalizeV31Submission(packet, task, value as never, op.id, commitOnly),
        validateSubmission: (value) => validateV31Submission(packet, task, value as never),
      }),
    };
    const envelope = (task: string, speech: unknown, memory: unknown) =>
      JSON.stringify({ task, memory, speech, rationale: "r" });
    const replies = [
      envelope(
        "closing_response",
        { text: "Wrong task.", acts: [], respondsTo: [] },
        { journalUpdate: null, decisionBrief: null },
      ),
      envelope("journal_update", null, {
        journalUpdate: { mode: "append", text: "A fresh note." },
        decisionBrief: { action: "Wait for more evidence.", attention: "Hear the quiet seats." },
      }),
    ];
    const bodies: { messages: unknown[]; output_config?: unknown }[] = [];
    const directory = mkdtempSync(join(tmpdir(), "claude-session-ledger-"));
    try {
      const provider = new AnthropicMessagesProvider({
        ledger: new ClaudeSpendLedger(join(directory, "spend.json"), 200),
        client: {
          messages: {
            stream(body) {
              bodies.push(structuredClone(body) as never);
              const text = replies.shift()!;
              return {
                on: () => undefined,
                abort: () => undefined,
                finalMessage: async () =>
                  ({
                    id: `msg_${bodies.length}`,
                    type: "message",
                    role: "assistant",
                    model: MODEL,
                    content: [
                      { type: "thinking", thinking: "", signature: `sig-${bodies.length}` },
                      { type: "text", text, citations: null },
                    ],
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    stop_details: null,
                    usage: { input_tokens: 1_000, output_tokens: 80 },
                  }) as never,
              };
            },
          },
        },
      });
      await new DecisionExecutorV2(repository, provider).execute(options);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(bodies).toHaveLength(2);
    const [first, second] = bodies as {
      messages: { content: unknown }[];
      output_config: unknown;
    }[];
    expect(second!.output_config).toEqual(first!.output_config);
    // The invalid reply is replayed verbatim, then a repair turn follows it.
    expect(JSON.stringify(second!.messages)).toContain('"signature":"sig-1"');
    expect(JSON.stringify(second!.messages)).toContain("Wrong task.");
    const repairTurn = JSON.stringify(second!.messages.at(-1));
    expect(repairTurn).toContain("Expected API response task journal_update");
    expect(new DecisionStore(repository).attempts(game.id).map((a) => a.status)).toEqual([
      "invalid",
      "valid",
    ]);
  });
});
