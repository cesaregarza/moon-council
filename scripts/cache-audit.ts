#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

type TokenUsage = {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
};

export type CacheAttempt = {
  id: string;
  decisionId: string;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  schemaVersion: string;
  usage?: TokenUsage | null;
  provider?: string;
  model?: string;
  providerMetadata?: {
    cacheDiagnostics?: { type?: string; reason?: string } | null;
    /** Claude session protocol: which session turn, and the read it should have made. */
    claudeSession?: { id: string; turn: number; expectedCacheRead: number | null };
  };
  request?: {
    instructions?: unknown;
    schema?: unknown;
    cache?: unknown;
    sharedInput?: unknown;
    publicInput?: unknown;
    privateInput?: unknown;
    input?: unknown;
    layerHashes?: Record<string, string | null | undefined>;
  } | null;
};

type Bucket = {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  hitCalls: number;
  invalidCalls: number;
  unknownInputCalls: number;
  knownCacheInputTokens: number;
  unknownCacheCalls: number;
  unknownWriteCalls: number;
  knownUncachedInputTokens: number;
  unknownBreakdownCalls: number;
};

function emptyBucket(): Bucket {
  return {
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    hitCalls: 0,
    invalidCalls: 0,
    unknownInputCalls: 0,
    knownCacheInputTokens: 0,
    unknownCacheCalls: 0,
    unknownWriteCalls: 0,
    knownUncachedInputTokens: 0,
    unknownBreakdownCalls: 0,
  };
}

function addAttempt(bucket: Bucket, attempt: CacheAttempt): void {
  bucket.calls += 1;
  const input = attempt.usage?.inputTokens;
  const cached = attempt.usage?.cachedInputTokens;
  const written = attempt.usage?.cacheWriteInputTokens;
  if (typeof input === "number") bucket.inputTokens += input;
  else bucket.unknownInputCalls += 1;
  if (typeof cached === "number" && typeof input === "number") {
    bucket.cachedInputTokens += cached;
    bucket.knownCacheInputTokens += input;
  } else bucket.unknownCacheCalls += 1;
  if (typeof written === "number") bucket.cacheWriteInputTokens += written;
  else bucket.unknownWriteCalls += 1;
  if (
    typeof input === "number" &&
    typeof cached === "number" &&
    typeof written === "number" &&
    cached + written <= input
  )
    bucket.knownUncachedInputTokens += input - cached - written;
  else bucket.unknownBreakdownCalls += 1;
  if (typeof cached === "number" && cached > 0) bucket.hitCalls += 1;
  if (attempt.status !== "valid") bucket.invalidCalls += 1;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function rate(bucket: Bucket): number | null {
  return bucket.knownCacheInputTokens > 0
    ? (100 * bucket.cachedInputTokens) / bucket.knownCacheInputTokens
    : null;
}

/** Provider-reported write share; OpenAI and mapped Anthropic usage both include writes in input. */
function writeRate(bucket: Bucket): number | null {
  return bucket.knownCacheInputTokens > 0 && bucket.unknownWriteCalls === 0
    ? (100 * bucket.cacheWriteInputTokens) / bucket.knownCacheInputTokens
    : null;
}

export function summarizeAttempts(attempts: CacheAttempt[]) {
  const total = emptyBucket(),
    bySchema = new Map<string, Bucket>(),
    byOrdinal = new Map<number, Bucket>();
  const byProvider = new Map<string, Bucket>(),
    diagnostics = new Map<string, number>();
  const seenByDecision = new Map<string, number>();
  const prefixBySchema = new Map<
    string,
    {
      instructions: Set<string>;
      schemas: Set<string>;
      canonicalSchemas: Set<string>;
      cache: Set<string>;
      briefings: Set<string>;
    }
  >();
  for (const attempt of attempts) {
    addAttempt(total, attempt);
    const providerKey = `${attempt.provider ?? "unknown"}:${attempt.model ?? "unknown"}`;
    const providerBucket = byProvider.get(providerKey) ?? emptyBucket();
    addAttempt(providerBucket, attempt);
    byProvider.set(providerKey, providerBucket);
    const diagnostic = attempt.providerMetadata?.cacheDiagnostics;
    const diagnosticKey = diagnostic
      ? `${diagnostic.type ?? "unknown"}${diagnostic.reason ? `:${diagnostic.reason}` : ""}`
      : "not_reported";
    diagnostics.set(diagnosticKey, (diagnostics.get(diagnosticKey) ?? 0) + 1);
    const schema = attempt.schemaVersion || "unknown";
    const schemaBucket = bySchema.get(schema) ?? emptyBucket();
    addAttempt(schemaBucket, attempt);
    bySchema.set(schema, schemaBucket);
    const ordinal = (seenByDecision.get(attempt.decisionId) ?? 0) + 1;
    seenByDecision.set(attempt.decisionId, ordinal);
    const ordinalBucket = byOrdinal.get(ordinal) ?? emptyBucket();
    addAttempt(ordinalBucket, attempt);
    byOrdinal.set(ordinal, ordinalBucket);
    const variants = prefixBySchema.get(schema) ?? {
      instructions: new Set(),
      schemas: new Set(),
      canonicalSchemas: new Set(),
      cache: new Set(),
      briefings: new Set(),
    };
    variants.instructions.add(JSON.stringify(attempt.request?.instructions));
    variants.schemas.add(JSON.stringify(attempt.request?.schema));
    variants.canonicalSchemas.add(canonicalJson(attempt.request?.schema));
    variants.cache.add(canonicalJson(attempt.request?.cache));
    variants.briefings.add(JSON.stringify(attempt.request?.sharedInput));
    prefixBySchema.set(schema, variants);
  }
  const row = (key: string | number, bucket: Bucket) => ({
    key,
    ...bucket,
    cachePercent: rate(bucket),
    cacheWritePercent: writeRate(bucket),
  });
  return {
    total: row("total", total),
    byProvider: [...byProvider]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, bucket]) => row(key, bucket)),
    diagnostics: Object.fromEntries([...diagnostics].sort(([a], [b]) => a.localeCompare(b))),
    bySchema: [...bySchema]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, bucket]) => row(key, bucket)),
    byAttemptOrdinal: [...byOrdinal]
      .sort(([a], [b]) => a - b)
      .map(([key, bucket]) => row(key, bucket)),
    prefixVariants: [...prefixBySchema]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([schema, value]) => ({
        schema,
        instructions: value.instructions.size,
        schemas: value.schemas.size,
        canonicalSchemas: value.canonicalSchemas.size,
        cacheMetadata: value.cache.size,
        briefings: value.briefings.size,
      })),
  };
}

