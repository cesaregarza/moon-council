#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

type JsonRecord = Record<string, unknown>;

export interface AuditEvent {
  id?: string;
  sequence: number;
  type: string;
  phase: string;
  day: number;
  visibility: string;
  payload: JsonRecord;
  createdAt: string;
}

export interface AuditAttempt {
  id: string;
  playerId: string;
  status: string;
  schemaVersion: string;
  error?: string | null;
  provider: string;
  model: string;
  reasoningEffort: string;
  latencyMs: number | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cachedInputTokens: number | null;
    reasoningTokens: number | null;
  };
}

export interface AuditGame {
  id: string;
  name: string;
  status: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  activeRuntimeMs?: number;
}

interface EnginePlayer {
  id: string;
  name: string;
  role: { name: string; alignment: string };
}

interface AuctionScore {
  playerId: string;
  urge: number;
  listenerInterest: number;
  normalizedListenerInterest: number;
  priority: number;
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const left = sorted[Math.floor((sorted.length - 1) / 2)]!;
  const right = sorted[Math.floor(sorted.length / 2)]!;
  return (left + right) / 2;
};
const percentile = (values: number[], fraction: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? sorted.at(-1)!;
};
const mean = (values: number[]): number | null =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const maxIds = (values: Array<{ playerId: string; value: number }>): string[] => {
  if (!values.length) return [];
  const highest = Math.max(...values.map((item) => item.value));
  return values
    .filter((item) => Math.abs(item.value - highest) < 1e-9)
    .map((item) => item.playerId);
};

function rolePlayers(events: AuditEvent[]): EnginePlayer[] {
  const created = events.find((event) => event.type === "game.created");
  return Array.isArray(created?.payload.players) ? (created.payload.players as EnginePlayer[]) : [];
}

function aliveAt(players: EnginePlayer[], events: AuditEvent[], sequence: number): Set<string> {
  const eliminated = new Set(
    events
      .filter((event) => event.sequence < sequence && event.type === "player.eliminated")
      .map((event) => String(event.payload.playerId)),
  );
  return new Set(players.filter((player) => !eliminated.has(player.id)).map((player) => player.id));
}

function latestBelief(
  events: AuditEvent[],
  observerId: string,
  targetId: string,
  beforeSequence: number,
): number | null {
  const update = events.findLast(
    (event) =>
      event.sequence < beforeSequence &&
      event.type === "journal.v2_updated" &&
      event.payload.playerId === observerId,
  );
  const journal = update?.payload.journal as
    { beliefs?: Array<{ playerId?: string; probability?: number }> } | undefined;
  const belief = journal?.beliefs?.find((item) => item.playerId === targetId);
  return numberOrNull(belief?.probability);
}

function tokenField(attempts: AuditAttempt[], key: keyof AuditAttempt["usage"]) {
  const known = attempts.flatMap((attempt) =>
    typeof attempt.usage[key] === "number" ? [attempt.usage[key] as number] : [],
  );
  return {
    knownTotal: known.reduce((sum, value) => sum + value, 0),
    unknownAttempts: attempts.length - known.length,
  };
}

