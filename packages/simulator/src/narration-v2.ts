import { z } from "zod";
import { providerJsonSchema, type GamePhase, type GameConfigV2, unknownUsage, type UsageV2 } from "@werewolf/contracts";
import { DecisionStore, type LabRepository } from "@werewolf/db";
import type { DecisionProvider } from "@werewolf/llm";
import { assertV2Budget, V2BudgetError, usageTotals } from "./decisions-v2";
import { estimatedTokens } from "./context-v2";

const NarrationSchema = z.strictObject({ text: z.string().min(1).max(800) });
type Narration = z.infer<typeof NarrationSchema>;
type Prompt = { instructions: string; input: string };

export interface NarrationCheckpoint {
  schemaVersion: "moderator_narration_v2";
  decisionId: string;
  recovery: number;
  status: "open" | "pending" | "committed" | "paused" | "skipped";
  best: string | null;
  basePrompt: Prompt;
  lastPrompt: Prompt;
  error: string | null;
}

export interface NarrationV2Options {
  gameId: string;
  decisionId: string;
  phase: GamePhase;
  day: number;
  model: string;
  reasoningEffort?: string;
  provider?: string;
  disclosurePacket: Record<string, unknown>;
  fallbackText: string;
  mandatoryRemaining?: number;
  mandatoryTokenReserve?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class NarrationPausedError extends Error {}

const keyOf = (id: string) => `narration:${id}`;
const instructions = "You are a neutral Werewolf moderator. Narrate only the supplied engine-produced public disclosure packet. Do not infer, reveal, or invent private information, player context, hidden reasoning, actions, or outcomes. Return only {text} as a concise atmospheric announcement.";
const active = (repository: LabRepository, gameId: string) => ["running", "stepping"].includes(repository.getGame(gameId)?.status ?? "");
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2_000);

export class NarrationV2 {
  readonly store: DecisionStore;
  constructor(private readonly repository: LabRepository, private readonly provider: DecisionProvider) { this.store = new DecisionStore(repository); }

  checkpoint(gameId: string, decisionId: string): NarrationCheckpoint | undefined {
    return this.store.get<NarrationCheckpoint>(gameId, keyOf(decisionId));
  }

  /** Called by the orchestrator only after its atomic public announcement commit. */
  acknowledge(gameId: string, decisionId: string, text?: string): string {
    const checkpoint = this.checkpoint(gameId, decisionId);
    if (!checkpoint?.best || (text !== undefined && checkpoint.best !== text)) throw new NarrationPausedError("narration acknowledgement has no matching pending report");
    this.store.put(gameId, keyOf(decisionId), { ...checkpoint, status: "committed" });
    return checkpoint.best;
  }

