import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

interface LedgerRecord {
  attempt: number;
  stage: string;
  data: Record<string, unknown>;
}
export async function studyUsage(path: string) {
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  const truncatedTrailingRecord = Boolean(lines.at(-1));
  // A process can die during append; never fabricate usage from its partial last record.
  lines.pop();
  const records = lines.filter(Boolean).map((line) => JSON.parse(line) as LedgerRecord);
  const started = records.filter((record) => record.stage === "started");
  const usages = records.filter((record) => record.stage === "usage");
  const total = (key: string) =>
    usages.reduce(
      (sum, record) =>
        sum + (typeof record.data[key] === "number" ? (record.data[key] as number) : 0),
      0,
    );
  const known = (key: string) =>
    usages.filter((record) => typeof record.data[key] === "number").length;
  return {
    attempts: started.length,
    completed: records.filter((record) => record.stage === "completed").length,
    failed: records.filter((record) => record.stage === "failed").length,
    unfinished: started.filter(
      (start) =>
        !records.some(
          (record) =>
            record.attempt === start.attempt && ["completed", "failed"].includes(record.stage),
        ),
    ).length,
    knownInputTokens: total("inputTokens"),
    knownOutputTokens: total("outputTokens"),
    knownTotalTokens: total("totalTokens"),
    knownCachedInputTokens: total("cachedInputTokens"),
    unknownTotalTokenAttempts: started.length - known("totalTokens"),
    unknownCachedTokenAttempts: started.length - known("cachedInputTokens"),
    actualModels: [
      ...new Set(
        records.filter((record) => record.stage === "completed").map((record) => record.data.model),
      ),
    ],
    truncatedTrailingRecord,
  };
}
