import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonLines, writePrettyJson } from "./lib/stream-json";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const file = async (name: string) => {
  const directory = await mkdtemp(join(tmpdir(), "stream-json-"));
  directories.push(directory);
  return join(directory, name);
};

describe("streamed research artifacts (CES-1584)", () => {
  it("writes exactly the bytes of JSON.stringify(value, null, 2)", async () => {
    const value = {
      schemaVersion: "werewolf_research_bundle_v2",
      game: { id: "g", nested: { list: [1, { a: "é ✓" }], empty: [] } },
      skipped: undefined,
      events: [{ type: "x", payload: { text: "line\nbreak" } }, undefined, [], {}, "s"],
      attempts: [],
      decisions: [{ opportunity: { id: "d" }, attempts: undefined, turns: [] }],
    };
    const path = await file("research.json");
    await writePrettyJson(path, value);
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(value, null, 2));
    const empty = await file("empty.json");
    await writePrettyJson(empty, {});
    expect(await readFile(empty, "utf8")).toBe(JSON.stringify({}, null, 2));
  });

  it("never serializes a top-level array whole: each element is serialized once", async () => {
    let calls = 0;
    const counted = (n: number) => ({ toJSON: () => ((calls += 1), { n }) });
    const value = { events: [counted(1), counted(2), counted(3)], other: [counted(4)] };
    const path = await file("counted.json");
    await writePrettyJson(path, value);
    expect(calls).toBe(4);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      events: [{ n: 1 }, { n: 2 }, { n: 3 }],
      other: [{ n: 4 }],
    });
  });

  it("writes one JSON value per line", async () => {
    const values = [{ kind: "metadata" }, { kind: "event", event: { text: "a\nb" } }];
    const path = await file("research.jsonl");
    await writeJsonLines(path, values);
    expect(await readFile(path, "utf8")).toBe(
      values.map((v) => JSON.stringify(v)).join("\n") + "\n",
    );
  });
});
