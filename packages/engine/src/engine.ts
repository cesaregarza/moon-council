import type {
  Alignment,
  GameEventV1,
  GamePhase,
  NightActionDecisionSchema,
  PrivateJournalV1,
  RoleActionV1,
  RoleDefinitionV1,
  StoredGameConfig,
  WinPredicateV1,
} from "@werewolf/contracts";
import type { z } from "zod";
import { seededChoice, shuffled } from "./random";

export type NightActionDecisionV1 = z.infer<typeof NightActionDecisionSchema>;

export interface EnginePlayer {
  id: string;
  name: string;
  personality: string;
  model?: string;
  role: RoleDefinitionV1;
  alive: boolean;
  revealedRole?: string;
}

export interface SubmittedNightAction {
  actorId: string;
  actionId: string;
  targetIds: string[];
}

export interface CastVote {
  voterId: string;
  targetId: string | null;
}

export interface GameState {
  gameId: string;
  config: StoredGameConfig;
  phase: GamePhase;
  day: number;
  status:
    | "lobby"
    | "queued"
    | "running"
    | "paused"
    | "completed"
    | "aborted"
    | "budget_exhausted"
    | "failed";
  players: EnginePlayer[];
  pendingNightActions: SubmittedNightAction[];
  actionUses: Record<string, number>;
  /** Accepted night-action targets, keyed by actor/action/day for replay-safe rule checks. */
  protectionHistory: Record<string, string[]>;
  votes: CastVote[];
  winnerAlignments: Alignment[];
  winnerPlayerIds: string[];
  outcomeReason?: string;
  modelCalls: number;
  startedAt?: string;
}

export interface EngineEventInput {
  type: string;
  phase: GamePhase;
  day: number;
  visibility: GameEventV1["visibility"];
  audienceIds?: string[];
  payload: Record<string, unknown>;
}

export function createGameState(gameId: string, config: StoredGameConfig): GameState {
  const roles = shuffled(config.roleDeck, `${config.seed}:roles`);
  return {
    gameId,
    config,
    phase: "setup",
    day: 0,
    status: "lobby",
    players: config.seats.map((seat, index) => ({
      ...seat,
      role: roles[index]!,
      alive: true,
    })),
    pendingNightActions: [],
    actionUses: {},
    protectionHistory: {},
    votes: [],
    winnerAlignments: [],
    winnerPlayerIds: [],
    modelCalls: 0,
  };
}

export function createGameCreatedEvent(state: GameState): EngineEventInput {
  return {
    type: "game.created",
    phase: "setup",
    day: 0,
    visibility: "moderator",
    payload: {
      config: state.config,
      players: state.players,
    },
  };
}

export function reduceGame(gameId: string, events: readonly GameEventV1[]): GameState {
  const created = events.find((event) => event.type === "game.created");
  if (!created) throw new Error(`Game ${gameId} has no game.created event`);
  const config = created.payload.config as StoredGameConfig;
  const initial = createGameState(gameId, config);
  initial.players = structuredClone(created.payload.players as EnginePlayer[]);
  return events.reduce(reduceEvent, initial);
}

