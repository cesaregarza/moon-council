#!/usr/bin/env -S npx tsx
import { nativePath } from "./lib/native-path";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { GameConfigV2 } from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase } from "@werewolf/db";
import { reduceGame } from "@werewolf/engine";
import { AskJevProvider, createDecisionProvider, loadProviderEnvironment } from "@werewolf/llm";
import { V2GameOrchestrator } from "../packages/simulator/src/orchestrator-v2";
import { auditGameV2 } from "../packages/simulator/src/audit-v2";
import { observerPayload, decisionRecords } from "../apps/api/src/observer";
import { summarizeGameAudit, summarizeGameProgress, summarizeJournalWorkflow } from "./game-audit";
import { attentionConfigs, syntheticAttentionJev } from "./lib/attention-experiment";

async function runArm(directory: string, config: GameConfigV2, live: boolean) {
  await mkdir(directory, { mode: 0o700 });
  const db = openDatabase(join(directory, "game.db"));
  try {
    const repository = new LabRepository(db),
      store = new DecisionStore(repository);
    const game = repository.createGame(config);
    const runner = new V2GameOrchestrator(
      repository,
      createDecisionProvider(live ? "openai" : "fake"),
      live ? new AskJevProvider() : syntheticAttentionJev(),
    );
    runner.initialize(game.id);
    console.log(
      JSON.stringify({
        kind: "started",
        directory,
        gameId: game.id,
        name: config.name,
        modelSettings: config.modelSettings,
        safety: config.safety,
      }),
    );
    repository.updateGame(game.id, { status: "running" });
    for (let step = 0; step < 4; step++) {
      const state = reduceGame(game.id, repository.listEvents(game.id));
      if (
        !["setup", "day_discussion"].includes(state.phase) ||
        repository.getGame(game.id)!.status !== "running"
      )
        break;
      await runner.runGameStep(game.id);
    }
    // The phase boundary can follow a final closing speech. Complete that pending
    // reflection batch in decision-step mode; refreshJournals runs before any vote.
    if (
      reduceGame(game.id, repository.listEvents(game.id)).phase === "day_vote" &&
      repository.getGame(game.id)!.status === "running" &&
      summarizeJournalWorkflow(repository.listEvents(game.id), store.attempts(game.id)).checks.some(
        (check) => check.status === "pending" && check.missingPlayerIds.length > 0,
      )
    ) {
      store.put(game.id, "stepUnit", "decision");
      repository.updateGame(game.id, { status: "stepping" });
      await runner.runGameStep(game.id);
      if (repository.getGame(game.id)!.status === "stepping")
        repository.updateGame(game.id, { status: "running" });
    }
    const state = reduceGame(game.id, repository.listEvents(game.id));
    const reachedBoundary =
      state.phase === "day_vote" && repository.getGame(game.id)!.status === "running";
    if (reachedBoundary) {
      repository.appendEvent(game.id, {
        type: "game.paused",
        phase: state.phase,
        day: state.day,
        visibility: "public",
        payload: { reason: "attention experiment: discussion complete, before first vote" },
      });
      repository.updateGame(game.id, { status: "paused", error: null });
    }
    const current = repository.getGame(game.id)!;
    const audit = summarizeGameAudit(
      { ...current, error: current.error ?? null },
      repository.listEvents(game.id),
      store.attempts(game.id),
    );
    const invariantAudit = auditGameV2(repository, game.id);
    if (repository.listEvents(game.id).some((event) => event.type.startsWith("vote.")))
      invariantAudit.issues.push("Experiment crossed the before-vote boundary");
    const payload = observerPayload(repository, current, { kind: "moderator" }, undefined, {
      includeAttempts: true,
    });
    const bundle = {
      schemaVersion: "werewolf_research_bundle_v3_1",
      perspective: "moderator",
      ...payload,
      journals: payload.state.journals,
      decisions: decisionRecords(repository, game.id, { kind: "moderator" }).map((opportunity) => ({
        opportunity,
        attemptIds: store.attempts(game.id, opportunity.id).map((attempt) => attempt.id),
        events: payload.events.filter((event) => event.payload.decisionId === opportunity.id),
      })),
    };
    await writeFile(join(directory, "research.json"), JSON.stringify(bundle, null, 2), {
      mode: 0o600,
    });
    await writeFile(join(directory, "audit.json"), JSON.stringify(audit, null, 2), { mode: 0o600 });
    await writeFile(join(directory, "invariants.json"), JSON.stringify(invariantAudit, null, 2), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        kind: "finished",
        reachedBoundary,
        issues: invariantAudit.issues,
        ...summarizeGameProgress(audit),
      }),
    );
    if (!reachedBoundary || invariantAudit.issues.length)
      throw new Error(`Incomplete arm: ${current.error ?? current.status}; see saved diagnostics`);
    return {
      gameId: game.id,
      directory,
      attention: audit.discussion.attention,
      provider: audit.provider,
      reflections: audit.journal,
    };
  } finally {
    db.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      live: { type: "boolean" },
      fake: { type: "boolean" },
      out: { type: "string" },
      model: { type: "string", default: "gpt-6-luna" },
      effort: { type: "string", default: "xhigh" },
      seed: { type: "string", default: "attention-rambler-1" },
      "max-calls": { type: "string", default: "500" },
      "max-minutes": { type: "string", default: "30" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: npm run attention:experiment -- [--live | --fake] [--out NEW_DIRECTORY] [--model MODEL] [--effort EFFORT] [--seed SEED] [--max-calls 500] [--max-minutes 30]\nDefault previews paired configurations without model calls or writes. --live runs OpenAI + Jev; --fake checks mechanics only. Each arm stops after Day 1 discussion, before voting. Output includes private game artifacts; keep it outside public source. Existing output directories are rejected.",
    );
    return;
  }
  if (values.live && values.fake) throw new Error("Choose --live or --fake");
  const configs = attentionConfigs({
    model: values.model!,
    effort: values.effort!,
    seed: values.seed!,
    live: Boolean(values.live),
    maxCalls: Number(values["max-calls"]),
    maxMinutes: Number(values["max-minutes"]),
  });
  if (!values.live && !values.fake) {
    console.log(JSON.stringify(configs, null, 2));
    return;
  }
  if (!values.out) throw new Error("An explicit, fresh --out directory is required");
  const directory = await nativePath(values.out);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  if (values.live) loadProviderEnvironment();
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(
      {
        ...configs,
        live: Boolean(values.live),
        hypothesis:
          "A persistent rambler with maximal urgency may lose listener interest and floor share.",
        limitation:
          "One paired stochastic trial; personality and urgency change together. Same seed fixes roles, not model outputs. Normal opening quotas, readiness and follow-up caps remain in force.",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const control = await runArm(join(directory, "control"), configs.control, Boolean(values.live));
  const treatment = await runArm(
    join(directory, "treatment"),
    configs.treatment,
    Boolean(values.live),
  );
  await writeFile(
    join(directory, "comparison.json"),
    JSON.stringify({ targetId: configs.targetId, control, treatment }, null, 2),
    { mode: 0o600 },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
