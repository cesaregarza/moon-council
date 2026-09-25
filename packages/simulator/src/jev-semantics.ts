import type { PlayerContextV2, V3TaskKind } from "@werewolf/contracts";

export interface SemanticAssessment {
  rule: string;
  applicable: boolean;
  issues: string[];
}

/** A narrow invariant, not a general strategy oracle or confidence threshold. */
export function assessActorChoice(
  packet: PlayerContextV2,
  task: V3TaskKind | undefined,
  choice: string | null,
): SemanticAssessment {
  const result: SemanticAssessment = {
    rule: "verified_last_wolf_ballot_v1",
    applicable: false,
    issues: [],
  };
  const role = packet.self.role;
  const predicate = role.winCondition.predicate;
  const hasWolfEliminationObjective = predicate.kind === "alignment_eliminated"
    && predicate.alignment === "werewolf";
  if (task !== "vote_choice" || !role.winCondition.terminal) return result;
  if (!hasWolfEliminationObjective || role.passives.voteWeight <= 0) return result;

  // Public deck counts are keyed by role name, including when versions differ.
  const catalog = packet.rules.roles as { name: string; alignment: string }[] | undefined;
  const counts = packet.rules.roleCounts as Record<string, number> | undefined;
  if (!catalog || !counts) return result;
  const wolfRoles = new Set(catalog.filter(r => r.alignment === "werewolf").map(r => r.name));
  // A shared name across alignments makes name-only revealed deaths ambiguous.
  if (catalog.some(r => r.alignment !== "werewolf" && wolfRoles.has(r.name))) return result;
  const startingWolves = [...wolfRoles].reduce((total, name) => total + (counts[name] ?? 0), 0);
  const dead = packet.players.filter(player => !player.alive);
  if (dead.some(player => !player.revealedRole)) return result;
  const deadWolves = dead.filter(player => wolfRoles.has(player.revealedRole!)).length;
  if (startingWolves - deadWolves !== 1) return result;

  const knownWolves = new Set<string>();
  for (const source of packet.sources) {
    if (source.type !== "inspection.delivered" || source.scope !== "player") continue;
    if (source.data.actorId !== packet.self.id) continue;
    const { targetId, result: inspection } = source.data;
    const isWolf = inspection === "werewolf" || wolfRoles.has(String(inspection));
    if (isWolf && typeof targetId === "string" && packet.legalTargets.includes(targetId)) {
      knownWolves.add(targetId);
    }
  }
  if (knownWolves.size !== 1) return result;

  const target = [...knownWolves][0]!;
  const handle = String.fromCharCode(97 + packet.legalTargets.indexOf(target));
  result.applicable = true;
  if (choice !== handle) {
    const action = choice === "abstain" ? "abstains" : "targets someone else";
    result.issues.push(
      `Your own verified inspection identifies ${target} as the sole remaining werewolf. `
      + `Eliminating all werewolves is your terminal win condition and voting for ${target} is legal. `
      + `This ballot instead ${action}. Reconsider using your private knowledge, even if it is not publicly known.`,
    );
  }
  return result;
}
