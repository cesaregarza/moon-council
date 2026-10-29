import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERSONALITY_PRESETS,
  PersonalityProfileSchema,
  seededPersonalityValues,
  sha256Hex,
} from "@werewolf/contracts";
import {
  generatedProfile,
  generatorInput,
  mockGenerator,
  samplePersonalityPool,
} from "./lib/personality-generator";

/**
 * CES-1585: generated personalities. A seed gives the values; a generator writes the text from
 * numbers only, so no role, seat or game fact can reach it. Tests use the mock generator.
 */
describe("personality generation (CES-1585)", () => {
  it("gives the generator numbers only: no role, seat, name or game field", () => {
    const input = generatorInput(seededPersonalityValues("sample-1"));
    expect(Object.keys(input).sort()).toEqual(["motivations", "traits"]);
    const preset = generatorInput(seededPersonalityValues("sample-1"), "Disruptor");
    expect(Object.keys(preset).sort()).toEqual(["motivations", "presetName", "traits"]);
    for (const value of [...Object.values(input.traits), ...Object.values(input.motivations)])
      expect(typeof value).toBe("number");
    expect(JSON.stringify(input)).not.toMatch(/role|seat|werewolf|villager|player|game/i);
  });

  it("builds a frozen, valid generated profile deterministically from a seed", async () => {
    const one = await generatedProfile("sample-3", mockGenerator, "2026-10-28T00:00:00.000Z");
    const two = await generatedProfile("sample-3", mockGenerator, "2026-10-28T00:00:00.000Z");
    expect(two).toEqual(one);
    expect(PersonalityProfileSchema.safeParse(one).success).toBe(true);
    expect(one.source).toMatchObject({
      kind: "generated",
      seed: "sample-3",
      valuesSha256: sha256Hex(JSON.stringify(seededPersonalityValues("sample-3"))),
      generator: { model: "mock" },
    });
    expect(one.traits).toEqual(seededPersonalityValues("sample-3").traits);
  });

  it("keeps the committed sample pool: the five presets plus three mock profiles", async () => {
    const committed = JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures", "personality-samples.json"), "utf8"),
    );
    const pool = await samplePersonalityPool();
    expect(committed).toEqual(pool);
    expect(pool.slice(0, 5).map((p) => p.id)).toEqual([
      "liar",
      "maverick",
      "sacrificial-lamb",
      "disruptor",
      "careful-reasoner",
    ]);
    expect(pool[3]).toEqual(PERSONALITY_PRESETS.disruptor);
    for (const mock of pool.slice(5)) expect(mock.label).toMatch(/^Mock /);
    expect(pool.slice(5).map((p) => (p.source.kind === "generated" ? p.source.seed : ""))).toEqual([
      "sample-1",
      "sample-2",
      "sample-3",
    ]);
  });
});
