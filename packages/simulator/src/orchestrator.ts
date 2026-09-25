import {
  InitiativeDecisionSchema,
  NightActionDecisionSchema,
  SpeechDecisionSchema,
  TeamPointDecisionSchema,
  VoteDecisionSchema,
  type AgentDecisionV1,
  type GameEventV1,
  type InitiativeDecisionSchema as InitiativeSchemaType,
  type PrivateJournalV1,
  type ProviderUsageV1,
} from "@werewolf/contracts";
import { LabRepository, type GameRecord } from "@werewolf/db";
import {
  checkWinners,
  createGameCreatedEvent,
  createGameState,
  discussionReady,
  projectPlayer,
  reduceGame,
  resolveNight,
  resolveVote,
  selectFollowUp,
  shuffled,
  transition,
  validateNightAction,
  type GameState,
  type InitiativeCandidate,
  type SubmittedNightAction,
} from "@werewolf/engine";
import {
  decideWithRepair,
  resolveDefaultModel,
  resolveModeratorModel,
  type DecisionKind,
  type DecisionProvider,
} from "@werewolf/llm";
import { z } from "zod";
import { V2GameOrchestrator } from "./orchestrator-v2";

const NarrationSchema = z.object({ text: z.string().min(1).max(800) });
type InitiativeDecision = z.infer<typeof InitiativeSchemaType>;
const TEAM_POINT_TURNS_PER_PLAYER = 3;

class BudgetExhaustedError extends Error {}
class ProviderOutageError extends Error {}

export class GameOrchestrator {
  constructor(
    private readonly repository: LabRepository,
    private readonly provider: DecisionProvider,
    private readonly defaultModel = resolveDefaultModel(),
  ) {}

  initializeGame(game: GameRecord): GameState {
    if (game.config.schemaVersion === "game_config_v2")
      return new V2GameOrchestrator(this.repository, this.provider).initialize(game.id);
    const existing = this.repository.listEvents(game.id);
    if (existing.length > 0) return reduceGame(game.id, existing);
    const state = createGameState(game.id, game.config);
    this.repository.appendEvent(game.id, createGameCreatedEvent(state));
    for (const player of state.players) {
      this.repository.saveJournal(game.id, player.id, {
        beliefs: [],
        goals: [],
        strategy: "",
        unresolvedQuestions: [],
      });
    }
    return reduceGame(game.id, this.repository.listEvents(game.id));
  }

