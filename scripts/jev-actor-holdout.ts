import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { emptyJournalV2 } from "@werewolf/contracts";
import { LabRepository, openDatabase } from "@werewolf/db";
import { AskJevProvider, FakeDecisionProvider, OpenAIResponsesProvider } from "@werewolf/llm";
import { DecisionExecutorV2 } from "../packages/simulator/src/decisions-v2";
import { JOURNAL_EVIDENCE_TYPES } from "../packages/simulator/src/player-brief";
import { applyJournalV2, contentHash } from "../packages/simulator/src/context-v2";
import {
  decisionRequestV31,
  normalizeV31Submission,
  validateV31Submission,
} from "../packages/simulator/src/request-v3-1";
import {
  createActorHoldout,
  HOLDOUT_LABELS,
  type HoldoutLabel,
} from "../packages/simulator/src/testing/actor-holdouts";
import { holdoutVote } from "../packages/simulator/src/testing/actor-execution";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function vote(label: HoldoutLabel, workflow: "journal_v3" | "journal_v4", live: boolean) {
  const db = openDatabase(":memory:");
  try {
    const repository = new LabRepository(db),
      fixture = createActorHoldout(repository, label, workflow, 2);
    const options = holdoutVote(repository, fixture);
    if (!live) return { label, workflow, rubric: fixture.rubric, packet: fixture.packet };
    let error: string | null = null;
    try {
      await new DecisionExecutorV2(
        repository,
        new FakeDecisionProvider(),
        new AskJevProvider(),
      ).execute(options);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const attempts = fixture.store.attempts(fixture.game.id, options.opportunity.id);
    const op = fixture.store.opportunities(fixture.game.id)[0]!;
    const assessments = repository
      .listEvents(fixture.game.id)
      .filter((event) => event.type === "decision.semantic_assessed");
    const choices = attempts.map((attempt) => {
      let handle: string | undefined;
      try {
        handle = JSON.parse(attempt.response ?? "{}").answers?.target?.choice;
      } catch {}
      const target =
        handle === "abstain"
          ? null
          : handle
            ? fixture.packet.legalTargets[handle.charCodeAt(0) - 97]
            : undefined;
      return {
        attemptId: attempt.id,
        handle,
        target,
        passes:
          target !== undefined &&
          (fixture.expectedTarget !== undefined
            ? target === fixture.expectedTarget
            : target !== fixture.forbiddenTarget),
      };
    });
    return {
      label,
      workflow,
      rubric: fixture.rubric,
      packet: fixture.packet,
      choices,
      status: op.status,
      error,
      attempts,
      assessments,
      addedLlmCallsMeasured: attempts.filter((attempt) => attempt.provider !== "jev").length,
      semanticReconsiderationsMeasured: attempts.filter(
        (attempt) => JSON.parse(attempt.request.input).state?.reconsideration,
      ).length,
      harnessRepetitionsByConstruction: 0,
    };
  } finally {
    db.close();
  }
}
async function lunaReflection() {
  const db = openDatabase(":memory:");
  const repository = new LabRepository(db),
    fixture = createActorHoldout(repository, "doubt-dominated");
  const packet = {
    ...fixture.packet,
    journal: {
      ...emptyJournalV2(),
      text: "I have kept my role private and have not yet reflected on the latest result or speeches.",
    },
  };
  const task = {
    type: "journal_update" as const,
    revision: String(packet.rules.journalRevision),
    sourceIds: packet.sources
      .filter((source) => JOURNAL_EVIDENCE_TYPES.has(source.type))
      .map((source) => source.id),
  };
  const prepared = decisionRequestV31(packet, task, true, null, null);
  const receipt: Record<string, unknown> = {
    scenario: "doubt-dominated",
    packet,
    promptVersion: prepared.promptVersion,
    task,
    model: "gpt-6-luna",
    reasoningEffort: "xhigh",
    callsByConstruction: 1,
  };
  const started = Date.now();
  try {
    const result = await new OpenAIResponsesProvider().decide({
      kind: "decision_v3_1",
      gameId: fixture.game.id,
      playerId: fixture.actor.id,
      model: "gpt-6-luna",
      reasoningEffort: "xhigh",
      schemaName: task.type,
      schema: prepared.schema,
      apiResponseFormat: prepared.apiResponseFormat,
      preparedPrompt: prepared.prompt,
      contextV2: packet,
      proposalKind: "pass",
      commitOnly: true,
      maxOutputTokens: 8192,
      timeoutMs: 120000,
      onUsage: (usage, metadata) => {
        receipt.usage = usage;
        receipt.metadata = metadata;
      },
      onProviderRequest: (wire) => {
        receipt.wireRequest = wire;
      },
      onRawResponse: (raw) => {
        receipt.raw = raw;
      },
      onProviderMetadata: (metadata) => {
        receipt.providerMetadata = metadata;
      },
    });
    const errors = validateV31Submission(packet, task, result.data);
    if (errors.length) throw new Error(errors.join("; "));
    const report = normalizeV31Submission(packet, task, result.data, "luna-reflection", true);
    fixture.packet.journal = applyJournalV2(packet.journal, report, 16000);
    // Keep the same in-memory journal base for the follow-on real decision executor.
    repository.appendEvent(fixture.game.id, {
      type: "journal.v2_updated",
      phase: packet.phase,
      day: packet.day,
      visibility: "player",
      audienceIds: [fixture.actor.id],
      payload: { playerId: fixture.actor.id, journal: fixture.packet.journal },
    });
    receipt.reflectionLatencyMs = Date.now() - started;
    receipt.brief = fixture.packet.journal.decisionBrief;
    receipt.briefCharacters = {
      action: fixture.packet.journal.decisionBrief!.action.length,
      attention: fixture.packet.journal.decisionBrief!.attention.length,
    };
    const options = holdoutVote(repository, fixture);
    options.opportunity.baseJournalVersion = fixture.packet.journal.version;
    options.opportunity.viewId = contentHash(fixture.packet);
    fixture.store.save(options.opportunity);
    try {
      await new DecisionExecutorV2(
        repository,
        new FakeDecisionProvider(),
        new AskJevProvider(),
      ).execute(options);
    } catch (error) {
      receipt.voteError = error instanceof Error ? error.message : String(error);
    }
    receipt.voteAttempts = fixture.store.attempts(fixture.game.id);
    receipt.voteStatus = fixture.store.opportunities(fixture.game.id)[0]!.status;
    receipt.semanticAssessments = repository
      .listEvents(fixture.game.id)
      .filter((event) => event.type === "decision.semantic_assessed");
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    receipt.reflectionLatencyMs = Date.now() - started;
  } finally {
    db.close();
  }
  return receipt;
}
async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      luna: { type: "boolean" },
      "luna-only": { type: "boolean" },
      out: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: tsx scripts/jev-actor-holdout.ts [--live --out NEW_DIRECTORY] [--luna|--luna-only]\nFour post-review synthetic cases, each arm once. Production may reconsider one provable contradiction. Preserves every outcome, including rubric failures. --luna adds one real reflection and its Jev ballot; no full game. Offline by default.",
    );
    return;
  }
  if ((values.luna || values["luna-only"]) && !values.live)
    throw new Error("--luna requires --live");
  let directory: string | undefined;
  if (values.live) {
    if (!values.out) throw new Error("--live requires --out NEW_DIRECTORY");
    const output = resolve(values.out),
      parent = await realpath(dirname(output));
    if (parent === "/mnt" || parent.startsWith("/mnt/")) throw new Error("Use native Linux paths");
    directory = join(parent, basename(output));
    await mkdir(directory, { mode: 0o700 });
  }
  const promptFiles = [
    "packages/simulator/src/jev-actor.ts",
    "packages/simulator/src/jev-actions.ts",
    "packages/simulator/src/jev-semantics.ts",
    "packages/simulator/src/request-v3-1.ts",
    "packages/simulator/src/testing/actor-holdouts.ts",
  ];
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const fileHashes = Object.fromEntries(
    await Promise.all(
      promptFiles.map(async (path) => [path, sha(await readFile(join(root, path), "utf8"))]),
    ),
  );
  const report: {
    generatedAt: string;
    method: string;
    fileHashes: Record<string, string>;
    results: unknown[];
    luna?: unknown;
  } = {
    generatedAt: new Date().toISOString(),
    method:
      "Post-review cases authored after prompt freeze; not an independent population benchmark. Both arms run once, all outcomes retained. Production guard may add one reconsideration. No reruns based on results.",
    fileHashes,
    results: [],
  };
  const save = async () => {
    if (directory)
      await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
        mode: 0o600,
      });
  };
  await save();
  for (const label of values["luna-only"] ? [] : HOLDOUT_LABELS)
    for (const workflow of ["journal_v3", "journal_v4"] as const) {
      const result = await vote(label, workflow, Boolean(values.live));
      report.results.push(result);
      await save();
      console.log(
        JSON.stringify({
          label,
          workflow,
          ...("choices" in result
            ? { choices: result.choices, status: result.status, error: result.error }
            : { rubric: result.rubric }),
        }),
      );
    }
  if (values.luna || values["luna-only"]) {
    report.luna = await lunaReflection();
    await save();
    console.log(
      JSON.stringify({
        luna: "receipt saved",
        ...Object.fromEntries(
          Object.entries(report.luna as object).filter(([key]) =>
            ["error", "usage", "reflectionLatencyMs", "briefCharacters", "voteStatus"].includes(
              key,
            ),
          ),
        ),
      }),
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
