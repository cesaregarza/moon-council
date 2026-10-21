import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { POLICIES } from "./lib/auction-control";
import { scaleJobs, runScaleCase, scaleSummary, type ScaleRun } from "./lib/auction-scale";
import { nativePath } from "./lib/native-path";
import { sha256 } from "./lib/auction-study-design";

export function scaleReport(summary: ReturnType<typeof scaleSummary>) {
  const lines = [
    "# Ordered dependency chains and speaker scheduling",
    "",
    "Correction: auction-scale-v1 counted independently available facts and did not implement the requested ordered task. Its one-cycle cyclic results are not evidence for this task. V2 requires each holder to receive the actual public predecessor output before producing its own result. An early turn records waiting and cannot count as a result. Earlier blocked turns are not retroactively credited when a prerequisite later appears.",
    "",
    "Zero provider calls. Compare 4/8/12/16 players and chains held by three players, 75% of players, or everyone except one. All 24 orders are enumerated at four players; larger sizes reuse 96 distinct fixed orders from v1. At four players the three chain lengths coincide, so repeated labels are not independent evidence. Each case starts fresh and allows N*k slots, enough for k complete cyclic passes. Completion requires publishing the terminal derived result, with every prerequisite validated.",
    "",
    "The production ranking formula, urgency-only selector, and persistent cyclic cursor are unchanged. Honest urgency is 0.8 only when a result is currently computable and unpublished, otherwise 0.05. The single optional rambler urges 1 and adds no result. Conditional public memory rates unheard peers 0.7 and blocked/exhausted/no-information peers 0.05; an explicitly stated waiting condition reopens to 0.7 when its public prerequisite arrives. Flat-interest always rates peers 0.7. Bids never inspect another actor's private packet or future output. All remain willing and all policies exclude the previous speaker.",
    "",
    "Report mean completion among completed cases with censoring separately. Cyclic >N and >2N counts expose actual revisits across cycles. The exact mean (N*k+1)/2 is for k distinct holders in a uniform random cyclic order: (N+1)/2 to the first holder, then mean forward distance N/2 per successor. Sampled means are labeled separately. This is a scripted causal task, not a test of live model comprehension or API efficiency.",
    "",
    "| Players | Steps | Profile | Condition | Signal | Auction | Urgency | Cyclic sampled | Cyclic exact | Cyclic >N | Cyclic >2N | Cyclic max | Incomplete A/U/C |",
    "|---:|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const row of summary) {
    const values = POLICIES.map((p) => row.outcomes[p]!.completedMean?.toFixed(2) ?? "—");
    const incomplete = POLICIES.map((p) => {
      const cell = row.outcomes[p]!;
      return `${cell.incomplete}/${cell.cases}`;
    }).join(", ");
    const cyclic = row.outcomes.cyclic!;
    lines.push(
      `| ${row.count} | ${row.holders} | ${row.profile} | ${row.condition} | ${row.signal} | ${values.join(" | ")} | ${row.exactUniformOrderedCyclicMean.toFixed(2)} | ${cyclic.overOneCycle}/${cyclic.cases} | ${cyclic.overTwoCycles}/${cyclic.cases} | ${cyclic.maxCompletion ?? "—"} | ${incomplete} |`,
    );
  }
  lines.push(
    "",
    "All policies face identical causal gates. The evaluator never selects the next speaker by hidden packet ownership; it merely prevents a result before its prerequisite exists. Perfect private readiness and exact conditional memory are declared assumptions, not measured Jev behavior. Waiting means temporarily blocked, not permanently exhausted. The old unordered task remains a separate historical baseline; its conclusions have been withdrawn for this ordered task.",
    "",
  );
  return lines.join("\n");
}
async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log(
      "Usage: npm run auction:scale -- --out NEW_DIRECTORY\nFrozen ordered dependency chains with 4/8/12/16 players. No provider calls.",
    );
    return;
  }
  if (!values.out) throw new Error("Provide --out");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim())
    throw new Error("Commit the scaling protocol before running");
  const out = await nativePath(values.out);
  await mkdir(out, { mode: 0o700 });
  const paths = [
    "scripts/auction-scale.ts",
    "scripts/lib/auction-scale.ts",
    "scripts/lib/auction-dependency.ts",
    "scripts/lib/auction-control.ts",
    "packages/simulator/src/speaker-auction.ts",
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, sha256(await readFile(join(root, path), "utf8"))]),
    ),
  );
  const jobs = scaleJobs();
  const manifest = {
    protocol: "auction-scale-v2",
    task: "public-predecessor-activated private transformations",
    completion: "terminal derived result published after all prerequisites",
    slotBudget: "players * chain steps",
    seatOrderVersion: "auction-scale-v1",
    sourceCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    hashes,
    modelCalls: 0,
    jobs,
  };
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  const runs: ScaleRun[] = jobs.map((job) => ({ ...runScaleCase(job), profile: job.profile }));
  const summary = scaleSummary(runs);
  await writeFile(join(out, "runs.json"), JSON.stringify(runs), { mode: 0o600 });
  await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  await writeFile(join(out, "report.md"), scaleReport(summary), { mode: 0o600 });
  console.log(JSON.stringify({ directory: out, cases: runs.length, modelCalls: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
