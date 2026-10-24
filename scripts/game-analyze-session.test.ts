import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { GameConfigV2Schema } from "@werewolf/contracts";
import { LabRepository, openDatabase } from "@werewolf/db";
import { reduceGame } from "@werewolf/engine";
import {
  AnthropicMessagesProvider,
  AskJevProvider,
  ClaudeSpendLedger,
  FakeDecisionProvider,
  type ClaudeClient,
  type DecisionProvider,
  type JevRequest,
} from "@werewolf/llm";
import { V2GameOrchestrator } from "../packages/simulator/src/orchestrator-v2";
import { actorConfig } from "../packages/simulator/src/testing/actor-fixtures";
import { analyzeGame } from "./game-analyze";
import type { MomentReview } from "./lib/analyze-review";

/**
 * CES-1565: the analyzer on a game played under the Claude session protocol. The real
 * orchestrator plays a short game with a fake Anthropic client in every seat (reflection, speech
 * and closing go through Claude sessions) and a scripted Jev (votes, night choices, pack points
 * and bids stay Jev decisions under journal_v4). The analyzer then reads the stored game. Nothing
 * calls a live provider.
 */
const directories: string[] = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

const MODEL = "claude-haiku-5-5";
const SPEECH_TASKS = ["journal_update", "discussion_free_speech", "closing_response"] as const;

function sessionConfig() {
  return GameConfigV2Schema.parse({
    ...actorConfig(),
    protocolVersion: "agent_claude_session_v1",
    maxSpendUsd: 50,
    modelSettings: Object.fromEntries(
      actorConfig().seats.map((seat) => [
        seat.id,
        { model: MODEL, provider: "anthropic", reasoningEffort: "medium" },
      ]),
    ),
  });
}

/** The REQUEST's task type: the last one the session turn names. */
function requestTask(body: Anthropic.MessageStreamParams): string | undefined {
  const last = body.messages.at(-1)!;
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content.map((block) => ("text" in block ? block.text : "")).join("\n");
  const named = [...text.matchAll(/"type":"([a-z_]+)"/g)]
    .map((match) => match[1]!)
    .filter((type) => (SPEECH_TASKS as readonly string[]).includes(type));
  return named.at(-1);
}

/** A response envelope that passes each task's checks. */
function envelope(task: string) {
  if (task === "journal_update")
    return {
      task,
      memory: {
        journalUpdate: { mode: "append", text: "A short note on today." },
        decisionBrief: { action: "Follow the vote closely.", attention: "Hear the quiet seats." },
      },
      speech: null,
      rationale: "r",
    };
  return {
    task,
    memory: { journalUpdate: null, decisionBrief: null },
    speech: { text: "I am still listening.", acts: [], respondsTo: [] },
    rationale: "r",
  };
}

/** A fake Anthropic client answering every session request; an unknown request fails by name. */
function sessionClaude() {
  const tasks: string[] = [];
  const client: ClaudeClient = {
    messages: {
      stream(body) {
        const task = requestTask(body);
        tasks.push(task ?? "unknown");
        let listener: ((event: Anthropic.MessageStreamEvent) => void) | undefined;
        return {
          on: (_event, handler) => (listener = handler),
          abort: () => undefined,
          finalMessage: async () => {
            if (!task) throw new Error(`The fake Claude client got a request with no known task`);
            listener?.({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "", citations: null },
            } as Anthropic.MessageStreamEvent);
            return {
              id: `msg_${tasks.length}`,
              type: "message",
              role: "assistant",
              model: MODEL,
              content: [{ type: "text", text: JSON.stringify(envelope(task)), citations: null }],
              stop_reason: "end_turn",
              stop_sequence: null,
              stop_details: null,
              usage: {
                input_tokens: 1_000,
                output_tokens: 80,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            } as never;
          },
        };
      },
    },
  };
  return { client, tasks };
}

const choice = (handles: string[], pick: string, p: number) => ({
  type: "choice",
  choice: pick,
  confidence: 1,
  probabilities: Object.fromEntries(
    handles.map((h) => [h, h === pick ? p : (1 - p) / (handles.length - 1)]),
  ),
});

/**
 * Jev for the game itself: both wolves point at the victim at once (a unanimous first round),
 * the doctor protects someone else (so the kill lands), and every other choice is the first
 * option with a peaked distribution, so ballots carry a recorded Jev signal.
 */
function gameJev(wolves: string[], victim: string) {
  return new AskJevProvider(async (input) => {
    const request = JSON.parse(input) as JevRequest;
    const self = /\((p\d+)\), /.exec(JSON.stringify(request))?.[1] ?? "";
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
        const criteria = q.criteria as Record<string, string>;
        const handles = Object.keys(criteria);
        const of = (id: string) => handles.find((h) => criteria[h]!.includes(`(${id})`));
        if (wolves.includes(self) && of(victim)) return [key, choice(handles, of(victim)!, 0.9)];
        const notVictim = handles.find((h) => h !== of(victim)) ?? handles[0]!;
        return [key, choice(handles, notVictim, 0.9)];
      }),
    );
    return JSON.stringify({ model: "fake", usage: { input_tokens: 1, output_tokens: 1 }, answers });
  });
}

