import type { DecisionOpportunityV1 } from "@werewolf/contracts";
import { DecisionStore, type LabRepository } from "@werewolf/db";
import { reduceGame } from "@werewolf/engine";
import { applyJournalV2, authorizedSources, contentHash, validateReport } from "./context-v2";
import { journalEvidenceRevision } from "./player-brief";

function conflict(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 409 });
}

/** Commit the final recorded Jev ballot, never a substituted or newly generated choice. */
export function acknowledgeSemanticAnomaly(
  repository: LabRepository,
  gameId: string,
  decisionId: string,
  note: string,
) {
  if (!note.trim() || note.length > 1_000)
    conflict("An operator note of 1–1000 characters is required");
  const store = new DecisionStore(repository);
  return store.atomic(() => {
    const game = repository.getGame(gameId);
    const op = store.get<DecisionOpportunityV1>(gameId, `decision:${decisionId}`);
    if (!game || !op) conflict("Unknown game or decision");
    if (op.status === "committed" && op.jevState?.semanticAcknowledgment) {
      return {
        decisionId,
        status: "committed",
        gameStatus: game.status,
        alreadyAcknowledged: true,
      };
    }
    if (game.status !== "paused" || op.status !== "paused")
      conflict("The game and decision must be paused");
    if (game.config.schemaVersion !== "game_config_v2") conflict("V2 game required");
    const final = op.jevState?.semanticFinal;
    if (!op.jevState?.semanticRejected || !final)
      conflict("No final semantically rejected Jev choice is recorded");
    // The current semantic guard applies only to ballots. Extend recovery with any future guard.
    if (op.taskType !== "vote_choice" || final.report.proposal.kind !== "vote") {
      conflict("This semantic recovery action supports recorded ballots only");
    }
    const events = repository.listEvents(gameId);
    const state = reduceGame(gameId, events);
    const actor = state.players.find((player) => player.id === op.playerId && player.alive);
    const revision = journalEvidenceRevision(authorizedSources(state, events, op.playerId));
    const stale =
      state.phase !== "day_vote" ||
      `${state.day}:${state.phase}` !== op.epoch ||
      !actor ||
      store.journal(gameId, op.playerId).version !== op.baseJournalVersion ||
      revision !== op.packet.rules.journalRevision ||
      contentHash(op.packet) !== op.viewId;
    if (stale)
      conflict(
        "The recorded ballot is stale; acknowledgment cannot bypass changed evidence or legal state",
      );
    if (state.votes.some((vote) => vote.voterId === op.playerId))
      conflict("The player already cast a ballot");
    const attempt = store.attempts(gameId, op.id).find((item) => item.id === final.attemptId);
    if (attempt?.provider !== "jev" || attempt.status !== "valid" || !attempt.response) {
      conflict("The final validated Jev receipt is missing");
    }
    const errors = validateReport(
      final.report,
      op.packet,
      game.config.deliberation.maxJournalTokens,
    );
    if (errors.length) conflict(`Recorded ballot no longer validates: ${errors.join("; ")}`);
    const targets = final.report.proposal.targets;
    if (targets && (targets.mode !== "direct" || targets.playerIds.length !== 1)) {
      conflict("Acknowledgment requires Jev's single recorded target or abstention");
    }
    const targetId = targets?.playerIds[0] ?? null;
    if (
      targetId &&
      !state.players.some(
        (player) => player.id === targetId && player.alive && player.id !== op.playerId,
      )
    ) {
      conflict("Recorded target is no longer legal");
    }

    op.jevState.semanticAcknowledgment = { note: note.trim(), at: new Date().toISOString() };
    op.best = final.report;
    op.bestSubmission = final.submission;
    op.status = "pending";
    store.save(op);
    repository.appendEvent(gameId, {
      type: "decision.semantic_acknowledged",
      phase: state.phase,
      day: state.day,
      visibility: "player",
      audienceIds: [op.playerId],
      payload: {
        playerId: op.playerId,
        decisionId,
        attemptId: final.attemptId,
        operator: true,
        note: note.trim(),
        issues: op.jevState.semanticIssues,
        proposal: op.best.proposal,
      },
    });
    repository.appendEvent(gameId, {
      type: "decision.reported",
      phase: state.phase,
      day: state.day,
      visibility: "player",
      audienceIds: [op.playerId],
      payload: {
        playerId: op.playerId,
        decisionId,
        report: op.best,
        submission: op.bestSubmission,
        taskType: op.taskType,
        attemptId: final.attemptId,
        continuation: "operator_acknowledged_anomaly",
      },
    });
    // DecisionStore.commit checks normal epoch/journal invariants. Keep the temporary
    // active status and the final paused status inside this same SQLite transaction.
    repository.updateGame(gameId, { status: "stepping" });
    const journal = applyJournalV2(
      op.packet.journal,
      final.report,
      game.config.deliberation.maxJournalTokens,
    );
    const committed = store.commit(op, journal, [
      {
        type: "vote.cast",
        phase: state.phase,
        day: state.day,
        visibility: "player",
        audienceIds: [op.playerId],
        payload: { vote: { voterId: op.playerId, targetId } },
      },
    ]);
    if (!committed) conflict("Could not commit the recorded ballot");
    repository.updateGame(gameId, { status: "paused", error: null });
    return { decisionId, status: "committed", gameStatus: "paused", alreadyAcknowledged: false };
  });
}
