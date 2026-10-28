import { createWriteStream } from "node:fs";
import { once } from "node:events";

/**
 * Writes large research artifacts piece by piece instead of as one string (CES-1584): a long
 * game's bundle no longer fits a 1 GB heap as a single JSON string.
 */
async function writePieces(path: string, pieces: Iterable<string>): Promise<void> {
  const out = createWriteStream(path);
  for (const piece of pieces) if (!out.write(piece)) await once(out, "drain");
  out.end();
  await once(out, "finish");
}

const indent = (text: string, spaces: number) => text.replaceAll("\n", `\n${" ".repeat(spaces)}`);
/** A value as JSON.stringify(value, null, 2) writes it inside an array (undefined becomes null). */
const element = (value: unknown) => JSON.stringify(value, null, 2) ?? "null";

/** The same bytes as JSON.stringify(value, null, 2), with each top-level array streamed. */
function* prettyPieces(value: Record<string, unknown>): Generator<string> {
  const entries = Object.entries(value).filter(([, v]) => JSON.stringify(v) !== undefined);
  if (!entries.length) return yield "{}";
  yield "{";
  for (const [index, [key, v]] of entries.entries()) {
    yield `${index ? "," : ""}\n  ${JSON.stringify(key)}: `;
    if (!Array.isArray(v) || !v.length) {
      yield indent(JSON.stringify(v, null, 2), 2);
      continue;
    }
    yield "[";
    for (const [i, item] of v.entries()) yield `${i ? "," : ""}\n    ${indent(element(item), 4)}`;
    yield "\n  ]";
  }
  yield "\n}";
}

export const writePrettyJson = (path: string, value: Record<string, unknown>) =>
  writePieces(path, prettyPieces(value));

/** One JSON value per line, each line written as it is made. */
export const writeJsonLines = (path: string, values: Iterable<unknown>) =>
  writePieces(
    path,
    (function* () {
      for (const value of values) yield `${JSON.stringify(value)}\n`;
    })(),
  );
