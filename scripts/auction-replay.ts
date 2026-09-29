import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sha256, validateManifest } from "./lib/auction-study-design";
import { parseReplayInput } from "./lib/auction-replay-input";
import { replayAuction, structuralCases, summarizeReplays } from "./lib/auction-replay";

async function nativeDirectory(path: string) {
  const lexical = resolve(path);
  const forbidden = (p: string) => p === "/mnt" || p.startsWith("/mnt/");
  if (forbidden(lexical)) throw new Error("Use native Linux study storage");
  const canonical = await realpath(lexical);
  if (forbidden(canonical)) throw new Error("Use native Linux study storage");
  return canonical;
}
export async function replayStudy(directory: string) {
  const root = await nativeDirectory(directory);
  const rawManifest = await readFile(join(root, "manifest.json"), "utf8");
  const manifest = validateManifest(JSON.parse(rawManifest));
  const runs = [];
  for (const run of manifest.runs) {
    if (basename(run.id) !== run.id) throw new Error("Invalid study run path");
    let raw: string;
    try {
      raw = await readFile(join(root, run.id, "checkpoint.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      runs.push({
        id: run.id,
        condition: run.condition,
        status: "not_started",
        checkpointHash: null,
        targetId: run.targetId,
        obstructerId: run.obstructerId ?? null,
        snapshots: [],
        players: [],
      });
      continue;
    }
    const state = parseReplayInput(JSON.parse(raw), manifest.bias);
    if (
      state.run.id !== run.id ||
      state.run.targetId !== run.targetId ||
      state.run.obstructerId !== run.obstructerId
    )
      throw new Error("Checkpoint does not match manifest run");
    const snapshots = state.auctions.map((a) => ({
      turn: a.turn,
      recordedWinner: a.selected,
      ...replayAuction(a, manifest.bias),
    }));
    runs.push({
      id: run.id,
      condition: run.condition,
      status: state.status,
      checkpointHash: sha256(raw),
      targetId: run.targetId,
      obstructerId: run.obstructerId ?? null,
      snapshots,
      players: summarizeReplays(
        snapshots,
        state.players.map((p) => p.id),
      ),
    });
  }
  return {
    study: root,
    protocol: manifest.protocol,
    sourceCommit: manifest.sourceCommit,
    manifestHash: sha256(rawManifest),
    bias: manifest.bias,
    runs,
  };
}
export function replayReport(studies: Awaited<ReturnType<typeof replayStudy>>[]) {
  const lines = [
    "# Speaker auction: frozen-bid replay",
    "",
    "No provider calls. Each recorded auction is a separate counterfactual: original bids, candidate eligibility, peer ratings, and tie order are frozen. Changed winners do not generate new speeches, journals, or future eligibility. Counts are NOT simulated conversation floor shares or independent trials.",
    "",
    "The baseline uses original (unforced) bids. Recorded effective winners, original winners, and all recorded scores must reproduce before analysis. Journals, records, speeches, and provider requests are excluded from the output.",
    "",
    "Interventions change one actor's own bid: urge_only sets urgency to 1 and preserves willingness; max_urgency also forces willingness; zero_rival_ratings sets that actor's outgoing peer ratings to zero; max_and_zero combines the latter two. Peer ratings of the actor never change. These are mechanical stress tests, not learned strategies.",
    "",
    "| Study | Condition | Status | Actor | Eligible recorded states | Original wins | Max urgency wins | Zero rival ratings wins | Combined wins |",
    "|---|---|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const study of studies) {
    for (const run of study.runs) {
      const targets = run.players.filter(
        (p) => p.playerId === run.targetId || p.playerId === run.obstructerId,
      );
      if (!targets.length)
        lines.push(
          `| ${basename(study.study)} | ${run.condition} | ${run.status} | ${run.targetId} | 0 | — | — | — | — |`,
        );
      for (const actor of targets) {
        const count = (mode: string) =>
          actor.interventions.find((i) => i.mode === mode)?.wins ?? "—";
        lines.push(
          `| ${basename(study.study)} | ${run.condition} | ${run.status} | ${actor.playerId} | ${actor.eligibleStates} | ${actor.eligibleStates ? actor.naturalWins : "—"} | ${count("max_urgency")} | ${count("zero_rival_ratings")} | ${count("max_and_zero")} |`,
        );
      }
    }
  }
  lines.push(
    "",
    "## Structural fixtures",
    "",
    "At bias 0.25, a max-urgency actor with mean listener interest 0.05 loses to urgency 0.2 with interest 0.9. If everyone's interest is zero, the uniform-interest fallback instead lets the highest urgency win. Fixed positive listener preferences can make two speakers alternate for all 12 turns, starving the other two despite the previous-speaker exclusion. These are deterministic constructions, not measured model behavior.",
    "",
    "See docs/AUCTION_TESTING.md for interpretation, the exact arithmetic, and the next behavioral tests. Incomplete discussions contribute only explicitly labeled observed prefixes; zero-auction failures provide no intervention outcomes.",
    "",
  );
  return lines.join("\n");
}
async function main() {
  const { values } = parseArgs({
    options: {
      study: { type: "string", multiple: true },
      out: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: npm run auction:replay -- --study DIR [--study DIR] [--out NEW_DIR]\nReproduce and perturb saved auction bids without model calls or checkpoint changes. Output excludes journals and speeches. Without --out, print JSON. Output directory must not exist.",
    );
    return;
  }
  if (!values.study?.length) throw new Error("Provide at least one --study directory");
  const studies = await Promise.all(values.study.map(replayStudy));
  if (new Set(studies.map((s) => s.study)).size !== studies.length)
    throw new Error("Duplicate study directory");
  const sources = [
    "./auction-replay.ts",
    "./lib/auction-replay.ts",
    "./lib/auction-replay-input.ts",
    "../packages/simulator/src/speaker-auction.ts",
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sources.map(async (file) => [
        file,
        sha256(await readFile(new URL(file, import.meta.url), "utf8")),
      ]),
    ),
  );
  const output =
    JSON.stringify(
      {
        schemaVersion: "auction_replay_v1",
        sourceHashes,
        studies,
        structuralCases: structuralCases(),
      },
      null,
      2,
    ) + "\n";
  if (!values.out) {
    console.log(output);
    return;
  }
  const parent = await nativeDirectory(resolve(values.out, ".."));
  const target = join(parent, basename(resolve(values.out)));
  await mkdir(target, { mode: 0o700 });
  await writeFile(join(target, "replay.json"), output, { mode: 0o600, flag: "wx" });
  const report = replayReport(studies);
  await writeFile(join(target, "report.md"), report, { mode: 0o600, flag: "wx" });
  console.log(report);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
