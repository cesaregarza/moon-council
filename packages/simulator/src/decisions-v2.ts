import { currentDecisionBrief } from "./player-brief";
import { journalTokens } from "./freeform-journal";
import {
  providerJsonSchema,
  type DecisionOpportunityV1,
  type DecisionReportV2,
  type GameConfigV2,
  CLAUDE_SESSION_PROTOCOL,
} from "@werewolf/contracts";
import { DecisionStore, LabRepository, type ProviderAttemptRecord } from "@werewolf/db";
import { type EngineEventInput } from "@werewolf/engine";
import { ClaudeSessions } from "./claude-session";
import {
  AskJevProvider,
  claudeReservationUsd,
  claudeUsageCostUsd,
  UnpricedModelError,
  type DecisionProvider,
} from "@werewolf/llm";
import { usesJournalWorkflow } from "./jev-actions";
import { journalCompactionRequest, materializeCompactedJournal } from "./journal-compaction";
import { prepareJevStage, usesJev } from "./jev-decision";
import type { ApiResponseFormat, DecisionRequest, PreparedPrompt } from "@werewolf/llm";
import type { z } from "zod";
import {
  canonicalizeReportReferences,
  citationAliasIds,
  decisionRequestV2,
  initialCommitOnly,
} from "./request-v2";
import {
  applyJournalV2,
  ContextLimitError,
  estimatedTokens,
  journalLimitMessage,
  validateReport,
} from "./context-v2";

export function preparedTokenEstimate(
  prepared: { tokens: number; jsonSchema: unknown; apiResponseFormat?: ApiResponseFormat },
  api = false,
): number {
  const format = api ? prepared.apiResponseFormat : undefined;
  return (
    prepared.tokens +
    (format
      ? estimatedTokens(providerJsonSchema(format.schema)) +
        estimatedTokens(format.instructions) -
        estimatedTokens(prepared.jsonSchema)
      : 0)
  );
}

export function validatePreparedReport(
  report: DecisionReportV2,
  packet: DecisionOpportunityV1["packet"],
  maxJournalTokens: number,
  optionalJournal: boolean,
) {
  const errors = validateReport(report, packet, maxJournalTokens);
  if (!errors.length || !optionalJournal)
    return { report, errors, annotationErrors: [] as string[] };
  const withoutJournal = { ...report, journalPatch: [] };
  const essentialErrors = validateReport(withoutJournal, packet, maxJournalTokens);
  return essentialErrors.length
    ? { report, errors, annotationErrors: [] as string[] }
    : { report: withoutJournal, errors: [] as string[], annotationErrors: errors };
}

export class DecisionPausedError extends Error {}
export class V2BudgetError extends Error {}
/** The game refused a Claude call at the reservation its exact request needs; nothing was sent. */
export class ClaudeSpendRefusedError extends V2BudgetError {
  override name = "ClaudeSpendRefusedError";
}
/** An unsettled Claude attempt with no admitted reservation: nothing bounds what it may cost. */
export class UnreservedClaudeAttemptError extends V2BudgetError {
  override name = "UnreservedClaudeAttemptError";
}
export function usageTotals(store: DecisionStore, gameId: string) {
  const attempts = store.attempts(gameId);
  return {
    calls: attempts.length,
    knownTokens: attempts.reduce((n, a) => n + (a.usage.totalTokens ?? 0), 0),
    unknownAttempts: attempts.filter((a) => a.usage.totalTokens === null).length,
    admissionTokens: attempts.reduce(
      (n, a) =>
        n + (a.usage.totalTokens ?? estimatedTokens(a.request) + (a.maxOutputTokens ?? 600)),
      0,
    ),
  };
}
/** Providers that take a stable API response format and the configured output cap. */
const usesApiResponseFormat = (provider: string) =>
  provider === "openai" || provider === "anthropic";

/** A model call about to be sent, reserved at its worst case before it is admitted. */
export interface NextCallReservation {
  provider: string;
  model: string;
  inputTokens: number;
  maxOutputTokens: number | null;
}
/** Claude output cap assumed when a recorded call set none (the provider's default cap). */
const CLAUDE_DEFAULT_OUTPUT_CAP = 16_000;

/** `estimatedTokens` is UTF-8 bytes / 3; a token is never shorter than a byte, so 3x bounds it. */
const promptCeilingTokens = (estimate: number) => 3 * estimate;

const validUsd = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The worst case admitted for the next call, stored on its attempt; undefined for non-Claude. */
export function claudeNextReservationUsd(next: NextCallReservation): number | undefined {
  if (next.provider !== "anthropic") return undefined;
  return claudeReservationUsd(
    next.model,
    promptCeilingTokens(next.inputTokens),
    next.maxOutputTokens ?? CLAUDE_DEFAULT_OUTPUT_CAP,
  );
}

