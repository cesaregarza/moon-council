import { writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { claudeReservationUsd } from "@werewolf/llm";
import {
  GENERATOR_PROMPT,
  generatedProfile,
  mockGenerator,
  type PersonalityGenerator,
} from "./lib/personality-generator";

/**
 * CES-1585: write a personality pool file offline, never at game time.
 *   npm exec tsx scripts/personality-generate.ts -- --seed-prefix S --count N --out pool.json
 * The default generator is the deterministic mock. `--generator anthropic --model M` is live and
 * paid: it needs --max-profiles and --max-spend-usd, and refuses before any call unless the count
 * and its worst-case cost fit both. Each profile's seed is `${prefix}-${n}`.
 */
const { values } = parseArgs({
  options: {
    "seed-prefix": { type: "string" },
    count: { type: "string" },
    out: { type: "string" },
    generator: { type: "string", default: "mock" },
    model: { type: "string" },
    "max-profiles": { type: "string" },
    "max-spend-usd": { type: "string" },
  },
});
const prefix = values["seed-prefix"],
  count = Number(values.count),
  out = values.out;
if (!prefix || !out || !Number.isInteger(count) || count < 1)
  throw new Error("usage: --seed-prefix S --count N --out FILE [--generator mock|anthropic]");
if (existsSync(out)) throw new Error(`${out} exists; choose a new file`);

/** Live generation: one strict-JSON call per profile, from numbers only. */
const MAX_OUTPUT_TOKENS = 600;
const PROMPT_CEILING_TOKENS = 1_000;
function anthropicGenerator(model: string): PersonalityGenerator {
  const client = new Anthropic({ maxRetries: 0 });
  const schema = {
    type: "object",
    properties: { label: { type: "string" }, text: { type: "string" } },
    required: ["label", "text"],
    additionalProperties: false,
  };
  return {
    model,
    prompt: GENERATOR_PROMPT,
    async generate(input) {
      const message = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: GENERATOR_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(input) }],
        output_config: { format: { type: "json_schema", schema } },
      } as never);
      const block = (message as { content: { type: string; text?: string }[] }).content.find(
        (part) => part.type === "text",
      );
      return JSON.parse(block?.text ?? "") as { label: string; text: string };
    },
  };
}

let generator = mockGenerator;
if (values.generator === "anthropic") {
  const model = values.model,
    maxProfiles = Number(values["max-profiles"]),
    maxSpendUsd = Number(values["max-spend-usd"]);
  if (!model) throw new Error("--model is required for live generation");
  if (!Number.isInteger(maxProfiles) || maxProfiles < 1 || !(maxSpendUsd > 0))
    throw new Error("live generation requires --max-profiles and --max-spend-usd");
  if (count > maxProfiles)
    throw new Error(`--count ${count} exceeds --max-profiles ${maxProfiles}`);
  const worstCase = count * claudeReservationUsd(model, PROMPT_CEILING_TOKENS, MAX_OUTPUT_TOKENS);
  if (worstCase > maxSpendUsd)
    throw new Error(`worst case $${worstCase.toFixed(4)} exceeds --max-spend-usd ${maxSpendUsd}`);
  generator = anthropicGenerator(model);
} else if (values.generator !== "mock") throw new Error("--generator is mock or anthropic");

const createdAt = new Date().toISOString();
const pool = [];
for (let n = 1; n <= count; n += 1)
  pool.push(await generatedProfile(`${prefix}-${n}`, generator, createdAt));
writeFileSync(out, `${JSON.stringify(pool, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ kind: "personality_pool", out, count, generator: generator.model }));