function reduceEvent(state: GameState, event: GameEventV1): GameState {
  // Configuration and role snapshots are immutable; copy only mutable reducer fields.
  const next: GameState = {
    ...state,
    players: state.players.map((player) => ({ ...player })),
    pendingNightActions: [...state.pendingNightActions],
    actionUses: { ...state.actionUses },
    protectionHistory: { ...state.protectionHistory },
    votes: [...state.votes],
    winnerAlignments: [...state.winnerAlignments],
    winnerPlayerIds: [...state.winnerPlayerIds],
  };
  if (!isV2MetadataAuditEvent(next.config, event)) {
    next.phase = event.phase;
    next.day = event.day;
  }
  switch (event.type) {
    case "game.started":
      next.status = "running";
      next.startedAt = String(event.payload.startedAt);
      break;
    case "game.paused":
      next.status = "paused";
      break;
    case "game.resumed":
      next.status = "running";
      break;
    case "game.aborted":
      next.status = "aborted";
      next.phase = "ended";
      break;
    case "game.budget_exhausted":
      next.status = "budget_exhausted";
      next.phase = "ended";
      next.outcomeReason =
        typeof event.payload.reason === "string" ? event.payload.reason : "budget_exhausted";
      break;
    case "game.budget_extended":
      if (isV2Config(next.config)) {
        next.config = {
          ...next.config,
          maxTotalTokens:
            event.payload.maxTotalTokens === null ? null : Number(event.payload.maxTotalTokens),
          safety: { ...next.config.safety, maxWallClockMs: Number(event.payload.maxWallClockMs) },
          deliberation: {
            ...next.config.deliberation,
            maxContextTokens: Number(
              event.payload.maxContextTokens ?? next.config.deliberation.maxContextTokens,
            ),
          },
        };
      }
      next.status = "running";
      next.outcomeReason = undefined;
      break;
    case "model.attempt_started":
      if (isV2Config(next.config)) next.modelCalls += 1;
      break;
    case "model.call_recorded":
      if (!isV2Config(next.config)) next.modelCalls += Number(event.payload.attempts ?? 1);
      break;
    case "night.action_submitted":
      const submitted = event.payload.action as SubmittedNightAction;
      next.pendingNightActions.push(submitted);
      const useKey = `${submitted.actorId}:${submitted.actionId}`;
      next.actionUses[useKey] = (next.actionUses[useKey] ?? 0) + 1;
      const historyKey = `${submitted.actorId}:${submitted.actionId}:${event.day}`;
      const previousTargets = next.protectionHistory[historyKey] ?? [];
      next.protectionHistory[historyKey] = [
        ...new Set([...previousTargets, ...submitted.targetIds]),
      ];
      break;
    case "night.resolved":
      next.pendingNightActions = [];
      break;
    case "vote.cast":
      next.votes.push(event.payload.vote as CastVote);
      break;
    case "vote.resolved":
      next.votes = [];
      break;
    case "player.eliminated": {
      const player = next.players.find((candidate) => candidate.id === event.payload.playerId);
      if (player) {
        player.alive = false;
        if (next.config.revealRolesOnDeath) player.revealedRole = player.role.name;
      }
      break;
    }
    case "role.revealed": {
      const player = next.players.find((candidate) => candidate.id === event.payload.playerId);
      if (player && typeof event.payload.roleName === "string")
        player.revealedRole = event.payload.roleName;
      break;
    }
    case "game.ended":
      next.status = "completed";
      next.phase = "ended";
      next.winnerAlignments = event.payload.winnerAlignments as Alignment[];
      next.winnerPlayerIds = event.payload.winnerPlayerIds as string[];
      next.outcomeReason = String(event.payload.reason);
      break;
    default:
      break;
  }
  return next;
}

function isV2Config(
  config: StoredGameConfig,
): config is Extract<StoredGameConfig, { schemaVersion: "game_config_v2" }> {
  return config.schemaVersion === "game_config_v2";
}

function isV2MetadataAuditEvent(config: StoredGameConfig, event: GameEventV1): boolean {
  if (!isV2Config(config)) return false;
  if (event.payload.metadata === true || event.payload.audit === true) return true;
  return (
    event.type.startsWith("model.") ||
    event.type.startsWith("audit.") ||
    event.type.startsWith("callback.") ||
    event.type.startsWith("decision.") ||
    event.type.startsWith("deliberation.") ||
    event.type.startsWith("journal.") ||
    event.type.endsWith(".audit")
  );
}

export function transition(state: GameState, phase: GamePhase, day = state.day): EngineEventInput {
  return {
    type: "phase.changed",
    phase,
    day,
    visibility: "public",
    payload: { from: state.phase, to: phase },
  };
}

