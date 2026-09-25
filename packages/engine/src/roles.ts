import { RoleDefinitionSchema, type RoleDefinitionV1 } from "@werewolf/contracts";

const villageWin = {
  terminal: true,
  predicate: { kind: "alignment_eliminated" as const, alignment: "werewolf" as const },
};

const wolfWin = {
  terminal: true,
  predicate: {
    kind: "alignment_parity" as const,
    alignment: "werewolf" as const,
    against: ["village", "neutral"] as const,
  },
};

export const STARTER_ROLES: RoleDefinitionV1[] = [
  {
    schemaVersion: "role_v1",
    id: "villager",
    version: 1,
    name: "Villager",
    alignment: "village",
    description: "Find and eliminate every werewolf through discussion and voting.",
    knowledge: ["own_role"],
    actions: [],
    passives: { voteWeight: 1 },
    winCondition: villageWin,
  },
  {
    schemaVersion: "role_v1",
    id: "werewolf",
    version: 2,
    name: "Werewolf",
    alignment: "werewolf",
    description:
      "Silently point with the pack at night, survive the day, and reach parity with the village.",
    knowledge: ["own_role", "alignment_team", "team_channel"],
    actions: [
      {
        id: "pack_kill",
        name: "Pack kill",
        description:
          "Unanimously point with every living werewolf at one non-werewolf player to eliminate tonight.",
        phase: "night",
        effect: "eliminate",
        target: {
          min: 1,
          max: 1,
          allowSelf: false,
          aliveOnly: true,
          deniedAlignments: ["werewolf"],
        },
        teamAggregation: "unanimity",
      },
    ],
    passives: { voteWeight: 1, teamChannel: "werewolves" },
    winCondition: wolfWin,
  },
  {
    schemaVersion: "role_v1",
    id: "seer",
    version: 1,
    name: "Seer",
    alignment: "village",
    description: "Each night, learn whether one living player belongs to the werewolf alignment.",
    knowledge: ["own_role"],
    actions: [
      {
        id: "divine_alignment",
        name: "Divine alignment",
        description: "Inspect one other living player's alignment.",
        phase: "night",
        effect: "inspect_alignment",
        target: { min: 1, max: 1, allowSelf: false, aliveOnly: true },
        teamAggregation: "none",
      },
    ],
    passives: { voteWeight: 1 },
    winCondition: villageWin,
  },
  {
    schemaVersion: "role_v1",
    id: "doctor",
    version: 1,
    name: "Doctor",
    alignment: "village",
    description: "Protect one living player from elimination each night, including yourself.",
    knowledge: ["own_role"],
    actions: [
      {
        id: "protect_player",
        name: "Protect",
        description: "Prevent one player from being eliminated tonight.",
        phase: "night",
        effect: "protect",
        target: { min: 1, max: 1, allowSelf: true, aliveOnly: true },
        teamAggregation: "none",
      },
    ],
    passives: { voteWeight: 1 },
    winCondition: villageWin,
  },
  {
    schemaVersion: "role_v1",
    id: "roleblocker",
    version: 1,
    name: "Roleblocker",
    alignment: "village",
    description: "Prevent one other player's night action from resolving.",
    knowledge: ["own_role"],
    actions: [
      {
        id: "block_action",
        name: "Block",
        description: "Block one other living player's night action.",
        phase: "night",
        effect: "block",
        target: { min: 1, max: 1, allowSelf: false, aliveOnly: true },
        teamAggregation: "none",
      },
    ],
    passives: { voteWeight: 1 },
    winCondition: villageWin,
  },
  {
    schemaVersion: "role_v1",
    id: "mayor",
    version: 1,
    name: "Mayor",
    alignment: "village",
    description: "Your public elimination vote counts twice.",
    knowledge: ["own_role"],
    actions: [],
    passives: { voteWeight: 2 },
    winCondition: villageWin,
  },
].map((role) => RoleDefinitionSchema.parse(role));

/** The original Doctor remains available for replay and legacy V1 games. */
export const DOCTOR_V1 = structuredClone(STARTER_ROLES.find((role) => role.id === "doctor")!);

/** Immutable V2 role definition: a Doctor cannot protect the same target twice in a row. */
export const DOCTOR_V2 = RoleDefinitionSchema.parse({
  ...DOCTOR_V1,
  version: 2,
  actions: DOCTOR_V1.actions.map((action) => ({
    ...action,
    target: { ...action.target, allowConsecutiveTarget: false },
  })),
});

/**
 * Replaces the Doctor in the standard preset. A Bodyguard shields someone else and cannot
 * shield itself, so the protective role has to read the table instead of turtling, and it
 * keeps the no-consecutive-target rule the V2 Doctor introduced.
 *
 * A Witch -- one-shot heal plus one-shot poison -- was the other candidate and is the more
 * interesting role, but it needs two night abilities. `context-v2` and the V3 request layer
 * both hardcode `legalActions[0]`, so its second ability would be silently unreachable.
 * See the handoff's deferred work.
 */
export const BODYGUARD = RoleDefinitionSchema.parse({
  schemaVersion: "role_v1",
  id: "bodyguard",
  version: 1,
  name: "Bodyguard",
  alignment: "village",
  description:
    "Each night, shield one other living player from elimination. You cannot shield yourself, and you cannot shield the same player on consecutive nights.",
  knowledge: ["own_role"],
  actions: [
    {
      id: "shield_player",
      name: "Shield",
      description: "Prevent one other player from being eliminated tonight.",
      phase: "night",
      effect: "protect",
      target: { min: 1, max: 1, allowSelf: false, aliveOnly: true, allowConsecutiveTarget: false },
      teamAggregation: "none",
    },
  ],
  passives: { voteWeight: 1 },
  winCondition: villageWin,
});

export function roleById(id: string, version?: number): RoleDefinitionV1 | undefined {
  if (id === "doctor" && version === DOCTOR_V2.version) return structuredClone(DOCTOR_V2);
  if (id === "bodyguard" && (version === undefined || version === BODYGUARD.version))
    return structuredClone(BODYGUARD);
  return STARTER_ROLES.find(
    (role) => role.id === id && (version === undefined || role.version === version),
  );
}
