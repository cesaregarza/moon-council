import { spawn } from "node:child_process";
import { z } from "zod";
import { unknownUsage, type UsageV2 } from "@werewolf/contracts";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "./provider";

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "choice"; instructions: string; criteria: Record<string, unknown> };
export interface JevRequest { model: string; state: unknown; questions: Record<string, JevQuestion> }
const probability = z.number().min(0).max(1);
const distribution = z.record(z.string(), probability);
const AnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: distribution, confidence: probability }),
  z.object({ type: z.literal("score"), score: z.number().nonnegative(), probabilities: distribution, confidence: probability }),
]);
export const JevResponseSchema = z.object({
  model: z.string().min(1), answers: z.record(z.string(), AnswerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).optional(),
});
export type JevResponse = z.infer<typeof JevResponseSchema>;

/** Validate the distribution against this exact question set, including legal option keys. */
export function jevResponseSchema(request: JevRequest) {
  return JevResponseSchema.superRefine((response, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (JSON.stringify(Object.keys(response.answers).sort()) !== JSON.stringify(Object.keys(request.questions).sort())) issue("Jev question IDs do not match");
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = response.answers[id];
      if (!answer || answer.type !== question.type) { issue(`Jev answer type mismatch: ${id}`); continue; }
      if (answer.type === "noul" || question.type === "noul") continue;
      const options = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
      if (JSON.stringify(Object.keys(answer.probabilities).sort()) !== JSON.stringify(options.sort())) issue(`Jev option mismatch: ${id}`);
      // Decimal-rounded totals of 0.99/1.01 sit on the permitted boundary.
      if (Math.abs(Object.values(answer.probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.01 + 1e-12) issue(`Jev probabilities must sum to one: ${id}`);
      if (answer.type === "choice" && (!options.includes(answer.choice) || answer.probabilities[answer.choice]! < Math.max(...Object.values(answer.probabilities)) - 1e-6)) issue(`Invalid Jev choice: ${id}`);
      if (answer.type === "score" && answer.score > options.length - 1) issue(`Invalid Jev score: ${id}`);
    }
  });
}

export type AskJevRunner = (input: string, options: { signal?: AbortSignal; timeoutMs: number }) => Promise<string>;
const MAX_BYTES = 1024 * 1024;

/** Use the installed CLI so credential handling and mandatory private request logging stay centralized. */
export const runAskJev: AskJevRunner = (input, { signal, timeoutMs }) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error("Jev request aborted")); return; }
  if (Buffer.byteLength(input) > MAX_BYTES) { reject(new Error("Jev request exceeds 1 MiB")); return; }
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "TYPESAFE_API_KEY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "LANG"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(process.env.ASK_JEV_BIN?.trim() || "ask-jev", ["--timeout", String(Math.max(1, Math.ceil(timeoutMs / 1000)))], { detached: process.platform !== "win32", shell: false, stdio: ["pipe", "pipe", "pipe"], env });
  let size = 0, stderrSize = 0, settled = false;
  let stdinFailed = false;
  const killProcessTree = () => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
    }
  };
  const chunks: Buffer[] = [];
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (error) { killProcessTree(); reject(error); }
    else resolve(Buffer.concat(chunks).toString("utf8"));
  };
  const abort = () => finish(new Error("Jev request aborted"));
  const timer = setTimeout(() => finish(new Error("Jev request timed out")), timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  child.on("error", () => finish(new Error("Could not launch ask-jev; install the CLI or set ASK_JEV_BIN")));
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BYTES) finish(new Error("Jev response exceeds 1 MiB"));
    else chunks.push(chunk);
  });
  // Drain stderr but never copy supplied context or credentials into an application error.
  child.stderr.on("data", (chunk: Buffer) => { stderrSize += chunk.length; if (stderrSize > MAX_BYTES) finish(new Error("Jev stderr exceeds 1 MiB")); });
  // EPIPE commonly precedes a useful nonzero exit. Drain/await close so we retain
  // that exit code; the deadline still bounds a child that never exits.
  child.stdin.on("error", () => { stdinFailed = true; });
  child.on("close", code => {
    if (code !== 0) finish(new Error(`ask-jev failed (exit ${code}); check CLI credentials, service access, and its private request log`));
    else finish(stdinFailed ? new Error("Could not send the complete request to ask-jev (exit 0)") : undefined);
  });
  child.stdin.end(input);
});

export class AskJevProvider implements DecisionProvider {
  constructor(private readonly run: AskJevRunner = runAskJev) {}
  async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    if (request.kind !== "jev" || !request.preparedPrompt) throw new Error("Jev requires a typed Jev request");
    let usage: UsageV2 = unknownUsage(), model = request.model;
    try {
      const raw = await this.run(request.preparedPrompt.input, { signal: request.signal, timeoutMs: Math.min(request.timeoutMs ?? 20_000, 20_000) });
      request.onRawResponse?.(raw);
      const response = JSON.parse(raw);
      const measured = JevResponseSchema.shape.usage.safeParse(response.usage);
      if (measured.success && measured.data) {
        usage = { ...usage, inputTokens: measured.data.input_tokens, outputTokens: measured.data.output_tokens, totalTokens: measured.data.input_tokens + measured.data.output_tokens };
      }
      if (typeof response.model === "string" && response.model) model = response.model;
      const data = request.schema.parse(response);
      return { data, provider: "jev", model, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, totalTokens: usage.totalTokens ?? 0 } };
    } finally {
      request.onUsage?.(usage, { provider: "jev", model, outputLimitEnforced: false });
    }
  }
}
