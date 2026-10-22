import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export const REPORT_FILES = ["analysis.json", "analysis.md"] as const;
type ReportFile = (typeof REPORT_FILES)[number];

/** How a previous report from this analyzer starts; anything else is never overwritten. */
function isPreviousReport(file: ReportFile, text: string): boolean {
  if (file === "analysis.md") return text.startsWith("# Surprise analysis: game ");
  try {
    return JSON.parse(text)?.schemaVersion === "game_analysis_v1";
  } catch {
    return false;
  }
}

/** The nearest existing ancestor resolved through links, so a new directory compares exactly. */
function resolved(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(resolved(dirname(path)), basename(path));
}

/**
 * Refuses report paths that could touch the game database: the database itself, its -wal or
 * -shm file, any symbolic link, a hard link to the database, or any existing file that is not
 * a previous report from this analyzer. SQLite's read-only mode cannot stop a file write.
 */
export function assertSafeReportPaths(dbPath: string, outDir: string): void {
  const database = realpathSync(dbPath);
  const protectedPaths = new Set([database, `${database}-wal`, `${database}-shm`]);
  const databaseFile = statSync(database);
  for (const file of REPORT_FILES) {
    const path = join(outDir, file);
    const refuse = (reason: string) => {
      throw new Error(`Refusing to write ${path}: ${reason}`);
    };
    if (protectedPaths.has(resolved(path))) refuse("it is the game database or its WAL/SHM file");
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) continue;
    if (entry.isSymbolicLink()) refuse("it is a symbolic link");
    const existing = statSync(path);
    if (existing.dev === databaseFile.dev && existing.ino === databaseFile.ino)
      refuse("it is a link to the game database");
    if (!existing.isFile() || !isPreviousReport(file, readFileSync(path, "utf8")))
      refuse("it exists and is not a previous report from this analyzer");
  }
}

/**
 * Writes a new file beside the target, then renames it over: readers never see a partial
 * report. The temporary file is created exclusively, so an existing path (someone else's file)
 * is never written or removed; only the file this call created is cleaned up after a failure.
 */
export function writeReportAtomically(
  path: string,
  text: string,
  name: () => string = randomUUID,
): void {
  const temporary = `${path}.${name()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  let renamed = false;
  try {
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) rmSync(temporary, { force: true });
  }
}
