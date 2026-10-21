import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const directories: string[] = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

type Layers = [string, string, string, string];
/** One recorded attempt; layer texts are sized so per-layer bytes are easy to check. */
function attempt(
  id: string,
  [started, ended]: [number, number],
  schemaVersion: string,
  layerHashes: Layers,
  cachedInputTokens: number | null,
  provider = "codex",
) {
  const at = (second: number) => `2026-09-24T10:00:${String(second).padStart(2, "0")}.000Z`;
  return {
    id,
    decisionId: `d-${id}`,
    playerId: "p1",
    status: "valid",
    startedAt: at(started),
    endedAt: at(ended),
    schemaVersion,
    provider,
    model: "gpt-6-luna",
    usage: { inputTokens: 1_000, cachedInputTokens, cacheWriteInputTokens: 0 },
    request: {
      instructions: "i".repeat(400),
      publicInput: "u".repeat(300),
      privateInput: "r".repeat(200),
      input: "q".repeat(100),
      layerHashes: {
        l0: layerHashes[0],
        l1: layerHashes[1],
        l2: layerHashes[2],
        l3: layerHashes[3],
      },
    },
  };
}

function audit(attempts: ReturnType<typeof attempt>[], ...flags: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "cache-audit-"));
  directories.push(directory);
  const path = join(directory, "fixture.db");
  const db = new Database(path);
  db.exec(
    "CREATE TABLE provider_attempts(id TEXT PRIMARY KEY, game_id TEXT, decision_id TEXT, player_id TEXT, status TEXT, value_json TEXT)",
  );
  const insert = db.prepare("INSERT INTO provider_attempts VALUES (?,?,?,?,?,?)");
  for (const a of attempts)
    insert.run(a.id, "g", a.decisionId, a.playerId, a.status, JSON.stringify(a));
  db.close();
  const run = spawnSync(
    join(root, "node_modules/.bin/tsx"),
    ["scripts/cache-audit.ts", "--db", path, "--game", "g", "--json", ...flags],
    { cwd: root, encoding: "utf8" },
  );
  expect(run.status, run.stderr).toBe(0);
  const result = JSON.parse(run.stdout);
  expect(result).toHaveProperty("layerPrefixStability");
  return result;
}

const reflection = "journal_update_v3_1",
  speech = "speech_v3_1";
const fixture = [
  // First reflection of a speech: nothing earlier shares its prefix.
  attempt("a1", [0, 10], reflection, ["A", "P", "X1", "R1"], 0),
  // Fan-out sibling: shares instructions and public layers, but a1 is still in flight.
  attempt("a2", [1, 11], reflection, ["A", "P", "X2", "R2"], 0),
  // Later reflection: the same two layers were settled by a1 and a2.
  attempt("a3", [20, 30], reflection, ["A", "P", "X3", "R3"], 600),
  // Different instructions, so no reusable prefix even though later layers repeat.
  attempt("a4", [31, 40], speech, ["B", "P", "X1", "R4"], 0),
  // Jev is not prompt-cached by OpenAI; it is skipped, not counted as a miss.
  attempt("a5", [41, 42], "discussion_score_v4", ["A", "P", "X1", "R1"], 0, "jev"),
];

describe("cache audit layer-prefix stability (fixture database)", () => {
  it("labels per-layer attribution as inferred, not provider-reported", () => {
    const { layerPrefixStability } = audit(fixture);
    expect(layerPrefixStability.basis).toMatch(/inferred from layer-prefix stability/);
    expect(layerPrefixStability.basis).toMatch(/not provider-reported/);
    expect(layerPrefixStability.skippedCalls).toEqual({ jev: 1, noLayerHashes: 0 });
  });

  it("counts reusable prefix depth per call type and separates in-flight-only reuse", () => {
    const { layerPrefixStability } = audit(fixture);
    const bySchema = Object.fromEntries(
      layerPrefixStability.bySchema.map((row: { key: string }) => [row.key, row]),
    );
    expect(bySchema[reflection]).toMatchObject({
      calls: 3,
      depthCalls: [1, 0, 2, 0, 0],
      inFlightOnlyCalls: 1,
      layers: [
        { layer: "l0 instructions", bytes: 1_200, repeatedBytes: 800, settledRepeatedBytes: 400 },
        { layer: "l1 public", bytes: 900, repeatedBytes: 600, settledRepeatedBytes: 300 },
        { layer: "l2 private", bytes: 600, repeatedBytes: 0, settledRepeatedBytes: 0 },
        { layer: "l3 request", bytes: 300, repeatedBytes: 0, settledRepeatedBytes: 0 },
      ],
    });
    expect(bySchema[speech]).toMatchObject({ calls: 1, depthCalls: [1, 0, 0, 0, 0] });
  });

  it("joins provider-reported cache tokens to the inferred prefix depth", () => {
    const { layerPrefixStability } = audit(fixture);
    expect(layerPrefixStability.byDepth).toEqual([
      {
        depth: 0,
        calls: 2,
        inputTokens: 2_000,
        cachedInputTokens: 0,
        knownCacheInputTokens: 2_000,
        unknownCacheCalls: 0,
      },
      {
        depth: 2,
        calls: 2,
        inputTokens: 2_000,
        cachedInputTokens: 600,
        knownCacheInputTokens: 2_000,
        unknownCacheCalls: 0,
      },
    ]);
  });

  it("keeps earlier attempts as prefix history when --after drops them from the counts", () => {
    const { layerPrefixStability } = audit(fixture, "--after", "1");
    const row = layerPrefixStability.bySchema.find(
      (item: { key: string }) => item.key === reflection,
    );
    expect(row).toMatchObject({ calls: 2, depthCalls: [0, 0, 2, 0, 0], inFlightOnlyCalls: 1 });
  });

  it("counts a Jev call without layer hashes as Jev, not as a missing-hash call", () => {
    const jevWithoutHashes = attempt("a6", [43, 44], "vote_v4", ["A", "P", "X", "R"], 0, "jev");
    const { layerPrefixStability } = audit([
      ...fixture,
      { ...jevWithoutHashes, request: { ...jevWithoutHashes.request, layerHashes: undefined } },
    ] as typeof fixture);
    expect(layerPrefixStability.skippedCalls).toEqual({ jev: 2, noLayerHashes: 0 });
  });

  it("keeps calls with unknown cache use out of the known-cache denominator", () => {
    // A later reflection at depth 2 whose provider reported no cached-token count.
    const unknown = attempt("a7", [50, 60], reflection, ["A", "P", "X7", "R7"], null);
    const { layerPrefixStability } = audit([...fixture, unknown]);
    expect(
      layerPrefixStability.byDepth.find((row: { depth: number }) => row.depth === 2),
    ).toMatchObject({
      calls: 3,
      inputTokens: 3_000,
      cachedInputTokens: 600,
      knownCacheInputTokens: 2_000,
      unknownCacheCalls: 1,
    });
  });
});
