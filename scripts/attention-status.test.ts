import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LabRepository, openDatabase } from "@werewolf/db";
import { attentionConfigs } from "./lib/attention-experiment";
import { attentionRunStatus } from "./attention-status";

it("monitors completed and missing arms without changing the database or exposing personalities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attention-status-"));
  try {
    await expect(attentionRunStatus(dir)).rejects.toThrow("manifest");
    await writeFile(join(dir, "manifest.json"), "{}");
    await mkdir(join(dir, "control"));
    const path = join(dir, "control", "game.db");
    const db = openDatabase(path);
    new LabRepository(db).createGame(
      attentionConfigs({
        model: "fake",
        effort: "low",
        seed: "fixture",
        live: false,
        maxCalls: 20,
        maxMinutes: 1,
      }).control,
    );
    db.close();
    const before = await readFile(path);
    const status = await attentionRunStatus(dir);
    expect(status[0]).toMatchObject({ arm: "control", game: { status: "lobby" } });
    expect(status[1]).toEqual({ arm: "treatment", status: "not_started" });
    expect(JSON.stringify(status)).not.toContain("personality");
    expect(await readFile(path)).toEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
