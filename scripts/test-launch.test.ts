import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");

/**
 * A package's `.bin` shim named in source: the literal path (with a slash or an escaped
 * backslash), or its parts joined, as in `join(root, "node_modules", ".bin", "tsx")`.
 */
const shimPath = /node_modules(?:\/|\\\\?|["'`]\s*,\s*["'`])\.bin/;

/** Every TypeScript file under packages, apps and scripts, except installed and built ones. */
function sourceFiles(): string[] {
  return ["packages", "apps", "scripts"].flatMap((top) =>
    readdirSync(join(root, top), { recursive: true, encoding: "utf8" })
      .filter((path) => /\.[cm]?tsx?$/.test(path))
      .filter(
        (path) => !path.split(/[\\/]/).some((part) => part === "node_modules" || part === "dist"),
      )
      .map((path) => join(top, path).split("\\").join("/"))
      .filter((path) => path !== "scripts/test-launch.test.ts"),
  );
}

/**
 * CES-1562, CES-1568: a package's `.bin` launcher under node_modules is an extensionless POSIX
 * shim that Windows cannot execute (ENOENT; its shim is a `.cmd`), so no source file names that
 * path. Code launches a tool portably instead: `process.execPath` with the tool's JS entry point,
 * or with tsx's loader (`--import tsx`) for TypeScript scripts.
 */
describe("launchers", () => {
  it("never spawn a package's .bin shim directly", () => {
    const offenders = sourceFiles().filter((file) =>
      shimPath.test(readFileSync(join(root, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("recognise the shim path written literally or joined from parts", () => {
    const tool = ["node_modules", ".bin", "tsx"];
    for (const named of [
      `"${tool.join("/")}"`,
      `"${tool.join("\\\\")}"`,
      `join(root, ${tool.map((part) => `"${part}"`).join(", ")})`,
      `join(root, '${tool[0]}', '${tool[1]}/tsx')`,
    ])
      expect(shimPath.test(named), named).toBe(true);
    expect(shimPath.test(`"${tool[0]}/oxlint/bin/oxlint"`)).toBe(false);
  });
});