  async runGameStep(gameId: string): Promise<void> {
    const game = this.repository.getGame(gameId);
    if (!game) throw new Error(`Unknown game ${gameId}`);
    if (game.config.schemaVersion === "game_config_v2")
      return new V2GameOrchestrator(this.repository, this.provider).runGameStep(gameId);
    if (!["queued", "running", "stepping", "lobby"].includes(game.status)) return;
    this.initializeGame(game);
    const failures = new Set<string>();
    try {
      let state = this.state(gameId);
      this.assertBudget(state);

      if (state.phase === "setup") {
        if (!this.events(gameId).some((event) => event.type === "game.started")) {
          this.repository.appendEvent(gameId, {
            type: "game.started",
            phase: "setup",
            day: 0,
            visibility: "public",
            payload: { startedAt: new Date().toISOString() },
          });
        }
        this.repository.appendEvent(gameId, transition(this.state(gameId), "night_team", 1));
        this.repository.updateGame(gameId, {
          status: game.status === "stepping" ? "stepping" : "running",
        });
        return;
      }

      if (state.phase === "night_team") {
        await this.runTeamDiscussion(state, failures);
        this.ensureNoProviderOutage(failures);
        state = this.state(gameId);
        this.repository.appendEvent(gameId, transition(state, "night_actions"));
        return;
      }

      if (state.phase === "night_actions") {
        await this.collectNightActions(state, failures);
        this.ensureNoProviderOutage(failures);
        state = this.state(gameId);
        const resolved = resolveNight(state);
        this.repository.appendEvents(gameId, resolved);
        state = this.state(gameId);
        const winner = checkWinners(state);
        if (winner) {
          this.repository.appendEvent(gameId, winner);
          this.finishGame(gameId);
          return;
        }
        const eliminated = resolved
          .filter((event) => event.type === "player.eliminated")
          .map((event) => ({
            playerName: event.payload.playerName,
            ...(event.payload.roleName ? { roleName: event.payload.roleName } : {}),
          }));
        const text =
          eliminated.length > 0
            ? eliminated
                .map(
                  (player) =>
                    `${player.playerName} was eliminated overnight${player.roleName ? ` and was ${player.roleName}` : ""}.`,
                )
                .join(" ")
            : "Dawn breaks. Nobody was eliminated overnight.";
        const narration = await this.narrate(state, {
          kind: "night_result",
          eliminated,
          fallbackText: text,
        });
        this.repository.appendEvent(gameId, {
          type: "moderator.announcement",
          phase: "day_announcement",
          day: state.day,
          visibility: "public",
          payload: { text: narration, disclosure: { eliminated } },
        });
        this.repository.appendEvent(gameId, transition(this.state(gameId), "day_announcement"));
        return;
      }

      if (state.phase === "day_announcement") {
        this.repository.appendEvent(gameId, transition(state, "day_discussion"));
        return;
      }

      if (state.phase === "day_discussion") {
        await this.runPublicDiscussion(state, failures);
        this.ensureNoProviderOutage(failures);
        this.repository.appendEvent(gameId, transition(this.state(gameId), "day_vote"));
        return;
      }

      if (state.phase === "day_vote") {
        await this.collectVotes(state, failures);
        this.ensureNoProviderOutage(failures);
        state = this.state(gameId);
        const result = resolveVote(state);
        const target = result.targetId
          ? state.players.find((player) => player.id === result.targetId)
          : undefined;
        this.repository.appendEvent(gameId, {
          type: "vote.resolved",
          phase: "day_resolution",
          day: state.day,
          visibility: "public",
          payload: {
            tally: result.tally,
            tied: result.tied,
            targetId: result.targetId,
            targetName: target?.name,
          },
        });
        if (target) {
          this.repository.appendEvent(gameId, {
            type: "player.eliminated",
            phase: "day_resolution",
            day: state.day,
            visibility: "public",
            payload: {
              playerId: target.id,
              playerName: target.name,
              roleName: state.config.revealRolesOnDeath ? target.role.name : undefined,
              cause: "vote",
            },
          });
        }
        state = this.state(gameId);
        const winner = checkWinners(state);
        if (winner) {
          this.repository.appendEvent(gameId, winner);
          this.finishGame(gameId);
          return;
        }
        if (state.day >= state.config.safety.maxCycles) {
          throw new BudgetExhaustedError("maximum day/night cycles reached");
        }
        this.repository.appendEvent(gameId, transition(state, "night_team", state.day + 1));
      }
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        const state = this.state(gameId);
        this.repository.appendEvent(gameId, {
          type: "game.budget_exhausted",
          phase: "ended",
          day: state.day,
          visibility: "public",
          payload: { reason: error.message },
        });
        this.repository.updateGame(gameId, {
          status: "budget_exhausted",
          outcome: { reason: error.message },
        });
        return;
      }
      if (error instanceof ProviderOutageError) {
        const state = this.state(gameId);
        this.repository.appendEvent(gameId, {
          type: "game.paused",
          phase: state.phase,
          day: state.day,
          visibility: "public",
          payload: { reason: error.message },
        });
        this.repository.updateGame(gameId, { status: "paused", error: error.message });
        return;
      }
      throw error;
    }
  }

  async runToCompletion(gameId: string): Promise<void> {
    for (let step = 0; step < 100; step += 1) {
      const game = this.repository.getGame(gameId);
      if (!game || ["completed", "aborted", "budget_exhausted", "failed"].includes(game.status))
        return;
      if (game.status === "paused") throw new Error(`Game ${gameId} paused during batch execution`);
      this.repository.updateGame(gameId, { status: "running" });
      await this.runGameStep(gameId);
    }
    throw new Error(`Game ${gameId} exceeded the runner step limit`);
  }

  private events(gameId: string): GameEventV1[] {
    return this.repository.listEvents(gameId);
  }

  private state(gameId: string): GameState {
    return reduceGame(gameId, this.events(gameId));
  }

  private assertBudget(state: GameState): void {
    if (state.modelCalls >= state.config.safety.maxModelCalls) {
      throw new BudgetExhaustedError("maximum model calls reached");
    }
    if (
      state.startedAt &&
      Date.now() - Date.parse(state.startedAt) >= state.config.safety.maxWallClockMs
    ) {
      throw new BudgetExhaustedError("maximum wall-clock duration reached");
    }
  }

  private ensureNoProviderOutage(failures: Set<string>): void {
    if (failures.size >= 3) {
      throw new ProviderOutageError("model provider failed for three distinct seats");
    }
  }

  private async askPlayer<T extends AgentDecisionV1>(
    gameId: string,
    playerId: string,
    kind: DecisionKind,
    schemaName: string,
    schema: z.ZodType<T>,
    failures: Set<string>,
    validate?: (decision: T, state: GameState) => string[],
    availableActionIds?: readonly string[],
  ): Promise<T | undefined> {
    const state = this.state(gameId);
    this.assertBudget(state);
    const player = state.players.find((candidate) => candidate.id === playerId);
    if (!player?.alive) return undefined;
    const view = projectPlayer(
      state,
      this.events(gameId),
      playerId,
      this.repository.getJournal(gameId, playerId),
    );
    if (availableActionIds) {
      const allowed = new Set(availableActionIds);
      view.availableActions = view.availableActions.filter((action) => allowed.has(action.id));
    }
    const model = player.model ?? this.defaultModel;
    const attempt = await decideWithRepair(
      this.provider,
      {
        kind,
        playerId,
        model,
        personality: player.personality,
        view,
        schemaName,
        schema,
        maxOutputTokens: state.config.safety.maxOutputTokens,
      },
      (decision) => validate?.(decision, this.state(gameId)) ?? [],
    );
    this.repository.appendEvent(gameId, {
      type: "model.call_recorded",
      phase: state.phase,
      day: state.day,
      visibility: "moderator",
      payload: {
        playerId,
        kind,
        model,
        attempts: attempt.attempts,
        success: Boolean(attempt.result),
      },
    });
    if (!attempt.result) {
      if (attempt.providerFailure) failures.add(playerId);
      this.repository.appendEvent(gameId, {
        type: "model.failure",
        phase: state.phase,
        day: state.day,
        visibility: "moderator",
        payload: { playerId, kind, errors: attempt.errors, safeFallback: true },
      });
      return undefined;
    }
    const result = attempt.result;
    this.repository.saveJournal(gameId, playerId, result.data.journal);
    this.repository.appendEvent(gameId, {
      type: "journal.updated",
      phase: state.phase,
      day: state.day,
      visibility: "player",
      audienceIds: [playerId],
      payload: { playerId, journal: result.data.journal },
    });
    this.recordUsage(gameId, playerId, result.provider, result.model, result.usage);
    return result.data;
  }

  private recordUsage(
    gameId: string,
    playerId: string | undefined,
    provider: string,
    model: string,
    usage: ProviderUsageV1,
  ): void {
    this.repository.recordUsage(gameId, playerId, provider, model, usage);
  }

  private async runTeamDiscussion(state: GameState, failures: Set<string>): Promise<void> {
    const teams = new Map<string, string[]>();
    for (const player of state.players.filter(
      (candidate) =>
        candidate.alive &&
        candidate.role.passives.teamChannel &&
        candidate.role.actions.some(
          (action) => action.effect === "eliminate" && action.teamAggregation !== "none",
        ),
    )) {
      const team = player.role.passives.teamChannel!;
      teams.set(team, [...(teams.get(team) ?? []), player.id]);
    }
    for (const [team, playerIds] of teams) {
      const order = shuffled(playerIds, `${state.config.seed}:team:${state.day}`);
      const maxTurns = TEAM_POINT_TURNS_PER_PLAYER * playerIds.length;
      const priorEvents = this.events(state.gameId);
      if (
        priorEvents.some(
          (event) =>
            ["team.consensus_reached", "team.consensus_failed"].includes(event.type) &&
            event.day === state.day &&
            event.payload.team === team,
        )
      ) {
        continue;
      }
      const latestPoints = new Map<string, string>();
      const priorPoints = priorEvents.filter(
        (event) =>
          event.type === "team.pointed" &&
          event.day === state.day &&
          event.payload.team === team &&
          playerIds.includes(String(event.payload.playerId)),
      );
      for (const event of priorPoints) {
        latestPoints.set(String(event.payload.playerId), String(event.payload.targetId));
      }
      const agreedTarget = () => {
        if (latestPoints.size !== playerIds.length) return undefined;
        const targets = new Set(latestPoints.values());
        return targets.size === 1 ? [...targets][0] : undefined;
      };
      let consensusTarget = agreedTarget();
      let turns = priorPoints.length;
      while (!consensusTarget && turns < maxTurns) {
        const playerId = order[turns % order.length]!;
        const player = this.state(state.gameId).players.find(
          (candidate) => candidate.id === playerId,
        );
        const teamAction = player?.role.actions.find(
          (action) => action.effect === "eliminate" && action.teamAggregation !== "none",
        );
        if (!teamAction) {
          turns += 1;
          continue;
        }
        const decision = await this.askPlayer(
          state.gameId,
          playerId,
          "team_point",
          "team_point",
          TeamPointDecisionSchema,
          failures,
          (candidate, current) =>
            validateNightAction(
              current,
              {
                actorId: playerId,
                actionId: teamAction.id,
                targetIds: [candidate.targetId],
              },
              { forTeamPoint: true },
            ),
        );
        turns += 1;
        if (!decision) continue;
        latestPoints.set(playerId, decision.targetId);
        const target = this.state(state.gameId).players.find(
          (candidate) => candidate.id === decision.targetId,
        );
        this.repository.appendEvent(state.gameId, {
          type: "team.pointed",
          phase: "night_team",
          day: state.day,
          visibility: "team",
          audienceIds: playerIds,
          payload: {
            team,
            playerId,
            targetId: decision.targetId,
            targetName: target?.name,
            turn: turns,
            maxTurns,
          },
        });
        consensusTarget = agreedTarget();
      }
      if (consensusTarget) {
        const target = this.state(state.gameId).players.find(
          (candidate) => candidate.id === consensusTarget,
        );
        this.repository.appendEvent(state.gameId, {
          type: "team.consensus_reached",
          phase: "night_team",
          day: state.day,
          visibility: "team",
          audienceIds: playerIds,
          payload: {
            team,
            targetId: consensusTarget,
            targetName: target?.name,
            turns,
            participants: playerIds.length,
          },
        });
      } else {
        this.repository.appendEvent(state.gameId, {
          type: "team.consensus_failed",
          phase: "night_team",
          day: state.day,
          visibility: "team",
          audienceIds: playerIds,
          payload: { team, reason: "turn_limit", turns: maxTurns, maxTurns },
        });
      }
    }
  }

  private async collectNightActions(state: GameState, failures: Set<string>): Promise<void> {
    const coordinatedActors = new Set<string>();
    const teams = new Map<string, { playerIds: string[]; actionIds: Map<string, string> }>();
    for (const player of state.players.filter((candidate) => candidate.alive)) {
      const action = player.role.actions.find(
        (candidate) => candidate.effect === "eliminate" && candidate.teamAggregation !== "none",
      );
      const team = player.role.passives.teamChannel;
      if (!action || !team) continue;
      coordinatedActors.add(player.id);
      const entry = teams.get(team) ?? { playerIds: [], actionIds: new Map<string, string>() };
      entry.playerIds.push(player.id);
      entry.actionIds.set(player.id, action.id);
      teams.set(team, entry);
    }
    const events = this.events(state.gameId);
    for (const [team, { playerIds, actionIds }] of teams) {
      const consensus = [...events]
        .reverse()
        .find(
          (event) =>
            event.type === "team.consensus_reached" &&
            event.day === state.day &&
            event.payload.team === team,
        );
      if (!consensus || typeof consensus.payload.targetId !== "string") {
        this.repository.appendEvent(state.gameId, {
          type: "night.team_action_skipped",
          phase: "night_actions",
          day: state.day,
          visibility: "moderator",
          payload: { team, reason: "no_unanimous_target" },
        });
        continue;
      }
      let accepted = 0;
      for (const playerId of playerIds) {
        const action: SubmittedNightAction = {
          actorId: playerId,
          actionId: actionIds.get(playerId)!,
          targetIds: [consensus.payload.targetId],
        };
        const errors = validateNightAction(this.state(state.gameId), action);
        if (errors.length > 0) {
          this.repository.appendEvent(state.gameId, {
            type: "night.action_rejected",
            phase: "night_actions",
            day: state.day,
            visibility: "moderator",
            payload: { action, errors, source: "team_consensus" },
          });
          continue;
        }
        this.repository.appendEvent(state.gameId, {
          type: "night.action_submitted",
          phase: "night_actions",
          day: state.day,
          visibility: "moderator",
          payload: { action, source: "team_consensus" },
        });
        accepted += 1;
      }
      if (accepted !== playerIds.length) {
        this.repository.appendEvent(state.gameId, {
          type: "night.team_action_skipped",
          phase: "night_actions",
          day: state.day,
          visibility: "moderator",
          payload: {
            team,
            reason: "consensus_action_rejected",
            accepted,
            required: playerIds.length,
          },
        });
      }
    }

    for (const player of shuffled(
      state.players.filter(
        (candidate) =>
          candidate.alive &&
          !coordinatedActors.has(candidate.id) &&
          candidate.role.actions.some((action) => action.teamAggregation === "none"),
      ),
      `${state.config.seed}:night-actions:${state.day}`,
    )) {
      const individualActionIds = player.role.actions
        .filter((action) => action.teamAggregation === "none")
        .map((action) => action.id);
      const decision = await this.askPlayer(
        state.gameId,
        player.id,
        "night_action",
        "night_action",
        NightActionDecisionSchema,
        failures,
        (candidate, current) => {
          if (!individualActionIds.includes(candidate.actionId)) {
            return ["coordinated actions use team pointing"];
          }
          return validateNightAction(current, {
            actorId: player.id,
            actionId: candidate.actionId,
            targetIds: candidate.targetIds,
          });
        },
        individualActionIds,
      );
      if (!decision) {
        this.repository.appendEvent(state.gameId, {
          type: "night.action_passed",
          phase: "night_actions",
          day: state.day,
          visibility: "moderator",
          payload: { playerId: player.id, safeFallback: true },
        });
        continue;
      }
      const action: SubmittedNightAction = {
        actorId: player.id,
        actionId: decision.actionId,
        targetIds: decision.targetIds,
      };
      this.repository.appendEvent(state.gameId, {
        type: "night.action_submitted",
        phase: "night_actions",
        day: state.day,
        visibility: "moderator",
        payload: { action },
      });
    }
  }

  private async runPublicDiscussion(state: GameState, failures: Set<string>): Promise<void> {
    const order = shuffled(
      state.players.filter((player) => player.alive).map((player) => player.id),
      `${state.config.seed}:discussion:${state.day}`,
    );
    let lastSpeaker: string | undefined;
    const lastSpoke = new Map<string, number>();
    for (const playerId of order) {
      const initiative = await this.askPlayer(
        state.gameId,
        playerId,
        "initiative",
        "initiative",
        InitiativeDecisionSchema,
        failures,
      );
      if (initiative?.intent !== "speak") {
        this.repository.appendEvent(state.gameId, {
          type: "discussion.pass",
          phase: "day_discussion",
          day: state.day,
          visibility: "public",
          payload: { playerId, intent: initiative?.intent ?? "pass" },
        });
        continue;
      }
      const speech = await this.askPlayer(
        state.gameId,
        playerId,
        "speech",
        "speech",
        SpeechDecisionSchema,
        failures,
      );
      if (!speech) continue;
      const event = this.repository.appendEvent(state.gameId, {
        type: "message.public",
        phase: "day_discussion",
        day: state.day,
        visibility: "public",
        payload: {
          playerId,
          text: speech.text,
          followUp: false,
          replyToEventId: speech.replyToEventId,
        },
      });
      lastSpeaker = playerId;
      lastSpoke.set(playerId, event.sequence);
    }

    const living = this.state(state.gameId).players.filter((player) => player.alive);
    const maxSlots = Math.ceil(living.length * state.config.discussion.maxFollowUpSlotsFactor);
    const followUps = new Map<string, number>();
    for (let slot = 0; slot < maxSlots; slot += 1) {
      const eligible = living.filter((player) => player.id !== lastSpeaker);
      const decisions = await Promise.all(
        eligible.map(async (player) => ({
          player,
          decision: await this.askPlayer(
            state.gameId,
            player.id,
            "initiative",
            "initiative",
            InitiativeDecisionSchema,
            failures,
          ),
        })),
      );
      const available = decisions.filter(
        (item): item is { player: (typeof living)[number]; decision: InitiativeDecision } =>
          Boolean(item.decision),
      );
      if (
        discussionReady(
          available.map((item) => item.decision),
          living.length,
          state.config.discussion.readyQuorum,
        )
      ) {
        break;
      }
      const candidates: InitiativeCandidate[] = available.map(({ player, decision }) => ({
        playerId: player.id,
        decision,
        lastSpokeAt: lastSpoke.get(player.id) ?? -1,
        followUpsUsed: followUps.get(player.id) ?? 0,
      }));
      const selected = selectFollowUp(
        candidates,
        `${state.config.seed}:follow-up:${state.day}:${slot}`,
        state.config.discussion.maxFollowUpsPerPlayer,
      );
      if (!selected) break;
      const speech = await this.askPlayer(
        state.gameId,
        selected.playerId,
        "speech",
        "speech",
        SpeechDecisionSchema,
        failures,
      );
      if (!speech) continue;
      const event = this.repository.appendEvent(state.gameId, {
        type: "message.public",
        phase: "day_discussion",
        day: state.day,
        visibility: "public",
        payload: {
          playerId: selected.playerId,
          text: speech.text,
          followUp: true,
          replyToEventId: speech.replyToEventId ?? selected.decision.replyToEventId,
        },
      });
      followUps.set(selected.playerId, (followUps.get(selected.playerId) ?? 0) + 1);
      lastSpoke.set(selected.playerId, event.sequence);
      lastSpeaker = selected.playerId;
    }
    this.repository.appendEvent(state.gameId, {
      type: "discussion.ended",
      phase: "day_discussion",
      day: state.day,
      visibility: "public",
      payload: { followUps: Object.fromEntries(followUps), maxSlots },
    });
  }

  private async collectVotes(state: GameState, failures: Set<string>): Promise<void> {
    for (const player of shuffled(
      state.players.filter((candidate) => candidate.alive),
      `${state.config.seed}:vote:${state.day}`,
    )) {
      const decision = await this.askPlayer(
        state.gameId,
        player.id,
        "vote",
        "vote",
        VoteDecisionSchema,
        failures,
        (candidate, current) => {
          if (candidate.targetId === null) return [];
          const target = current.players.find((item) => item.id === candidate.targetId);
          if (!target?.alive) return ["vote target must be a living player"];
          if (target.id === player.id) return ["self-voting is not allowed"];
          return [];
        },
      );
      this.repository.appendEvent(state.gameId, {
        type: "vote.cast",
        phase: "day_vote",
        day: state.day,
        visibility: "moderator",
        payload: {
          vote: { voterId: player.id, targetId: decision?.targetId ?? null },
          safeFallback: !decision,
        },
      });
    }
  }

  private async narrate(state: GameState, packet: Record<string, unknown>): Promise<string> {
    const fallback = String(packet.fallbackText ?? "The moderator advances the game.");
    if (!state.config.moderatorNarration) return fallback;
    const model = state.config.moderatorModel ?? resolveModeratorModel(this.defaultModel);
    const attempt = await decideWithRepair(this.provider, {
      kind: "narration",
      model,
      disclosurePacket: packet,
      schemaName: "moderator_narration",
      schema: NarrationSchema,
      maxOutputTokens: Math.min(300, state.config.safety.maxOutputTokens),
    });
    this.repository.appendEvent(state.gameId, {
      type: "model.call_recorded",
      phase: state.phase,
      day: state.day,
      visibility: "moderator",
      payload: {
        playerId: "moderator",
        kind: "narration",
        model,
        attempts: attempt.attempts,
        success: Boolean(attempt.result),
      },
    });
    if (!attempt.result) return fallback;
    this.recordUsage(
      state.gameId,
      undefined,
      attempt.result.provider,
      attempt.result.model,
      attempt.result.usage,
    );
    return attempt.result.data.text;
  }

  private finishGame(gameId: string): void {
    const state = this.state(gameId);
    this.repository.updateGame(gameId, {
      status: "completed",
      outcome: {
        winnerAlignments: state.winnerAlignments,
        winnerPlayerIds: state.winnerPlayerIds,
        reason: state.outcomeReason,
        day: state.day,
      },
      error: null,
    });
  }
}