export function getAction(
  state: GameState,
  actorId: string,
  actionId: string,
): RoleActionV1 | undefined {
  return state.players
    .find((player) => player.id === actorId)
    ?.role.actions.find((action) => action.id === actionId);
}

export function validateNightAction(
  state: GameState,
  submitted: SubmittedNightAction,
  options: { forResolution?: boolean; forTeamPoint?: boolean } = {},
): string[] {
  const actor = state.players.find((player) => player.id === submitted.actorId);
  if (!actor || !actor.alive) return ["actor is not alive"];
  if (options.forTeamPoint) {
    if (state.phase !== "night_team") return ["team points are not currently accepted"];
  } else if (state.phase !== "night_actions") {
    return ["night actions are not currently accepted"];
  }
  const action = getAction(state, submitted.actorId, submitted.actionId);
  if (!action) return ["action is not available to this role"];
  if (
    options.forTeamPoint &&
    (action.effect !== "eliminate" || action.teamAggregation === "none")
  ) {
    return ["action is not a coordinated elimination"];
  }
  const uses = state.actionUses[`${submitted.actorId}:${submitted.actionId}`] ?? 0;
  if (
    !options.forResolution &&
    !options.forTeamPoint &&
    state.pendingNightActions.some((item) => item.actorId === submitted.actorId)
  ) {
    return ["actor already submitted a night action"];
  }
  if (!options.forResolution && action.charges !== undefined && uses >= action.charges) {
    return ["action has no charges remaining"];
  }
  if (
    submitted.targetIds.length < action.target.min ||
    submitted.targetIds.length > action.target.max
  ) {
    return [`action requires ${action.target.min}-${action.target.max} targets`];
  }
  if (new Set(submitted.targetIds).size !== submitted.targetIds.length)
    return ["targets must be unique"];
  const errors: string[] = [];
  const previousTargets =
    action.target.allowConsecutiveTarget === false
      ? (state.protectionHistory[`${submitted.actorId}:${submitted.actionId}:${state.day - 1}`] ??
        [])
      : [];
  for (const targetId of submitted.targetIds) {
    const target = state.players.find((player) => player.id === targetId);
    if (!target) {
      errors.push(`unknown target ${targetId}`);
      continue;
    }
    if (!action.target.allowSelf && target.id === actor.id)
      errors.push("self-targeting is not allowed");
    if (action.target.aliveOnly && !target.alive) errors.push(`${target.name} is not alive`);
    if (
      action.target.allowedAlignments &&
      !action.target.allowedAlignments.includes(target.role.alignment)
    ) {
      errors.push(`${target.name} does not have an allowed alignment`);
    }
    if (action.target.deniedAlignments?.includes(target.role.alignment)) {
      errors.push(`${target.name} has a denied alignment`);
    }
    if (previousTargets.includes(targetId))
      errors.push("same target is not allowed on consecutive nights");
  }
  return errors;
}