/** Verify fresh public speech has reached every living journal before the next Jev call. */
export function summarizeJournalWorkflow(events: AuditEvent[], attempts: AuditAttempt[]) {
  const reflections = events.filter((event) => event.type === "journal.refreshed");
  const jevAttemptIds = new Set(
    attempts.filter((attempt) => attempt.provider === "jev").map((attempt) => attempt.id),
  );
  const jevStarts = events.filter(
    (event) =>
      event.type === "model.attempt_started" && jevAttemptIds.has(String(event.payload.attemptId)),
  );
  const players = rolePlayers(events);
  const speeches = events.filter((event) => event.type === "speech.public");
  const observed = reflections.length > 0;
  const checks = observed
    ? speeches
        .filter((speech) => speech.id != null)
        .map((speech) => {
          const nextJev = jevStarts.find((event) => event.sequence > speech.sequence);
          const before = nextJev?.sequence ?? (events.at(-1)?.sequence ?? speech.sequence) + 1;
          const living = [...aliveAt(players, events, before)];
          const missingPlayerIds = living.filter(
            (playerId) =>
              !reflections.some(
                (event) =>
                  event.sequence > speech.sequence &&
                  event.sequence < before &&
                  event.payload.playerId === playerId &&
                  (typeof event.payload.reviewedThroughSequence === "number"
                    ? Number.isSafeInteger(event.payload.reviewedThroughSequence) &&
                      event.payload.reviewedThroughSequence >= speech.sequence &&
                      event.payload.reviewedThroughSequence < event.sequence
                    : Array.isArray(event.payload.sourceIds) &&
                      event.payload.sourceIds.includes(speech.id)),
              ),
          );
          return {
            speechId: speech.id!,
            sequence: speech.sequence,
            day: speech.day,
            speakerId: String(speech.payload.playerId),
            nextJevSequence: nextJev?.sequence ?? null,
            expectedPlayers: living.length,
            missingPlayerIds,
            status: nextJev ? (missingPlayerIds.length ? "gap" : "verified") : "pending",
          };
        })
    : [];
  const last = speeches.at(-1);
  return {
    observed,
    reflections: reflections.length,
    proseUpdates: events.filter(
      (event) =>
        event.type === "journal.v2_updated" &&
        Array.isArray(event.payload.patch) &&
        event.payload.patch.some((op) => (op as JsonRecord).op === "write_text"),
    ).length,
    attentionUpdates: events.filter(
      (event) =>
        event.type === "journal.v2_updated" &&
        Array.isArray(event.payload.patch) &&
        event.payload.patch.some((op) => (op as JsonRecord).op === "set_attention"),
    ).length,
    speechesWithoutIds: speeches.filter((event) => event.id == null).length,
    verifiedSpeeches: checks.filter((check) => check.status === "verified").length,
    pendingSpeeches: checks.filter((check) => check.status === "pending").length,
    gaps: checks.filter((check) => check.status === "gap"),
    byPlayer: players.map((player) => ({
      playerId: player.id,
      playerName: player.name,
      reflections: reflections.filter((event) => event.payload.playerId === player.id).length,
    })),
    latestSpeech: last
      ? {
          sequence: last.sequence,
          day: last.day,
          playerId: last.payload.playerId,
          playerName: last.payload.playerName,
          text: last.payload.text,
        }
      : null,
    checks,
  };
}

