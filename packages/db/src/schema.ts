import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const roles = sqliteTable(
  "roles",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    alignment: text("alignment").notNull(),
    definitionJson: text("definition_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.version] })],
);

export const games = sqliteTable(
  "games",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    configJson: text("config_json").notNull(),
    experimentId: text("experiment_id"),
    outcomeJson: text("outcome_json"),
    error: text("error"),
    speedMs: integer("speed_ms").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("games_status_idx").on(table.status), index("games_experiment_idx").on(table.experimentId)],
);

export const events = sqliteTable(
  "events",
  {
    rowId: integer("row_id").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    gameId: text("game_id").notNull(),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    phase: text("phase").notNull(),
    day: integer("day").notNull(),
    visibility: text("visibility").notNull(),
    audienceJson: text("audience_json").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("events_id_idx").on(table.id),
    uniqueIndex("events_game_sequence_idx").on(table.gameId, table.sequence),
    index("events_game_idx").on(table.gameId),
  ],
);

export const journals = sqliteTable(
  "journals",
  {
    gameId: text("game_id").notNull(),
    playerId: text("player_id").notNull(),
    journalJson: text("journal_json").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.gameId, table.playerId] })],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    targetId: text("target_id").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("jobs_queue_idx").on(table.status, table.createdAt)],
);

export const experiments = sqliteTable(
  "experiments",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    specJson: text("spec_json").notNull(),
    summaryJson: text("summary_json"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("experiments_status_idx").on(table.status)],
);

export const usage = sqliteTable(
  "usage",
  {
    rowId: integer("row_id").primaryKey({ autoIncrement: true }),
    gameId: text("game_id").notNull(),
    playerId: text("player_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    estimatedCost: integer("estimated_cost_micros").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("usage_game_idx").on(table.gameId)],
);

