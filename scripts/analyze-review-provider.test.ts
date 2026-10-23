import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * CES-1564: an analysis whose review spends real credit (Claude) needs a per-run USD cap; Jev's
 * cost is not counted (Cesar, 2026-10-23). Without the cap the run is refused by name before Jev
 * or any review provider is constructed, from both the standalone CLI and the pilot's preflight.
 * Construction is spied.
 */
const calls = vi.hoisted(() => ({ created: [] as string[], anthropic: 0, jev: 0 }));
vi.mock("@werewolf/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@werewolf/llm")>();
  class SpiedAnthropic extends actual.AnthropicMessagesProvider {
    constructor(...args: ConstructorParameters<typeof actual.AnthropicMessagesProvider>) {
      calls.anthropic += 1;
      super(...args);
    }
  }
  class SpiedJev extends actual.AskJevProvider {
    constructor(...args: ConstructorParameters<typeof actual.AskJevProvider>) {
      calls.jev += 1;
      super(...args);
    }
  }
  return {
    ...actual,
    AnthropicMessagesProvider: SpiedAnthropic,
    AskJevProvider: SpiedJev,
    createDecisionProvider: (kind?: Parameters<typeof actual.createDecisionProvider>[0]) => {
      calls.created.push(String(kind));
      return actual.createDecisionProvider(kind);
    },
  };
});

const directories: string[] = [];
const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  calls.created.length = 0;
  calls.anthropic = 0;
  calls.jev = 0;
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

/** Runs a script as its own entry point (its `main` guard compares process.argv[1]). */
async function runScript(script: string, args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "review-provider-"));
  directories.push(directory);
  const path = resolve(__dirname, script);
  process.argv = [process.argv[0]!, path, ...args.map((a) => a.replace("$DIR", directory))];
  vi.resetModules();
  return import(path);
}

const review = (provider: string) => [
  "--review-provider",
  provider,
  "--review-model",
  "claude-haiku-5-5",
];

const analyzeArgs = (provider: string, ...extra: string[]) => [
  "--db",
  "$DIR/missing.db",
  "--game",
  "g",
  "--out",
  "$DIR/out",
  ...review(provider),
  ...extra,
];
const nothingConstructed = () => {
  expect(calls.created).toEqual([]);
  expect(calls.anthropic).toBe(0);
  expect(calls.jev).toBe(0);
};

describe("analysis review provider", () => {
  it("refuses anthropic in the CLI without a spend cap, before Jev or any provider", async () => {
    const run = runScript("game-analyze.ts", analyzeArgs("anthropic"));
    await expect(run).rejects.toMatchObject({ name: "MissingAnalysisSpendCapError" });
    nothingConstructed();
  });

  it("runs a free review in the CLI without a spend cap: Jev's cost is not counted", async () => {
    const run = runScript("game-analyze.ts", analyzeArgs("fake"));
    // The missing database stops the run after the providers are built.
    await expect(run).rejects.toThrow();
    expect(calls.created).toEqual(["fake"]);
    expect(calls.jev).toBe(1);
  });

  it("refuses an unpriced review provider in the CLI, before Jev or any provider", async () => {
    const run = runScript("game-analyze.ts", analyzeArgs("openai", "--max-spend-usd", "20"));
    await expect(run).rejects.toMatchObject({ name: "UnpricedReviewModelError" });
    nothingConstructed();
  });

  it("refuses an analysis without its spend cap in the pilot's preflight, before any game", async () => {
    const run = runScript("pilot.ts", [
      "--provider",
      "fake",
      "--analyze",
      ...review("anthropic"),
      "--db",
      "$DIR/game.db",
      "--out",
      "$DIR/out",
      // Stops the run right after its preflight, instead of running a game.
      "--mode",
      "bogus",
    ]);
    await expect(run).rejects.toMatchObject({ name: "MissingAnalysisSpendCapError" });
    nothingConstructed();
  });

  it("constructs Claude only through the run's spend cap in the CLI", async () => {
    const run = runScript("game-analyze.ts", analyzeArgs("anthropic", "--max-spend-usd", "20"));
    // The missing database (or a missing key) stops the run after construction.
    await expect(run).rejects.toThrow();
    expect(calls.created).toEqual([]);
    expect(calls.anthropic).toBe(1);
  });

  it("still constructs an existing review kind in the CLI", async () => {
    const run = runScript("game-analyze.ts", analyzeArgs("fake", "--max-spend-usd", "20"));
    // The missing database stops the run after the review provider is built.
    await expect(run).rejects.toThrow();
    expect(calls.created).toEqual(["fake"]);
  });
});
