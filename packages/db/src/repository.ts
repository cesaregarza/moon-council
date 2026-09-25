import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import {
  StoredExperimentSpecSchema,
  ExperimentSummarySchema,
  StoredExperimentSummarySchema,
  type StoredExperimentSummary,
  StoredGameConfigSchema,
  GameEventSchema,
  PrivateJournalSchema,
  RoleDefinitionSchema,
  type StoredExperimentSpec,
  type ExperimentSummaryV1,
  type StoredGameConfig,
  type GameEventV1,
  type PrivateJournalV1,
  type ProviderUsageV1,
  type RoleDefinitionV1,
} from "@werewolf/contracts";
import type { EngineEventInput } from "@werewolf/engine";
import type { DatabaseConnection } from "./database";
import { events, experiments, games, jobs, journals, roles, usage } from "./schema";

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export interface GameRecord {
  id: string;
  name: string;
  status: string;
  config: StoredGameConfig;
  experimentId?: string;
  outcome?: Record<string, unknown>;
  error?: string;
  speedMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentRecord {
  id: string;
  name: string;
  status: string;
  spec: StoredExperimentSpec;
  summary?: StoredExperimentSummary;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  id: string;
  kind: "game" | "experiment";
  targetId: string;
  attempts: number;
}

export class LabRepository {
  constructor(readonly connection: DatabaseConnection) {}

  seedRoles(definitions: readonly RoleDefinitionV1[]): void {
    const createdAt = now();
    this.connection.db
      .insert(roles)
      .values(
        definitions.map((definition) => ({
          id: definition.id,
          version: definition.version,
          name: definition.name,
          alignment: definition.alignment,
          definitionJson: JSON.stringify(definition),
          createdAt,
        })),
      )
      .onConflictDoNothing()
      .run();
  }

  listRoles(): RoleDefinitionV1[] {
    return this.connection.db
      .select()
      .from(roles)
      .orderBy(asc(roles.name), desc(roles.version))
      .all()
      .map((row) => RoleDefinitionSchema.parse(parseJson(row.definitionJson)));
  }

  getRole(id: string, version?: number): RoleDefinitionV1 | undefined {
    const rows = this.connection.db
      .select()
      .from(roles)
      .where(version ? and(eq(roles.id, id), eq(roles.version, version)) : eq(roles.id, id))
      .orderBy(desc(roles.version))
      .limit(1)
      .all();
    const row = rows[0];
    return row ? RoleDefinitionSchema.parse(parseJson(row.definitionJson)) : undefined;
  }

  createRole(input: unknown): RoleDefinitionV1 {
    const requested = RoleDefinitionSchema.omit({ version: true })
      .extend({ version: RoleDefinitionSchema.shape.version.optional() })
      .parse(input);
    const latest = this.connection.db
      .select({ version: max(roles.version) })
      .from(roles)
      .where(eq(roles.id, requested.id))
      .get();
    const definition = RoleDefinitionSchema.parse({
      ...requested,
      version: (latest?.version ?? 0) + 1,
    });
    this.connection.db
      .insert(roles)
      .values({
        id: definition.id,
        version: definition.version,
        name: definition.name,
        alignment: definition.alignment,
        definitionJson: JSON.stringify(definition),
        createdAt: now(),
      })
      .run();
    return definition;
  }

  createGame(configInput: StoredGameConfig, experimentId?: string): GameRecord {
    const config = StoredGameConfigSchema.parse(configInput);
    const id = randomUUID();
    const createdAt = now();
    this.connection.db
      .insert(games)
      .values({
        id,
        name: config.name,
        status: "lobby",
        configJson: JSON.stringify(config),
        experimentId,
        speedMs: config.speedMs,
        createdAt,
        updatedAt: createdAt,
      })
      .run();
    return this.getGame(id)!;
  }

  getGame(id: string): GameRecord | undefined {
    const row = this.connection.db.select().from(games).where(eq(games.id, id)).get();
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      config: StoredGameConfigSchema.parse(parseJson(row.configJson)),
      ...(row.experimentId ? { experimentId: row.experimentId } : {}),
      ...(row.outcomeJson ? { outcome: parseJson<Record<string, unknown>>(row.outcomeJson) } : {}),
      ...(row.error ? { error: row.error } : {}),
      speedMs: row.speedMs,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  listGames(limit = 100, experimentId?: string): GameRecord[] {
    const query = this.connection.db
      .select({ id: games.id })
      .from(games)
      .where(experimentId ? eq(games.experimentId, experimentId) : undefined)
      .orderBy(desc(games.createdAt))
      .limit(limit)
      .all();
    return query.map((row) => this.getGame(row.id)!).filter(Boolean);
  }

  updateGame(
    id: string,
    values: {
      status?: string;
      error?: string | null;
      outcome?: Record<string, unknown>;
      speedMs?: number;
    },
  ): void {
    this.connection.sqlite
      .transaction(() => {
        if (
          values.status !== undefined &&
          this.getGame(id)?.config.schemaVersion === "game_config_v2"
        ) {
          const read = (key: string): number | null => {
            const row = this.connection.sqlite
              .prepare("SELECT value_json FROM agent_records WHERE game_id=? AND record_key=?")
              .get(id, key) as { value_json: string } | undefined;
            return row ? (JSON.parse(row.value_json) as number | null) : null;
          };
          const write = (key: string, value: number | null) =>
            this.connection.sqlite
              .prepare(
                "INSERT INTO agent_records(game_id,record_key,value_json) VALUES(?,?,?) ON CONFLICT(game_id,record_key) DO UPDATE SET value_json=excluded.value_json",
              )
              .run(id, key, JSON.stringify(value));
          const started = read("runtimeStartedAt");
          const active = ["running", "stepping"].includes(values.status);
          if (started !== null && !active) {
            write("runtimeMs", (read("runtimeMs") ?? 0) + Math.max(0, Date.now() - started));
            write("runtimeStartedAt", null);
          } else if (started === null && active) write("runtimeStartedAt", Date.now());
        }
        this.connection.db
          .update(games)
          .set({
            ...(values.status !== undefined ? { status: values.status } : {}),
            ...(values.error !== undefined ? { error: values.error } : {}),
            ...(values.outcome !== undefined
              ? { outcomeJson: JSON.stringify(values.outcome) }
              : {}),
            ...(values.speedMs !== undefined ? { speedMs: values.speedMs } : {}),
            updatedAt: now(),
          })
          .where(eq(games.id, id))
          .run();
      })
      .immediate();
  }

  updateGameConfig(id: string, input: StoredGameConfig): void {
    const config = StoredGameConfigSchema.parse(input);
    this.connection.db
      .update(games)
      .set({ configJson: JSON.stringify(config), updatedAt: now() })
      .where(eq(games.id, id))
      .run();
  }

  appendEvent(gameId: string, input: EngineEventInput): GameEventV1 {
    return this.connection.db.transaction((tx) => {
      const latest = tx
        .select({ sequence: max(events.sequence) })
        .from(events)
        .where(eq(events.gameId, gameId))
        .get();
      const event = GameEventSchema.parse({
        schemaVersion: "game_event_v1",
        id: randomUUID(),
        gameId,
        sequence: (latest?.sequence ?? -1) + 1,
        type: input.type,
        phase: input.phase,
        day: input.day,
        visibility: input.visibility,
        audienceIds: input.audienceIds ?? [],
        payload: input.payload,
        createdAt: now(),
      });
      tx.insert(events)
        .values({
          id: event.id,
          gameId,
          sequence: event.sequence,
          type: event.type,
          phase: event.phase,
          day: event.day,
          visibility: event.visibility,
          audienceJson: JSON.stringify(event.audienceIds),
          payloadJson: JSON.stringify(event.payload),
          createdAt: event.createdAt,
        })
        .run();
      return event;
    });
  }

  appendEvents(gameId: string, inputs: readonly EngineEventInput[]): GameEventV1[] {
    return inputs.map((input) => this.appendEvent(gameId, input));
  }

  listEvents(gameId: string, after = -1): GameEventV1[] {
    return this.connection.db
      .select()
      .from(events)
      .where(and(eq(events.gameId, gameId), sql`${events.sequence} > ${after}`))
      .orderBy(asc(events.sequence))
      .all()
      .map((row) =>
        GameEventSchema.parse({
          schemaVersion: "game_event_v1",
          id: row.id,
          gameId: row.gameId,
          sequence: row.sequence,
          type: row.type,
          phase: row.phase,
          day: row.day,
          visibility: row.visibility,
          audienceIds: parseJson(row.audienceJson),
          payload: parseJson(row.payloadJson),
          createdAt: row.createdAt,
        }),
      );
  }

  getJournal(gameId: string, playerId: string): PrivateJournalV1 {
    const row = this.connection.db
      .select()
      .from(journals)
      .where(and(eq(journals.gameId, gameId), eq(journals.playerId, playerId)))
      .get();
    return row
      ? PrivateJournalSchema.parse(parseJson(row.journalJson))
      : PrivateJournalSchema.parse({});
  }

  listJournals(gameId: string): Record<string, PrivateJournalV1> {
    return Object.fromEntries(
      this.connection.db
        .select()
        .from(journals)
        .where(eq(journals.gameId, gameId))
        .all()
        .map((row) => [row.playerId, PrivateJournalSchema.parse(parseJson(row.journalJson))]),
    );
  }

  saveJournal(gameId: string, playerId: string, journal: PrivateJournalV1): void {
    const parsed = PrivateJournalSchema.parse(journal);
    this.connection.db
      .insert(journals)
      .values({ gameId, playerId, journalJson: JSON.stringify(parsed), updatedAt: now() })
      .onConflictDoUpdate({
        target: [journals.gameId, journals.playerId],
        set: { journalJson: JSON.stringify(parsed), updatedAt: now() },
      })
      .run();
  }

  enqueueJob(kind: JobRecord["kind"], targetId: string): JobRecord {
    const existing = this.connection.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, kind),
          eq(jobs.targetId, targetId),
          inArray(jobs.status, ["queued", "running"]),
        ),
      )
      .limit(1)
      .get();
    if (existing)
      return {
        id: existing.id,
        kind: existing.kind as JobRecord["kind"],
        targetId,
        attempts: existing.attempts,
      };
    const id = randomUUID();
    const createdAt = now();
    this.connection.db
      .insert(jobs)
      .values({
        id,
        kind,
        targetId,
        status: "queued",
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
      })
      .run();
    return { id, kind, targetId, attempts: 0 };
  }

  claimJob(): JobRecord | undefined {
    return this.connection.db.transaction((tx) => {
      const row = tx
        .select()
        .from(jobs)
        .where(eq(jobs.status, "queued"))
        .orderBy(asc(jobs.createdAt))
        .limit(1)
        .get();
      if (!row) return undefined;
      tx.update(jobs)
        .set({ status: "running", attempts: row.attempts + 1, updatedAt: now() })
        .where(eq(jobs.id, row.id))
        .run();
      return {
        id: row.id,
        kind: row.kind as JobRecord["kind"],
        targetId: row.targetId,
        attempts: row.attempts + 1,
      };
    });
  }

  finishJob(id: string, error?: string): void {
    this.connection.db
      .update(jobs)
      .set({ status: error ? "failed" : "completed", error: error ?? null, updatedAt: now() })
      .where(eq(jobs.id, id))
      .run();
  }

  createExperiment(specInput: StoredExperimentSpec): ExperimentRecord {
    const spec = StoredExperimentSpecSchema.parse(specInput);
    const id = randomUUID();
    const createdAt = now();
    this.connection.db
      .insert(experiments)
      .values({
        id,
        name: spec.name,
        status: "queued",
        specJson: JSON.stringify(spec),
        createdAt,
        updatedAt: createdAt,
      })
      .run();
    return this.getExperiment(id)!;
  }

  getExperiment(id: string): ExperimentRecord | undefined {
    const row = this.connection.db.select().from(experiments).where(eq(experiments.id, id)).get();
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      spec: StoredExperimentSpecSchema.parse(parseJson(row.specJson)),
      ...(row.summaryJson
        ? { summary: StoredExperimentSummarySchema.parse(parseJson(row.summaryJson)) }
        : {}),
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  listExperiments(): ExperimentRecord[] {
    return this.connection.db
      .select({ id: experiments.id })
      .from(experiments)
      .orderBy(desc(experiments.createdAt))
      .all()
      .map((row) => this.getExperiment(row.id)!);
  }

  updateExperiment(
    id: string,
    values: { status?: string; summary?: StoredExperimentSummary; error?: string | null },
  ): void {
    this.connection.db
      .update(experiments)
      .set({
        ...(values.status !== undefined ? { status: values.status } : {}),
        ...(values.summary !== undefined
          ? { summaryJson: JSON.stringify(StoredExperimentSummarySchema.parse(values.summary)) }
          : {}),
        ...(values.error !== undefined ? { error: values.error } : {}),
        updatedAt: now(),
      })
      .where(eq(experiments.id, id))
      .run();
  }

  recordUsage(
    gameId: string,
    playerId: string | undefined,
    provider: string,
    model: string,
    providerUsage: ProviderUsageV1,
    estimatedCostMicros = 0,
  ): void {
    this.connection.db
      .insert(usage)
      .values({
        gameId,
        playerId,
        provider,
        model,
        inputTokens: providerUsage.inputTokens,
        outputTokens: providerUsage.outputTokens,
        totalTokens: providerUsage.totalTokens,
        estimatedCost: estimatedCostMicros,
        createdAt: now(),
      })
      .run();
  }

  usageForGame(gameId: string) {
    const rows = this.connection.db.select().from(usage).where(eq(usage.gameId, gameId)).all();
    return rows.map((row) => ({
      ...row,
      estimatedCost: row.estimatedCost / 1_000_000,
    }));
  }
}
