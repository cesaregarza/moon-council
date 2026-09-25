import type { DecisionReportV2 } from "@werewolf/contracts";
import { DecisionStore, type LabRepository } from "@werewolf/db";
import { reduceGame } from "@werewolf/engine";
import { contentHash, estimatedTokens, validateReport } from "./context-v2";
import { responseDockets } from "./scheduler-v2";
import { validateJournalCompaction } from "./journal-compaction";

/** Team-point coordination metadata is public within the pack; free-form reasoning is not. */
export function validTeamPointFields(payload: Record<string, unknown>): boolean {
  return (
    Object.keys(payload).every((key) => ["playerId", "targetId", "round", "blind"].includes(key)) &&
    (payload.round === undefined ||
      (typeof payload.round === "number" &&
        Number.isInteger(payload.round) &&
        payload.round >= 0)) &&
    (payload.blind === undefined || typeof payload.blind === "boolean")
  );
}

/** Inspect explicit application artifacts only; no provider reasoning traces. */
export function auditGameV2(repository: LabRepository, id: string) {
  const game = repository.getGame(id);
  if (!game) throw new Error(`Unknown game ${id}`);
  if (game.config.schemaVersion !== "game_config_v2") throw new Error("V2 game required");
  const events = repository.listEvents(id),
    state = reduceGame(id, events),
    store = new DecisionStore(repository);
  const opportunities = store.opportunities(id),
    attempts = store.attempts(id),
    issues: string[] = [];
  for (const op of opportunities) {
    if (op.journalCompaction?.result)
      for (const error of validateJournalCompaction(
        op.journalCompaction.candidate,
        op.journalCompaction.result,
        game.config.deliberation.maxJournalTokens,
      ))
        issues.push(`${op.id}: ${error}`);
    if (contentHash(op.packet) !== op.viewId) issues.push(`${op.id}: context hash mismatch`);
    if (
      events.filter((e) => e.type === "decision.committed" && e.payload.decisionId === op.id)
        .length > 1
    )
      issues.push(`${op.id}: duplicate commitment`);
    for (const turn of events.filter(
      (e) => e.type === "decision.reported" && e.payload.decisionId === op.id,
    )) {
      const invalid = validateReport(
        turn.payload.report as DecisionReportV2,
        op.packet,
        game.config.deliberation.maxJournalTokens,
      );
      if (invalid.length) issues.push(`${op.id}: ${invalid.join("; ")}`);
    }
    const episodes = new Set(attempts.filter((a) => a.decisionId === op.id).map((a) => a.recovery));
    for (const recovery of episodes)
      if (
        attempts.filter((a) => a.decisionId === op.id && a.recovery === recovery).length >
        (game.config.deliberation.mode === "single" ? 2 : game.config.deliberation.maxCalls)
      )
        issues.push(`${op.id}: episode attempt cap exceeded`);
  }
  for (const event of events.filter((e) => e.type === "team.point"))
    if (!validTeamPointFields(event.payload))
      issues.push(`team point ${event.id}: unexpected shared field`);
  for (const ballot of events.filter((e) => e.type === "vote.cast"))
    if (ballot.visibility !== "player" && ballot.visibility !== "moderator")
      issues.push(`ballot ${ballot.id} was unsealed`);
  const ending = events.findLast((e) =>
    ["game.ended", "game.budget_exhausted", "game.aborted"].includes(e.type),
  );
  const dockets = responseDockets(state, events);
  const decisions = opportunities.map((op) => ({
    id: op.id,
    day: op.day,
    phase: op.phase,
    playerId: op.playerId,
    role: op.packet.self.role.name,
    status: op.status,
    contextEstimate: estimatedTokens(op.packet),
    sources: op.packet.sources.length,
    docket: op.packet.responseDocket,
    closing: op.packet.closing,
    committedProposal: op.status === "committed" ? op.best?.proposal : null,
    journalRevision: store.journal(id, op.playerId).version,
    turns: events
      .filter((e) => e.type === "decision.reported" && e.payload.decisionId === op.id)
      .map((e) => ({
        summary: (e.payload.report as DecisionReportV2).summary,
        alternatives: (e.payload.report as DecisionReportV2).alternatives,
        observations: (e.payload.report as DecisionReportV2).observations,
        continuation: e.payload.continuation,
        control: (e.payload.report as DecisionReportV2).control,
      })),
  }));
  return {
    schemaVersion: "pilot_audit_v2",
    gameId: id,
    status: game.status,
    day: state.day,
    ending: ending?.payload ?? null,
    issues,
    remainingResponseDockets: dockets,
    attempts: attempts.length,
    unknownUsageAttempts: attempts.filter((a) => a.usage.totalTokens === null).length,
    totalKnownTokens: attempts.reduce((n, a) => n + (a.usage.totalTokens ?? 0), 0),
    semanticAssessments: events
      .filter((e) => e.type === "decision.semantic_assessed")
      .map((e) => ({ day: e.day, sequence: e.sequence, ...e.payload })),
    failedAttempts: attempts
      .filter((a) => a.status === "invalid" || a.status === "unknown")
      .map((a) => ({ id: a.id, decisionId: a.decisionId, error: a.error })),
    nightChoices: events
      .filter((e) =>
        [
          "team.point",
          "team.agreement_frozen",
          "night.action_submitted",
          "night.resolved",
          "decision.random_draw",
        ].includes(e.type),
      )
      .map((e) => ({ day: e.day, type: e.type, payload: e.payload })),
    decisions,
  };
}
