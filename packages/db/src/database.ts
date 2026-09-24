import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export type LabDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseConnection {
  db: LabDatabase;
  sqlite: Database.Database;
  path: string;
  close(): void;
}

export function resolveDatabasePath(configured = process.env.DATABASE_URL ?? "./data/werewolf.db"): string {
  const normalized = configured.startsWith("file:") ? configured.slice(5) : configured;
  if (normalized === ":memory:") return normalized;
  return isAbsolute(normalized) ? normalized : resolve(repositoryRoot, normalized);
}

export function openDatabase(configured?: string): DatabaseConnection {
  const path = resolveDatabasePath(configured);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  migrate(db, { migrationsFolder });
  return { db, sqlite, path, close: () => sqlite.close() };
}