/**
 * The provider's actual cost when validly recorded; else what the ledger holds for a call with
 * held attempts (`heldUsd`, every explicit retry included); else the cost from valid usage; else
 * the reservation admitted when the call began. A negative or non-finite cost, or invalid usage,
 * is never credit. With none of these, the attempt cannot be bounded and admission stops.
 */
function claudeAttemptUsd(attempt: ProviderAttemptRecord): number {
  const actual = attempt.providerMetadata?.costUsd;
  if (validUsd(actual)) return actual;
  const held = attempt.providerMetadata?.heldUsd;
  if (validUsd(held)) return held;
  const fromUsage = claudeUsageCostUsd(attempt.model, attempt.usage);
  if (fromUsage !== null) return fromUsage;
  if (validUsd(attempt.reservedUsd)) return attempt.reservedUsd;
  throw new UnreservedClaudeAttemptError(
    `spend admission refused: Claude attempt ${attempt.id} has unknown usage and no admitted reservation`,
  );
}

/** Settled Claude calls at actual cost; unsettled ones stay reserved at their worst case. */
function claudeSpendUsd(store: DecisionStore, gameId: string, next?: NextCallReservation): number {
  const settled = store
    .attempts(gameId)
    .filter((attempt) => attempt.provider === "anthropic")
    .reduce((sum, attempt) => sum + claudeAttemptUsd(attempt), 0);
  return settled + ((next && claudeNextReservationUsd(next)) ?? 0);
}

/** The game's Claude spend alone: settled calls plus every unsettled reservation, this one included. */
function assertClaudeSpendFits(store: DecisionStore, gameId: string, config: GameConfigV2) {
  if (config.maxSpendUsd === null) return;
  let spend: number;
  try {
    spend = claudeSpendUsd(store, gameId);
  } catch (error) {
    if (error instanceof UnpricedModelError)
      throw new ClaudeSpendRefusedError(`spend admission refused: ${error.message}`);
    throw error;
  }
  if (spend > config.maxSpendUsd)
    throw new ClaudeSpendRefusedError(
      `Claude spend admission limit reached at the request's exact reservation ($${spend.toFixed(4)} of $${config.maxSpendUsd})`,
    );
}

const NO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningTokens: 0,
};

/**
 * The game's half of a Claude call's admission, run by the provider with the reservation it
 * computed from the exact request (CES-1556). The attempt holds that figure from here on, so
 * each parallel sibling is checked against the others' true reservations.
 *
 * The provider calls this once per explicit attempt, each time with the call's running total, so
 * a refusal is not proof that nothing was sent (CES-1564). Rule R: a refusal never lowers what
 * the game holds for the call.
 * - Refused with nothing admitted yet: nothing was sent, so the attempt closes at zero and holds
 *   nothing.
 * - Refused after an admitted attempt: the hold stays at the last admitted figure, and the usage
 *   is left alone, because valid zero usage would price the attempt at $0 and erase that hold
 *   until the provider's own settlement (`heldUsd` or `costUsd`) replaces it.
 */
export function claudeSpendAdmission(
  store: DecisionStore,
  gameId: string,
  config: GameConfigV2,
  attempt: ProviderAttemptRecord,
): (usd: number) => void {
  /** The last figure this call admitted; null until a check passes, so nothing was sent. */
  let admittedUsd: number | null = null;
  return (usd) => {
    attempt.reservedUsd = usd;
    store.updateAttempt(attempt);
    try {
      assertClaudeSpendFits(store, gameId, config);
      admittedUsd = usd;
    } catch (error) {
      const refusal = error instanceof Error ? error.message : String(error);
      Object.assign(attempt, {
        reservedUsd: admittedUsd ?? 0,
        status: "invalid",
        error:
          admittedUsd === null
            ? `spend admission refused before sending: ${refusal}`
            : `spend admission refused for a later attempt, after $${admittedUsd.toFixed(4)} was sent: ${refusal}`,
        endedAt: new Date().toISOString(),
        ...(admittedUsd === null ? { usage: NO_USAGE } : {}),
      });
      store.updateAttempt(attempt);
      throw error;
    }
  };
}

