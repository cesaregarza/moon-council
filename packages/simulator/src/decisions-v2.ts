import { type DecisionOpportunityV1, type DecisionReportV2, type GameConfigV2 } from "@werewolf/contracts";
import { DecisionStore, LabRepository } from "@werewolf/db";
import { type EngineEventInput } from "@werewolf/engine";
import type { DecisionProvider } from "@werewolf/llm";
import type { PreparedPrompt } from "@werewolf/llm";
import type { z } from "zod";
import { canonicalizeReportReferences, citationAliasIds, decisionRequestV2, initialCommitOnly } from "./request-v2";
import { applyJournalV2, ContextLimitError, estimatedTokens, validateReport } from "./context-v2";

export function validatePreparedReport(report:DecisionReportV2,packet:DecisionOpportunityV1["packet"],maxJournalTokens:number,optionalJournal:boolean) {
  const errors=validateReport(report,packet,maxJournalTokens);
  if(!errors.length||!optionalJournal)return {report,errors,annotationErrors:[] as string[]};
  const withoutJournal={...report,journalPatch:[]};
  const essentialErrors=validateReport(withoutJournal,packet,maxJournalTokens);
  return essentialErrors.length?{report,errors,annotationErrors:[] as string[]}:{report:withoutJournal,errors:[] as string[],annotationErrors:errors};
}

export class DecisionPausedError extends Error {}
export class V2BudgetError extends Error {}
export function usageTotals(store: DecisionStore, gameId: string) {
  const attempts = store.attempts(gameId);
  return { calls: attempts.length, knownTokens: attempts.reduce((n,a) => n + (a.usage.totalTokens ?? 0), 0), unknownAttempts: attempts.filter(a => a.usage.totalTokens === null).length,
    admissionTokens: attempts.reduce((n,a) => n + (a.usage.totalTokens ?? estimatedTokens(a.request) + 600), 0) };
}
export function assertV2Budget(store: DecisionStore, gameId: string, config: GameConfigV2, additionalActiveMs = 0, admitCall = true): void {
  const usage = usageTotals(store, gameId);
  if (usage.calls > config.safety.maxModelCalls || (admitCall && usage.calls >= config.safety.maxModelCalls)) throw new V2BudgetError("model-call admission limit reached");
  if (usage.admissionTokens >= config.maxTotalTokens) throw new V2BudgetError("total-token admission threshold reached (unknown usage conservatively reserved; in-flight overshoot is possible)");
  if (store.activeRuntimeMs(gameId) >= config.safety.maxWallClockMs) throw new V2BudgetError("active-runtime limit reached");
}