/** Request layers in the order the OpenAI request sends them (packages/llm/src/openai-cache.ts). */
const LAYERS = [
  ["l0", "l0 instructions", "instructions"],
  ["l1", "l1 public", "publicInput"],
  ["l2", "l2 private", "privateInput"],
  ["l3", "l3 request", "input"],
] as const;
const NEVER_ENDED = "\uffff";

type LayerBytes = {
  layer: string;
  bytes: number;
  repeatedBytes: number;
  settledRepeatedBytes: number;
};
type StabilityBucket = {
  calls: number;
  depthCalls: number[];
  inFlightOnlyCalls: number;
  layers: LayerBytes[];
};
type DepthTokens = {
  depth: number;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** Input of calls that reported a cached-token count; the denominator for cache share. */
  knownCacheInputTokens: number;
  unknownCacheCalls: number;
};

function addDepthTokens(byDepth: Map<number, DepthTokens>, depth: number, attempt: CacheAttempt) {
  const tokens = byDepth.get(depth) ?? {
    depth,
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    knownCacheInputTokens: 0,
    unknownCacheCalls: 0,
  };
  const input = attempt.usage?.inputTokens,
    cached = attempt.usage?.cachedInputTokens;
  tokens.calls += 1;
  tokens.inputTokens += input ?? 0;
  // An unreported cache count is unknown, not a miss.
  if (typeof input === "number" && typeof cached === "number") {
    tokens.cachedInputTokens += cached;
    tokens.knownCacheInputTokens += input;
  } else tokens.unknownCacheCalls += 1;
  byDepth.set(depth, tokens);
}

function byteSize(value: unknown): number {
  if (value == null) return 0;
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
}

function leading(keys: string[], ok: (key: string) => boolean): number {
  const index = keys.findIndex((key) => !ok(key));
  return index === -1 ? keys.length : index;
}

function emptyStability(): StabilityBucket {
  return {
    calls: 0,
    depthCalls: LAYERS.map(() => 0).concat(0),
    inFlightOnlyCalls: 0,
    layers: LAYERS.map(([, layer]) => ({
      layer,
      bytes: 0,
      repeatedBytes: 0,
      settledRepeatedBytes: 0,
    })),
  };
}

function addStability(
  bucket: StabilityBucket,
  attempt: CacheAttempt,
  depth: number,
  settled: number,
): void {
  bucket.calls += 1;
  bucket.depthCalls[depth] = (bucket.depthCalls[depth] ?? 0) + 1;
  if (settled < depth) bucket.inFlightOnlyCalls += 1;
  LAYERS.forEach(([, , field], index) => {
    const bytes = byteSize(attempt.request?.[field]),
      row = bucket.layers[index]!;
    row.bytes += bytes;
    if (index < depth) row.repeatedBytes += bytes;
    if (index < settled) row.settledRepeatedBytes += bytes;
  });
}

