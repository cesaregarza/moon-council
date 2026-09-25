import { acknowledgeSemanticAnomaly } from "../packages/simulator/src/semantic-recovery";
import { mkdtemp, mkdir, readFile, writeFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { GameConfigV2Schema, STANDARD_ROLE_IDS, seatName } from "@werewolf/contracts";
import { LabRepository, openDatabase, DecisionStore } from "@werewolf/db";
import { DOCTOR_V2, STARTER_ROLES, reduceGame } from "@werewolf/engine";
import {
  loadProviderEnvironment,
  AskJevProvider,
  createDecisionProvider,
  type DecisionProvider,
} from "@werewolf/llm";
import { V2GameOrchestrator } from "../packages/simulator/src/orchestrator-v2";
import { auditGameV2 } from "../packages/simulator/src/audit-v2";
import { observerPayload, decisionRecords } from "../apps/api/src/observer";

loadProviderEnvironment();

const { values } = parseArgs({
  options: {
    "acknowledge-semantic": { type: "string" },
    "operator-note": { type: "string" },
    help: { type: "boolean" },
    journals: { type: "boolean" },
    "pause-at-first-night": { type: "boolean" },
    "event-type": { type: "string", multiple: true },
    task: { type: "string" },
    "jev-input": { type: "boolean" },
    attempt: { type: "string" },
    "jev-review": { type: "boolean" },
    evidence: { type: "boolean" },
    player: { type: "string" },
    decision: { type: "string" },
    "decision-engine": { type: "string" },
    "jev-model": { type: "string" },
    "max-output-tokens": { type: "string", default: "8192" },
    "max-calls": { type: "string", default: "500" },
    "max-tokens": { type: "string", default: "unlimited" },
    "max-minutes": { type: "string", default: "30" },
    provider: { type: "string", default: "fake" },
    model: { type: "string" },
    effort: { type: "string", default: "xhigh" },
    seed: { type: "string", default: "standard-v3-pilot" },
    db: { type: "string" },
    game: { type: "string" },
    resume: { type: "boolean" },
    out: { type: "string" },
    audit: { type: "boolean" },
    snapshot: { type: "boolean" },
    mode: { type: "string", default: "gated" },
    parallel: { type: "string", default: "4" },
    "speaker-bias": { type: "string", default: "0.25" },
    "inspect-bundle": { type: "string" },
    match: { type: "string", multiple: true },
    day: { type: "string" },
    limit: { type: "string" },
    offset: { type: "string" },
  },
});
if (values.help)
  console.log(
    "Saved journals as Markdown: --inspect-bundle research.json --journals [--player p7]. Read-only; private game information.\nExact recorded CLI input: --inspect-bundle research.json --jev-input --decision ID [--attempt ID]. Writes the original JSON without a wrapper.\nAdd --jev-review [--player p1] [--decision ID] [--task vote_choice] [--evidence] to extract Jev gates, decisions and explicit LLM advice. Contains private game evidence.\nOffline inspection (no database writes or model calls): --inspect-bundle research.json [--match NAME_OR_ID ...] [--day DAY] [--limit 30] [--offset 0] [--event-type TYPE ...] [--player ID]. Event-type selection explicitly includes full matching event payloads. Prints latency/usage and only explicitly matched speech, journal patches, and reports as JSON.",
  );
if (values["inspect-bundle"] && !values.help) {
  if (
    values.resume ||
    values.snapshot ||
    values.db ||
    values.game ||
    values.out ||
    values["pause-at-first-night"]
  )
    throw new Error(
      "Bundle inspection cannot be combined with game execution or database/output options",
    );
  if (values.journals) {
    if (
      values["jev-input"] ||
      values["jev-review"] ||
      values.evidence ||
      values.decision ||
      values.attempt ||
      values.task ||
      values.day ||
      values.match ||
      values.limit ||
      values.offset ||
      values["event-type"]
    )
      throw new Error("Use --journals with optional --player only");
    const { journalSnapshotMarkdown } = await import("../packages/simulator/src/audit-bundle-v2");
    process.stdout.write(
      journalSnapshotMarkdown(
        JSON.parse(await readFile(await nativePath(values["inspect-bundle"]), "utf8")),
        values.player,
      ),
    );
    process.exit(0);
  }
  if (values["jev-input"]) {
    if (
      !values.decision ||
      values["jev-review"] ||
      values.evidence ||
      values.task ||
      values.player ||
      values.day ||
      values.match ||
      values.limit ||
      values.offset ||
      values["event-type"]
    )
      throw new Error("Use --jev-input with --decision and optional --attempt only");
    const { extractJevInput } = await import("../packages/simulator/src/jev-review");
    const bundle = JSON.parse(await readFile(await nativePath(values["inspect-bundle"]), "utf8"));
    process.stdout.write(
      extractJevInput(bundle, { decision: values.decision, attempt: values.attempt }),
    );
    process.exit(0);
  }
  if (values.attempt) throw new Error("--attempt requires --jev-input");
  if (!values["jev-review"] && (values.evidence || values.decision || values.task))
    throw new Error("Jev filters require --jev-review");
  if (
    values["jev-review"] &&
    (values.match || values.limit || values.offset || values["event-type"])
  )
    throw new Error("Use --day, --player or --decision with --jev-review");
  const { inspectResearchBundle } = await import("../packages/simulator/src/audit-bundle-v2");
  const { reviewJevDecisions } = await import("../packages/simulator/src/jev-review");
  const bundle = JSON.parse(await readFile(await nativePath(values["inspect-bundle"]), "utf8"));
  console.log(
    JSON.stringify(
      values["jev-review"]
        ? reviewJevDecisions(bundle, {
            day: values.day === undefined ? undefined : Number(values.day),
            player: values.player,
            decision: values.decision,
            task: values.task,
            evidence: values.evidence,
          })
        : inspectResearchBundle(bundle, {
            eventTypes: values["event-type"],
            player: values.player,
            matches: values.match,
            day: values.day === undefined ? undefined : Number(values.day),
            limit: values.limit === undefined ? undefined : Number(values.limit),
            offset: values.offset === undefined ? undefined : Number(values.offset),
          }),
      null,
      2,
    ),
  );
  process.exit(0);
}
if (
  !values.help &&
  (values.journals ||
    values.match ||
    values.day ||
    values.limit ||
    values.offset ||
    values["jev-review"] ||
    values.evidence ||
    values.player ||
    values.decision ||
    values.task ||
    values["event-type"] ||
    values["jev-input"] ||
    values.attempt)
)
  throw new Error("Inspection filters require --inspect-bundle");
if (values.help) {
  console.log(
    "Usage: npm run pilot -- --provider fake|codex|openai --model MODEL --effort xhigh --seed SEED [--decision-engine llm|jev] [--jev-model jev-latest] [--max-output-tokens 8192] [--max-calls 500] [--max-tokens unlimited|NUMBER] [--max-minutes 30] [--mode gated|single] [--parallel 4] [--speaker-bias 0.25] [--db NATIVE_PATH] [--out DIRECTORY] [--pause-at-first-night]\nNew games use protocol V3.1: stable public E refs and per-player private R refs, small task-specific model responses, reactive listener bids, selected-only speech generation, sparse memory, and a full Day 1 before Night 1. Add --pause-at-first-night to pause after Day 1 ballots, before any Night 1 work. Resume the SAME game: --db DB --game ID --resume (omit the pause flag). Audit only: --db DB --game ID --audit. Acknowledge a final semantic anomaly without model calls: --db DB --game ID --acknowledge-semantic DECISION --operator-note NOTE (commits the recorded ballot and stays paused). Add --snapshot to export an immutable SQLite backup in the output directory. Live providers require an explicit model; never substitute another model. Artifacts are moderator-spoiler JSON and Markdown; no credentials or hidden reasoning traces.",
  );
  process.exit(0);
}
if (values["acknowledge-semantic"]) {
  if (
    !values.db ||
    !values.game ||
    !values["operator-note"] ||
    values.resume ||
    values.audit ||
    values["inspect-bundle"]
  ) {
    throw new Error(
      "Use --acknowledge-semantic DECISION --operator-note NOTE --db DB --game GAME; resume separately",
    );
  }
  const connection = openDatabase(await nativePath(values.db));
  try {
    const result = acknowledgeSemanticAnomaly(
      new LabRepository(connection),
      values.game,
      values["acknowledge-semantic"],
      values["operator-note"],
    );
    console.log(JSON.stringify(result));
  } finally {
    connection.close();
  }
  process.exit(0);
}
if (values["operator-note"]) throw new Error("--operator-note requires --acknowledge-semantic");
if (!["fake", "codex", "openai"].includes(values.provider!)) throw new Error("Invalid provider");
if (values.provider !== "fake" && !values.model)
  throw new Error("Explicit --model required for live calls");
if (!["single", "gated"].includes(values.mode!)) throw new Error("Invalid deliberation mode");
const decisionEngine = {
  workflow: "journal_v4",
  mode: values["decision-engine"] ?? "llm",
  model: values["jev-model"] ?? "jev-latest",
};
if (!["llm", "jev"].includes(decisionEngine.mode))
  throw new Error("--decision-engine must be llm or jev");
const maxModelCalls = Number(values["max-calls"]),
  maxTotalTokens = values["max-tokens"] === "unlimited" ? null : Number(values["max-tokens"]),
  maxWallClockMs = Number(values["max-minutes"]) * 60_000;
if (!Number.isInteger(maxModelCalls) || maxModelCalls < 20 || maxModelCalls > 10_000)
  throw new Error("--max-calls must be an integer from 20 to 10000");
if (
  maxTotalTokens !== null &&
  (!Number.isInteger(maxTotalTokens) || maxTotalTokens < 1_000 || maxTotalTokens > 100_000_000)
)
  throw new Error("--max-tokens must be unlimited or an integer from 1000 to 100000000");
if (!Number.isInteger(maxWallClockMs) || maxWallClockMs < 60_000 || maxWallClockMs > 86_400_000)
  throw new Error("--max-minutes must be from 1 to 1440");
const maxParallelDecisions = Number(values.parallel),
  speakerBias = Number(values["speaker-bias"]);
if (!Number.isInteger(maxParallelDecisions) || maxParallelDecisions < 1 || maxParallelDecisions > 8)
  throw new Error("--parallel must be an integer from 1 to 8");
if (!Number.isFinite(speakerBias) || speakerBias < 0.01 || speakerBias > 1)
  throw new Error("--speaker-bias must be from 0.01 to 1");
async function nativePath(path: string) {
  const full = resolve(path);
  if (full === "/mnt" || full.startsWith("/mnt/")) throw new Error("Use a native Linux path");
  let existing = full;
  for (;;) {
    try {
      const real = await realpath(existing);
      if (real === "/mnt" || real.startsWith("/mnt/"))
        throw new Error("Windows-mounted symlink target is forbidden");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existing = dirname(existing);
    }
  }
  return full;
}
const directory = values.out
  ? await nativePath(values.out)
  : await mkdtemp("/tmp/werewolf-v3-pilot-");
await mkdir(directory, { recursive: true });
const databasePath = await nativePath(values.db ?? join(directory, "game.db"));
await mkdir(dirname(databasePath), { recursive: true });
const connection = openDatabase(databasePath),
  repository = new LabRepository(connection);
repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
const seats = STANDARD_ROLE_IDS.map((_, i) => ({
  id: `p${i + 1}`,
  name: seatName(i),
  personality: "Observant, concise, and strategically independent.",
}));
const providerKind = values.provider as "fake" | "codex" | "openai",
  model = values.model ?? "fake-model";
const game = values.game
  ? repository.getGame(values.game)
  : repository.createGame(
      GameConfigV2Schema.parse({
        schemaVersion: "game_config_v2",
        protocolVersion: "agent_v3_1",
        name: `${model} ${values.effort} · V3.1 pilot`,
        preset: "standard-8-v2",
        seed: values.seed,
        seats,
        roleDeck: STANDARD_ROLE_IDS.map((id) =>
          id === "doctor" ? DOCTOR_V2 : STARTER_ROLES.find((r) => r.id === id)!,
        ),
        rules: { packExecution: "any_unblocked", revealBallots: true, firstCycle: "day_first" },
        discussion: { speakerSelection: "listener_auction", speakerBias, maxParallelDecisions },
        deliberation: {
          mode: values.mode,
          bidReasoningEffort: "medium",
          maxJournalTokens: 16_000,
          maxContextTokens: 32_000,
        },
        decisionEngine,
        maxTotalTokens,
        safety: {
          maxModelCalls,
          maxWallClockMs,
          maxOutputTokens: Number(values["max-output-tokens"]),
        },
        speedMs: 0,
        modelSettings: Object.fromEntries(
          seats.map((s) => [
            s.id,
            { model, reasoningEffort: values.effort, provider: providerKind },
          ]),
        ),
      }),
    );
if (!game) throw new Error("Unknown existing game");
if (game.config.schemaVersion !== "game_config_v2") throw new Error("Legacy games are replay-only");
if (values.game && !values.resume && !values.audit)
  throw new Error("Existing games require --resume or --audit");
if (
  values.resume &&
  Object.values(game.config.modelSettings).some(
    (settings) =>
      settings.provider !== providerKind ||
      settings.model !== model ||
      settings.reasoningEffort !== values.effort,
  )
)
  throw new Error(
    "Resume must use the game's frozen --provider, --model, and --effort; no silent model substitution",
  );
if (
  values.resume &&
  ((values["decision-engine"] && game.config.decisionEngine.mode !== values["decision-engine"]) ||
    (values["jev-model"] && game.config.decisionEngine.model !== values["jev-model"]))
)
  throw new Error("Resume must use the game's frozen decision engine and Jev model");
console.log(
  JSON.stringify({
    kind: "pilot",
    gameId: game.id,
    databasePath,
    directory,
    decisionEngine: game.config.decisionEngine,
    modelSettings: game.config.modelSettings,
    safety: game.config.safety,
    maxTotalTokens: game.config.maxTotalTokens,
  }),
);
let checkpointReached = false;
if (!values.audit) {
  const base = createDecisionProvider(providerKind);
  const logged = (provider: DecisionProvider): DecisionProvider => ({
    releaseSession: (key) => provider.releaseSession?.(key),
    decide: async (request) => {
      const started = Date.now();
      const info = {
        actor: request.playerId,
        day: request.contextV2?.day,
        phase: request.contextV2?.phase,
        task: request.schemaName,
        model: request.model,
        effort: request.reasoningEffort,
      };
      console.log(JSON.stringify({ kind: "call", ...info }));
      const result = await provider.decide(request);
      console.log(
        JSON.stringify({
          kind: "call_completed",
          ...info,
          provider: result.provider,
          latencyMs: Date.now() - started,
          totalTokens: result.usage.totalTokens,
        }),
      );
      return result;
    },
  });
  const orchestrator = new V2GameOrchestrator(
    repository,
    logged(base),
    logged(new AskJevProvider()),
  );
  const startingState = orchestrator.initialize(game.id);
  if (!["completed", "aborted", "budget_exhausted", "failed"].includes(game.status))
    new DecisionStore(repository).atomic(() => {
      if (values.resume && game.status === "paused")
        repository.appendEvent(game.id, {
          type: "game.resumed",
          phase: startingState.phase,
          day: startingState.day,
          visibility: "public",
          payload: { reason: "operator pilot resume" },
        });
      repository.updateGame(game.id, { status: "running", error: null });
    });
  for (
    let step = 0;
    step < 128 && ["running", "stepping"].includes(repository.getGame(game.id)!.status);
    step++
  ) {
    const before = reduceGame(game.id, repository.listEvents(game.id));
    if (values["pause-at-first-night"] && before.day === 1 && before.phase.startsWith("night_")) {
      new DecisionStore(repository).atomic(() => {
        repository.appendEvent(game.id, {
          type: "game.paused",
          phase: before.phase,
          day: before.day,
          visibility: "public",
          payload: { reason: "operator first-night checkpoint" },
        });
        repository.updateGame(game.id, { status: "paused", error: null });
      });
      checkpointReached = true;
      console.log(
        JSON.stringify({
          kind: "checkpoint",
          gameId: game.id,
          status: "paused",
          day: before.day,
          phase: before.phase,
          reason: "first night; no night actions started",
        }),
      );
      break;
    }
    await orchestrator.runGameStep(game.id);
    const current = repository.getGame(game.id)!,
      state = reduceGame(game.id, repository.listEvents(game.id));
    console.log(
      JSON.stringify({
        kind: "progress",
        status: current.status,
        day: state.day,
        phase: state.phase,
        attempts: new DecisionStore(repository).attempts(game.id).length,
        error: current.error,
      }),
    );
  }
}
const audit = auditGameV2(repository, game.id),
  current = repository.getGame(game.id)!;
const payload = observerPayload(repository, current, { kind: "moderator" }, undefined, {
  includeAttempts: true,
});
// Reuse the already loaded moderator snapshot instead of reloading every notebook
// and event once for each decision in a long game.
const details = decisionRecords(repository, game.id, { kind: "moderator" }).map((opportunity) => {
  const events = payload.events.filter((event) => event.payload.decisionId === opportunity.id);
  const attempts = (payload.attempts ?? []).filter(
    (attempt) => attempt.decisionId === opportunity.id,
  );
  return {
    opportunity,
    attempts,
    turns: events
      .filter((event) => event.type === "decision.reported")
      .map((event) => event.payload),
    events,
  };
});
const protocol =
  game.config.schemaVersion === "game_config_v2" ? game.config.protocolVersion : null;
const isSplit = protocol === "agent_v3" || protocol === "agent_v3_1";
const decisions = isSplit
  ? details.map((detail) =>
      detail
        ? {
            ...detail,
            attemptIds: detail.attempts.map((attempt) => attempt.id),
            attempts: undefined,
          }
        : detail,
    )
  : details;
const bundle = {
  schemaVersion:
    protocol === "agent_v3_1"
      ? "werewolf_research_bundle_v3_1"
      : protocol === "agent_v3"
        ? "werewolf_research_bundle_v3"
        : "werewolf_research_bundle_v2",
  perspective: "moderator",
  ...payload,
  attempts: payload.attempts ?? [],
  decisions,
};
await writeFile(join(directory, "research.json"), JSON.stringify(bundle, null, 2));
await writeFile(
  join(directory, "research.jsonl"),
  [
    JSON.stringify({
      kind: "metadata",
      schemaVersion: bundle.schemaVersion,
      perspective: "moderator",
      game: bundle.game,
    }),
    ...bundle.events.map((event) => JSON.stringify({ kind: "event", event })),
    ...bundle.decisions.map((decision) => JSON.stringify({ kind: "decision", decision })),
    ...bundle.attempts.map((attempt) => JSON.stringify({ kind: "attempt", attempt })),
  ].join("\n") + "\n",
);
await writeFile(join(directory, "audit.json"), JSON.stringify(audit, null, 2));
const lines = [
  `# ${protocol === "agent_v3_1" ? "V3.1" : protocol === "agent_v3" ? "V3" : "V2"} pilot audit`,
  "",
  `Game: ${game.id}`,
  `Status: ${audit.status}; day ${audit.day}; attempts ${audit.attempts}; known tokens ${audit.totalKnownTokens}; unknown usage attempts ${audit.unknownUsageAttempts}.`,
  "",
  `## Invariant findings`,
  "",
  ...(audit.issues.length ? audit.issues.map((i) => `- ${i}`) : ["No automated audit violations."]),
  "",
  `## Every explicit decision (spoilers)`,
  "",
  ...audit.decisions.flatMap((d) => [
    `### Day ${d.day} · ${d.playerId} (${d.role}) · ${d.phase}`,
    "",
    `Status: ${d.status}. Context estimate ${d.contextEstimate} tokens; ${d.sources} sources. Closing: ${d.closing}. Docket: ${d.docket.join(", ") || "none"}.`,
    ...d.turns.map((t) => `- ${t.summary} [${String(t.continuation)}]`),
    `Committed: ${JSON.stringify(d.committedProposal)}`,
    "",
  ]),
];
await writeFile(join(directory, "audit.md"), lines.join("\n"));
console.log(
  JSON.stringify({
    kind: "result",
    gameId: game.id,
    status: audit.status,
    issues: audit.issues,
    attempts: audit.attempts,
    tokens: audit.totalKnownTokens,
    artifacts: directory,
  }),
);
if (values.snapshot) {
  const target = await nativePath(join(directory, game.id + ".db"));
  try {
    await stat(target);
    throw new Error("Snapshot target already exists; select a fresh output directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await connection.sqlite.backup(target);
  console.log(JSON.stringify({ kind: "snapshot", path: target }));
}
connection.close();
if (audit.issues.length) process.exitCode = 1;
else if (!values.audit && !checkpointReached && audit.status !== "completed")
  process.exitCode = audit.status === "paused" ? 3 : 2;
