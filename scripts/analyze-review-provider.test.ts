import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Felix's ruling f9f6d39f: until a per-run USD cap for analysis is designed, `anthropic` is
 * refused as the review provider, by name, before any provider is constructed or any SDK call is
 * made, from both the standalone CLI and the pilot's preflight. Provider construction is spied.
 */
const calls = vi.hoisted(() => ({ created: [] as string[], anthropic: 0 }));
vi.mock("@werewolf/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@werewolf/llm")>();
  class SpiedAnthropic extends actual.AnthropicMessagesProvider {
    constructor(...args: ConstructorParameters<typeof actual.AnthropicMessagesProvider>) {
      calls.anthropic += 1;
      super(...args);
    }
  }
  return {
    ...actual,
    AnthropicMessagesProvider: SpiedAnthropic,
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

describe("analysis review provider", () => {
  it("refuses anthropic in the CLI before constructing any provider", async () => {
    const run = runScript("game-analyze.ts", [
      "--db",
      "$DIR/missing.db",
      "--game",
      "g",
      "--out",
      "$DIR/out",
      ...review("anthropic"),
    ]);
    await expect(run).rejects.toMatchObject({ name: "UncappedReviewSpendError" });
    expect(calls.created).toEqual([]);
    expect(calls.anthropic).toBe(0);
  });

  it("refuses anthropic in the pilot's preflight, before any game or provider", async () => {
    const run = runScript("pilot.ts", [
      "--provider",
      "fake",
      "--analyze",
      ...review("anthropic"),
      "--db",
      "$DIR/game.db",
      "--out",
      "$DIR/out",
      // Stops the old code right after its preflight, instead of running a game.
      "--mode",
      "bogus",
    ]);
    await expect(run).rejects.toMatchObject({ name: "UncappedReviewSpendError" });
    expect(calls.created).toEqual([]);
    expect(calls.anthropic).toBe(0);
  });

  it("still constructs an existing review kind in the CLI", async () => {
    const run = runScript("game-analyze.ts", [
      "--db",
      "$DIR/missing.db",
      "--game",
      "g",
      "--out",
      "$DIR/out",
      ...review("fake"),
    ]);
    // The missing database stops the run after the review provider is built.
    await expect(run).rejects.toThrow();
    expect(calls.created).toEqual(["fake"]);
  });
});
