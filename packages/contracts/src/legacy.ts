import { z } from "zod";

export const AlignmentSchema = z.enum(["village", "werewolf", "neutral"]);
export type Alignment = z.infer<typeof AlignmentSchema>;

export const GamePhaseSchema = z.enum([
  "setup",
  "night_team",
  "night_actions",
  "night_resolution",
  "day_announcement",
  "day_discussion",
  "day_vote",
  "day_resolution",
  "ended",
]);
export type GamePhase = z.infer<typeof GamePhaseSchema>;

export const EffectTypeSchema = z.enum([
  "eliminate",
  "protect",
  "inspect_alignment",
  "inspect_role",
  "block",
  "reveal",
]);
export type EffectType = z.infer<typeof EffectTypeSchema>;

export type WinPredicateV1 =
  | { kind: "alignment_eliminated"; alignment: Alignment }
  | { kind: "alignment_parity"; alignment: Alignment; against: Alignment[] }
  | { kind: "self_alive" }
  | { kind: "all"; predicates: WinPredicateV1[] }
  | { kind: "any"; predicates: WinPredicateV1[] }
  | { kind: "not"; predicate: WinPredicateV1 };

export const WinPredicateSchema: z.ZodType<WinPredicateV1> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("alignment_eliminated"), alignment: AlignmentSchema }),
    z.object({
      kind: z.literal("alignment_parity"),
      alignment: AlignmentSchema,
      against: z.array(AlignmentSchema).min(1),
    }),
    z.object({ kind: z.literal("self_alive") }),
    z.object({ kind: z.literal("all"), predicates: z.array(WinPredicateSchema).min(1) }),
    z.object({ kind: z.literal("any"), predicates: z.array(WinPredicateSchema).min(1) }),
    z.object({ kind: z.literal("not"), predicate: WinPredicateSchema }),
  ]),
);

export const TargetRuleSchema = z.object({
  min: z.number().int().min(0).max(4).default(1),
  max: z.number().int().min(0).max(4).default(1),
  allowSelf: z.boolean().default(false),
  aliveOnly: z.boolean().default(true),
  allowConsecutiveTarget: z.boolean().optional(),
  allowedAlignments: z.array(AlignmentSchema).optional(),
  deniedAlignments: z.array(AlignmentSchema).optional(),
});
export type TargetRuleV1 = z.infer<typeof TargetRuleSchema>;

export const RoleActionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  phase: z.literal("night"),
  effect: EffectTypeSchema,
  target: TargetRuleSchema,
  teamAggregation: z.enum(["none", "plurality", "unanimity"]).default("none"),
  charges: z.number().int().positive().optional(),
});
export type RoleActionV1 = z.infer<typeof RoleActionSchema>;

export const RoleDefinitionSchema = z.object({
  schemaVersion: z.literal("role_v1"),
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  version: z.number().int().positive(),
  name: z.string().min(1).max(80),
  alignment: AlignmentSchema,
  description: z.string().min(1).max(1_500),
  knowledge: z.array(z.enum(["own_role", "alignment_team", "team_channel"])).default(["own_role"]),
  actions: z.array(RoleActionSchema).max(4).default([]),
  passives: z
    .object({
      voteWeight: z.number().int().min(1).max(5).default(1),
      teamChannel: z
        .string()
        .regex(/^[a-z][a-z0-9_-]*$/)
        .optional(),
    })
    .default({ voteWeight: 1 }),
  winCondition: z.object({
    terminal: z.boolean().default(true),
    predicate: WinPredicateSchema,
  }),
});
export type RoleDefinitionV1 = z.infer<typeof RoleDefinitionSchema>;

export const SeatConfigSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  personality: z.string().max(1_000).default("Observant, concise, and socially strategic."),
  model: z.string().min(1).optional(),
});
export type SeatConfigV1 = z.infer<typeof SeatConfigSchema>;

