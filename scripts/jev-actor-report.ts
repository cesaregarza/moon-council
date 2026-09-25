import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { actorEvaluationCases } from "./jev-actor-eval";

const { values } = parseArgs({
  options: {
    holdouts: { type: "string" },
    reflection: { type: "string" },
    baseline: { type: "string" },
    revised: { type: "string" },
    out: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help)
  console.log(
    "Usage: tsx scripts/jev-actor-report.ts --baseline BASELINE_DIR --revised REVISED_DIR --out REPORT.json\nCombines exact synthetic receipts, verifies current revised prompts match, and compares observed rubric results, usage and latency. No model calls.\nPost-review receipts: --holdouts REPORT.json --reflection REPORT.json --out NEW_REPORT.json",
  );
else if (values.holdouts || values.reflection) {
  if (!values.holdouts || !values.reflection || !values.out)
    throw new Error("Supply --holdouts REPORT.json --reflection REPORT.json --out NEW_REPORT.json");
  const held = JSON.parse(await readFile(values.holdouts, "utf8"));
  const reflection = JSON.parse(await readFile(values.reflection, "utf8"));
  if (held.results.length !== 8 || !reflection.luna || reflection.results.length)
    throw new Error("Expected eight paired outcomes and one separate reflection receipt");
  const summarize = (workflow: string) => {
    const rows = held.results.filter((row: any) => row.workflow === workflow);
    const attempts = rows.flatMap((row: any) => row.attempts);
    return {
      cases: rows.length,
      firstChoicePasses: rows.filter((row: any) => row.choices[0]?.passes).length,
      failures: rows.filter((row: any) => !row.choices[0]?.passes).map((row: any) => row.label),
      modelVersions: [...new Set(attempts.map((attempt: any) => attempt.model))],
      inputTokens: attempts.reduce(
        (total: number, attempt: any) => total + (attempt.usage.inputTokens ?? 0),
        0,
      ),
      latencyMs: attempts.reduce(
        (total: number, attempt: any) => total + (attempt.latencyMs ?? 0),
        0,
      ),
      measuredAttempts: attempts.length,
      semanticReconsiderations: rows.reduce(
        (total: number, row: any) => total + row.semanticReconsiderationsMeasured,
        0,
      ),
      nonJevCalls: rows.reduce((total: number, row: any) => total + row.addedLlmCallsMeasured, 0),
    };
  };
  const summary = {
    baseline: summarize("journal_v3"),
    revised: summarize("journal_v4"),
    luna: {
      usage: reflection.luna.usage,
      reflectionLatencyMs: reflection.luna.reflectionLatencyMs,
      briefCharacters: reflection.luna.briefCharacters,
      voteStatus: reflection.luna.voteStatus,
    },
  };
  const report = {
    reportGeneratedAt: new Date().toISOString(),
    summary,
    limitations:
      "Four post-review cases, not an independent population benchmark. Preserve the cleared-villager failure. One Luna reflection measures total usage only, not incremental brief cost or whole-game savings. No prompt retuning after outcomes.",
    runNotes: [
      "The paired command completed and saved all eight Jev outcomes. Its optional Luna setup then rejected non-citable synthetic metadata before any Luna call. The source-ID filter was corrected to use JOURNAL_EVIDENCE_TYPES, and only the separate reflection leg was run; no Jev comparison arm was rerun.",
    ],
    holdouts: held,
    reflection,
  };
  await writeFile(values.out, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(summary, null, 2));
} else {
  if (!values.baseline || !values.revised || !values.out)
    throw new Error("Supply --baseline, --revised and --out");
  for (const path of [values.baseline, values.revised, values.out])
    if (resolve(path).startsWith("/mnt/")) throw new Error("Use native Linux paths");
  const current = actorEvaluationCases();
  const load = async (directory: string, verify: boolean) => {
    const results = JSON.parse(await readFile(join(directory, "results.json"), "utf8")) as Record<
      string,
      any
    >[];
    if (results.length !== current.length) throw new Error("Incomplete scenario set");
    return Promise.all(
      results.map(async (row) => {
        const fixture = current.find((c) => c.label === row.label);
        if (!fixture) throw new Error("Unknown case label");
        const input = JSON.parse(
          await readFile(join(directory, `${row.label}.input.json`), "utf8"),
        );
        if (verify && JSON.stringify(input.request) !== JSON.stringify(fixture.request))
          throw new Error(`Revised prompt changed: ${row.label}`);
        return { ...row, input };
      }),
    );
  };
  const baseline = await load(values.baseline, false),
    revised = await load(values.revised, true);
  const summarize = (rows: Record<string, any>[]) => ({
    cases: rows.length,
    passed: rows.filter((r) => r.passed).length,
    failures: rows.filter((r) => !r.passed).map((r) => r.label),
    invalidOrTransportErrors: rows.filter((r) => r.error).length,
    models: [...new Set(rows.map((r) => r.response?.model))],
    inputTokens: rows.reduce((n, r) => n + (r.response?.usage.input_tokens ?? 0), 0),
    latencyMs: rows.reduce((n, r) => n + r.latencyMs, 0),
    byConstruction: { retries: 0, addedLlmCalls: 0 },
  });
  const summary = { baseline: summarize(baseline), revised: summarize(revised) };
  const report = {
    reportGeneratedAt: new Date().toISOString(),
    scope:
      "Synthetic fixtures only. One call per workflow/case; no statistical reliability claim. No live LLM calls; briefs are fixtures. Runtime maintains them during existing mandatory reflections.",
    summary,
    baseline,
    revised,
  };
  await writeFile(values.out, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(summary, null, 2));
}
