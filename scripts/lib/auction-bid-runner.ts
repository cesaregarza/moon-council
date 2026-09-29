import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  jevResponseSchema,
  type DecisionProvider,
  type DecisionRequest,
  type JevResponse,
} from "@werewolf/llm";
import { JournalSchema } from "./auction-study-agents";
import {
  bidRequest,
  journalRequest,
  MAX_CALLS,
  orderedContexts,
  type BidMode,
} from "./auction-bid-design";

export type BidJob = ReturnType<typeof orderedContexts>[number];
export interface BidObservation {
  id: string;
  mode: BidMode;
  status: "complete" | "failed" | "skipped";
  journal: string | null;
  response: JevResponse | null;
  error: string | null;
}
export type RecordEvent = (event: Record<string, unknown>) => void;
export const fileRecorder =
  (directory: string): RecordEvent =>
  (event) =>
    appendFileSync(
      join(directory, "attempts.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
      { mode: 0o600 },
    );

/** A shared ledger and ceiling across both concurrent contexts. No provider retries. */
export class BidCalls {
  private count = 0;
  private started = Date.now();
  constructor(
    private providers: { jev: DecisionProvider; luna: DecisionProvider },
    private record: RecordEvent,
    private maxMinutes = 20,
    private maxCalls = MAX_CALLS,
  ) {
    if (
      !Number.isInteger(maxCalls) ||
      maxCalls < 1 ||
      !Number.isFinite(maxMinutes) ||
      maxMinutes <= 0
    )
      throw new Error("Invalid probe budget");
  }
  async call<T>(id: string, stage: string, request: DecisionRequest<T>): Promise<T> {
    const remaining = this.maxMinutes * 60000 - (Date.now() - this.started);
    if (this.count >= this.maxCalls || remaining <= 0)
      throw new Error("Probe budget exhausted; no call sent");
    const attempt = ++this.count;
    const at = Date.now();
    const log = (event: string, data: unknown) => this.record({ id, stage, attempt, event, data });
    log("started", { prompt: request.preparedPrompt, model: request.model });
    try {
      const provider = request.kind === "jev" ? this.providers.jev : this.providers.luna;
      const result = await provider.decide({
        ...request,
        timeoutMs: Math.min(180000, remaining),
        maxOutputTokens: null,
        onProviderRequest: (body) => log("request", body),
        onRawResponse: (raw) => log("response", raw),
        onUsage: (usage, metadata) => log("usage", { ...usage, ...metadata }),
        onProviderMetadata: (metadata) => log("metadata", metadata),
      });
      log("completed", { model: result.model, elapsedMs: Date.now() - at });
      return result.data;
    } catch (error) {
      log("failed", {
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - at,
      });
      throw error;
    }
  }
}
export async function scoreJournal(
  calls: BidCalls,
  job: BidJob,
  mode: BidMode,
  journal: string,
): Promise<BidObservation> {
  const request = bidRequest(job.context, journal);
  try {
    const response = await calls.call(job.id, mode, {
      kind: "jev",
      playerId: "p1",
      model: request.model,
      schemaName: "study_jev",
      schema: jevResponseSchema(request),
      maxOutputTokens: null,
      preparedPrompt: { instructions: "", input: JSON.stringify(request) },
    });
    return { id: job.id, mode, status: "complete", journal, response, error: null };
  } catch (error) {
    return {
      id: job.id,
      mode,
      status: "failed",
      journal,
      response: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
export async function probeJournal(
  calls: BidCalls,
  job: BidJob,
  mode: "luna" | "memory-v2",
): Promise<BidObservation> {
  let journal: string;
  try {
    const update = await calls.call(job.id, mode === "luna" ? "journal" : "journal-memory-v2", {
      kind: "decision_v3_1",
      playerId: "p1",
      gameId: "auction-bid-pairs-v1",
      model: "gpt-6-luna",
      reasoningEffort: "xhigh",
      schemaName: "study_journal",
      schema: JournalSchema,
      maxOutputTokens: null,
      preparedPrompt: journalRequest(job.context, mode === "luna" ? "legacy" : "memory-v2"),
    });
    journal = update.journal;
  } catch (error) {
    return {
      id: job.id,
      mode,
      status: "skipped",
      journal: null,
      response: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return scoreJournal(calls, job, mode, journal);
}
export async function probeContext(calls: BidCalls, job: BidJob): Promise<BidObservation[]> {
  const authored = await scoreJournal(calls, job, "authored", job.context.authoredJournal);
  return [authored, await probeJournal(calls, job, "luna")];
}
export async function compareJournals(calls: BidCalls, job: BidJob): Promise<BidObservation[]> {
  const modes: Array<"luna" | "memory-v2"> =
    job.variant === "a" ? ["luna", "memory-v2"] : ["memory-v2", "luna"];
  const results = [];
  for (const mode of modes) results.push(await probeJournal(calls, job, mode));
  return results;
}
export async function runBidJobs(
  calls: BidCalls,
  jobs: BidJob[],
  save: (results: BidObservation[]) => Promise<void>,
  comparison = false,
) {
  const results: BidObservation[] = [];
  // Fixed two-context batches: no adaptive ordering, replacement, or outcome-dependent retries.
  for (let index = 0; index < jobs.length; index += 2) {
    const batch = await Promise.all(
      jobs
        .slice(index, index + 2)
        .map((job) => (comparison ? compareJournals(calls, job) : probeContext(calls, job))),
    );
    results.push(...batch.flat());
    await save(results);
  }
  return results;
}
