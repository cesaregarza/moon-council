import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { providerJsonSchema, type DecisionOpportunityV1, type UsageV2 } from "@werewolf/contracts";
import type { ProviderAttemptRecord } from "@werewolf/db";
import type { DecisionRequest, PreparedPrompt } from "@werewolf/llm";
import { v31ApiResponseFormat, v31SubmissionSchema, validateV31Submission, normalizeV31Submission, type V31Submission } from "./request-v3-1";
import type { V3TaskSpec } from "./request-v3";
import { validatePreparedReport } from "./decisions-v2";

export function archivedCacheCases(dbPath: string, gameId: string, attemptIds: string[]) {
  if (!attemptIds.length || attemptIds.length > 12) throw new Error("Select 1–12 explicit attempt IDs");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return attemptIds.map(id => {
      const row = db.prepare("SELECT value_json FROM provider_attempts WHERE game_id=? AND id=?").get(gameId, id) as {value_json:string}|undefined;
      if (!row) throw new Error(`Attempt not found: ${id}`);
      const attempt = JSON.parse(row.value_json) as ProviderAttemptRecord;
      if (attempt.provider !== "codex" || attempt.status !== "valid") throw new Error("Replay accepts validated recorded Codex attempts only");
      const saved = db.prepare("SELECT value_json FROM agent_records WHERE game_id=? AND record_key=?").get(gameId, `decision:${attempt.decisionId}`) as {value_json:string}|undefined;
      if (!saved) throw new Error("Missing frozen decision packet");
      const op = JSON.parse(saved.value_json) as DecisionOpportunityV1;
      const input = JSON.parse(attempt.request.input).REQUEST;
      const task = input.task as V3TaskSpec;
      const schema = v31SubmissionSchema(op.packet, task);
      if (JSON.stringify(providerJsonSchema(schema)) !== JSON.stringify(attempt.request.schema)) throw new Error("Archived schema differs from current schema; refusing to silently rewrite the test");
      const request: DecisionRequest<V31Submission> = {
        kind: "decision_v3_1", gameId, playerId: attempt.playerId, model: attempt.model, reasoningEffort: attempt.reasoningEffort,
        contextV2: op.packet, apiResponseFormat:v31ApiResponseFormat(op.packet,task), schema, schemaName: task.type, preparedPrompt: attempt.request as PreparedPrompt,
        maxOutputTokens: 8192, timeoutMs: 120_000,
      };
      return { attempt, request, validate(value: V31Submission) {
        const errors = validateV31Submission(op.packet, task, value);
        const report = normalizeV31Submission(op.packet, task, value, op.id, input.commitOnly);
        errors.push(...validatePreparedReport(report, op.packet, 1200, task.type !== "journal_update").errors);
        return errors;
      } };
    });
  } finally { db.close(); }
}

export function requestFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Estimate structural reuse separately from the provider's actual cache-token receipts. */
export function prefixComparison(previous: Record<string, unknown> | undefined, current: Record<string, unknown>) {
  const messages = Array.isArray(current.input) ? current.input : [];
  let sameMessages = 0;
  const before = previous && Array.isArray(previous.input) ? previous.input : [];
  while (sameMessages < before.length && sameMessages < messages.length && requestFingerprint(before[sameMessages]) === requestFingerprint(messages[sameMessages])) sameMessages++;
  return { equalLeadingMessages: sameMessages, equalLeadingBytes: sameMessages ? Buffer.byteLength(JSON.stringify(messages.slice(0, sameMessages))) : 0,
    schemaEqual: previous ? requestFingerprint(previous.text) === requestFingerprint(current.text) : null,
    reasoningEqual: previous ? requestFingerprint(previous.reasoning) === requestFingerprint(current.reasoning) : null };
}

export function cacheReceiptSummary(rows: Array<{usage?: UsageV2; latencyMs: number; original?: {usage:UsageV2;latencyMs:number|null}}> ) {
  const sum = (key: keyof UsageV2) => rows.reduce((n, r) => n + (r.usage?.[key] ?? 0), 0);
  const input=sum("inputTokens"),cached=sum("cachedInputTokens"),written=sum("cacheWriteInputTokens");
  const complete=rows.every(r=>r.usage?.inputTokens!=null&&r.usage?.cachedInputTokens!=null&&r.usage?.cacheWriteInputTokens!=null);
  return {calls:rows.length,inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:written,outputTokens:sum("outputTokens"),reasoningTokens:sum("reasoningTokens"),
    cacheReadFraction:complete&&input>0?cached/input:null,
    // GPT-5.6+ categories are mutually exclusive, not additive write fees.
    inputRateEquivalentTokens:complete?input-cached-written+cached*0.1+written*1.25:null,
    latencyMs:rows.reduce((n,r)=>n+r.latencyMs,0),originalInputTokens:rows.reduce((n,r)=>n+(r.original?.usage.inputTokens??0),0),originalLatencyMs:rows.reduce((n,r)=>n+(r.original?.latencyMs??0),0)};
}
