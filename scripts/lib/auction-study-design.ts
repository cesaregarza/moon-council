import { FOCUSED, RAMBLING } from "./auction-study-personas";
import { createHash } from "node:crypto";
import { shuffled } from "@werewolf/engine";
import { validateChainManifest, type ChainCondition } from "./chain-study-design";
import { AUCTION_SCENARIOS } from "./auction-study-scenarios";

export const CONDITIONS = [
  "focused-natural",
  "focused-forced",
  "rambling-natural",
  "rambling-forced",
] as const;
export type Condition = (typeof CONDITIONS)[number];
export { FOCUSED, RAMBLING } from "./auction-study-personas";
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export interface StudyRun {
  id: string;
  seed: string;
  scenarioId: string;
  condition: Condition | ChainCondition;
  obstructerId?: string;
  targetId: string;
  witnessId: string;
  evidenceOrder: string[];
}
export interface StudyManifest {
  schemaVersion: "speech_auction_study_v1";
  protocol: "free-floor-v1" | "clue-chain-v1";
  createdAt: string;
  sourceCommit: string;
  live: boolean;
  model: string;
  effort: string;
  turns: number;
  bias: number;
  concurrency: number;
  maxMinutes: number;
  runs: StudyRun[];
  scenarios: typeof AUCTION_SCENARIOS;
  personalities: { focused: string; rambling: string; obstruction?: string };
}
export function studyRuns(seeds: string[], scenarioIds: string[]) {
  if (!seeds.length || new Set(seeds).size !== seeds.length || seeds.some((seed) => !seed.trim()))
    throw new Error("Provide distinct nonempty seeds");
  if (
    !scenarioIds.length ||
    new Set(scenarioIds).size !== scenarioIds.length ||
    scenarioIds.some((id) => !AUCTION_SCENARIOS.some((scenario) => scenario.id === id))
  )
    throw new Error("Choose distinct known scenarios");
  return seeds.flatMap((seed, block) =>
    scenarioIds.flatMap((scenarioId) => {
      const evidenceOrder = shuffled(["p1", "p2", "p3", "p4"], `${seed}:${scenarioId}:evidence`);
      return shuffled([...CONDITIONS], `${seed}:${scenarioId}:conditions`).map((condition) => ({
        id: `b${String(block + 1).padStart(2, "0")}-${scenarioId}-${condition}`,
        seed,
        scenarioId,
        condition,
        targetId: evidenceOrder[0]!,
        witnessId: evidenceOrder[1]!,
        evidenceOrder,
      }));
    }),
  );
}
export function validateManifest(value: unknown): StudyManifest {
  const manifest = value as StudyManifest;
  if (
    manifest.schemaVersion !== "speech_auction_study_v1" ||
    !["free-floor-v1", "clue-chain-v1"].includes(manifest.protocol)
  )
    throw new Error("Unknown study protocol");
  if (
    !Number.isInteger(manifest.turns) ||
    manifest.turns < 8 ||
    manifest.turns > 24 ||
    ![1, 2].includes(manifest.concurrency) ||
    manifest.bias !== 0.25 ||
    !Number.isFinite(manifest.maxMinutes) ||
    manifest.maxMinutes <= 0 ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
    typeof manifest.live !== "boolean" ||
    typeof manifest.model !== "string" ||
    typeof manifest.effort !== "string"
  )
    throw new Error("Invalid study settings");
  if (manifest.protocol === "clue-chain-v1") return validateChainManifest(manifest);
  const seeds = [...new Set(manifest.runs.map((run) => run.seed))];
  const scenarios = [...new Set(manifest.runs.map((run) => run.scenarioId))];
  if (
    JSON.stringify(studyRuns(seeds, scenarios)) !== JSON.stringify(manifest.runs) ||
    JSON.stringify(manifest.scenarios) !== JSON.stringify(AUCTION_SCENARIOS) ||
    manifest.personalities.focused !== FOCUSED ||
    manifest.personalities.rambling !== RAMBLING
  )
    throw new Error("Study manifest differs from the frozen protocol");
  return manifest;
}