export function assertV2Budget(
  store: DecisionStore,
  gameId: string,
  config: GameConfigV2,
  additionalActiveMs = 0,
  admitCall = true,
  next?: NextCallReservation,
): void {
  const usage = usageTotals(store, gameId);
  if (
    usage.calls > config.safety.maxModelCalls ||
    (admitCall && usage.calls >= config.safety.maxModelCalls)
  )
    throw new V2BudgetError("model-call admission limit reached");
  if (config.maxTotalTokens !== null && usage.admissionTokens >= config.maxTotalTokens)
    throw new V2BudgetError(
      "total-token admission threshold reached (unknown usage conservatively reserved; in-flight overshoot is possible)",
    );
  if (store.activeRuntimeMs(gameId) >= config.safety.maxWallClockMs)
    throw new V2BudgetError("active-runtime limit reached");
  if (config.maxSpendUsd !== null) {
    let spend: number;
    try {
      spend = claudeSpendUsd(store, gameId, next);
    } catch (error) {
      if (error instanceof UnpricedModelError)
        throw new V2BudgetError(`spend admission refused: ${error.message}`);
      throw error;
    }
    if (spend > config.maxSpendUsd || (!next && spend >= config.maxSpendUsd))
      throw new V2BudgetError(
        `Claude spend admission limit reached ($${spend.toFixed(4)} of $${config.maxSpendUsd}, unsettled calls reserved at their worst case)`,
      );
  }
}

