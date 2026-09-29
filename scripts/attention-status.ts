#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { readGameAudit, summarizeGameProgress } from "./game-audit";
import { nativePath } from "./lib/native-path";

/** Reuse the read-only game audit, exposing no private journals or roles. */
export async function attentionRunStatus(directory: string) {
  const root = await nativePath(directory);
  if (!existsSync(join(root, "manifest.json"))) throw new Error("Missing experiment manifest");
  const arms = [];
  for (const arm of ["control", "treatment"]) {
    const path = await nativePath(join(root, arm, "game.db"));
    if (!existsSync(path)) {
      arms.push({ arm, status: "not_started" });
      continue;
    }
    const db = new Database(path, { readonly: true, fileMustExist: true });
    let id: string;
    try {
      const games = db.prepare("SELECT id FROM games ORDER BY id").all() as { id: string }[];
      if (games.length !== 1) throw new Error(`Expected exactly one game in ${arm}`);
      id = games[0]!.id;
    } finally {
      db.close();
    }
    arms.push({ arm, ...summarizeGameProgress(readGameAudit(path, id)) });
  }
  return arms;
}

async function main() {
  const { values } = parseArgs({ options: { help: { type: "boolean" }, out: { type: "string" } } });
  if (values.help) {
    console.log(
      "Usage: npm run attention:status -- --out EXPERIMENT_DIRECTORY\nRead-only progress for both arms; no provider calls or private journals.",
    );
    return;
  }
  if (!values.out) throw new Error("--out is required");
  console.log(JSON.stringify(await attentionRunStatus(values.out), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
