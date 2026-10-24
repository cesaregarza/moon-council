import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const shim = ["node_modules", ".bin"].join("/");

/** Every test file under the directories vitest runs. */
function testFiles(): string[] {
  return ["packages", "apps", "scripts"].flatMap((top) =>
    readdirSync(join(root, top), { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".test.ts") && !path.split(/[\\/]/).includes("node_modules"))
      .map((path) => join(top, path)),
  );
}

/**
 * CES-1562: a package's `.bin` launcher under node_modules is an extensionless POSIX shim that
 * Windows cannot execute (ENOENT; its shim is a `.cmd`), so no test file names that path. Tests
 * launch TypeScript scripts portably instead: `process.execPath` with tsx's loader
 * (`--import tsx`).
 */
describe("test launchers", () => {
  it("never spawn a package's .bin shim directly", () => {
    const offenders = testFiles().filter((file) =>
      readFileSync(join(root, file), "utf8").includes(shim),
    );
    expect(offenders).toEqual([]);
  });
});