  async narrate(options: NarrationV2Options): Promise<string> {
    const started=Date.now();
    const log=(type:string,payload:Record<string,unknown>)=>this.repository.appendEvent(options.gameId,{type,phase:options.phase,day:options.day,visibility:"moderator",payload:{playerId:"moderator",decisionId:options.decisionId,...payload}});
    const game = this.repository.getGame(options.gameId);
    if (!game || game.config.schemaVersion !== "game_config_v2") throw new Error("V2 narration requires a V2 game");
    const config = game.config as GameConfigV2;
    const maxOutputTokens = Math.min(options.maxOutputTokens ?? 300, config.safety.maxOutputTokens);
    const timeoutMs = options.timeoutMs ?? config.deliberation.requestTimeoutMs;
    const basePrompt: Prompt = { instructions, input: JSON.stringify({ disclosurePacket: options.disclosurePacket }) };
    const jsonSchema = providerJsonSchema(NarrationSchema);
    let checkpoint = this.checkpoint(options.gameId, options.decisionId);
    if (checkpoint && checkpoint.basePrompt.input !== basePrompt.input) throw new NarrationPausedError("narration disclosure packet changed after checkpoint");
    if (checkpoint?.best && ["pending", "committed"].includes(checkpoint.status)) return checkpoint.best;
    if (checkpoint?.status === "skipped") return options.fallbackText;
    if (!active(this.repository, options.gameId)) {
      if (checkpoint) this.store.put(options.gameId, keyOf(options.decisionId), { ...checkpoint, status: "paused" });
      throw new NarrationPausedError("narration is paused; a pending report remains uncommitted");
    }
    if (!checkpoint) {
      checkpoint = { schemaVersion: "moderator_narration_v2", decisionId: options.decisionId, recovery: 0, status: "open", best: null, basePrompt, lastPrompt: basePrompt, error: null };
    } else if (checkpoint.status === "paused") {
      checkpoint = { ...checkpoint, recovery: checkpoint.recovery + 1, status: "open", best: null, lastPrompt: basePrompt, error: null };
    }
    this.store.put(options.gameId, keyOf(options.decisionId), checkpoint);
    const recoveryAttempts = () => this.store.attempts(options.gameId, options.decisionId).filter(attempt => attempt.recovery === checkpoint!.recovery);
    if (recoveryAttempts().some(attempt => ["started", "received"].includes(attempt.status))) {
      checkpoint = { ...checkpoint, status: "paused", error: "uncertain in-flight narration" };
      this.store.put(options.gameId, keyOf(options.decisionId), checkpoint);
      throw new NarrationPausedError("uncertain in-flight narration; resume starts a recorded recovery");
    }
    const priorAttempts = recoveryAttempts();
    if (priorAttempts.length >= 2) {
      checkpoint = { ...checkpoint, status: "paused", error: "narration retry limit reached" };
      this.store.put(options.gameId, keyOf(options.decisionId), checkpoint);
      throw new NarrationPausedError("exhausted narration retries; no announcement fabricated");
    }
    const reserveCalls = options.mandatoryRemaining ?? 0;
    const reserveTokens = options.mandatoryTokenReserve ?? reserveCalls * (estimatedTokens(basePrompt) + estimatedTokens(jsonSchema) + maxOutputTokens);
    const admitsBudget = () => {
      const usage = usageTotals(this.store, options.gameId);
      try { assertV2Budget(this.store, options.gameId, config); } catch (error) { if (!(error instanceof V2BudgetError)) throw error; return false; }
      return usage.calls + 1 + reserveCalls < config.safety.maxModelCalls && usage.admissionTokens + estimatedTokens(basePrompt) + estimatedTokens(jsonSchema) + maxOutputTokens + reserveTokens < config.maxTotalTokens;
    };
    if (!admitsBudget()) {
      checkpoint = { ...checkpoint, status: "skipped", error: "optional narration skipped to reserve mandatory decision budget" };
      this.store.put(options.gameId, keyOf(options.decisionId), checkpoint);
      return options.fallbackText;
    }
    let repair = priorAttempts.length > 0;
    for (let index = priorAttempts.length; index < 2; index += 1) {
      if (!admitsBudget()) {
        checkpoint = { ...checkpoint, status: "skipped", error: "optional narration skipped to reserve mandatory decision budget" };
        this.store.put(options.gameId, keyOf(options.decisionId), checkpoint);
        return options.fallbackText;
      }
      const prompt: Prompt = index === 0 ? basePrompt : { instructions, input: JSON.stringify({ disclosurePacket: options.disclosurePacket, correctionRequired: checkpoint.error }) };
      checkpoint = { ...checkpoint, lastPrompt: prompt };
      this.store.put(options.gameId, keyOf(options.decisionId), checkpoint);
      const opportunity = { id: options.decisionId, gameId: options.gameId, playerId: "moderator", phase: options.phase, day: options.day, recovery: checkpoint.recovery };
      const attempt = this.store.beginAttempt(opportunity, { model: options.model, provider: options.provider ?? "unknown", reasoningEffort: "none", optional: true, request: { ...prompt, schema: jsonSchema } });
      attempt.promptVersion = "moderator_prompt_v2.1";
      attempt.schemaVersion = "moderator_narration_v2";
      attempt.reasoningEffort = options.reasoningEffort ?? "none";
      this.store.updateAttempt(attempt);
      const controller = new AbortController();
      const abort = () => controller.abort(options.signal?.reason ?? new Error("narration aborted"));
      if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
      const requestTimeout=Math.min(timeoutMs,Math.max(1,config.deliberation.episodeTimeoutMs-(Date.now()-started)));
      const timer = setTimeout(() => controller.abort(new Error("narration timeout")), requestTimeout);
      const abortPoll=setInterval(()=>{if(this.repository.getGame(options.gameId)?.status==="aborted")controller.abort(new Error("game aborted"));},50);
      let receivedResult = false;
      let usageReceived = false;
      const onUsage = (usageValue: UsageV2, metadata: { provider: string; model: string; outputLimitEnforced: boolean }) => {
        if (usageReceived) return;
        usageReceived = true;
        attempt.usage = usageValue; attempt.provider = metadata.provider; attempt.model = metadata.model; attempt.outputLimitEnforced = metadata.outputLimitEnforced;
        attempt.status = "received"; attempt.endedAt = new Date().toISOString(); attempt.latencyMs = Date.now() - Date.parse(attempt.startedAt);
        this.store.atomic(() => {this.store.updateAttempt(attempt);log("decision.usage_received",{attemptId:attempt.id,usage:usageValue,latencyMs:attempt.latencyMs,outputLimitEnforced:attempt.outputLimitEnforced});});
      };
      try {
        const abortPromise = new Promise<never>((_resolve, reject) => {
          if (controller.signal.aborted) reject(controller.signal.reason);
          else controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        });
        const call = this.provider.decide<Narration>({ kind: "narration", model: options.model, playerId: "moderator", disclosurePacket: options.disclosurePacket, schemaName: "moderator_narration", schema: NarrationSchema, maxOutputTokens, reasoningEffort: options.reasoningEffort ?? "none", preparedPrompt: prompt, signal: controller.signal, timeoutMs, onUsage });
        const result = await Promise.race([call, abortPromise]);
        receivedResult = true;
        if (!usageReceived) onUsage(unknownUsage(), { provider: attempt.provider, model: attempt.model, outputLimitEnforced: options.provider !== "codex" });
        const report = NarrationSchema.parse(result.data);
        attempt.status = "valid"; attempt.endedAt = new Date().toISOString(); attempt.latencyMs = Date.now() - Date.parse(attempt.startedAt);
        checkpoint = { ...checkpoint, status: "pending", best: report.text, error: null };
        this.store.atomic(()=>{this.store.updateAttempt(attempt);this.store.put(options.gameId,keyOf(options.decisionId),checkpoint);log("decision.narration_reported",{attemptId:attempt.id,recovery:checkpoint!.recovery,report});});
        assertV2Budget(this.store,options.gameId,config,0,false);
        if (!active(this.repository, options.gameId)) throw new NarrationPausedError("narration report is pending after pause; no announcement committed");
        return report.text;
      } catch (error) {
        if (error instanceof NarrationPausedError || error instanceof V2BudgetError) throw error;
        if (!usageReceived) onUsage(unknownUsage(), { provider: attempt.provider, model: attempt.model, outputLimitEnforced: options.provider !== "codex" });
        attempt.status = controller.signal.aborted || !receivedResult || !usageReceived ? (receivedResult ? "invalid" : "unknown") : "invalid";
        attempt.error = errorText(error); attempt.endedAt = new Date().toISOString(); attempt.latencyMs = Date.now() - Date.parse(attempt.startedAt);
        this.store.updateAttempt(attempt);
        log("decision.attempt_failed",{attemptId:attempt.id,error:attempt.error,recovery:checkpoint.recovery});
        checkpoint = { ...checkpoint, error: attempt.error };
        if (!active(this.repository, options.gameId)) { checkpoint = { ...checkpoint, status: "paused" }; this.store.put(options.gameId, keyOf(options.decisionId), checkpoint); throw new NarrationPausedError("narration paused after failed attempt"); }
        if (repair || index === 1 || controller.signal.aborted) break;
        repair = true;
      } finally { clearTimeout(timer); clearInterval(abortPoll); options.signal?.removeEventListener("abort", abort); }
    }
    checkpoint = { ...checkpoint, status: "paused" };
    this.store.put(options.gameId, keyOf(options.decisionId), checkpoint);
    throw new NarrationPausedError("exhausted narration retries; no announcement fabricated");
  }
}

export const narrateV2 = (repository: LabRepository, provider: DecisionProvider, options: NarrationV2Options) => new NarrationV2(repository, provider).narrate(options);
