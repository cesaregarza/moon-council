import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runAskJev, jevResponseSchema, type AskJevRunner } from "../packages/llm/src/jev";

const text = z.string().min(1);
const question = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), instructions: text }).strict(),
  z
    .object({
      type: z.literal("score"),
      instructions: text,
      criteria: z.array(text).min(2).max(10),
    })
    .strict(),
  z
    .object({
      type: z.literal("choice"),
      instructions: text,
      criteria: z
        .record(text, z.unknown())
        .refine(
          (v) => Object.keys(v).length >= 2 && Object.keys(v).length <= 255,
          "Expected 2–255 choices",
        ),
    })
    .strict(),
]);
const casesSchema = z
  .array(
    z
      .object({
        label: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
        request: z
          .object({
            model: text,
            state: z.unknown(),
            questions: z
              .record(text, question)
              .refine((v) => Object.keys(v).length > 0, "Questions required"),
          })
          .strict(),
      })
      .strict(),
  )
  .min(1)
  .max(24)
  .refine(
    (rows) => new Set(rows.map((r) => r.label)).size === rows.length,
    "Duplicate case labels",
  );
export const parseProbeCases = (value: unknown) => casesSchema.parse(value);
type ProbeCase = ReturnType<typeof parseProbeCases>[number];
export function describeProbeCase(row: ProbeCase) {
  const state = row.request.state;
  return {
    label: row.label,
    model: row.request.model,
    requestBytes: Buffer.byteLength(JSON.stringify(row.request)),
    stateFieldBytes:
      state && typeof state === "object" && !Array.isArray(state)
        ? Object.fromEntries(
            Object.entries(state).map(([key, value]) => [
              key,
              Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value)),
            ]),
          )
        : null,
  };
}
export async function evaluateProbeCase(row: ProbeCase, run: AskJevRunner = runAskJev) {
  const raw = await run(JSON.stringify(row.request), { timeoutMs: 20_000 });
  try {
    return { raw, response: jevResponseSchema(row.request).parse(JSON.parse(raw)), error: null };
  } catch {
    return { raw, response: null, error: "Invalid Jev response; inspect saved raw response" };
  }
}
async function native(path: string) {
  const result = await realpath(path);
  if (result === "/mnt" || result.startsWith("/mnt/")) throw new Error("Use native Linux paths");
  return result;
}
async function main() {
  const { values } = parseArgs({
    options: {
      cases: { type: "string" },
      out: { type: "string" },
      live: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: npm run jev:probe -- --cases CASES.json [--live --out NEW_DIRECTORY]\nCases: [{label,request:{model,state,questions}}]. Default: offline size report. --live sends each explicit case once via ask-jev, sequentially; no retries or game mutations. Requires a new native output directory whose parent exists. Saves exact inputs, raw outputs, validated answers, and summary.json. Stops on failure. Compare returned model versions before comparing results.",
    );
    return;
  }
  if (!values.cases || Boolean(values.out) !== Boolean(values.live))
    throw new Error("Supply --cases; --live and --out must be supplied together");
  const cases = parseProbeCases(
    JSON.parse(await readFile(await native(resolve(values.cases)), "utf8")),
  );
  if (!values.live) {
    console.log(JSON.stringify(cases.map(describeProbeCase), null, 2));
    return;
  }
  const output = resolve(values.out!),
    directory = join(await native(dirname(output)), basename(output));
  await mkdir(directory, { mode: 0o700 });
  const summaries = [];
  for (const row of cases) {
    await writeFile(join(directory, `${row.label}.input.json`), JSON.stringify(row.request), {
      mode: 0o600,
      flag: "wx",
    });
    const started = Date.now();
    let result: Awaited<ReturnType<typeof evaluateProbeCase>>;
    try {
      result = await evaluateProbeCase(row);
    } catch {
      result = {
        raw: "",
        response: null,
        error: "Ask Jev transport failed; inspect the CLI's private request log",
      };
    }
    await writeFile(
      join(directory, `${row.label}.output.json`),
      JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    const summary = {
      ...describeProbeCase(row),
      latencyMs: Date.now() - started,
      response: result.response,
      error: result.error,
    };
    summaries.push(summary);
    await writeFile(join(directory, "summary.json"), JSON.stringify(summaries, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(JSON.stringify(summary));
    if (result.error) {
      process.exitCode = 1;
      break;
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