/**
 * Infer where cache reuse was possible from recorded layer hashes. A call's prefix depth is the
 * number of leading layers matching an earlier-started call; its settled depth counts only calls
 * that had finished before it started. Earlier attempts outside `counted` remain prefix history.
 */
export function layerPrefixStability(
  attempts: CacheAttempt[],
  counted: Set<string> = new Set(attempts.map((attempt) => attempt.id)),
) {
  const earliestEnd = new Map<string, string>(),
    bySchema = new Map<string, StabilityBucket>(),
    byDepth = new Map<number, DepthTokens>();
  const skippedCalls = { jev: 0, noLayerHashes: 0 };
  for (const attempt of attempts) {
    const hashes = attempt.request?.layerHashes;
    // Jev is not prompt-cached by OpenAI, so its calls are neither history nor misses.
    if (attempt.provider === "jev" || !hashes) {
      if (counted.has(attempt.id))
        skippedCalls[attempt.provider === "jev" ? "jev" : "noLayerHashes"] += 1;
      continue;
    }
    const keys = LAYERS.map((_, depth) =>
      LAYERS.slice(0, depth + 1)
        .map(([key]) => hashes[key] ?? "")
        .join("|"),
    );
    if (counted.has(attempt.id)) {
      const depth = leading(keys, (key) => earliestEnd.has(key)),
        settled = leading(keys, (key) => earliestEnd.get(key)! <= attempt.startedAt);
      const bucket = bySchema.get(attempt.schemaVersion) ?? emptyStability();
      addStability(bucket, attempt, depth, settled);
      bySchema.set(attempt.schemaVersion, bucket);
      addDepthTokens(byDepth, depth, attempt);
    }
    const ended = attempt.endedAt ?? NEVER_ENDED;
    for (const key of keys)
      if (!earliestEnd.has(key) || ended < earliestEnd.get(key)!) earliestEnd.set(key, ended);
  }
  return {
    basis:
      "Per-layer attribution is inferred from layer-prefix stability across calls; it is not provider-reported. Providers report cached tokens per call only.",
    layers: LAYERS.map(([, layer]) => layer),
    skippedCalls,
    byDepth: [...byDepth.values()].sort((a, b) => a.depth - b.depth),
    bySchema: [...bySchema]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, bucket]) => ({ key, ...bucket })),
  };
}

/**
 * Claude session calls by call kind. A call that should read its session (the previous
 * request's whole prompt) but reports fewer cached tokens is a miss: something upstream of the
 * new turn changed, or the entry expired.
 */
export function claudeSessionAccounting(attempts: CacheAttempt[]) {
  const rows = new Map<
    string,
    {
      key: string;
      calls: number;
      inputTokens: number;
      readTokens: number;
      writeTokens: number;
      misses: number;
    }
  >();
  for (const attempt of attempts) {
    const session = attempt.providerMetadata?.claudeSession;
    if (!session) continue;
    const row = rows.get(attempt.schemaVersion) ?? {
      key: attempt.schemaVersion,
      calls: 0,
      inputTokens: 0,
      readTokens: 0,
      writeTokens: 0,
      misses: 0,
    };
    const read = attempt.usage?.cachedInputTokens ?? 0;
    row.calls += 1;
    row.inputTokens += attempt.usage?.inputTokens ?? 0;
    row.readTokens += read;
    row.writeTokens += attempt.usage?.cacheWriteInputTokens ?? 0;
    if (session.expectedCacheRead !== null && read < session.expectedCacheRead) row.misses += 1;
    rows.set(attempt.schemaVersion, row);
  }
  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function compact(value: number): string {
  const scales: [[number, string], [number, string], [number, string], [number, string]] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [scale, suffix] of scales)
    if (Math.abs(value) >= scale)
      return `${(value / scale).toFixed(value >= scale * 100 ? 0 : value >= scale * 10 ? 1 : 2).replace(/\.0+$/, "")}${suffix}`;
  return String(value);
}

function percent(value: number | null): string {
  return value === null ? "unknown" : `${value.toFixed(2)}%`;
}
function printRows(title: string, rows: Array<Record<string, unknown>>, columns: string[]): void {
  console.log(`\n${title}`);
  console.log(columns.join("\t"));
  for (const row of rows)
    console.log(
      columns
        .map((column) => {
          const value = row[column];
          if (column.endsWith("Tokens") && typeof value === "number") return compact(value);
          if (column.endsWith("Percent") && typeof value === "number") return percent(value);
          return value == null
            ? ""
            : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
              ? String(value)
              : JSON.stringify(value);
        })
        .join("\t"),
    );
}

