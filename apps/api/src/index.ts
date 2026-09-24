import { fileURLToPath } from "node:url";
import { buildApi } from "./app";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // .env is optional; process environment remains authoritative.
}

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.API_PORT ?? 4310);
const { app } = await buildApi({ logger: true });
await app.listen({ host, port });