/** Plays the session game through the first night's kill and the first day's vote. */
async function sessionGame() {
  const directory = mkdtempSync(join(tmpdir(), "session-game-"));
  directories.push(directory);
  const dbPath = join(directory, "game.db");
  const connection = openDatabase(dbPath);
  const repository = new LabRepository(connection);
  const game = repository.createGame(sessionConfig());
  new V2GameOrchestrator(repository, new FakeDecisionProvider()).initialize(game.id);
  const state = reduceGame(game.id, repository.listEvents(game.id));
  const wolves = state.players.filter((p) => p.role.alignment === "werewolf").map((p) => p.id);
  const victim = state.players.find((p) => p.role.id === "villager")!.id;
  const claude = sessionClaude();
  const provider = new AnthropicMessagesProvider({
    client: claude.client,
    ledger: new ClaudeSpendLedger(join(directory, "spend.json"), 200),
  });
  const runner = new V2GameOrchestrator(repository, provider, gameJev(wolves, victim));
  repository.updateGame(game.id, { status: "running" });
  const has = (type: string) => repository.listEvents(game.id).some((e) => e.type === type);
  for (let step = 0; step < 300 && !has("vote.resolved"); step += 1)
    await runner.runGameStep(game.id);
  const status = repository.getGame(game.id)!.status;
  const lastEvents = repository
    .listEvents(game.id)
    .slice(-5)
    .map((e) => e.type);
  const reached = { dawn: has("night.resolved"), vote: has("vote.resolved") };
  connection.close();
  return { dbPath, gameId: game.id, directory, victim, claude, status, lastEvents, reached };
}

/** The analyzer's public view: a peaked prediction on the first option, never a flat one. */
const publicJev: DecisionProvider = {
  decide: async (request) => {
    const jevRequest = JSON.parse(request.preparedPrompt!.input) as JevRequest;
    const handles = Object.keys(
      (jevRequest.questions.prediction as { criteria: Record<string, unknown> }).criteria,
    );
    return {
      data: {
        model: "jev-latest",
        answers: { prediction: choice(handles, handles[0]!, 0.8) },
      } as never,
      provider: "jev",
      model: "jev-latest",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
  },
};

const plain = (): MomentReview =>
  ({
    explanation: "Routine.",
    citedEventIds: [],
    knowledgeClaims: [],
    groundTruth: "",
    regressionCandidate: false,
  }) as MomentReview;

describe("the analyzer on a Claude session-protocol game", () => {
  it("scores at least one ballot and one kill, with every pack night consistent", async () => {
    const game = await sessionGame();
    // The game must reach the moments this test is about; otherwise say where it stopped.
    expect(
      game.reached,
      `game stopped (${game.status}) after ${game.lastEvents.join(", ")}; Claude tasks: ${game.claude.tasks.join(", ")}`,
    ).toEqual({ dawn: true, vote: true });
    // Reflection, speech and closing really went through the Claude session client.
    expect(game.claude.tasks).toContain("journal_update");
    expect(game.claude.tasks).toContain("discussion_free_speech");
    expect(game.claude.tasks).not.toContain("unknown");

    const report = await analyzeGame({
      dbPath: game.dbPath,
      gameId: game.gameId,
      outDir: join(game.directory, "analysis"),
      jev: publicJev,
      jevModel: "jev-latest",
      review: {
        provider: {
          decide: async () => ({
            data: plain() as never,
            provider: "fake",
            model: "review",
            usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 },
          }),
        },
        kind: "fake",
        model: "review",
      },
    });
    const summary = report.moments
      .map((m) => `${m.id} ${m.kind} ${m.class}${m.noSignalReason ? `: ${m.noSignalReason}` : ""}`)
      .join("; ");
    const scored = (kind: string) =>
      report.moments.filter((m) => m.kind === kind && m.class !== "no_signal");
    expect(scored("ballot").length, `no ballot scored: ${summary}`).toBeGreaterThan(0);
    expect(scored("night_action").length, `no kill scored: ${summary}`).toBeGreaterThan(0);
    // The seven pack-night invariants: a broken one is a night's inconsistency, never repaired.
    const broken = report.moments.filter((m) =>
      /inconsistent pack records/.test(m.noSignalReason ?? ""),
    );
    expect(broken, `pack invariants broken: ${summary}`).toEqual([]);
    const kill = scored("night_action")[0]!;
    expect(kill.actual).toBe(game.victim);
  }, 120_000);
});
