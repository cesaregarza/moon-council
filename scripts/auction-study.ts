#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { loadProviderEnvironment } from "@werewolf/llm";
import { nativePath } from "./lib/native-path";
import { chainDesign } from "./lib/chain-study-design";
import { AUCTION_SCENARIOS } from "./lib/auction-study-scenarios";
import {
  FOCUSED,
  RAMBLING,
  studyRuns,
  validateManifest,
  type StudyManifest,
} from "./lib/auction-study-design";
import { runStudyDiscussion } from "./lib/auction-study-runner";
import { loadCheckpoints, writeStudyReport } from "./lib/auction-study-analysis";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function currentSource() {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", sourceRoot, ...args], { encoding: "utf8" }).trim();
  return {
    commit: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain", "--untracked-files=normal")),
  };
}
async function execute(root: string, manifest: StudyManifest) {
  const lock = join(root, ".running");
  await writeFile(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    if (manifest.live) loadProviderEnvironment();
    let index = 0;
    const worker = async () => {
      while (index < manifest.runs.length) {
        const run = manifest.runs[index++]!;
        const directory = await nativePath(join(root, run.id));
        // Preserve failed/interrupted attempts. Resume starts only untouched discussions.
        if (existsSync(directory)) continue;
        console.log(JSON.stringify({ kind: "started", run: run.id }));
        await runStudyDiscussion(directory, manifest, run);
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: manifest.concurrency }, worker));
    const report = await writeStudyReport(root, manifest);
    const rejected = workers.find((worker) => worker.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    if (report.complete !== report.expected)
      throw new Error("Study contains incomplete discussions; inspect checkpoints and report");
  } finally {
    await unlink(lock);
  }
}
export async function studyStatus(root: string, manifest: StudyManifest) {
  const states = await loadCheckpoints(root, manifest);
  return manifest.runs.map((run) => {
    const state = states.find((item) => item.run.id === run.id);
    return {
      id: run.id,
      status: state?.status ?? (existsSync(join(root, run.id)) ? "interrupted" : "not_started"),
      turns: state?.auctions.length ?? 0,
      speeches: state?.speeches.length ?? 0,
      answers: state?.answers.length ?? 0,
      error: state?.error ?? null,
    };
  });
}
async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      live: { type: "boolean" },
      fake: { type: "boolean" },
      resume: { type: "boolean" },
      status: { type: "boolean" },
      report: { type: "boolean" },
      out: { type: "string" },
      seeds: { type: "string", default: "auction-pilot-1" },
      scenarios: { type: "string" },
      protocol: { type: "string", default: "free-floor-v1" },
      model: { type: "string", default: "gpt-6-luna" },
      effort: { type: "string", default: "xhigh" },
      turns: { type: "string", default: "12" },
      concurrency: { type: "string", default: "2" },
      "max-minutes": { type: "string", default: "30" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: npm run auction:study -- [--live | --fake] --out NEW_DIRECTORY [--seeds SEED,SEED] [--protocol free-floor-v1 | clue-chain-v1] [--scenarios supplier,incident,correction] [--turns 12] [--concurrency 2] [--model gpt-6-luna] [--effort xhigh] [--max-minutes 30]\nDefault previews, no calls or writes. --status / --report --out DIR are read-only with respect to discussions and never call providers. --report writes derived private analysis. --resume --out DIR uses the frozen manifest and starts only untouched discussions; it never retries an existing failed/interrupted discussion. Runs require a clean committed source tree. A stale .running lock requires operator inspection/removal after verifying its process is gone. Artifacts contain private synthetic evidence and journals.",
    );
    return;
  }
  const modes = [values.live, values.fake, values.resume, values.status, values.report].filter(
    Boolean,
  );
  if (modes.length > 1) throw new Error("Choose only one execution or inspection mode");
  const root = values.out ? await nativePath(values.out) : null;
  if (modes.length && !root) throw new Error("--out is required");
  if (values.status || values.report || values.resume) {
    const manifest = validateManifest(
      JSON.parse(await readFile(join(root!, "manifest.json"), "utf8")),
    );
    if (values.status) console.log(JSON.stringify(await studyStatus(root!, manifest), null, 2));
    else if (values.report) console.log(JSON.stringify(await writeStudyReport(root!, manifest)));
    else {
      const source = currentSource();
      if (source.dirty || source.commit !== manifest.sourceCommit)
        throw new Error("Resume requires the original clean source commit");
      await execute(root!, manifest);
    }
    return;
  }
  const source = currentSource();
  if (values.protocol === "clue-chain-v1" && values.scenarios)
    throw new Error("The chain protocol generates its scenario from each seed; omit --scenarios");
  const design =
    values.protocol === "clue-chain-v1"
      ? chainDesign(values.seeds!.split(","))
      : {
          runs: studyRuns(
            values.seeds!.split(","),
            (values.scenarios ?? AUCTION_SCENARIOS.map((item) => item.id).join(",")).split(","),
          ),
          scenarios: AUCTION_SCENARIOS,
          personalities: { focused: FOCUSED, rambling: RAMBLING },
        };
  const manifest: StudyManifest = validateManifest({
    schemaVersion: "speech_auction_study_v1",
    protocol: values.protocol,
    createdAt: new Date().toISOString(),
    sourceCommit: source.commit,
    live: Boolean(values.live),
    model: values.model!,
    effort: values.effort!,
    turns: Number(values.turns),
    bias: 0.25,
    concurrency: Number(values.concurrency),
    maxMinutes: Number(values["max-minutes"]),
    ...design,
  });
  if (!values.live && !values.fake) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  if (source.dirty) throw new Error("Commit verified source before running a reproducible study");
  await mkdir(dirname(root!), { recursive: true });
  await mkdir(root!, { mode: 0o700 });
  await writeFile(join(root!, "manifest.json"), JSON.stringify(manifest, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  await execute(root!, manifest);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
