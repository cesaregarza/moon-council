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
    "# Group size and speaker scheduling",
    "",
    "Zero provider calls. All clues are initially available, one necessary fact per holder. Compare a fixed three holders, 75% of the roster, and everyone except one participant. All 24 orders are enumerated at four participants; each larger roster uses 96 distinct reproducible hash-sorted seat orders, matched across all conditions and policies. At four participants the three information profiles coincide; these repeated design cells are not independent evidence.",
    "",
    "The production auction and the original control's bidding rule are reused. Honest urgency is 0.8 with unshared evidence, 0.05 otherwise. The optional single rambler always urges 1 and has no clue. Observed-memory ratings are 0.7 for unheard peers and 0.05 after a peer exhausts its information or adds none. Flat-interest keeps ratings at 0.7. Ratings see only public speaking history, never another player's hidden clue ownership. All actors stay willing; every policy excludes the previous speaker. The cyclic cursor persists. A run stops when all necessary facts are public or after twice the roster size in slots.",
    "",
    "Means below are conditional on completion; incomplete counts are reported separately in auction/urgency/cyclic order. The exact cyclic expectation k(N+1)/(k+1) assumes a uniformly random order and is distinct from the sampled cyclic mean. It follows from the expected maximum of k distinct holder positions among N seats. The experiment measures disclosure turns, not answer comprehension, API calls, tokens, or elapsed model time.",
    "",
    "| Players | Necessary holders | Profile | Condition | Signal | Auction | Urgency | Cyclic sample | Cyclic exact | Incomplete |",
    "|---:|---:|---|---|---|---:|---:|---:|---:|---|",
  ];
  for (const row of summary) {
    const values = POLICIES.map((p) => row.outcomes[p]!.completedMean?.toFixed(2) ?? "—");
    const incomplete = POLICIES.map((p) => {
      const cell = row.outcomes[p]!;
      return `${cell.incomplete}/${cell.cases}`;
    }).join(", ");
    lines.push(
      `| ${row.count} | ${row.holders} | ${row.profile} | ${row.condition} | ${row.signal} | ${values.join(" | ")} | ${row.exactUniformCyclicMean.toFixed(2)} | ${incomplete} |`,
    );
  }
  lines.push(
    "",
    "These are scripted design cases, not independent model conversations. Perfect observation memory and declared urgency/listening rules remove model comprehension error but do not guarantee real models will supply useful preferences. More participants can add waiting, useful evidence, adversaries, and bid-collection work; this experiment varies only roster size and evidence density, retaining at most one rambler. It does not test delayed arrivals, coalitions, multiple ramblers, or language-model scheduling at scale.",
    "",
  );
  return lines.join("\n");
}
async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log(
      "Usage: npm run auction:scale -- --out NEW_DIRECTORY\nFrozen 4/8/12/16-player, three-density scripted comparison. No provider calls.",
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
    protocol: "auction-scale-v1",
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
