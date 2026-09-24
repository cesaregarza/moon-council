import type { GameEventV1, PlayerViewV1, PrivateJournalV1 } from "@werewolf/contracts";
import type { GameState } from "./engine";

export type Viewer =
  | { kind: "public" }
  | { kind: "moderator" }
  | { kind: "player"; playerId: string }
  | { kind: "team"; teamId: string };

export function eventVisibleTo(event: GameEventV1, viewer: Viewer): boolean {
  if (viewer.kind === "moderator") return true;
  if (event.visibility === "public") return true;
  if (viewer.kind === "player" && event.visibility === "player") return event.audienceIds.includes(viewer.playerId);
  if (viewer.kind === "player" && event.visibility === "team") return event.audienceIds.includes(viewer.playerId);
  if (viewer.kind === "team" && event.visibility === "team") return event.audienceIds.includes(viewer.teamId);
  return false;
}

export function projectEvents(events: readonly GameEventV1[], viewer: Viewer): GameEventV1[] {
  return events.filter((event) => eventVisibleTo(event, viewer));
}

export function projectPlayer(
  state: GameState,
  events: readonly GameEventV1[],
  playerId: string,
  journal: PrivateJournalV1,
): PlayerViewV1 {
  const self = state.players.find((player) => player.id === playerId);
  if (!self) throw new Error(`Unknown player ${playerId}`);
  const visible = projectEvents(events, { kind: "player", playerId });
  const knowsTeam = self.role.knowledge.includes("alignment_team");
  return {
    gameId: state.gameId,
    phase: state.phase,
    day: state.day,
    self: { id: self.id, name: self.name, alive: self.alive, role: self.role },
    knownAllies: knowsTeam
      ? state.players
          .filter((player) => player.id !== self.id && player.role.alignment === self.role.alignment)
          .map((player) => ({ id: player.id, name: player.name }))
      : [],
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      alive: player.alive,
      ...(player.revealedRole ? { revealedRole: player.revealedRole } : {}),
    })),
    publicEvents: visible.filter((event) => event.visibility === "public"),
    teamEvents: visible.filter(
      (event) =>
        event.visibility === "team" &&
        ["team.pointed", "team.consensus_reached", "team.consensus_failed"].includes(event.type),
    ),
    privateEvents: visible.filter((event) => event.visibility === "player"),
    journal,
    availableActions: self.alive && state.phase === "night_actions" ? self.role.actions : [],
  };
}

export function moderatorSnapshot(state: GameState, events: readonly GameEventV1[], journals: Record<string, PrivateJournalV1>) {
  return {
    ...state,
    events: projectEvents(events, { kind: "moderator" }),
    journals,
  };
}

