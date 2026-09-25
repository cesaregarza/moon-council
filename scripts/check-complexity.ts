import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

const Baseline = z.record(z.string(), z.array(z.number().int().positive()));
export type ComplexityBaseline = z.infer<typeof Baseline>;
const Report = z.object({
  diagnostics: z.array(
    z.object({
      filename: z.string(),
      message: z.string(),
      code: z.string(),
    }),
  ),
});

/** Retain each function's allowance; a simpler function cannot subsidize a more complex one. */
export function complexityRegressions(
  current: ComplexityBaseline,
  baseline: ComplexityBaseline,
): string[] {
  return Object.keys(current)
    .sort()
    .flatMap((key) => {
      const scores = [...current[key]!].sort((a, b) => b - a);
      const allowed = [...(baseline[key] ?? [])].sort((a, b) => b - a);
      return scores.flatMap((score, index) =>
        score > (allowed[index] ?? 20)
          ? [`${key}: complexity ${score} exceeds ${allowed[index] ?? 20}`]
          : [],
      );
    });
}

export function complexityBaseline(report: unknown): ComplexityBaseline {
  const result: ComplexityBaseline = {};
  for (const diagnostic of Report.parse(report).diagnostics) {
    const match = /^(.*) has a complexity of (\d+)\. Maximum allowed is 20\.$/.exec(
      diagnostic.message,
    );
    if (diagnostic.code !== "eslint(complexity)" || !match)
      throw new Error("Unexpected complexity diagnostic");
    const key = `${diagnostic.filename}: ${match[1]}`;
    (result[key] ??= []).push(Number(match[2]));
  }
  return Object.fromEntries(
    Object.entries(result)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, values]) => [key, values.sort((a, b) => b - a)]),
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      "write-baseline": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: npm run complexity [-- --write-baseline]\nChecks production TypeScript against a complexity ceiling of 20 and reviewed per-function exceptions.\n--write-baseline deliberately replaces the exceptions; review its diff. No model calls.",
    );
    return;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawnSync(
    join(root, "node_modules/.bin/oxlint"),
    [
      "--config",
      "scripts/complexity.oxlint.json",
      "--disable-nested-config",
      "--ignore-pattern",
      "**/*.test.ts",
      "--ignore-pattern",
      "**/*.spec.ts",
      "--ignore-pattern",
      "**/testing/**",
      "--ignore-pattern",
      "**/dist/**",
      "--format",
      "json",
      "apps",
      "packages",
      "scripts",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (child.error) throw child.error;
  if (child.signal || (child.status !== 0 && child.status !== 1) || child.stderr.trim()) {
    throw new Error(`Complexity analysis failed: ${child.stderr || child.signal || child.status}`);
  }
  const current = complexityBaseline(JSON.parse(child.stdout));
  const path = join(root, "scripts/complexity-baseline.json");
  if (values["write-baseline"]) {
    await writeFile(path, JSON.stringify(current, null, 2) + "\n");
    console.log("Wrote complexity baseline; review every changed exception.");
    return;
  }
  const baseline = Baseline.parse(JSON.parse(await readFile(path, "utf8")));
  const regressions = complexityRegressions(current, baseline);
  if (regressions.length) {
    console.error(regressions.join("\n"));
    process.exitCode = 1;
  } else {
    const count = Object.values(current).reduce((sum, scores) => sum + scores.length, 0);
    console.log(`No complexity regressions (${count} existing functions exceed 20).`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
