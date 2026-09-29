import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AskJevProvider, OpenAIResponsesProvider } from "@werewolf/llm";
import {
  BID_PROTOCOL,
  JOURNAL_PROTOCOL,
  JOURNAL_MAX_CALLS,
  MAX_CALLS,
  NEAR_TIE,
  ORDER_SEED,
  PAIRS,
  bidRequest,
  journalRequest,
  orderedContexts,
} from "./lib/auction-bid-design";
import { sha256 } from "./lib/auction-study-design";
import { saveJson } from "./lib/auction-study-runner";
import { BidCalls, fileRecorder, runBidJobs, type BidObservation } from "./lib/auction-bid-runner";
import { bidReport, summarizeBids } from "./lib/auction-bid-report";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = [
  "scripts/auction-bid-probe.ts",
  "scripts/fixtures/auction-bid-cases.json",
  "scripts/lib/auction-bid-design.ts",
  "scripts/lib/auction-bid-runner.ts",
  "scripts/lib/auction-bid-report.ts",
  "scripts/lib/auction-study-agents.ts",
  "scripts/lib/study-journal.ts",
  "scripts/lib/chain-study-design.ts",
  "packages/llm/src/jev.ts",
  "packages/llm/src/openai.ts",
  "packages/llm/src/openai-cache.ts",
  "package-lock.json",
];
const git = (...args: string[]) =>
  execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
