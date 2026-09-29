import { realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";

export async function nativePath(path: string): Promise<string> {
  const full = resolve(path);
  if (full === "/mnt" || full.startsWith("/mnt/")) throw new Error("Use a native Linux path");
  let existing = full;
  for (;;) {
    try {
      const resolved = await realpath(existing);
      if (resolved === "/mnt" || resolved.startsWith("/mnt/"))
        throw new Error("Mounted symlink target is forbidden");
      return full;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existing = dirname(existing);
    }
  }
}