export interface ExecuteDecisionOptions {
  opportunity: DecisionOpportunityV1;
  mandatoryRemaining: number;
  eventsForCommit: (report: DecisionReportV2, submission?: unknown) => EngineEventInput[];
  validateCurrent: () => boolean;
  /** Persist the final validated report but let a deterministic batch coordinator commit later. */
  deferCommit?: boolean;
  requestForAttempt?: (commitOnly:boolean, previous:DecisionReportV2|null, repair:string|null) => {
    schema:z.ZodType; prompt:PreparedPrompt; jsonSchema:unknown; tokens:number; maxOutputTokens:number;
    promptVersion:string; schemaVersion:string; schemaName:string;
    providerKind?: "decision_v3" | "decision_v3_1";
    normalize:(submission:unknown)=>DecisionReportV2; validateSubmission?:(submission:unknown)=>string[];
  };
  reasoningEffort?: string;
}
export class DecisionExecutorV2 {
  readonly store: DecisionStore;
  constructor(private repository: LabRepository, private provider: DecisionProvider) { this.store = new DecisionStore(repository); }
  private active(gameId: string) { return ["running", "stepping"].includes(this.repository.getGame(gameId)?.status ?? ""); }
  private log(op: DecisionOpportunityV1, type: string, payload: Record<string, unknown>) {
    this.repository.appendEvent(op.gameId, { type, phase: op.phase, day: op.day, visibility: "player", audienceIds: [op.playerId], payload: { playerId: op.playerId, decisionId: op.id, ...payload } });
  }
  async execute(options: ExecuteDecisionOptions): Promise<boolean> {
    let sessionKey: string | undefined;
    try {
      return await this.executeEpisode(options,key=>{sessionKey=key;});
    } finally {
      if(sessionKey) await this.provider.releaseSession?.(sessionKey);
    }
  }
  private async executeEpisode(options: ExecuteDecisionOptions, setSessionKey:(key:string)=>void): Promise<boolean> {
    let op = this.store.get<DecisionOpportunityV1>(options.opportunity.gameId, `decision:${options.opportunity.id}`) ?? options.opportunity;
    if (op.status === "committed") return true;
    if (op.status === "superseded") return false;
    const game = this.repository.getGame(op.gameId)!;
    if (game.config.schemaVersion !== "game_config_v2") throw new Error("V2 execution requires V2 config");
    const config = game.config;
    const policy = config.deliberation;
    const start = Date.now();
    const prior = this.store.attempts(op.gameId, op.id);
    if (op.best && prior.some(a => a.status === "valid") && op.status === "open") op.status = "pending";
    if (op.status === "paused" && this.active(op.gameId)) {
      op = { ...op, recovery: op.recovery + 1, status: "open" };
      this.log(op, "decision.recovery_started", { recovery: op.recovery, cumulativeAttempts: prior.length });
    } else if (prior.some(a => ["started", "received"].includes(a.status)) && !op.best) {
      op.status = "paused"; this.store.save(op);
      throw new DecisionPausedError("uncertain in-flight decision: explicit resume is required for a recorded recovery episode");
    }
    this.store.save(op);
    let repairUsed = false;
    let feedback: string | undefined;
    const maxAttempts = policy.mode === "single" ? Math.min(2, policy.maxCalls + 1) : policy.maxCalls;
    let optional = false;
    const commit = () => {
      if (!op.best || !options.validateCurrent()) throw new DecisionPausedError("stale proposal: relevant context or legal choices changed");
      const journal = applyJournalV2(op.packet.journal, op.best, policy.maxJournalTokens);
      return this.store.commit(op, journal, options.eventsForCommit(op.best,op.bestSubmission));
    };
    // A validated pending result survives operator pause and process restart without another call.
    if (op.best && op.status === "pending") return options.deferCommit ? false : commit();
    for (let index = 0; index < maxAttempts; index += 1) {
      if (!this.active(op.gameId)) return false;
      if (!options.validateCurrent()) throw new DecisionPausedError("stale decision view");
      if (Date.now() - start >= policy.episodeTimeoutMs) break;
      assertV2Budget(this.store, op.gameId, config, Date.now() - start);
      const finalCall = index === maxAttempts - 1;
      const allowance=op.phase.startsWith("night") ? policy.optionalNightCalls : policy.optionalDayCalls;
      const commitOnly=finalCall || initialCommitOnly(op.packet,op.kind,policy.mode) || optional && this.optionalCallsUsed(op)+1>=allowance;
      const legacy=decisionRequestV2(op.packet,op.kind,policy.mode,commitOnly,op.best,feedback ?? null);
      const prepared=options.requestForAttempt?.(commitOnly,op.best,feedback??null)??{...legacy,maxOutputTokens:config.safety.maxOutputTokens,promptVersion:"player_prompt_v2.2",schemaVersion:"private_decision_v2.stable",schemaName:"private_decision_v2",normalize:(submission:unknown)=>canonicalizeReportReferences(legacy.schema.parse(submission) as DecisionReportV2,op.packet)};
      const {schema,prompt,jsonSchema,tokens}=prepared;
      if (tokens > policy.maxContextTokens) {
        if(op.best){this.log(op,"decision.continuation_denied",{reason:"request_context_limit"});op.status="pending";this.store.save(op);return options.deferCommit?false:commit();}
        throw new ContextLimitError("context_limit: exact application request including schema does not fit configured estimate");
      }
      const settings = config.modelSettings[op.playerId]!;
      const sessionKey=`${op.gameId}:${op.id}:${op.recovery}`;
      setSessionKey(sessionKey);
      const reasoningEffort=options.reasoningEffort??settings.reasoningEffort;
      const attempt = this.store.beginAttempt(op, { model: settings.model, provider: settings.provider, reasoningEffort, optional, request: { ...prompt, schema: jsonSchema },promptVersion:prepared.promptVersion,schemaVersion:prepared.schemaVersion });
      const controller = new AbortController();
      const abortPoll = setInterval(() => { if (this.repository.getGame(op.gameId)?.status === "aborted") controller.abort(new Error("game aborted")); }, 50);
      const timeoutMs = Math.min(policy.requestTimeoutMs, policy.episodeTimeoutMs - (Date.now() - start));
      const timer = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
      const recordUsage = (usage: typeof attempt.usage, metadata: { provider: string; model: string; outputLimitEnforced: boolean }) => {
        attempt.usage = usage; attempt.provider = metadata.provider; attempt.model = metadata.model; attempt.outputLimitEnforced = metadata.outputLimitEnforced;
        if (attempt.status === "started") attempt.status = "received";
        attempt.endedAt = new Date().toISOString(); attempt.latencyMs = Date.now() - Date.parse(attempt.startedAt);
        this.store.atomic(() => { this.store.updateAttempt(attempt); this.log(op,"decision.usage_received",{attemptId:attempt.id,usage,latencyMs:attempt.latencyMs,outputLimitEnforced:attempt.outputLimitEnforced}); });
      };
      const recordResponse=(response:string)=>{attempt.response=response;this.store.updateAttempt(attempt);};
      try {
        const providerKind="providerKind" in prepared&&prepared.providerKind?prepared.providerKind:"decision_v3";
        const call = this.provider.decide({ kind: options.requestForAttempt?providerKind:"decision_v2", playerId: op.playerId, model: settings.model, reasoningEffort,
          contextV2: op.packet, proposalKind: op.kind, commitOnly, sessionKey, preparedPrompt: prompt, schemaName: prepared.schemaName, schema,
          maxOutputTokens: Math.min(config.safety.maxOutputTokens,prepared.maxOutputTokens), signal: controller.signal, timeoutMs, onUsage: recordUsage,onRawResponse:recordResponse });
        const result = await Promise.race([call, new Promise<never>((_resolve,reject) => { if(controller.signal.aborted) reject(controller.signal.reason); else controller.signal.addEventListener("abort",()=>reject(controller.signal.reason),{once:true}); })]);
        const submission=schema.parse(result.data);
        const submissionErrors="validateSubmission" in prepared?prepared.validateSubmission?.(submission)??[]:[];
        if(submissionErrors.length){this.log(op,"decision.submission_rejected",{submission,errors:submissionErrors,attemptId:attempt.id});throw new Error(submissionErrors.join("; "));}
        let report = prepared.normalize(submission);
        const validation=validatePreparedReport(report,op.packet,policy.maxJournalTokens,Boolean(options.requestForAttempt));
        report=validation.report;
        const errors=validation.errors;
        if(validation.annotationErrors.length)this.log(op,"decision.annotation_rejected",{attemptId:attempt.id,taskType:op.taskType,errors:validation.annotationErrors});
        if (errors.length) {
          const repairErrors=errors.includes("citations must reference delivered source IDs")?[...errors,`allowed citation aliases: ${citationAliasIds(op.packet).join(", ")}`]:errors;
          this.log(op,"decision.report_rejected",{report,errors:repairErrors,attemptId:attempt.id});throw new Error(repairErrors.join("; "));
        }
        op.best = report;
        op.bestSubmission=options.requestForAttempt?structuredClone(submission):undefined;
        const verdict = this.continuationVerdict(op, config, index, maxAttempts, options.mandatoryRemaining, start);
        op.status = verdict === "granted" ? "open" : "pending";
        attempt.status = "valid";
        this.store.atomic(() => {
          const current=this.store.get<DecisionOpportunityV1>(op.gameId,`decision:${op.id}`);
          if(current?.recovery !== op.recovery || current?.status === "committed") throw new DecisionPausedError("execution episode superseded");
          this.store.updateAttempt(attempt); this.store.save(op);
          this.log(op, "decision.reported", { report,submission:op.bestSubmission,taskType:op.taskType,recovery: op.recovery, turnIndex: index, viewId: op.viewId, continuation: verdict, attemptId: attempt.id });
        });
        assertV2Budget(this.store, op.gameId, config, Date.now() - start, false);
        if (!this.active(op.gameId)) { op.status = "pending"; this.store.save(op); return false; }
        if (verdict !== "granted") return options.deferCommit ? false : commit();
        optional = true; feedback = undefined;
      } catch (error) {
        if (error instanceof V2BudgetError || error instanceof ContextLimitError || error instanceof DecisionPausedError) throw error;
        attempt.status = controller.signal.aborted ? "unknown" : "invalid"; attempt.error = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
        attempt.endedAt = new Date().toISOString(); attempt.latencyMs = Date.now() - Date.parse(attempt.startedAt);
        this.store.updateAttempt(attempt);
        this.log(op, "decision.attempt_failed", { attemptId: attempt.id, error: attempt.error, recovery: op.recovery });
        if (!this.active(op.gameId)) { op.status = op.best ? "pending" : "paused"; this.store.save(op); return false; }
        if (repairUsed || finalCall || controller.signal.aborted) break;
        repairUsed = true; feedback = attempt.error.slice(0,800);
      } finally { clearInterval(abortPoll); clearTimeout(timer); }
    }
    if (op.best && options.validateCurrent()) { op.status = "pending"; this.store.save(op); return options.deferCommit ? false : commit(); }
    op.status = "paused"; this.store.save(op);
    throw new DecisionPausedError("exhausted decision retries without a valid proposal; no action fabricated");
  }
  private continuationVerdict(op: DecisionOpportunityV1, config: GameConfigV2, index: number, max: number, mandatory: number, start: number): string {
    const report = op.best!;
    if (report.control.kind === "commit") return "committed_by_player";
    if (config.deliberation.mode === "single" || index >= max - 1) return "commit_only";
    if (!report.control.question?.trim() || !report.control.reason || report.alternatives.length < 2) return "denied_unspecific_comparison";
    const words=new Set(report.control.question.toLowerCase().split(/[^a-z0-9_-]+/));
    if(report.alternatives.filter(alternative=>words.has(alternative.id.toLowerCase())).length<2) return "denied_missing_comparison_ids";
    const informative = op.packet.sources.some(s => ["speech.public", "inspection.delivered", "team.point", "vote.resolved"].includes(s.type));
    if (["night_action","team_point","vote"].includes(op.kind) && !informative) return "denied_informationless";
    if (op.kind === "discussion" && !op.packet.responseDocket.length && report.control.reason !== "resolve_conflict") return "denied_routine";
    const night = op.phase.startsWith("night");
    const optionalUsed = this.optionalCallsUsed(op);
    if (optionalUsed >= (night ? config.deliberation.optionalNightCalls : config.deliberation.optionalDayCalls)) return "denied_daily_allowance";
    const usage = usageTotals(this.store, op.gameId);
    if (usage.calls + mandatory + 1 >= config.safety.maxModelCalls || usage.admissionTokens + (mandatory + 1) * (estimatedTokens(op.packet) + config.safety.maxOutputTokens) >= config.maxTotalTokens) return "denied_mandatory_reserve";
    if (Date.now() - start + 1_000 >= config.deliberation.episodeTimeoutMs) return "denied_deadline";
    return "granted";
  }
  private optionalCallsUsed(op:DecisionOpportunityV1):number {
    return this.store.attempts(op.gameId).filter(attempt=>{
      if(attempt.playerId!==op.playerId || !attempt.optional) return false;
      const decision=this.store.get<DecisionOpportunityV1>(op.gameId,`decision:${attempt.decisionId}`);
      return decision?.day===op.day && decision.phase.startsWith("night")===op.phase.startsWith("night");
    }).length;
  }
}
