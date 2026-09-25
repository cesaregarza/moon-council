import { loadProviderEnvironment } from "@werewolf/llm";
import { buildApi } from "./app";

loadProviderEnvironment();

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.API_PORT ?? 4310);
const { app } = await buildApi({ logger: true });
await app.listen({ host, port });