export const SafetyLimitsSchema = z.object({
  maxCycles: z.number().int().min(1).max(30).default(8),
  maxModelCalls: z.number().int().min(20).max(10_000).default(500),
  maxOutputTokens: z.number().int().min(100).max(4_000).default(600),
  maxWallClockMs: z.number().int().min(60_000).max(86_400_000).default(1_800_000),
});

export const DiscussionPolicySchema = z.object({
  readyQuorum: z
    .number()
    .min(0.5)
    .max(1)
    .default(2 / 3),
  maxFollowUpsPerPlayer: z.number().int().min(0).max(8).default(2),
  maxFollowUpSlotsFactor: z.number().min(0).max(2).default(0.5),
});

export const GameConfigSchema = z
  .object({
    schemaVersion: z.literal("game_config_v1"),
    name: z.string().min(1).max(120),
    seed: z.string().min(1).max(120),
    seats: z.array(SeatConfigSchema).min(5).max(16),
    roleDeck: z.array(RoleDefinitionSchema).min(5).max(16),
    revealRolesOnDeath: z.boolean().default(true),
    moderatorModel: z.string().min(1).optional(),
    moderatorNarration: z.boolean().default(false),
    discussion: DiscussionPolicySchema.default({
      readyQuorum: 2 / 3,
      maxFollowUpsPerPlayer: 2,
      maxFollowUpSlotsFactor: 0.5,
    }),
    safety: SafetyLimitsSchema.default({
      maxCycles: 8,
      maxModelCalls: 500,
      maxOutputTokens: 600,
      maxWallClockMs: 1_800_000,
    }),
    speedMs: z.number().int().min(0).max(30_000).default(500),
  })
  .superRefine((value, context) => {
    if (value.seats.length !== value.roleDeck.length) {
      context.addIssue({
        code: "custom",
        message: "roleDeck must contain exactly one role per seat",
      });
    }
    if (!value.roleDeck.some((role) => role.alignment === "werewolf")) {
      context.addIssue({ code: "custom", message: "roleDeck must contain at least one werewolf" });
    }
    if (!value.roleDeck.some((role) => role.alignment === "village")) {
      context.addIssue({
        code: "custom",
        message: "roleDeck must contain at least one village role",
      });
    }
  });
export type GameConfigV1 = z.infer<typeof GameConfigSchema>;

export const CreateGameRequestSchema = z.object({
  name: z.string().min(1).max(120),
  seed: z.string().min(1).max(120),
  seats: z.array(SeatConfigSchema).min(5).max(16),
  roleRefs: z
    .array(z.object({ id: z.string(), version: z.number().int().positive().optional() }))
    .min(5)
    .max(16),
  revealRolesOnDeath: z.boolean().default(true),
  moderatorModel: z.string().optional(),
  moderatorNarration: z.boolean().default(false),
  discussion: DiscussionPolicySchema.default({
    readyQuorum: 2 / 3,
    maxFollowUpsPerPlayer: 2,
    maxFollowUpSlotsFactor: 0.5,
  }),
  safety: SafetyLimitsSchema.default({
    maxCycles: 8,
    maxModelCalls: 500,
    maxOutputTokens: 600,
    maxWallClockMs: 1_800_000,
  }),
  speedMs: z.number().int().min(0).max(30_000).default(500),
});
export type CreateGameRequestV1 = z.infer<typeof CreateGameRequestSchema>;

export const PrivateJournalSchema = z.object({
  beliefs: z
    .array(
      z.object({
        playerId: z.string(),
        suspicion: z.number().min(0).max(1),
        note: z.string().max(240),
      }),
    )
    .max(32)
    .default([]),
  goals: z.array(z.string().max(240)).max(8).default([]),
  strategy: z.string().max(1_000).default(""),
  unresolvedQuestions: z.array(z.string().max(240)).max(8).default([]),
});
export type PrivateJournalV1 = z.infer<typeof PrivateJournalSchema>;