function usage(): never {
  console.error(
    "Usage: npm run cache:audit -- --db <sqlite-path> --game <game-id> [--after <attempt-count>] [--schema-suffix <suffix>] [--json]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]) {
  let dbPath = "",
    gameId = "",
    after = 0,
    schemaSuffix = "",
    json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--json") {
      json = true;
      continue;
    }
    const value = argv[++index];
    if (!value) usage();
    if (arg === "--db") dbPath = resolve(value);
    else if (arg === "--game") gameId = value;
    else if (arg === "--after") after = Number(value);
    else if (arg === "--schema-suffix") schemaSuffix = value;
    else usage();
  }
  if (!dbPath || !gameId || !Number.isInteger(after) || after < 0) usage();
  return { dbPath, gameId, after, schemaSuffix, json };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.dbPath)) throw new Error(`Database does not exist: ${options.dbPath}`);
  const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        "SELECT id, decision_id AS decisionId, status, value_json AS valueJson FROM provider_attempts WHERE game_id=? ORDER BY json_extract(value_json, '$.startedAt'), id",
      )
      .all(options.gameId) as Array<{
      id: string;
      decisionId: string;
      status: string;
      valueJson: string;
    }>;
    if (rows.length === 0)
      throw new Error(`No provider attempts found for game: ${options.gameId}`);
    const recorded = rows.map((row, index) => {
        const value = JSON.parse(row.valueJson) as Partial<CacheAttempt>;
        return {
          id: row.id,
          decisionId: row.decisionId,
          status: row.status,
          startedAt: value.startedAt ?? String(index),
          endedAt: value.endedAt ?? null,
          schemaVersion: value.schemaVersion ?? "unknown",
          usage: value.usage,
          request: value.request,
          provider: value.provider,
          model: value.model,
          providerMetadata: value.providerMetadata,
        } satisfies CacheAttempt;
      }),
      attempts = recorded
        .slice(options.after)
        .filter(
          (attempt) =>
            !options.schemaSuffix || attempt.schemaVersion.endsWith(options.schemaSuffix),
        );
    if (attempts.length === 0) throw new Error("No attempts remain after applying filters");
    const summary = summarizeAttempts(attempts),
      stability = layerPrefixStability(recorded, new Set(attempts.map((attempt) => attempt.id))),
      result = {
        gameId: options.gameId,
        after: options.after,
        schemaSuffix: options.schemaSuffix || null,
        ...summary,
        layerPrefixStability: stability,
        claudeSessions: claudeSessionAccounting(attempts),
      };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Game ${options.gameId}`);
    console.log(`Attempts ${summary.total.calls} (after ${options.after})`);
    console.log(
      `Cache ${compact(summary.total.cachedInputTokens)} / ${compact(summary.total.knownCacheInputTokens)} known input = ${percent(summary.total.cachePercent)}; ${summary.total.hitCalls}/${summary.total.calls} hit calls; ${summary.total.invalidCalls} invalid`,
    );
    printRows("By provider/model", summary.byProvider, [
      "key",
      "calls",
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteInputTokens",
      "cachePercent",
      "cacheWritePercent",
      "unknownCacheCalls",
      "unknownWriteCalls",
    ]);
    console.log(`Diagnostics: ${JSON.stringify(summary.diagnostics)}`);
    printRows("By schema", summary.bySchema, [
      "key",
      "calls",
      "inputTokens",
      "cachedInputTokens",
      "cachePercent",
      "cacheWritePercent",
      "hitCalls",
      "invalidCalls",
    ]);
    printRows("By attempt ordinal within decision", summary.byAttemptOrdinal, [
      "key",
      "calls",
      "inputTokens",
      "cachedInputTokens",
      "cachePercent",
      "cacheWritePercent",
      "hitCalls",
    ]);
    printRows("Request variation", summary.prefixVariants, [
      "schema",
      "instructions",
      "schemas",
      "canonicalSchemas",
      "cacheMetadata",
      "briefings",
    ]);
    console.log(`\nLayer-prefix stability (${stability.basis})`);
    console.log(`Skipped: ${JSON.stringify(stability.skippedCalls)}`);
    printRows("By prefix depth (provider-reported tokens)", stability.byDepth, [
      "depth",
      "calls",
      "inputTokens",
      "cachedInputTokens",
      "knownCacheInputTokens",
      "unknownCacheCalls",
    ]);
    printRows("Prefix depth by schema", stability.bySchema, [
      "key",
      "calls",
      "depthCalls",
      "inFlightOnlyCalls",
    ]);
    printRows(
      "Layer bytes by schema",
      stability.bySchema.flatMap((row) => row.layers.map((layer) => ({ key: row.key, ...layer }))),
      ["key", "layer", "bytes", "repeatedBytes", "settledRepeatedBytes"],
    );
    printRows("Claude sessions by call kind (provider-reported)", result.claudeSessions, [
      "key",
      "calls",
      "inputTokens",
      "readTokens",
      "writeTokens",
      "misses",
    ]);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
