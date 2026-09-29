import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { controlStudy, CONDITIONS, SIGNALS, POLICIES } from "./lib/auction-control";
import { nativePath } from "./lib/native-path";
import { sha256 } from "./lib/auction-study-design";

export function controlReport(runs: ReturnType<typeof controlStudy>) {
  const mean = (values: number[]) =>
    values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) : "—";
  const lines = [
    "# Speaker auction: historical unordered disclosure control",
    "",
    "Scope: these facts may be disclosed in any order. This is not the intended causal A-before-B-before-C task; use auction:scale for ordered dependencies. No model calls. Scripted speakers, exact observation memory, three necessary facts and twelve slots. All 24 seat/tie orders are enumerated per cell. These are deterministic design cases, not independent human or model conversations.",
    "",
    "The observed-memory signal scores an unheard peer 0.7 and a peer who exhausted current information or supplied no task information 0.05. This explicit toy rule is the listening-signal assumption being tested. Flat-interest holds every sincere rating at 0.7. Nobody sees another actor's private arrival before disclosure. The scripts never lie about evidence; zero-rater is a private bidding intervention, not a misinformation test.",
    "",
    "| Condition | Signal | Arrivals | Policy | Mean completion slot | Incomplete /24 | Mean empty slots before completion |",
    "|---|---|---|---|---:|---:|---:|",
  ];
  for (const condition of CONDITIONS)
    for (const signal of SIGNALS)
      for (const staggered of [false, true])
        for (const policy of POLICIES) {
          const cells = runs.filter(
            (r) =>
              r.condition === condition &&
              r.signal === signal &&
              r.staggered === staggered &&
              r.policy === policy,
          );
          const completed = cells.flatMap((r) =>
            r.completionTurn === null ? [] : [r.completionTurn],
          );
          lines.push(
            `| ${condition} | ${signal} | ${staggered ? "1/4/7" : "1/1/1"} | ${policy} | ${mean(completed)} | ${cells.length - completed.length} / ${cells.length} | ${mean(cells.map((r) => r.uninformativeBeforeCompletion))} |`,
          );
        }
  lines.push(
    "",
    "Completion is the slot at which all three true links are publicly disclosed, not a model's inferred answer. Missing completion is censored, never treated as instant success. Trace JSON retains exact journals, each rating, selections, all source arrivals, and per-source eligible passovers. Floor/text counts after completion can reflect surplus slots, so they are not the primary utility measure.",
    "",
    "Personalities are implemented behaviors: max-rambler always urges 1 and adds no task evidence; zero-rater sets only p2's outgoing ratings to zero while keeping its ordinary truthful disclosure and urgency. Other actors disclose their record once, then accurately report no additional delivered information. All actors remain willing, and every scheduler excludes the last speaker. Cyclic scheduling advances a persistent seat cursor. Tie order is matched within each policy comparison.",
    "",
    "This isolates scheduler behavior under specified preferences. It does not establish that Jev will generate these preferences, that a rambler will follow a natural-language instruction, or that the auction is optimal. Uniform-interest is an ablation of the listening signal; it is not an estimate of a real model's error rate.",
    "",
  );
  return lines.join("\n");
}
async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log(
      "Usage: npm run auction:control -- --out NEW_DIRECTORY\nEnumerates 864 deterministic cases; no provider calls. Writes full traces and a descriptive report.",
    );
    return;
  }
  if (!values.out) throw new Error("Provide --out");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim())
    throw new Error("Commit the controlled protocol before running");
  const out = await nativePath(values.out);
  await mkdir(out, { mode: 0o700 });
  const paths = [
    "scripts/auction-control.ts",
    "scripts/lib/auction-control.ts",
    "packages/simulator/src/speaker-auction.ts",
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, sha256(await readFile(join(root, path), "utf8"))]),
    ),
  );
  const manifest = {
    protocol: "auction-control-v1",
    sourceCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    hashes,
    conditions: CONDITIONS,
    signals: SIGNALS,
    policies: POLICIES,
    slots: 12,
    bias: 0.25,
    modelCalls: 0,
  };
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const runs = controlStudy();
  await writeFile(join(out, "traces.json"), JSON.stringify(runs), { mode: 0o600 });
  await writeFile(join(out, "report.md"), controlReport(runs), { mode: 0o600 });
  console.log(JSON.stringify({ directory: out, cases: runs.length, modelCalls: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