async function hashes() {
  return Object.fromEntries(
    await Promise.all(
      SOURCES.map(async (file) => [file, sha256(await readFile(join(ROOT, file), "utf8"))]),
    ),
  );
}
async function nativePath(path: string, existing: boolean) {
  const lexical = resolve(path);
  const forbidden = (value: string) => value === "/mnt" || value.startsWith("/mnt/");
  if (forbidden(lexical)) throw new Error("Use native Linux probe storage");
  const canonical = await realpath(existing ? lexical : dirname(lexical));
  if (forbidden(canonical)) throw new Error("Use native Linux probe storage");
  return lexical;
}
export async function prepareBidProbe(directory: string, comparison = false) {
  if (git("status", "--porcelain"))
    throw new Error("Commit source changes before freezing a live protocol");
  const out = await nativePath(directory, false);
  await mkdir(out, { mode: 0o700 });
  const jobs = orderedContexts();
  const manifest = {
    protocol: comparison ? JOURNAL_PROTOCOL : BID_PROTOCOL,
    createdAt: new Date().toISOString(),
    sourceCommit: git("rev-parse", "HEAD"),
    sourceHashes: await hashes(),
    maxCalls: comparison ? JOURNAL_MAX_CALLS : MAX_CALLS,
    maxMinutes: 20,
    concurrency: 2,
    model: "gpt-6-luna",
    effort: "xhigh",
    jev: "jev-latest",
    outputTokenLimit: null,
    ...(comparison
      ? {
          journalAssessment: [
            "Retain explicit statements of no additional evidence, absent records, and refusals, with attribution.",
            "Distinguish answered, unanswered, declined, and superseded questions; retain consequential remaining uncertainty.",
            "Keep personally received records separate from public claims and pending events.",
            "State what another contribution could add without inventing a contribution or imposing a lower bid.",
            "Preserve private objective, actual beliefs, and strategy separately; do not silently turn obstruction into cooperation.",
            "Treat unchanged truthful clue retention under padding as a preservation check, not a score target.",
          ],
        }
      : {}),
    orderSeed: ORDER_SEED,
    nearTie: NEAR_TIE,
    pairs: PAIRS,
    jobs,
    previews: jobs.map((job) => ({
      id: job.id,
      authored: bidRequest(job.context, job.context.authoredJournal),
      journal: journalRequest(job.context),
      ...(comparison ? { memoryV2: journalRequest(job.context, "memory-v2") } : {}),
    })),
  };
  await saveJson(join(out, "manifest.json"), manifest);
  return manifest;
}
export async function reportBidProbe(directory: string) {
  const raw = await readFile(join(directory, "manifest.json"), "utf8");
  const frozen = JSON.parse(raw) as { protocol: string; pairs: unknown };
  if (
    ![BID_PROTOCOL, JOURNAL_PROTOCOL].includes(frozen.protocol) ||
    JSON.stringify(frozen.pairs) !== JSON.stringify(PAIRS)
  )
    throw new Error("Generate the report using the frozen protocol and fixture version");
  const observations = JSON.parse(
    await readFile(join(directory, "results.json"), "utf8"),
  ) as BidObservation[];
  await saveJson(join(directory, "summary.json"), {
    manifestHash: sha256(raw),
    rows: summarizeBids(
      observations,
      frozen.protocol === JOURNAL_PROTOCOL ? ["luna", "memory-v2"] : undefined,
    ),
  });
  await writeFile(
    join(directory, "report.md"),
    bidReport(observations, sha256(raw), frozen.protocol === JOURNAL_PROTOCOL),
    {
      mode: 0o600,
    },
  );
}
async function run(directory: string) {
  const raw = await readFile(join(directory, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as Awaited<ReturnType<typeof prepareBidProbe>>;
  if (
    ![BID_PROTOCOL, JOURNAL_PROTOCOL].includes(manifest.protocol) ||
    manifest.sourceCommit !== git("rev-parse", "HEAD") ||
    git("status", "--porcelain")
  )
    throw new Error("Run only the clean source commit frozen in the manifest");
  const currentHashes = await hashes();
  if (
    JSON.stringify(manifest.sourceHashes) !== JSON.stringify(currentHashes) ||
    JSON.stringify(manifest.jobs) !== JSON.stringify(orderedContexts()) ||
    JSON.stringify(manifest.pairs) !== JSON.stringify(PAIRS) ||
    manifest.maxCalls !==
      (manifest.protocol === JOURNAL_PROTOCOL ? JOURNAL_MAX_CALLS : MAX_CALLS) ||
    manifest.maxMinutes !== 20
  )
    throw new Error("Frozen source, input, or budget changed");
  const providers = { jev: new AskJevProvider(), luna: new OpenAIResponsesProvider() };
  // Exclusive marker refuses rerunning after success, failure, or an uncertain interruption.
  await writeFile(
    join(directory, "started.json"),
    JSON.stringify({ at: new Date().toISOString(), manifestHash: sha256(raw) }),
    { flag: "wx", mode: 0o600 },
  );
  const results = await runBidJobs(
    new BidCalls(providers, fileRecorder(directory), 20, manifest.maxCalls),
    manifest.jobs,
    async (items) => {
      await saveJson(join(directory, "results.json"), items);
      console.log(
        JSON.stringify({
          observations: items.length,
          complete: items.filter((r) => r.status === "complete").length,
        }),
      );
    },
    manifest.protocol === JOURNAL_PROTOCOL,
  );
  await reportBidProbe(directory);
  const failed = results.filter((r) => r.status !== "complete").length;
  console.log(JSON.stringify({ directory, observations: results.length, failed }));
  if (failed) process.exitCode = 1;
}
async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      mode: { type: "string", default: "prepare" },
      live: { type: "boolean", default: false },
      "journal-comparison": { type: "boolean", default: false },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: npm run auction:bid-probe -- --out data/new-probe --mode prepare|run|report [--live] [--journal-comparison]\n--journal-comparison prepares a fresh 64-call legacy/memory-v2 comparison. prepare freezes 8 pairs (no calls); run requires --live, clean frozen source, and provider credentials (at most 48 calls, 20 minutes, 2 concurrent contexts). No retries or resume. report rebuilds tables without calls.",
    );
    return;
  }
  if (!values.out || !["prepare", "run", "report"].includes(values.mode!))
    throw new Error("Provide --out and a valid --mode");
  if (values["journal-comparison"] && values.mode !== "prepare")
    throw new Error("Existing runs use their frozen protocol; omit --journal-comparison");
  if (values.mode === "prepare") {
    const manifest = await prepareBidProbe(values.out, values["journal-comparison"]);
    console.log(
      JSON.stringify({
        directory: resolve(values.out),
        pairs: manifest.pairs.length,
        maxCalls: manifest.maxCalls,
      }),
    );
  } else {
    const directory = await nativePath(values.out, true);
    if (values.mode === "report") await reportBidProbe(directory);
    else {
      if (!values.live) throw new Error("run requires --live");
      await run(directory);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
