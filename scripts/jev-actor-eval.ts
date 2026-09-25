import { mkdir, writeFile, realpath } from "node:fs/promises";
import { dirname, basename, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { actorConfig, actorFixtures } from "../packages/simulator/src/testing/actor-fixtures";
import { prepareJevAction } from "../packages/simulator/src/jev-actions";
import { decisionRequestV31, normalizeV31Submission } from "../packages/simulator/src/request-v3-1";
import { evaluateProbeCase, describeProbeCase } from "./jev-probe";
import type { V3TaskSpec } from "../packages/simulator/src/request-v3";
import type { JevRequest } from "../packages/llm/src/jev";

export function actorEvaluationCases(workflow: "journal_v3" | "journal_v4" = "journal_v4") {
  return actorFixtures().map((f) => {
    const config = actorConfig();
    config.decisionEngine.workflow = workflow;
    f.packet.rules.jevWorkflow = workflow;
    const task = {
      type: f.task,
      proposalKind:
        f.task === "night_choice"
          ? "night_action"
          : f.task === "team_point_choice"
            ? "team_point"
            : f.task === "discussion_score"
              ? "discussion"
              : "vote",
    } as V3TaskSpec;
    const base = {
      ...decisionRequestV31(f.packet, task, true, null, null),
      schemaName: f.task,
      normalize: (v: unknown) =>
        normalizeV31Submission(f.packet, task, v as never, "synthetic", true),
    };
    const stage = prepareJevAction(
      { packet: f.packet, playerId: f.packet.self.id, taskType: f.task },
      config,
      base,
    );
    const expected =
      f.expectedTarget === undefined
        ? undefined
        : f.expectedTarget === null
          ? "abstain"
          : String.fromCharCode(97 + f.packet.legalTargets.indexOf(f.expectedTarget));
    return {
      label: f.label,
      request: JSON.parse(stage.prepared.prompt.input) as JevRequest,
      expected,
      rubric: f.rubric,
      promptVersion: stage.prepared.promptVersion,
    };
  });
}
async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      out: { type: "string" },
      workflow: { type: "string", default: "journal_v4" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: npm run jev:actor-eval -- [--workflow journal_v3|journal_v4] [--live --out NEW_DIRECTORY]\nOffline by default. --live sends eight synthetic scenarios once each (no retries, no saved games). Saves exact prompts, distributions, model versions, usage, latency, rubric results. Fails if any response fails its semantic rubric; confidence is not correctness.",
    );
    return;
  }
  if (values.workflow !== "journal_v3" && values.workflow !== "journal_v4")
    throw new Error("Use journal_v3 or journal_v4");
  const cases = actorEvaluationCases(values.workflow);
  if (!values.live) {
    console.log(
      JSON.stringify(
        cases.map((c) => ({ ...describeProbeCase(c), expected: c.expected, rubric: c.rubric })),
        null,
        2,
      ),
    );
    return;
  }
  if (!values.out) throw new Error("Live evaluation requires --out NEW_DIRECTORY");
  const output = resolve(values.out),
    parent = await realpath(dirname(output));
  if (parent === "/mnt" || parent.startsWith("/mnt/")) throw new Error("Use native Linux paths");
  const directory = join(parent, basename(output));
  await mkdir(directory, { mode: 0o700 });
  const results = [];
  for (const c of cases) {
    await writeFile(join(directory, `${c.label}.input.json`), JSON.stringify(c, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    const start = Date.now();
    let response;
    try {
      response = await evaluateProbeCase(c);
    } catch {
      response = {
        raw: "",
        response: null,
        error: "Transport failed; see private ask-jev request log",
      };
    }
    const answers = response.response?.answers;
    const target = answers?.target;
    const score = (key: string) => {
      const a = answers?.[key];
      return a?.type === "score" ? a.score : undefined;
    };
    const passed =
      c.expected !== undefined
        ? target?.type === "choice" && target.choice === c.expected
        : score("listen_3") !== undefined &&
          score("listen_1") !== undefined &&
          score("listen_3")! > score("listen_1")!;
    const result = {
      ...describeProbeCase(c),
      promptVersion: c.promptVersion,
      latencyMs: Date.now() - start,
      expected: c.expected ?? "listen_3 > listen_1",
      rubric: c.rubric,
      passed,
      ...response,
    };
    results.push(result);
    await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        label: c.label,
        passed,
        model: response.response?.model,
        latencyMs: result.latencyMs,
        usage: response.response?.usage,
        error: response.error,
      }),
    );
    if (response.error) break;
  }
  if (results.length !== cases.length || results.some((r) => !r.passed)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
