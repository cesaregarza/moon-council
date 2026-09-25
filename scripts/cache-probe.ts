import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  GameConfigV2Schema,
  STANDARD_ROLE_IDS,
  emptyJournalV2,
  seatName,
  type GameEventV1,
  type UsageV2,
} from "@werewolf/contracts";
import { DOCTOR_V2, STARTER_ROLES, createGameState } from "@werewolf/engine";
import {
  loadProviderEnvironment,
  OpenAIResponsesProvider,
  openAIRequest,
  type DecisionRequest,
} from "@werewolf/llm";
import { buildContextV2 } from "../packages/simulator/src/context-v2";
import {
  decisionRequestV31,
  normalizeV31Submission,
  validateV31Submission,
  type V31Submission,
} from "../packages/simulator/src/request-v3-1";
import { validatePreparedReport } from "../packages/simulator/src/decisions-v2";
import type { V3TaskSpec } from "../packages/simulator/src/request-v3";

const { values } = parseArgs({
  options: {
    compare: { type: "string", multiple: true },
    report: { type: "string" },
    db: { type: "string" },
    game: { type: "string" },
    attempt: { type: "string", multiple: true },
    help: { type: "boolean" },
    live: { type: "boolean" },
    model: { type: "string" },
    effort: { type: "string" },
    out: { type: "string" },
  },
});
if (values.help) {
  console.log(
    "Usage: npm run cache:probe -- [--live --out DIRECTORY] [--model gpt-6-luna] [--effort xhigh]\nOffline report: --compare BASELINE/summary.json --compare REVISED/summary.json --report REPORT.md. Output directories must be new. Archived input: --db DATABASE --game GAME_ID --attempt ATTEMPT_ID [--attempt ...], using each original model, effort, packet and schema. Default: offline request inspection. --live runs exactly three independent journal updates: cold prefix, another seat, then appended speech. Each call is capped at 8192 output+reasoning tokens and 120 seconds. No retries or running-game mutations. Records exact requests, receipts, validation and reported cache usage; never assumes a hit. Stop at the first failure.",
  );
  process.exit(0);
}
if (values.live && !values.out) throw new Error("--live requires --out for the audit receipts");
if (values.compare || values.report) {
  if (
    values.live ||
    values.db ||
    values.game ||
    values.attempt ||
    !values.compare ||
    values.compare.length !== 2 ||
    !values.report
  )
    throw new Error(
      "Comparison requires exactly two --compare summary paths and --report PATH; no live/replay flags",
    );
  const { writeCacheComparison } = await import("./cache-replay-report");
  await writeCacheComparison(values.compare, values.report);
  process.exit(0);
}
loadProviderEnvironment();
if (values.db || values.game || values.attempt) {
  if (!values.db || !values.game || !values.attempt?.length)
    throw new Error("Archived replay requires --db, --game and repeated --attempt IDs");
  const { replayCacheProbe } = await import("./cache-replay-probe");
  await replayCacheProbe({
    db: values.db,
    game: values.game,
    attempts: values.attempt,
    live: Boolean(values.live),
    out: values.out,
    model: values.model,
    effort: values.effort,
  });
  process.exit(process.exitCode ?? 0);
}
values.model ??= "gpt-6-luna";
values.effort ??= "xhigh";
const gameId = `cache-probe-${randomUUID()}`;
const seats = STANDARD_ROLE_IDS.map((_, i) => ({ id: `p${i + 1}`, name: seatName(i) }));
const config = GameConfigV2Schema.parse({
  schemaVersion: "game_config_v2",
  protocolVersion: "agent_v3_1",
  name: "API cache probe",
  seed: "openai-cache-probe",
  preset: "standard-8-v2",
  seats,
  roleDeck: STANDARD_ROLE_IDS.map((id) =>
    id === "doctor" ? DOCTOR_V2 : STARTER_ROLES.find((role) => role.id === id),
  ),
  decisionEngine: { mode: "jev", workflow: "journal_v2" },
  rules: { firstCycle: "day_first" },
  discussion: { speakerSelection: "listener_auction" },
  modelSettings: Object.fromEntries(
    seats.map((seat) => [
      seat.id,
      { provider: "openai", model: values.model, reasoningEffort: values.effort },
    ]),
  ),
});
const state = createGameState(gameId, config);
state.phase = "day_discussion";
state.day = 1;
const event = (id: string, sequence: number, playerId: string, text: string): GameEventV1 => ({
  schemaVersion: "game_event_v1",
  id,
  gameId,
  sequence,
  type: "speech.public",
  phase: "day_discussion",
  day: 1,
  visibility: "public",
  audienceIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: {
    playerId,
    playerName: seats.find((s) => s.id === playerId)!.name,
    text,
    acts: [],
    respondsTo: [],
    closing: false,
  },
});
const speeches = [
  event(
    "speech-one",
    1,
    "p3",
    "We have no night information yet. I want everyone to distinguish evidence from guesses.",
  ),
  event(
    "speech-two",
    2,
    "p4",
    "I agree that we lack evidence, but we should record what each player says and revisit it after tonight.",
  ),
];
const cases = [
  { name: "cold", playerId: "p1", events: speeches.slice(0, 1) },
  { name: "other-seat", playerId: "p2", events: speeches.slice(0, 1) },
  { name: "appended-speech", playerId: "p1", events: speeches },
];
const results: Record<string, unknown>[] = [];
const provider = values.live ? new OpenAIResponsesProvider() : null;
const directory = values.out ? resolve(values.out) : null;
if (directory) {
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
}
for (const scenario of cases) {
  const journal = emptyJournalV2();
  const packet = buildContextV2(
    state,
    scenario.events,
    scenario.playerId,
    journal,
    scenario.name,
    "discussion",
  );
  const task: V3TaskSpec = {
    type: "journal_update",
    sourceIds: scenario.events.map((item) => item.id),
    revision: scenario.name,
  };
  const prepared = decisionRequestV31(packet, task, true, null, null);
  if (prepared.tokens > 16_000) throw new Error("Probe input exceeds its 16000-token estimate cap");
  let usage: UsageV2 | undefined,
    metadata: Record<string, unknown> | undefined,
    wireRequest: Record<string, unknown> | undefined;
  const request: DecisionRequest<V31Submission> = {
    gameId,
    playerId: scenario.playerId,
    kind: "decision_v3_1",
    model: values.model!,
    reasoningEffort: values.effort,
    preparedPrompt: prepared.prompt,
    apiResponseFormat: prepared.apiResponseFormat,
    schema: prepared.schema,
    schemaName: "journal_update_v3_1",
    maxOutputTokens: 8192,
    timeoutMs: 120_000,
    onUsage: (value) => {
      usage = value;
    },
    onProviderMetadata: (value) => {
      metadata = value;
    },
    onProviderRequest: (value) => {
      wireRequest = value;
    },
  };
  const start = Date.now();
  let error: string | null = null,
    result: V31Submission | null = null;
  if (provider) {
    try {
      result = (await provider.decide(request)).data;
      const errors = validateV31Submission(packet, task, result);
      const report = normalizeV31Submission(packet, task, result, scenario.name, true);
      errors.push(
        ...validatePreparedReport(report, packet, config.deliberation.maxJournalTokens, false)
          .errors,
      );
      if (errors.length) throw new Error(errors.join("; "));
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  const row = {
    scenario: scenario.name,
    live: Boolean(provider),
    model: values.model,
    effort: values.effort,
    latencyMs: Date.now() - start,
    estimatedInputTokens: prepared.tokens,
    usage,
    metadata,
    error,
  };
  results.push(row);
  if (directory) {
    await writeFile(
      resolve(directory, `${scenario.name}.json`),
      JSON.stringify({ ...row, request: wireRequest ?? openAIRequest(request), result }, null, 2) +
        "\n",
      { mode: 0o600 },
    );
    await writeFile(resolve(directory, "summary.json"), JSON.stringify(results, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  console.log(JSON.stringify(row));
  if (error) {
    process.exitCode = 1;
    break;
  }
}