export function summarizeGameAudit(
  game: AuditGame,
  events: AuditEvent[],
  attempts: AuditAttempt[],
) {
  const players = rolePlayers(events);
  const playerById = new Map(players.map((player) => [player.id, player]));
  const ending = events.findLast((event) =>
    ["game.ended", "game.budget_exhausted", "game.aborted"].includes(event.type),
  );
  const latest = events.at(-1);
  const eliminations = events
    .filter((event) => event.type === "player.eliminated")
    .map((event) => ({
      sequence: event.sequence,
      day: event.day,
      playerId: String(event.payload.playerId),
      playerName: String(
        event.payload.playerName ??
          playerById.get(String(event.payload.playerId))?.name ??
          event.payload.playerId,
      ),
      roleName: String(
        (typeof event.payload.roleName === "string" ? event.payload.roleName : undefined) ??
          playerById.get(String(event.payload.playerId))?.role.name ??
          "unknown",
      ),
      alignment: playerById.get(String(event.payload.playerId))?.role.alignment ?? "unknown",
      cause: typeof event.payload.cause === "string" ? event.payload.cause : "unknown",
    }));
  const eliminatedIds = new Set(eliminations.map((event) => event.playerId));
  const winnerIds = new Set(
    Array.isArray(ending?.payload.winnerPlayerIds)
      ? ending.payload.winnerPlayerIds.map(String)
      : [],
  );
  const roster = players.map((player) => ({
    playerId: player.id,
    playerName: player.name,
    roleName: player.role.name,
    alignment: player.role.alignment,
    survived: !eliminatedIds.has(player.id),
    won: winnerIds.has(player.id),
    elimination: eliminations.find((item) => item.playerId === player.id) ?? null,
  }));

  const speeches = events.filter((event) => event.type === "speech.public");
  const auctions = events.filter((event) => event.type === "discussion.auction_resolved");
  const auctionDetails = auctions.map((event) => {
    const scores = Array.isArray(event.payload.scores)
      ? (event.payload.scores as AuctionScore[])
      : [];
    const selectedPlayerId =
      typeof event.payload.selectedPlayerId === "string" ? event.payload.selectedPlayerId : null;
    const alive = aliveAt(players, events, event.sequence);
    const suspicion = scores.map((score) => {
      const observations = [...alive]
        .filter((observerId) => observerId !== score.playerId)
        .flatMap((observerId) => {
          const value = latestBelief(events, observerId, score.playerId, event.sequence);
          return value == null ? [] : [value];
        });
      return {
        playerId: score.playerId,
        meanProbability: mean(observations),
        observers: observations.length,
      };
    });
    const coveredSuspicion = suspicion.filter(
      (item): item is { playerId: string; meanProbability: number; observers: number } =>
        item.meanProbability != null,
    );
    const maxSuspicionIds = maxIds(
      coveredSuspicion.map((item) => ({ playerId: item.playerId, value: item.meanProbability })),
    );
    return {
      sequence: event.sequence,
      day: event.day,
      stage: typeof event.payload.stage === "string" ? event.payload.stage : "unknown",
      round: numberOrNull(event.payload.round),
      selectedPlayerId,
      selectedPlayerName: selectedPlayerId
        ? (playerById.get(selectedPlayerId)?.name ?? selectedPlayerId)
        : null,
      candidateCount: scores.length,
      selectedScore: scores.find((score) => score.playerId === selectedPlayerId) ?? null,
      maximumUrgeIds: maxIds(
        scores.map((score) => ({ playerId: score.playerId, value: score.urge })),
      ),
      maximumListenerInterestIds: maxIds(
        scores.map((score) => ({ playerId: score.playerId, value: score.listenerInterest })),
      ),
      maximumPrivateSuspicionIds: maxSuspicionIds,
      suspicion,
    };
  });

  const byPlayer = roster.map((player) => {
    const selected = auctionDetails.filter(
      (auction) => auction.selectedPlayerId === player.playerId,
    );
    const playerSpeeches = speeches.filter((event) => event.payload.playerId === player.playerId);
    const formalActs = speeches.flatMap((event) =>
      (Array.isArray(event.payload.acts) ? event.payload.acts : []).map((act) => ({
        event,
        act: act as JsonRecord,
      })),
    );
    const selectedSuspicion = selected.flatMap((auction) => {
      const row = auction.suspicion.find((item) => item.playerId === player.playerId);
      return row?.meanProbability == null ? [] : [row.meanProbability];
    });
    return {
      playerId: player.playerId,
      playerName: player.playerName,
      roleName: player.roleName,
      alignment: player.alignment,
      auctionSelections: selected.length,
      openingSelections: selected.filter((auction) => auction.stage === "opening").length,
      followUpSelections: selected.filter((auction) => auction.stage === "followup").length,
      publicSpeeches: playerSpeeches.length,
      closingSpeeches: playerSpeeches.filter((event) => event.payload.closing === true).length,
      formalAccusationsReceived: formalActs.filter(
        ({ act }) => act.kind === "accusation" && act.targetId === player.playerId,
      ).length,
      formalChallengesReceived: formalActs.filter(
        ({ act }) => act.kind === "challenge" && act.targetId === player.playerId,
      ).length,
      selectedWithMaximumUrge: selected.filter((auction) =>
        auction.maximumUrgeIds.includes(player.playerId),
      ).length,
      selectedWithMaximumListenerInterest: selected.filter((auction) =>
        auction.maximumListenerInterestIds.includes(player.playerId),
      ).length,
      selectedWithMaximumPrivateSuspicion: selected.filter((auction) =>
        auction.maximumPrivateSuspicionIds.includes(player.playerId),
      ).length,
      meanPrivateSuspicionWhenSelected: mean(selectedSuspicion),
      meanUrgeWhenSelected: mean(
        selected.flatMap((auction) => (auction.selectedScore ? [auction.selectedScore.urge] : [])),
      ),
      meanListenerInterestWhenSelected: mean(
        selected.flatMap((auction) =>
          auction.selectedScore ? [auction.selectedScore.listenerInterest] : [],
        ),
      ),
    };
  });

  const statusCounts = Object.fromEntries(
    [...new Set(attempts.map((attempt) => attempt.status))]
      .sort()
      .map((status) => [status, attempts.filter((attempt) => attempt.status === status).length]),
  );
  const attemptContext = new Map(
    events
      .filter((event) => event.type === "model.attempt_started")
      .map((event) => [String(event.payload.attemptId), { day: event.day, phase: event.phase }]),
  );
  const latencyValues = attempts.flatMap((attempt) =>
    attempt.latencyMs == null ? [] : [attempt.latencyMs],
  );
  const input = tokenField(attempts, "inputTokens");
  const cached = tokenField(attempts, "cachedInputTokens");
  const byTask = [...new Set(attempts.map((attempt) => attempt.schemaVersion))]
    .sort()
    .map((schemaVersion) => {
      const rows = attempts.filter((attempt) => attempt.schemaVersion === schemaVersion);
      const taskInput = tokenField(rows, "inputTokens");
      const taskCached = tokenField(rows, "cachedInputTokens");
      return {
        schemaVersion,
        byEffort: [...new Set(rows.map((row) => row.reasoningEffort))]
          .sort()
          .map((reasoningEffort) => {
            const calls = rows.filter((row) => row.reasoningEffort === reasoningEffort);
            return {
              reasoningEffort,
              attempts: calls.length,
              valid: calls.filter((row) => row.status === "valid").length,
              invalid: calls.filter((row) => row.status === "invalid").length,
              unknown: calls.filter((row) => row.status === "unknown").length,
              medianLatencyMs: median(
                calls.flatMap((row) => (row.latencyMs === null ? [] : [row.latencyMs])),
              ),
              outputTokens: tokenField(calls, "outputTokens"),
              reasoningTokens: tokenField(calls, "reasoningTokens"),
            };
          }),
        attempts: rows.length,
        valid: rows.filter((row) => row.status === "valid").length,
        invalid: rows.filter((row) => row.status === "invalid").length,
        inputTokens: taskInput.knownTotal,
        cachedInputTokens: taskCached.knownTotal,
        cachePercent: taskInput.knownTotal
          ? (100 * taskCached.knownTotal) / taskInput.knownTotal
          : null,
        medianLatencyMs: median(
          rows.flatMap((row) => (row.latencyMs == null ? [] : [row.latencyMs])),
        ),
      };
    });
  const dayPhaseKeys = [
    ...new Set(
      attempts.map((attempt) => {
        const context = attemptContext.get(attempt.id);
        return `${context?.day ?? "unknown"}:${context?.phase ?? "unknown"}`;
      }),
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const byDayPhase = dayPhaseKeys.map((key) => {
    const rows = attempts.filter((attempt) => {
      const context = attemptContext.get(attempt.id);
      return `${context?.day ?? "unknown"}:${context?.phase ?? "unknown"}` === key;
    });
    const [day, phase] = key.split(":", 2);
    const taskInput = tokenField(rows, "inputTokens"),
      taskOutput = tokenField(rows, "outputTokens"),
      taskCached = tokenField(rows, "cachedInputTokens");
    return {
      day: day === "unknown" ? null : Number(day),
      phase,
      attempts: rows.length,
      valid: rows.filter((row) => row.status === "valid").length,
      invalid: rows.filter((row) => row.status === "invalid").length,
      inputTokens: taskInput.knownTotal,
      outputTokens: taskOutput.knownTotal,
      cachedInputTokens: taskCached.knownTotal,
      cachePercent: taskInput.knownTotal
        ? (100 * taskCached.knownTotal) / taskInput.knownTotal
        : null,
      medianLatencyMs: median(
        rows.flatMap((row) => (row.latencyMs == null ? [] : [row.latencyMs])),
      ),
    };
  });
  const voteEvents = events.filter((event) => event.type === "vote.resolved");
  const ballots = voteEvents.flatMap((event) =>
    Array.isArray(event.payload.ballots)
      ? (event.payload.ballots as Array<{ voterId: string; targetId: string | null }>).map(
          (ballot) => ({ day: event.day, ...ballot }),
        )
      : [],
  );
  const villageBallots = ballots.filter(
    (ballot) => playerById.get(ballot.voterId)?.role.alignment === "village" && ballot.targetId,
  );
  const villageVotesForWolves = villageBallots.filter(
    (ballot) => playerById.get(String(ballot.targetId))?.role.alignment === "werewolf",
  ).length;
  const packAgreements = events.filter((event) => event.type === "team.agreement_frozen");
  const typeCounts = Object.fromEntries(
    [...new Set(events.map((event) => event.type))]
      .sort()
      .map((type) => [type, events.filter((event) => event.type === type).length]),
  );
  const startedAt =
    events.find((event) => event.type === "game.started")?.createdAt ?? game.createdAt;
  const endedAt = ending?.createdAt ?? null;
  const elapsedMs = endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null;

  return {
    schemaVersion: "werewolf_game_audit_v1",
    game: {
      id: game.id,
      name: game.name,
      status: game.status,
      error: game.error,
      activeRuntimeMs: game.activeRuntimeMs ?? null,
      latestSequence: latest?.sequence ?? null,
      latestDay: latest?.day ?? null,
      latestPhase: latest?.phase ?? null,
      ending: ending
        ? {
            type: ending.type,
            day: ending.day,
            createdAt: ending.createdAt,
            payload: ending.payload,
          }
        : null,
      startedAt,
      endedAt,
      recordedElapsedMs: elapsedMs,
    },
    roster,
    journal: summarizeJournalWorkflow(events, attempts),
    mechanics: {
      eliminations,
      daysWithVotes: voteEvents.length,
      ballots: ballots.length,
      villageVotesForWolves,
      villageVotingAccuracy: villageBallots.length
        ? villageVotesForWolves / villageBallots.length
        : null,
      nightResolutions: events.filter((event) => event.type === "night.resolved").length,
      packAgreements: packAgreements.length,
      unanimousPackTargets: packAgreements.filter(
        (event) => event.payload.reason === "unanimous" && event.payload.targetId != null,
      ).length,
      skippedPackKills: packAgreements.filter((event) => event.payload.targetId == null).length,
    },
    discussion: {
      auctions: auctions.length,
      bids: events.filter((event) => event.type === "discussion.bid_submitted").length,
      selectedSpeakers: events.filter((event) => event.type === "discussion.speaker_selected")
        .length,
      publicSpeeches: speeches.length,
      transcript: speeches.map((event) => ({
        sequence: event.sequence,
        day: event.day,
        playerId: event.payload.playerId,
        playerName: event.payload.playerName,
        text: event.payload.text,
        acts: event.payload.acts,
        respondsTo: event.payload.respondsTo,
      })),
      ordinarySpeeches: speeches.filter((event) => event.payload.closing !== true).length,
      closingSpeeches: speeches.filter((event) => event.payload.closing === true).length,
      selectedWithMaximumUrge: auctionDetails.filter(
        (auction) =>
          auction.selectedPlayerId && auction.maximumUrgeIds.includes(auction.selectedPlayerId),
      ).length,
      selectedWithMaximumListenerInterest: auctionDetails.filter(
        (auction) =>
          auction.selectedPlayerId &&
          auction.maximumListenerInterestIds.includes(auction.selectedPlayerId),
      ).length,
      selectedWithMaximumPrivateSuspicion: auctionDetails.filter(
        (auction) =>
          auction.selectedPlayerId &&
          auction.maximumPrivateSuspicionIds.includes(auction.selectedPlayerId),
      ).length,
      privateSuspicionCoverageAuctions: auctionDetails.filter((auction) =>
        auction.suspicion.some((item) => item.observers > 0),
      ).length,
      byPlayer,
      auctionsByDay: [...new Set(auctionDetails.map((auction) => auction.day))]
        .sort((a, b) => a - b)
        .map((day) => ({
          day,
          auctions: auctionDetails.filter((auction) => auction.day === day).length,
          speeches: speeches.filter((event) => event.day === day).length,
        })),
      auctionDetails,
    },
    provider: {
      models: Object.fromEntries(
        [...new Set(attempts.map((attempt) => `${attempt.provider}:${attempt.model}`))]
          .sort()
          .map((key) => [
            key,
            attempts.filter((attempt) => `${attempt.provider}:${attempt.model}` === key).length,
          ]),
      ),
      reasoningEfforts: Object.fromEntries(
        [...new Set(attempts.map((attempt) => attempt.reasoningEffort))]
          .sort()
          .map((key) => [
            key,
            attempts.filter((attempt) => attempt.reasoningEffort === key).length,
          ]),
      ),
      attempts: attempts.length,
      statusCounts,
      invalidAttempts: attempts.filter((attempt) => attempt.status === "invalid").length,
      invalidDetails: attempts
        .filter((attempt) => attempt.status === "invalid")
        .map((attempt) => ({
          id: attempt.id,
          playerId: attempt.playerId,
          provider: attempt.provider,
          schemaVersion: attempt.schemaVersion,
          error: attempt.error ?? null,
        })),
      failedDetails: attempts
        .filter((attempt) => ["invalid", "unknown"].includes(attempt.status))
        .map((attempt) => ({
          id: attempt.id,
          playerId: attempt.playerId,
          provider: attempt.provider,
          schemaVersion: attempt.schemaVersion,
          status: attempt.status,
          reasoningEffort: attempt.reasoningEffort,
          latencyMs: attempt.latencyMs,
          error: attempt.error ?? null,
        })),
      usage: {
        inputTokens: input,
        outputTokens: tokenField(attempts, "outputTokens"),
        totalTokens: tokenField(attempts, "totalTokens"),
        cachedInputTokens: cached,
        reasoningTokens: tokenField(attempts, "reasoningTokens"),
        cachePercent: input.knownTotal ? (100 * cached.knownTotal) / input.knownTotal : null,
      },
      latency: {
        recordedAttempts: latencyValues.length,
        totalMs: latencyValues.reduce((sum, value) => sum + value, 0),
        medianMs: median(latencyValues),
        p95Ms: percentile(latencyValues, 0.95),
        maxMs: latencyValues.length ? Math.max(...latencyValues) : null,
      },
      byTask,
      byModel: [...new Set(attempts.map((attempt) => `${attempt.provider}:${attempt.model}`))]
        .sort()
        .map((model) => {
          const rows = attempts.filter(
            (attempt) => `${attempt.provider}:${attempt.model}` === model,
          );
          return {
            model,
            attempts: rows.length,
            medianLatencyMs: median(
              rows.flatMap((row) => (row.latencyMs == null ? [] : [row.latencyMs])),
            ),
          };
        }),
      byDayPhase,
    },
    eventTypeCounts: typeCounts,
  };
}

/** Small reusable snapshot for monitoring a running pilot, without private notebooks. */
export function summarizeGameProgress(audit: ReturnType<typeof summarizeGameAudit>) {
  return {
    game: audit.game,
    eliminations: audit.mechanics.eliminations,
    speeches: audit.discussion.publicSpeeches,
    compactions: audit.eventTypeCounts["journal.compacted"] ?? 0,
    recentFailures: audit.provider.failedDetails
      .slice(-3)
      .map((attempt) => ({ ...attempt, error: attempt.error?.replace(/\s+/g, " ").slice(0, 180) })),
    latestSpeech: audit.journal.latestSpeech,
    journal: {
      reflections: audit.journal.reflections,
      verifiedSpeeches: audit.journal.verifiedSpeeches,
      pendingSpeeches: audit.journal.pendingSpeeches,
      gaps: audit.journal.gaps.length,
    },
    provider: {
      attempts: audit.provider.attempts,
      statusCounts: audit.provider.statusCounts,
      byModel: audit.provider.byModel,
      knownTokens: audit.provider.usage.totalTokens.knownTotal,
      invalidAttempts: audit.provider.invalidAttempts,
    },
  };
}

function usage(exitCode = 2): never {
  console.error(
    "Usage: npm run game:audit -- --db <sqlite-path> --game <game-id> [--compact] [--status]",
  );
  process.exit(exitCode);
}

function parseArgs(argv: string[]) {
  let dbPath = "",
    gameId = "",
    compact = false,
    status = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--compact") {
      compact = true;
      continue;
    }
    if (arg === "--status") {
      status = true;
      continue;
    }
    const value = argv[++index];
    if (!value) usage();
    if (arg === "--db") dbPath = resolve(value);
    else if (arg === "--game") gameId = value;
    else usage();
  }
  if (!dbPath || !gameId) usage();
  return { dbPath, gameId, compact, status };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.dbPath)) throw new Error(`Database does not exist: ${options.dbPath}`);
  const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        "SELECT id,name,status,error,created_at AS createdAt,updated_at AS updatedAt FROM games WHERE id=?",
      )
      .get(options.gameId) as AuditGame | undefined;
    if (!row) throw new Error(`Unknown game: ${options.gameId}`);
    const runtimeRows = db
      .prepare(
        "SELECT record_key AS key,value_json AS value FROM agent_records WHERE game_id=? AND record_key IN ('runtimeMs','runtimeStartedAt')",
      )
      .all(options.gameId) as Array<{ key: string; value: string }>;
    const runtime = Object.fromEntries(
      runtimeRows.map((record) => [record.key, numberOrNull(JSON.parse(record.value))]),
    );
    row.activeRuntimeMs =
      (runtime.runtimeMs ?? 0) +
      (runtime.runtimeStartedAt == null ? 0 : Math.max(0, Date.now() - runtime.runtimeStartedAt));
    const eventRows = db
      .prepare(
        "SELECT id,sequence,type,phase,day,visibility,payload_json AS payloadJson,created_at AS createdAt FROM events WHERE game_id=? ORDER BY sequence",
      )
      .all(options.gameId) as Array<Omit<AuditEvent, "payload"> & { payloadJson: string }>;
    const attemptRows = db
      .prepare(
        "SELECT value_json AS valueJson FROM provider_attempts WHERE game_id=? ORDER BY rowid",
      )
      .all(options.gameId) as Array<{ valueJson: string }>;
    const events = eventRows.map(({ payloadJson, ...event }) => ({
      ...event,
      payload: JSON.parse(payloadJson) as JsonRecord,
    }));
    const attempts = attemptRows.map((item) => {
      const value = JSON.parse(item.valueJson) as JsonRecord;
      const usage = (value.usage ?? {}) as JsonRecord;
      return {
        id: String(value.id),
        playerId: String(value.playerId),
        status: String(value.status),
        error: typeof value.error === "string" ? value.error : null,
        schemaVersion: typeof value.schemaVersion === "string" ? value.schemaVersion : "unknown",
        provider: typeof value.provider === "string" ? value.provider : "unknown",
        model: typeof value.model === "string" ? value.model : "unknown",
        reasoningEffort:
          typeof value.reasoningEffort === "string" ? value.reasoningEffort : "unknown",
        latencyMs: numberOrNull(value.latencyMs),
        usage: {
          inputTokens: numberOrNull(usage.inputTokens),
          outputTokens: numberOrNull(usage.outputTokens),
          totalTokens: numberOrNull(usage.totalTokens),
          cachedInputTokens: numberOrNull(usage.cachedInputTokens),
          reasoningTokens: numberOrNull(usage.reasoningTokens),
        },
      } satisfies AuditAttempt;
    });
    const audit = summarizeGameAudit(row, events, attempts);
    console.log(
      JSON.stringify(
        options.status ? summarizeGameProgress(audit) : audit,
        null,
        options.compact ? 0 : 2,
      ),
    );
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