const DecisionBaseSchema = z.object({ journal: PrivateJournalSchema });
export const InitiativeDecisionSchema = DecisionBaseSchema.extend({
  kind: z.literal("initiative"),
  intent: z.enum(["speak", "pass", "ready_to_vote"]),
  urgency: z.enum(["low", "medium", "high"]),
  replyToEventId: z.string().nullable(),
  topic: z.string().max(240).nullable(),
});
export const SpeechDecisionSchema = DecisionBaseSchema.extend({
  kind: z.literal("speech"),
  text: z.string().min(1).max(1_200),
  replyToEventId: z.string().nullable(),
});
export const TeamPointDecisionSchema = DecisionBaseSchema.extend({
  kind: z.literal("team_point"),
  targetId: z.string().min(1),
});
export const NightActionDecisionSchema = DecisionBaseSchema.extend({
  kind: z.literal("night_action"),
  actionId: z.string(),
  targetIds: z.array(z.string()).max(4),
});
export const VoteDecisionSchema = DecisionBaseSchema.extend({
  kind: z.literal("vote"),
  targetId: z.string().nullable(),
});
export const AgentDecisionSchema = z.discriminatedUnion("kind", [
  InitiativeDecisionSchema,
  SpeechDecisionSchema,
  TeamPointDecisionSchema,
  NightActionDecisionSchema,
  VoteDecisionSchema,
]);
export type AgentDecisionV1 = z.infer<typeof AgentDecisionSchema>;

export const EventVisibilitySchema = z.enum(["public", "moderator", "player", "team"]);
export const GameEventSchema = z.object({
  schemaVersion: z.literal("game_event_v1"),
  id: z.string(),
  gameId: z.string(),
  sequence: z.number().int().nonnegative(),
  type: z.string().min(1),
  phase: GamePhaseSchema,
  day: z.number().int().nonnegative(),
  visibility: EventVisibilitySchema,
  audienceIds: z.array(z.string()).default([]),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type GameEventV1 = z.infer<typeof GameEventSchema>;

export const PlayerViewSchema = z.object({
  gameId: z.string(),
  phase: GamePhaseSchema,
  day: z.number().int().nonnegative(),
  self: z.object({
    id: z.string(),
    name: z.string(),
    alive: z.boolean(),
    role: RoleDefinitionSchema,
  }),
  knownAllies: z.array(z.object({ id: z.string(), name: z.string() })),
  players: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      alive: z.boolean(),
      revealedRole: z.string().optional(),
    }),
  ),
  publicEvents: z.array(GameEventSchema),
  teamEvents: z.array(GameEventSchema),
  privateEvents: z.array(GameEventSchema),
  journal: PrivateJournalSchema,
  availableActions: z.array(RoleActionSchema),
});
export type PlayerViewV1 = z.infer<typeof PlayerViewSchema>;

export const ExperimentSpecSchema = z.object({
  schemaVersion: z.literal("experiment_v1"),
  name: z.string().min(1).max(120),
  baseConfig: GameConfigSchema,
  runs: z.number().int().min(1).max(50),
  concurrency: z.number().int().min(1).max(3).default(1),
  baseSeed: z.string().min(1),
  pricingPerMillionTokens: z
    .record(
      z.string(),
      z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }),
    )
    .default({}),
});
export type ExperimentSpecV1 = z.infer<typeof ExperimentSpecSchema>;

export const ExperimentSummarySchema = z.object({
  runsRequested: z.number().int(),
  runsCompleted: z.number().int(),
  winsByAlignment: z.record(z.string(), z.number().int()),
  winsByRole: z.record(z.string(), z.number().int()),
  survivalByRole: z.record(
    z.string(),
    z.object({ survived: z.number().int(), total: z.number().int() }),
  ),
  voteAccuracy: z.number().min(0).max(1),
  averageCycles: z.number(),
  averageMessages: z.number(),
  averageDurationMs: z.number(),
  followUps: z.number().int(),
  modelFailures: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  estimatedCost: z.number(),
});
export type ExperimentSummaryV1 = z.infer<typeof ExperimentSummarySchema>;

export interface ProviderUsageV1 {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