export interface ExecuteDecisionOptions {
  opportunity: DecisionOpportunityV1;
  mandatoryRemaining: number;
  eventsForCommit: (report: DecisionReportV2, submission?: unknown) => EngineEventInput[];
  validateCurrent: () => boolean;
  /** Persist the final validated report but let a deterministic batch coordinator commit later. */
  deferCommit?: boolean;
  requestForAttempt?: (
    commitOnly: boolean,
    previous: DecisionReportV2 | null,
    repair: string | null,
  ) => {
    schema: z.ZodType;
    prompt: PreparedPrompt;
    jsonSchema: unknown;
    tokens: number;
    maxOutputTokens: number;
    promptVersion: string;
    schemaVersion: string;
    schemaName: string;
    apiResponseFormat?: ApiResponseFormat;
    providerKind?: "decision_v3" | "decision_v3_1" | "jev";
    normalize: (submission: unknown) => DecisionReportV2;
    validateSubmission?: (submission: unknown) => string[];
  };
  reasoningEffort?: string;
}
export class DecisionExecutorV2 {
  readonly store: DecisionStore;
  private readonly sessions: ClaudeSessions;
  constructor(
    private repository: LabRepository,
    private provider: DecisionProvider,
    private jevProvider: DecisionProvider = new AskJevProvider(),
  ) {
    this.store = new DecisionStore(repository);
    this.sessions = new ClaudeSessions(this.store);
  }
  /**
   * Claude session protocol (CES-1556): the seat's LLM calls (reflection, speech, closing) run
   * inside its day session. Jev calls and compactions keep their own one-off requests.
   */
  private claudeSessionFields(call: {
    op: DecisionOpportunityV1;
    config: GameConfigV2;
    provider: string;
    sessionEligible: boolean;
    model: string;
    /** The seat's configured effort; the session pins it when it opens. */
    effort: string;
    prompt: PreparedPrompt;
    apiResponseFormat: ApiResponseFormat | undefined;
    attempt: ProviderAttemptRecord;
  }): Partial<DecisionRequest<unknown>> {
    if (
      call.config.protocolVersion !== CLAUDE_SESSION_PROTOCOL ||
      call.provider !== "anthropic" ||
      !call.sessionEligible
    )
      return {};
    const turn = this.sessions.begin({
      gameId: call.op.gameId,
      playerId: call.op.playerId,
      packet: call.op.packet,
      model: call.model,
      effort: call.effort,
      kind: call.attempt.schemaVersion,
      instructions: call.prompt.instructions,
      formatInstructions: call.apiResponseFormat?.instructions ?? "",
      requestInput: call.prompt.input,
    });
    // Audits must see the effort that actually ran, not the one the call asked for.
    call.attempt.reasoningEffort = turn.effort;
    this.store.updateAttempt(call.attempt);
    return {
      claudeHarness: turn.harness,
      reasoningEffort: turn.effort,
      onClaudeReply: (reply) => {
        turn.commit(reply);
        call.attempt.providerMetadata = {
          ...call.attempt.providerMetadata,
          claudeSession: turn.metadata,
        };
        this.store.updateAttempt(call.attempt);
      },
    };
  }
  private active(gameId: string) {
    return ["running", "stepping"].includes(this.repository.getGame(gameId)?.status ?? "");
  }
  private log(op: DecisionOpportunityV1, type: string, payload: Record<string, unknown>) {
    this.repository.appendEvent(op.gameId, {
      type,
      phase: op.phase,
      day: op.day,
      visibility: "player",
      audienceIds: [op.playerId],
      payload: { playerId: op.playerId, decisionId: op.id, ...payload },
    });
  }
  async execute(options: ExecuteDecisionOptions): Promise<boolean> {
    let sessionKey: string | undefined;
    try {
      return await this.executeEpisode(options, (key) => {
        sessionKey = key;
      });
    } finally {
      if (sessionKey) await this.provider.releaseSession?.(sessionKey);
    }
  }
  private async executeEpisode(
    options: ExecuteDecisionOptions,
    setSessionKey: (key: string) => void,
  ): Promise<boolean> {
    let op =
      this.store.get<DecisionOpportunityV1>(
        options.opportunity.gameId,
        `decision:${options.opportunity.id}`,
      ) ?? options.opportunity;
    if (op.status === "committed") return true;
    if (op.status === "superseded") return false;
    const game = this.repository.getGame(op.gameId)!;
    if (game.config.schemaVersion !== "game_config_v2")
      throw new Error("V2 execution requires V2 config");
    const config = game.config;
    if (config.decisionEngine.workflow === "journal_v4" && usesJev(op, config)) {
      if (op.jevState?.semanticRejected) {
        throw new DecisionPausedError(
          "semantic review exhausted; acknowledge the recorded anomaly explicitly before resuming",
        );
      }
      if (!currentDecisionBrief(op.packet) || op.playerId !== op.packet.self.id) {
        op.status = "paused";
        this.store.save(op);
        throw new DecisionPausedError(
          "invalid actor brief in persisted decision; refusing direct execution",
        );
      }
    }
    const policy = config.deliberation;
    const start = Date.now();
    const prior = this.store.attempts(op.gameId, op.id);
    if (op.best && prior.some((a) => a.status === "valid") && op.status === "open")
      op.status = "pending";
    if (op.status === "paused" && this.active(op.gameId)) {
      op = { ...op, recovery: op.recovery + 1, status: "open" };
      this.log(op, "decision.recovery_started", {
        recovery: op.recovery,
        cumulativeAttempts: prior.length,
      });
    } else if (prior.some((a) => ["started", "received"].includes(a.status)) && !op.best) {
      op.status = "paused";
      this.store.save(op);
      throw new DecisionPausedError(
        "uncertain in-flight decision: explicit resume is required for a recorded recovery episode",
      );
    }
    this.store.save(op);
    let repairUsed = false;
    // An explicit recovery keeps the last validation failure instead of repeating a blind first call.
    let feedback: string | undefined =
      op.recovery > 0
        ? (prior.findLast((attempt) => attempt.status === "invalid")?.error ?? undefined)
        : undefined;
    if (feedback?.startsWith("journal_limit:"))
      feedback = journalLimitMessage(op.packet.journal, policy.maxJournalTokens);
    const maxAttempts =
      policy.mode === "single" ? Math.min(2, policy.maxCalls + 1) : policy.maxCalls;
    let optional = Boolean(op.jevState);
    const commit = () => {
      if (!op.best || !options.validateCurrent())
        throw new DecisionPausedError("stale proposal: relevant context or legal choices changed");
      const journal =
        op.journalCompaction?.result ??
        applyJournalV2(op.packet.journal, op.best, policy.maxJournalTokens);
      return this.store.commit(op, journal, options.eventsForCommit(op.best, op.bestSubmission));
    };
    // A validated pending result survives operator pause and process restart without another call.
    if (op.best && op.status === "pending") return options.deferCommit ? false : commit();
    const firstIndex = usesJev(op, config)
      ? prior.filter((attempt) => attempt.recovery === op.recovery).length
      : 0;
    for (let index = firstIndex; index < maxAttempts; index += 1) {
      if (!this.active(op.gameId)) return false;
      if (!options.validateCurrent()) throw new DecisionPausedError("stale decision view");
      if (Date.now() - start >= policy.episodeTimeoutMs) break;
      assertV2Budget(this.store, op.gameId, config, Date.now() - start);
      const finalCall = index === maxAttempts - 1;
      const allowance = op.phase.startsWith("night")
        ? policy.optionalNightCalls
        : policy.optionalDayCalls;
      const commitOnly =
        finalCall ||
        initialCommitOnly(op.packet, op.kind, policy.mode) ||
        (optional && this.optionalCallsUsed(op) + 1 >= allowance);
      const legacy = decisionRequestV2(
        op.packet,
        op.kind,
        policy.mode,
        commitOnly,
        op.best,
        feedback ?? null,
      );
      const compacting = op.journalCompaction && !op.journalCompaction.result;
      let basePrepared: ReturnType<NonNullable<ExecuteDecisionOptions["requestForAttempt"]>>;
      if (compacting) {
        const previousDraft = this.store
          .attempts(op.gameId, op.id)
          .findLast(
            (attempt) =>
              attempt.schemaVersion.startsWith("journal_compaction_v") &&
              attempt.status === "invalid",
          );
        basePrepared = journalCompactionRequest(
          op.journalCompaction!,
          policy.maxJournalTokens,
          config.safety.maxOutputTokens,
          feedback ?? null,
          previousDraft?.response,
        );
      } else if (options.requestForAttempt) {
        basePrepared = options.requestForAttempt(commitOnly, op.best, feedback ?? null);
      } else {
        basePrepared = {
          ...legacy,
          maxOutputTokens: config.safety.maxOutputTokens,
          promptVersion: "player_prompt_v2.2",
          schemaVersion: "private_decision_v2.stable",
          schemaName: "private_decision_v2",
          normalize: (submission) =>
            canonicalizeReportReferences(
              legacy.schema.parse(submission) as DecisionReportV2,
              op.packet,
            ),
        };
      }
      const hybrid = !compacting && usesJev(op, config);
      const stage = hybrid
        ? prepareJevStage(
            op,
            config,
            basePrepared,
            usesJournalWorkflow(config)
              ? false
              : this.allowJevReasoning(
                  op,
                  config,
                  maxAttempts - index,
                  options.mandatoryRemaining,
                  start,
                ),
          )
        : undefined;
      const prepared = stage?.prepared ?? basePrepared;
      const { schema, prompt, jsonSchema } = prepared;
      const settings = config.modelSettings[op.playerId]!;
      const apiResponseFormat =
        usesApiResponseFormat(settings.provider) &&
        stage?.provider !== "jev" &&
        "apiResponseFormat" in prepared
          ? prepared.apiResponseFormat
          : undefined;
      const tokens = preparedTokenEstimate({ ...prepared, apiResponseFormat }, true);
      if (tokens > policy.maxContextTokens) {
        if (op.best) {
          this.log(op, "decision.continuation_denied", { reason: "request_context_limit" });
          op.status = "pending";
          this.store.save(op);
          return options.deferCommit ? false : commit();
        }
        throw new ContextLimitError(
          "context_limit: exact application request including schema does not fit configured estimate",
        );
      }
      const sessionKey = `${op.gameId}:${op.id}:${op.recovery}`;
      setSessionKey(sessionKey);
      const reasoningEffort =
        compacting && settings.provider === "openai"
          ? "low"
          : stage?.provider === "jev"
            ? "none"
            : stage
              ? settings.reasoningEffort
              : (options.reasoningEffort ?? settings.reasoningEffort);
      const callModel = stage?.provider === "jev" ? config.decisionEngine.model : settings.model;
      const callProvider = stage?.provider === "jev" ? this.jevProvider : this.provider;
      // Unlimited-token games release the API cap for summaries and explicitly
      // truncated retries, including a retry recovered from the saved attempt log.
      const releaseOutputCap =
        stage?.provider !== "jev" &&
        settings.provider === "openai" &&
        config.maxTotalTokens === null &&
        (compacting || feedback?.startsWith("OpenAI response incomplete: max_output_tokens"));
      const maxOutputTokens = releaseOutputCap
        ? null
        : stage?.provider !== "jev" && usesApiResponseFormat(settings.provider)
          ? config.safety.maxOutputTokens
          : Math.min(config.safety.maxOutputTokens, prepared.maxOutputTokens);
      // A known-truncated gameplay retry can use the remaining decision episode;
      // otherwise a larger reasoning response can hit the initial request deadline.
      const timeoutMs = Math.min(
        releaseOutputCap && !compacting ? policy.episodeTimeoutMs : policy.requestTimeoutMs,
        policy.episodeTimeoutMs - (Date.now() - start),
      );
      const attemptProvider = stage?.provider === "jev" ? "jev" : settings.provider;
      const nextCall = {
        provider: attemptProvider,
        model: callModel,
        inputTokens: tokens,
        maxOutputTokens,
      };
      assertV2Budget(this.store, op.gameId, config, Date.now() - start, true, nextCall);
      const attempt = this.store.beginAttempt(op, {
        reservedUsd: claudeNextReservationUsd(nextCall),
        maxOutputTokens,
        timeoutMs,
        model: callModel,
        provider: attemptProvider,
        reasoningEffort,
        optional,
        request: { ...prompt, schema: jsonSchema },
        promptVersion: prepared.promptVersion,
        schemaVersion: prepared.schemaVersion,
      });
      const controller = new AbortController();
      const abortPoll = setInterval(() => {
        if (this.repository.getGame(op.gameId)?.status === "aborted")
          controller.abort(new Error("game aborted"));
      }, 50);
      const timer = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
      const recordUsage = (
        usage: typeof attempt.usage,
        metadata: { provider: string; model: string; outputLimitEnforced: boolean },
      ) => {
        attempt.usage = usage;
        attempt.provider = metadata.provider;
        attempt.model = metadata.model;
        attempt.outputLimitEnforced = metadata.outputLimitEnforced;
        if (attempt.status === "started") attempt.status = "received";
        attempt.endedAt = new Date().toISOString();
        attempt.latencyMs = Date.now() - Date.parse(attempt.startedAt);
        this.store.atomic(() => {
          this.store.updateAttempt(attempt);
          this.log(op, "decision.usage_received", {
            attemptId: attempt.id,
            usage,
            latencyMs: attempt.latencyMs,
            outputLimitEnforced: attempt.outputLimitEnforced,
          });
        });
      };
      const recordResponse = (response: string) => {
        attempt.response = response;
        this.store.updateAttempt(attempt);
      };
      try {
        const providerKind =
          "providerKind" in prepared && prepared.providerKind
            ? prepared.providerKind
            : "decision_v3";
        const call = callProvider.decide({
          gameId: op.gameId,
          kind: options.requestForAttempt ? providerKind : "decision_v2",
          playerId: op.playerId,
          model: callModel,
          reasoningEffort,
          apiResponseFormat,
          contextV2: op.packet,
          proposalKind: op.kind,
          commitOnly,
          sessionKey,
          preparedPrompt: prompt,
          schemaName: prepared.schemaName,
          schema,
          maxOutputTokens,
          signal: controller.signal,
          timeoutMs,
          onUsage: recordUsage,
          onRawResponse: recordResponse,
          onProviderRequest: (body) => {
            attempt.wireRequest = body;
            this.store.updateAttempt(attempt);
          },
          onProviderMetadata: (metadata) => {
            attempt.providerMetadata = { ...attempt.providerMetadata, ...metadata };
            this.store.updateAttempt(attempt);
          },
          admitSpend: claudeSpendAdmission(this.store, op.gameId, config, attempt),
          ...this.claudeSessionFields({
            op,
            config,
            provider: attemptProvider,
            sessionEligible: !compacting,
            model: callModel,
            effort: settings.reasoningEffort,
            prompt,
            apiResponseFormat,
            attempt,
          }),
        });
        const result = await Promise.race([
          call,
          new Promise<never>((_resolve, reject) => {
            if (controller.signal.aborted) reject(controller.signal.reason);
            else
              controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
                once: true,
              });
          }),
        ]);
        const rawSubmission = schema.parse(result.data);
        const submission = stage ? stage.toSubmission(rawSubmission) : rawSubmission;
        const submissionErrors =
          "validateSubmission" in basePrepared
            ? (basePrepared.validateSubmission?.(submission) ?? [])
            : [];
        if (submissionErrors.length) {
          this.log(op, "decision.submission_rejected", {
            submission,
            errors: submissionErrors,
            attemptId: attempt.id,
          });
          throw new Error(submissionErrors.join("; "));
        }
        let report = basePrepared.normalize(submission);
        const validation = validatePreparedReport(
          report,
          op.packet,
          policy.maxJournalTokens,
          Boolean(options.requestForAttempt) && op.taskType !== "journal_update",
        );
        report = validation.report;
        const errors = validation.errors;
        if (validation.annotationErrors.length)
          this.log(op, "decision.annotation_rejected", {
            attemptId: attempt.id,
            taskType: op.taskType,
            errors: validation.annotationErrors,
          });
        if (
          !compacting &&
          op.taskType === "journal_update" &&
          errors.length > 0 &&
          errors.every((error) => error.startsWith("journal_limit:"))
        ) {
          const candidate = applyJournalV2(op.packet.journal, report, Infinity);
          op.journalCompaction = {
            candidate,
            sourceReport: report,
            sourceSubmission: submission,
            sourceAttemptId: attempt.id,
          };
          op.status = "open";
          attempt.status = "valid";
          this.store.atomic(() => {
            const current = this.store.get<DecisionOpportunityV1>(op.gameId, `decision:${op.id}`);
            if (current?.recovery !== op.recovery || current.status === "committed")
              throw new DecisionPausedError("execution episode superseded");
            this.store.updateAttempt(attempt);
            this.store.save(op);
            this.log(op, "decision.journal_compaction_requested", {
              attemptId: attempt.id,
              beforeTokens: journalTokens(candidate),
              maximumTokens: policy.maxJournalTokens,
            });
          });
          feedback = undefined;
          optional = false;
          repairUsed = false;
          continue;
        }
        if (errors.length) {
          const repairErrors = errors.includes("citations must reference delivered source IDs")
            ? [...errors, `allowed citation aliases: ${citationAliasIds(op.packet).join(", ")}`]
            : errors;
          this.log(op, "decision.report_rejected", {
            report,
            errors: repairErrors,
            attemptId: attempt.id,
          });
          throw new Error(repairErrors.join("; "));
        }
        const assessment = stage?.assess?.(rawSubmission);
        if (assessment?.issues.length) {
          const exhausted = Boolean(op.jevState?.semanticIssues);
          const next: DecisionOpportunityV1 = {
            ...op,
            status: exhausted ? "paused" : "open",
            jevState: {
              stage: "decide",
              evaluation: op.jevState?.evaluation ?? rawSubmission,
              semanticIssues: assessment.issues,
              semanticRejected: exhausted,
              ...(exhausted
                ? {
                    semanticFinal: { attemptId: attempt.id, report, submission },
                  }
                : {}),
            },
          };
          attempt.status = "valid";
          this.store.atomic(() => {
            const current = this.store.get<DecisionOpportunityV1>(op.gameId, `decision:${op.id}`);
            if (current?.recovery !== op.recovery || current?.status === "committed") {
              throw new DecisionPausedError("execution episode superseded");
            }
            this.store.updateAttempt(attempt);
            this.store.save(next);
            this.log(next, "decision.semantic_assessed", {
              attemptId: attempt.id,
              ...assessment,
              transportValid: true,
            });
            this.log(next, "decision.jev_stage", {
              attemptId: attempt.id,
              stage: "decide",
              checkpoint: next.jevState,
            });
          });
          op = next;
          if (exhausted) {
            throw new DecisionPausedError(
              "semantic contradiction persisted after one reconsideration; acknowledge the recorded anomaly to commit it",
            );
          }
          optional = true;
          feedback = undefined;
          continue;
        }
        const checkpoint = stage?.checkpoint(rawSubmission);
        if (checkpoint) {
          // A gate or advisory LLM response is not an executable fallback action.
          op.jevState = checkpoint;
          op.status = "open";
          attempt.status = "valid";
          this.store.atomic(() => {
            const current = this.store.get<DecisionOpportunityV1>(op.gameId, `decision:${op.id}`);
            if (current?.recovery !== op.recovery || current?.status === "committed")
              throw new DecisionPausedError("execution episode superseded");
            this.store.updateAttempt(attempt);
            this.store.save(op);
            this.log(op, "decision.jev_stage", {
              attemptId: attempt.id,
              stage: checkpoint.stage,
              checkpoint,
            });
          });
          assertV2Budget(this.store, op.gameId, config, Date.now() - start, false);
          if (!this.active(op.gameId)) return false;
          optional = true;
          feedback = undefined;
          continue;
        }
        if (compacting) {
          op.journalCompaction = {
            ...op.journalCompaction!,
            result: materializeCompactedJournal(op.journalCompaction!, submission),
            attemptId: attempt.id,
          };
          // The journal changed outside the session: the seat's next call opens a new one.
          this.sessions.close(op.gameId, op.playerId);
        }
        op.best = report;
        op.bestSubmission = compacting
          ? op.journalCompaction!.sourceSubmission
          : options.requestForAttempt
            ? structuredClone(submission)
            : undefined;
        const verdict = this.continuationVerdict(
          op,
          config,
          index,
          maxAttempts,
          options.mandatoryRemaining,
          start,
        );
        op.status = verdict === "granted" ? "open" : "pending";
        attempt.status = "valid";
        this.store.atomic(() => {
          const current = this.store.get<DecisionOpportunityV1>(op.gameId, `decision:${op.id}`);
          if (current?.recovery !== op.recovery || current?.status === "committed")
            throw new DecisionPausedError("execution episode superseded");
          this.store.updateAttempt(attempt);
          this.store.save(op);
          if (assessment?.applicable) {
            this.log(op, "decision.semantic_assessed", {
              attemptId: attempt.id,
              ...assessment,
              transportValid: true,
            });
          }
          this.log(op, "decision.reported", {
            report,
            submission: op.bestSubmission,
            taskType: op.taskType,
            recovery: op.recovery,
            turnIndex: index,
            viewId: op.viewId,
            continuation: verdict,
            attemptId: attempt.id,
          });
        });
        assertV2Budget(this.store, op.gameId, config, Date.now() - start, false);
        if (!this.active(op.gameId)) {
          op.status = "pending";
          this.store.save(op);
          return false;
        }
        if (verdict !== "granted") return options.deferCommit ? false : commit();
        optional = true;
        feedback = undefined;
      } catch (error) {
        if (
          error instanceof V2BudgetError ||
          error instanceof ContextLimitError ||
          error instanceof DecisionPausedError
        )
          throw error;
        attempt.status = controller.signal.aborted ? "unknown" : "invalid";
        attempt.error =
          error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
        attempt.endedAt = new Date().toISOString();
        attempt.latencyMs = Date.now() - Date.parse(attempt.startedAt);
        this.store.updateAttempt(attempt);
        this.log(op, "decision.attempt_failed", {
          attemptId: attempt.id,
          error: attempt.error,
          recovery: op.recovery,
        });
        if (!this.active(op.gameId)) {
          op.status = op.best ? "pending" : "paused";
          this.store.save(op);
          return false;
        }
        if (repairUsed || finalCall || controller.signal.aborted) break;
        repairUsed = true;
        feedback = attempt.error.slice(0, 800);
      } finally {
        clearInterval(abortPoll);
        clearTimeout(timer);
      }
    }
    if (op.best && options.validateCurrent()) {
      op.status = "pending";
      this.store.save(op);
      return options.deferCommit ? false : commit();
    }
    op.status = "paused";
    this.store.save(op);
    if (op.jevState?.semanticIssues && !op.jevState.semanticRejected) {
      throw new DecisionPausedError(
        "semantic reconsideration is pending; episode call budget exhausted; resume to complete the recorded review",
      );
    }
    throw new DecisionPausedError(
      "exhausted decision retries without a valid proposal; no action fabricated",
    );
  }
  private allowJevReasoning(
    op: DecisionOpportunityV1,
    config: GameConfigV2,
    remaining: number,
    mandatory: number,
    start: number,
  ): boolean {
    if (config.deliberation.mode !== "gated" || remaining < 3) return false;
    const allowance = op.phase.startsWith("night")
      ? config.deliberation.optionalNightCalls
      : config.deliberation.optionalDayCalls;
    if (this.optionalCallsUsed(op) + 2 > allowance) return false;
    const usage = usageTotals(this.store, op.gameId);
    const reservedCalls = mandatory + 3;
    return (
      usage.calls + reservedCalls <= config.safety.maxModelCalls &&
      (config.maxTotalTokens === null ||
        usage.admissionTokens +
          reservedCalls * (estimatedTokens(op.packet) + config.safety.maxOutputTokens) <
          config.maxTotalTokens) &&
      Date.now() - start + 2_000 < config.deliberation.episodeTimeoutMs
    );
  }
  private continuationVerdict(
    op: DecisionOpportunityV1,
    config: GameConfigV2,
    index: number,
    max: number,
    mandatory: number,
    start: number,
  ): string {
    const report = op.best!;
    if (report.control.kind === "commit") return "committed_by_player";
    if (config.deliberation.mode === "single" || index >= max - 1) return "commit_only";
    if (
      !report.control.question?.trim() ||
      !report.control.reason ||
      report.alternatives.length < 2
    )
      return "denied_unspecific_comparison";
    const words = new Set(report.control.question.toLowerCase().split(/[^a-z0-9_-]+/));
    if (
      report.alternatives.filter((alternative) => words.has(alternative.id.toLowerCase())).length <
      2
    )
      return "denied_missing_comparison_ids";
    const informative = op.packet.sources.some((s) =>
      ["speech.public", "inspection.delivered", "team.point", "vote.resolved"].includes(s.type),
    );
    if (["night_action", "team_point", "vote"].includes(op.kind) && !informative)
      return "denied_informationless";
    if (
      op.kind === "discussion" &&
      !op.packet.responseDocket.length &&
      report.control.reason !== "resolve_conflict"
    )
      return "denied_routine";
    const night = op.phase.startsWith("night");
    const optionalUsed = this.optionalCallsUsed(op);
    if (
      optionalUsed >=
      (night ? config.deliberation.optionalNightCalls : config.deliberation.optionalDayCalls)
    )
      return "denied_daily_allowance";
    const usage = usageTotals(this.store, op.gameId);
    if (
      usage.calls + mandatory + 1 >= config.safety.maxModelCalls ||
      (config.maxTotalTokens !== null &&
        usage.admissionTokens +
          (mandatory + 1) * (estimatedTokens(op.packet) + config.safety.maxOutputTokens) >=
          config.maxTotalTokens)
    )
      return "denied_mandatory_reserve";
    if (Date.now() - start + 1_000 >= config.deliberation.episodeTimeoutMs)
      return "denied_deadline";
    return "granted";
  }
  private optionalCallsUsed(op: DecisionOpportunityV1): number {
    return this.store.attempts(op.gameId).filter((attempt) => {
      if (attempt.playerId !== op.playerId || !attempt.optional) return false;
      const decision = this.store.get<DecisionOpportunityV1>(
        op.gameId,
        `decision:${attempt.decisionId}`,
      );
      return (
        decision?.day === op.day &&
        decision.phase.startsWith("night") === op.phase.startsWith("night")
      );
    }).length;
  }
}