function pluralityTarget(actions: SubmittedNightAction[], seed: string): string | undefined {
  const counts = new Map<string, number>();
  for (const action of actions) {
    const target = action.targetIds[0];
    if (target) counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  const highest = Math.max(0, ...counts.values());
  const tied = [...counts.entries()]
    .filter(([, count]) => count === highest)
    .map(([id]) => id)
    .sort();
  return seededChoice(tied, seed);
}

function teamGroup(state: GameState, actorId: string): string {
  const actor = state.players.find((player) => player.id === actorId);
  return actor?.role.passives.teamChannel ?? actor?.role.alignment ?? actorId;
}

function unanimousTarget(
  state: GameState,
  group: string,
  submissions: readonly SubmittedNightAction[],
  v2 = false,
): string | undefined {
  const expectedActors = state.players
    .filter(
      (player) =>
        player.alive &&
        teamGroup(state, player.id) === group &&
        (v2 ||
          player.role.actions.some(
            (action) => action.effect === "eliminate" && action.teamAggregation === "unanimity",
          )),
    )
    .map((player) => player.id);
  const submittedActors = new Set(submissions.map((submission) => submission.actorId));
  if (
    submissions.length !== submittedActors.size ||
    submittedActors.size !== expectedActors.length ||
    expectedActors.some((actorId) => !submittedActors.has(actorId))
  ) {
    return undefined;
  }
  const targets = new Set(submissions.map((submission) => submission.targetIds[0]).filter(Boolean));
  return targets.size === 1 ? [...targets][0] : undefined;
}

export function resolveNight(state: GameState): EngineEventInput[] {
  const v2 = isV2Config(state.config);
  const valid = state.pendingNightActions.filter(
    (action) => validateNightAction(state, action, { forResolution: true }).length === 0,
  );
  const blocked = new Set(
    valid
      .filter(
        (submitted) => getAction(state, submitted.actorId, submitted.actionId)?.effect === "block",
      )
      .flatMap((submitted) => submitted.targetIds),
  );
  const active = valid.filter((submitted) => !blocked.has(submitted.actorId));
  const protectedIds = new Set(
    active
      .filter(
        (submitted) =>
          getAction(state, submitted.actorId, submitted.actionId)?.effect === "protect",
      )
      .flatMap((submitted) => submitted.targetIds),
  );
  const events: EngineEventInput[] = [];
  const eliminateActions = (v2 ? valid : active).filter(
    (submitted) => getAction(state, submitted.actorId, submitted.actionId)?.effect === "eliminate",
  );
  const grouped = new Map<
    string,
    {
      aggregation: RoleActionV1["teamAggregation"];
      group: string;
      submissions: SubmittedNightAction[];
    }
  >();
  for (const submitted of eliminateActions) {
    const action = getAction(state, submitted.actorId, submitted.actionId)!;
    const group =
      action.teamAggregation === "none" ? submitted.actorId : teamGroup(state, submitted.actorId);
    const key = `${action.teamAggregation}:${group}`;
    const existing = grouped.get(key);
    grouped.set(key, {
      aggregation: action.teamAggregation,
      group,
      submissions: [...(existing?.submissions ?? []), submitted],
    });
  }
  const eliminated = new Set<string>();
  const skippedUnanimousGroups: string[] = [];
  for (const { aggregation, group, submissions } of grouped.values()) {
    const executableSubmissions =
      v2 && aggregation !== "unanimity"
        ? submissions.filter((submission) => !blocked.has(submission.actorId))
        : submissions;
    let target =
      aggregation === "unanimity"
        ? unanimousTarget(state, group, submissions, v2)
        : pluralityTarget(
            executableSubmissions,
            `${state.config.seed}:night:${state.day}:${group}`,
          );
    if (v2 && aggregation === "unanimity" && target) {
      const hasUnblockedConsenter = submissions.some(
        (submission) => submission.targetIds[0] === target && !blocked.has(submission.actorId),
      );
      if (!hasUnblockedConsenter) target = undefined;
    }
    if (!target && aggregation === "unanimity") skippedUnanimousGroups.push(group);
    if (target && !protectedIds.has(target)) eliminated.add(target);
  }
  for (const targetId of eliminated) {
    const player = state.players.find((candidate) => candidate.id === targetId)!;
    events.push({
      type: "player.eliminated",
      phase: "night_resolution",
      day: state.day,
      visibility: "public",
      payload: {
        playerId: targetId,
        playerName: player.name,
        roleName: state.config.revealRolesOnDeath ? player.role.name : undefined,
        cause: "night",
      },
    });
  }
  for (const submitted of active) {
    const action = getAction(state, submitted.actorId, submitted.actionId)!;
    if (!action.effect.startsWith("inspect")) continue;
    const target = state.players.find((player) => player.id === submitted.targetIds[0]);
    if (!target) continue;
    events.push({
      type: "inspection.delivered",
      phase: "night_resolution",
      day: state.day,
      visibility: "player",
      audienceIds: [submitted.actorId],
      payload: {
        actorId: submitted.actorId,
        targetId: target.id,
        targetName: target.name,
        result: action.effect === "inspect_role" ? target.role.name : target.role.alignment,
      },
    });
  }
  for (const submitted of active) {
    const action = getAction(state, submitted.actorId, submitted.actionId)!;
    if (action.effect !== "reveal") continue;
    const target = state.players.find((player) => player.id === submitted.targetIds[0]);
    if (target) {
      events.push({
        type: "role.revealed",
        phase: "night_resolution",
        day: state.day,
        visibility: "public",
        payload: { playerId: target.id, playerName: target.name, roleName: target.role.name },
      });
    }
  }
  events.push({
    type: "night.resolved",
    phase: "night_resolution",
    day: state.day,
    visibility: "moderator",
    payload: {
      blockedActorIds: [...blocked],
      protectedPlayerIds: [...protectedIds],
      eliminatedPlayerIds: [...eliminated],
      skippedUnanimousGroups,
    },
  });
  return events;
}

export function resolveVote(state: GameState): {
  targetId?: string;
  tally: Record<string, number>;
  tied: boolean;
} {
  const tally: Record<string, number> = {};
  for (const vote of state.votes) {
    if (!vote.targetId) continue;
    const voter = state.players.find((player) => player.id === vote.voterId);
    const target = state.players.find((player) => player.id === vote.targetId);
    if (!voter?.alive || !target?.alive || voter.id === target.id) continue;
    tally[target.id] = (tally[target.id] ?? 0) + voter.role.passives.voteWeight;
  }
  const highest = Math.max(0, ...Object.values(tally));
  const leaders = Object.entries(tally)
    .filter(([, count]) => count === highest && highest > 0)
    .map(([id]) => id)
    .sort();
  return {
    targetId: leaders.length === 1 ? leaders[0] : undefined,
    tally,
    tied: leaders.length !== 1,
  };
}

function predicateMatches(predicate: WinPredicateV1, state: GameState, selfId: string): boolean {
  const alive = state.players.filter((player) => player.alive);
  switch (predicate.kind) {
    case "alignment_eliminated":
      return alive.every((player) => player.role.alignment !== predicate.alignment);
    case "alignment_parity": {
      const own = alive.filter((player) => player.role.alignment === predicate.alignment).length;
      const opposing = alive.filter((player) =>
        predicate.against.includes(player.role.alignment),
      ).length;
      return own > 0 && own >= opposing;
    }
    case "self_alive":
      return Boolean(state.players.find((player) => player.id === selfId)?.alive);
    case "all":
      return predicate.predicates.every((child) => predicateMatches(child, state, selfId));
    case "any":
      return predicate.predicates.some((child) => predicateMatches(child, state, selfId));
    case "not":
      return !predicateMatches(predicate.predicate, state, selfId);
  }
}

export function checkWinners(state: GameState): EngineEventInput | undefined {
  const terminalWinners = state.players.filter(
    (player) =>
      player.role.winCondition.terminal &&
      predicateMatches(player.role.winCondition.predicate, state, player.id),
  );
  if (terminalWinners.length === 0) return undefined;
  const alignments = [...new Set(terminalWinners.map((player) => player.role.alignment))];
  const allWinners = state.players.filter((player) =>
    predicateMatches(player.role.winCondition.predicate, state, player.id),
  );
  return {
    type: "game.ended",
    phase: "ended",
    day: state.day,
    visibility: "public",
    payload: {
      winnerAlignments: alignments,
      winnerPlayerIds: allWinners.map((player) => player.id),
      reason: alignments.map((alignment) => `${alignment} win condition satisfied`).join("; "),
    },
  };
}

export function emptyJournal(): PrivateJournalV1 {
  return { beliefs: [], goals: [], strategy: "", unresolvedQuestions: [] };
}
