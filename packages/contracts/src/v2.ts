import { z } from "zod";
import { GameConfigSchema, GamePhaseSchema, RoleDefinitionSchema, CreateGameRequestSchema, DiscussionPolicySchema, ExperimentSpecSchema, ExperimentSummarySchema, SafetyLimitsSchema } from "./legacy";

export const STANDARD_ROLE_IDS = ["werewolf", "werewolf", "seer", "doctor", "villager", "villager", "villager", "villager"] as const;

/**
 * The standard roster with the Doctor replaced by a Bodyguard, which cannot shield itself.
 *
 * This is a new preset rather than an edit to `standard-8-v2`. Stored configs are re-parsed
 * through the frozen-roster check below every time a game is loaded, so changing an existing
 * preset's roster would make every archived game of that preset fail to load.
 */
export const STANDARD_ROLE_IDS_V3 = ["werewolf", "werewolf", "seer", "bodyguard", "villager", "villager", "villager", "villager"] as const;

export const PRESET_ROSTERS: Record<string, readonly string[]> = {
  "standard-8-v2": STANDARD_ROLE_IDS,
  "standard-8-v3": STANDARD_ROLE_IDS_V3,
};

/** Starter roles are version 1 except the two that were revised for V2. */
export const rosterRoleVersion = (id: string): number => (id === "werewolf" || id === "doctor" ? 2 : 1);

/**
 * Seat names by position: seat 1 is Ada, seat 2 is Ben, and so on down the alphabet.
 * Short and initial-keyed so a transcript stays readable and a name is never confused
 * with a role word. Rosters run to sixteen seats, so the list covers the whole alphabet.
 */
export const SEAT_NAMES = [
  "Ada", "Ben", "Cleo", "Dax", "Eli", "Fay", "Gus", "Hal", "Iris", "Jax", "Kit", "Leo", "Mae",
  "Nia", "Otto", "Pia", "Quin", "Rex", "Sam", "Tess", "Uma", "Vic", "Wren", "Xan", "Yara", "Zoe",
] as const;

/** Falls back to a positional name if a roster ever exceeds the alphabet. */
export const seatName = (index: number): string => SEAT_NAMES[index] ?? `Seat ${index + 1}`;
export const DeliberationPolicySchema = z.object({
  mode: z.enum(["single", "gated"]).default("gated"),
  maxCalls: z.number().int().min(1).max(3).default(3),
  optionalDayCalls: z.number().int().min(0).max(12).default(4),
  optionalNightCalls: z.number().int().min(0).max(6).default(2),
  requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(120_000),
  episodeTimeoutMs: z.number().int().min(1_000).max(600_000).default(300_000),
  maxContextTokens: z.number().int().min(1_000).max(32_000).default(8_000),
  maxJournalTokens: z.number().int().min(200).max(16_000).default(1_200),
  bidReasoningEffort: z.string().default("medium"),
  /** V3.2: characters of speech text kept when a record is delivered at `digest` tier. */
  digestChars: z.number().int().min(40).max(600).default(140),
});
export const DecisionEngineSchema = z.object({
  mode: z.enum(["llm", "jev"]).default("llm"),
  model: z.string().trim().min(1).default("jev-latest"),
  /** Missing on archived games means the original Jev workflow. */
  workflow: z.enum(["legacy_v1", "journal_v2", "journal_v3", "journal_v4"]).default("legacy_v1"),
  reasoningThreshold: z.number().min(0).max(1).default(0.5),
});
export const ModelSettingsSchema = z.object({ model: z.string().min(1), reasoningEffort: z.string().default("medium"), provider: z.enum(["fake", "codex", "codex_direct", "openai"]) });
export const DiscussionPolicyV2Schema = DiscussionPolicySchema.extend({
  speakerSelection: z.enum(["event_queue", "listener_auction"]).default("event_queue"),
  speakerBias: z.number().min(0.01).max(1).default(0.25),
  maxParallelDecisions: z.number().int().min(1).max(16).default(1),
});
const CreateDiscussionPolicyV2Schema = DiscussionPolicySchema.extend({
  speakerSelection: z.enum(["event_queue", "listener_auction"]).default("listener_auction"),
  speakerBias: z.number().min(0.01).max(1).default(0.25),
  maxParallelDecisions: z.number().int().min(1).max(16).default(4),
});
/** The Responses API output ceiling includes internal reasoning and final JSON. */
export const SafetyLimitsV2Schema = SafetyLimitsSchema.extend({
  maxOutputTokens: z.number().int().min(100).max(32_768).default(600),
});
// Worst-case JSON escaping costs six bytes per brief character. This includes
// bounded owner/revision metadata and at least 1,000 estimated prose tokens.
export const MIN_ACTOR_JOURNAL_TOKENS = 16_000;
export const GameConfigV2Schema = z.object({ ...GameConfigSchema.shape,
  schemaVersion: z.literal("game_config_v2"),
  safety: SafetyLimitsV2Schema.default(SafetyLimitsV2Schema.parse({})),
  preset: z.enum(["standard-8-v2", "standard-8-v3", "custom-v2"]).default("custom-v2"),
  protocolVersion: z.enum(["agent_v2", "agent_v2_1", "agent_v3", "agent_v3_1", "agent_v3_2"]).default("agent_v2"),
  rules: z.object({ packExecution: z.literal("any_unblocked").default("any_unblocked"), revealBallots: z.literal(true).default(true), firstCycle: z.enum(["night_first", "day_first"]).default("night_first") }).default({ packExecution: "any_unblocked", revealBallots: true, firstCycle: "night_first" }),
  discussion: DiscussionPolicyV2Schema.default(DiscussionPolicyV2Schema.parse({})),
  deliberation: DeliberationPolicySchema.default(DeliberationPolicySchema.parse({})),
  maxTotalTokens: z.number().int().min(1_000).max(100_000_000).nullable().default(2_000_000),
  modelSettings: z.record(z.string(), ModelSettingsSchema),
  decisionEngine: DecisionEngineSchema.default(DecisionEngineSchema.parse({})),
}).superRefine((value, ctx) => {
  if (value.decisionEngine.mode === "jev" && !["agent_v3_1", "agent_v3_2"].includes(value.protocolVersion)) ctx.addIssue({code:"custom",message:"Jev decisions require the V3.1 or V3.2 handle protocol"});
  if (value.decisionEngine.mode === "jev" && value.decisionEngine.workflow !== "legacy_v1" && value.discussion.speakerSelection !== "listener_auction") ctx.addIssue({code:"custom",message:"The journal Jev workflow requires listener auctions"});
  if (value.decisionEngine.mode === "jev" && value.decisionEngine.workflow === "journal_v4"
      && value.deliberation.maxJournalTokens < MIN_ACTOR_JOURNAL_TOKENS) {
    ctx.addIssue({
      code: "custom",
      path: ["deliberation", "maxJournalTokens"],
      message: `journal_v4 requires at least ${MIN_ACTOR_JOURNAL_TOKENS} journal tokens for the maximum current brief and prose headroom`,
    });
  }
  const roster=PRESET_ROSTERS[value.preset];
  if(roster) {
    const expected=roster.map(id=>`${id}:${rosterRoleVersion(id)}`).sort();
    const actual=value.roleDeck.map(role=>`${role.id}:${role.version}`).sort();
    if(value.seats.length!==8 || JSON.stringify(actual)!==JSON.stringify(expected)) ctx.addIssue({code:"custom",message:`${value.preset} requires its frozen eight-seat starter roster; use custom-v2 for edited roles`});
  }
  if (value.seats.length !== value.roleDeck.length) ctx.addIssue({ code: "custom", message: "role count must equal seat count" });
  if (new Set(value.seats.map(s => s.id)).size !== value.seats.length) ctx.addIssue({ code: "custom", message: "seat IDs must be unique" });
  for (const faction of ["werewolf", "village"]) if (!value.roleDeck.some(r => r.alignment === faction)) ctx.addIssue({ code: "custom", message: `missing ${faction} faction` });
  for (const seat of value.seats) if (!value.modelSettings[seat.id]) ctx.addIssue({ code: "custom", message: `missing resolved model for ${seat.id}` });
  for (const role of value.roleDeck) for (const action of role.actions) {
    const filters = [...(action.target.allowedAlignments ?? []), ...(action.target.deniedAlignments ?? [])];
    if (filters.length && (!role.knowledge.includes("alignment_team") || filters.some(alignment => alignment !== role.alignment))) ctx.addIssue({code:"custom",message:"Alignment-filtered legal targets require team knowledge and may only restrict the actor's own alignment; hidden alignment filters would leak roles."});
  }
});
export type GameConfigV2 = z.infer<typeof GameConfigV2Schema>;
export const StoredGameConfigSchema = z.union([GameConfigSchema, GameConfigV2Schema]);
export type StoredGameConfig = z.infer<typeof StoredGameConfigSchema>;
const NewGameSafetySchema = SafetyLimitsV2Schema.extend({ maxOutputTokens: z.number().int().min(100).max(32_768).default(8_192) });
const NewGameDeliberationSchema = DeliberationPolicySchema.extend({
  maxJournalTokens: z.number().int().min(200).max(16_000).default(16_000),
  maxContextTokens: z.number().int().min(1_000).max(32_000).default(32_000),
});
export const CreateGameV2RequestSchema = CreateGameRequestSchema.extend({
  safety: NewGameSafetySchema.default(NewGameSafetySchema.parse({})),
  preset: z.enum(["standard-8-v2", "standard-8-v3", "custom-v2"]).default("custom-v2"),
  discussion: CreateDiscussionPolicyV2Schema.default(CreateDiscussionPolicyV2Schema.parse({})),
  deliberation: NewGameDeliberationSchema.default(NewGameDeliberationSchema.parse({})),
  maxTotalTokens: z.number().int().min(1_000).max(100_000_000).nullable().default(null),
  reasoningEffort: z.string().optional(),
  /** Opt in to the V3.2 delivery ladder; omitted means the V3.1 default. */
  protocolVersion: z.enum(["agent_v3_1", "agent_v3_2"]).optional(),
  decisionEngine: DecisionEngineSchema.extend({ workflow: z.enum(["legacy_v1", "journal_v2", "journal_v3", "journal_v4"]).default("journal_v4") }).optional(),
});
export type CreateGameV2Request = z.infer<typeof CreateGameV2RequestSchema>;
export const ExperimentSpecV2Schema = ExperimentSpecSchema.extend({ schemaVersion: z.literal("experiment_v2"), baseConfig: GameConfigV2Schema });
export const StoredExperimentSpecSchema = z.union([ExperimentSpecSchema, ExperimentSpecV2Schema]);
export type StoredExperimentSpec = z.infer<typeof StoredExperimentSpecSchema>;
export const ExperimentSummaryV2Schema = ExperimentSummarySchema.extend({
  schemaVersion:z.literal("experiment_summary_v2"), completed:z.number().int(), interrupted:z.number().int(), failed:z.number().int(), budgetTruncated:z.number().int(), validOutcomeDenominator:z.number().int(),
  cachedInputTokens:z.number().int(), reasoningTokens:z.number().int(), unknownUsageAttempts:z.number().int(), totalAttempts:z.number().int(), estimatedCostIsLowerBound:z.boolean(),
  factionWinRates:z.record(z.string(),z.number()), roleWinRates:z.record(z.string(),z.number()),
});
export const StoredExperimentSummarySchema=z.union([ExperimentSummaryV2Schema,ExperimentSummarySchema]);
export type ExperimentSummaryV2=z.infer<typeof ExperimentSummaryV2Schema>;
export type StoredExperimentSummary=z.infer<typeof StoredExperimentSummarySchema>;
const Id = z.string().min(1).max(120);
const Brief = z.string().max(240);
const SourceId = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/);
const Refs = z.array(SourceId).max(6);
export const BeliefV2Schema = z.strictObject({ playerId: Id, probability: z.number().min(0).max(1), basis: z.enum(["prior", "inference", "authorized_fact"]), note: Brief, sources: Refs });
export const HypothesisV2Schema = z.strictObject({ id: Id, statement: Brief, confidence: z.number().min(0).max(1), sources: Refs });
export const DecisionBriefTextSchema = z.strictObject({ action: z.string().trim().min(1).max(4000), attention: z.string().trim().min(1).max(3000) });
export const DecisionBriefSchema = DecisionBriefTextSchema.extend({ playerId: Id, evidenceRevision: z.string().length(64) });
export const PrivateJournalV2Schema = z.strictObject({
  schemaVersion: z.literal("journal_v2"), version: z.number().int().nonnegative(),
  /** Free-form journal; legacy fields remain readable for archived games. */
  text: z.string().optional(),
  decisionBrief: DecisionBriefSchema.optional(),
  attentionNotes: z.array(z.strictObject({playerId: Id, note: Brief, sources: Refs})).max(16).optional(),
  beliefs: z.array(BeliefV2Schema).max(16), hypotheses: z.array(HypothesisV2Schema).max(6),
  strategy: z.string().max(600), goals: z.array(Brief).max(4), unresolvedQuestions: z.array(Brief).max(4), deceptionPlan: z.string().max(400).nullable(),
});
export type PrivateJournalV2 = z.infer<typeof PrivateJournalV2Schema>;
export const emptyJournalV2 = (): PrivateJournalV2 => ({ schemaVersion: "journal_v2", version: 0, beliefs: [], hypotheses: [], strategy: "", goals: [], unresolvedQuestions: [], deceptionPlan: null });
// Strict Structured Outputs accepts nested anyOf, not oneOf. Literal op tags
// keep these union branches disjoint while retaining the same runtime contract.
export const JournalOperationSchema = z.union([
  z.strictObject({ op: z.literal("set_decision_brief"), value: DecisionBriefSchema }),
  z.strictObject({ op: z.literal("write_text"), mode: z.enum(["append", "replace"]), text: z.string().min(1) }),
  z.strictObject({ op: z.literal("upsert_belief"), value: BeliefV2Schema }),
  z.strictObject({ op: z.literal("upsert_hypothesis"), value: HypothesisV2Schema }),
  z.strictObject({ op: z.literal("remove_hypothesis"), id: Id }),
  z.strictObject({ op: z.literal("set_strategy"), strategy: z.string().max(600), goals: z.array(Brief).max(4) }),
  z.strictObject({ op: z.literal("set_attention"), notes: z.array(z.strictObject({playerId: Id, note: Brief, sources: Refs})).max(16) }),
  z.strictObject({ op: z.literal("set_questions"), questions: z.array(Brief).max(4) }),
  z.strictObject({ op: z.literal("set_deception"), plan: z.string().max(400).nullable() }),
]);
export const SpeechActV2Schema = z.strictObject({ kind: z.enum(["accusation", "challenge", "role_claim", "result_claim", "reply"]), targetId: Id.nullable(), claim: Brief, sourceId: SourceId.nullable() });
export const PublicSpeechV2Schema = z.strictObject({ text: z.string().min(1).max(1_200), acts: z.array(SpeechActV2Schema).max(4), respondsTo: Refs });
export const TargetChoiceV2Schema = z.strictObject({ mode: z.enum(["direct", "uniform"]), playerIds: z.array(Id).min(1).max(16) });
export const ActionProposalV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("night_action"), actionId: Id, targets: TargetChoiceV2Schema }),
  z.strictObject({ kind: z.literal("team_point"), targets: TargetChoiceV2Schema }),
  z.strictObject({ kind: z.literal("vote"), targets: TargetChoiceV2Schema.nullable() }),
  z.strictObject({ kind: z.literal("discussion"), speech: PublicSpeechV2Schema.nullable(), ready: z.boolean(), interests: z.array(z.enum(["accused_me", "claims", "mentions_me"])).max(3), silenceCase: z.strictObject({ speechAlternative: Brief, advantage: Brief }).nullable() }),
  z.strictObject({ kind: z.literal("pass"), reason: Brief }),
]);
export type ActionProposalV2 = z.infer<typeof ActionProposalV2Schema>;
export const ListenerPreferenceV1Schema = z.strictObject({ playerId: Id, willingness: z.number().min(0).max(1) });
export const SpeakerIntentV1Schema = z.strictObject({
  wantsToSpeak: z.boolean(), urge: z.number().min(0).max(1),
  willingnessToListen: z.array(ListenerPreferenceV1Schema).max(16),
});
export type SpeakerIntentV1 = z.infer<typeof SpeakerIntentV1Schema>;

export const EvidenceHandleV3Schema = z.string().regex(/^e[1-9][0-9]*$/);
const EvidenceHandlesV3Schema = z.array(EvidenceHandleV3Schema).max(6);
const AgentBeliefSuggestionV1Schema = z.strictObject({ playerId: Id, probability: z.number().min(0).max(1), note: Brief, evidence: EvidenceHandlesV3Schema });
const AgentHypothesisSuggestionV1Schema = z.strictObject({ statement: Brief, confidence: z.number().min(0).max(1), evidence: EvidenceHandlesV3Schema });
export const MemorySuggestionsV3Schema = z.strictObject({
  attentionUpdate: z.array(z.strictObject({playerId: Id, note: Brief, evidence: EvidenceHandlesV3Schema})).max(16).nullable().optional(),
  beliefs: z.array(AgentBeliefSuggestionV1Schema).max(2),
  hypotheses: z.array(AgentHypothesisSuggestionV1Schema).max(1),
  strategyUpdate: z.strictObject({ strategy: z.string().max(600), goals: z.array(Brief).max(4) }).nullable(),
  questionsUpdate: z.array(Brief).max(4).nullable(),
  deceptionUpdate: z.strictObject({ plan: z.string().max(400).nullable() }).nullable(),
});
export const DiscussionPlanV3Schema = z.strictObject({ kind: z.enum(["accusation", "challenge", "role_claim", "result_claim", "reply"]), targetId: Id.nullable(), respondsTo: EvidenceHandlesV3Schema, point: Brief });
export const DiscussionBidV3Schema = z.strictObject({ urge: z.number().min(0).max(1), ready: z.boolean(), plan: DiscussionPlanV3Schema.nullable(), listen: z.record(z.string(),z.number().min(0).max(1)), memory: MemorySuggestionsV3Schema, rationale: z.string().max(300) });
export const ListenerBidV3Schema = z.strictObject({ ready: z.boolean(), listen: z.record(z.string(),z.number().min(0).max(1)), memory: MemorySuggestionsV3Schema, rationale: z.string().max(300) });
const SpeechActSuggestionV3Schema = z.strictObject({ kind: z.enum(["accusation", "challenge", "role_claim", "result_claim", "reply"]), targetId: Id.nullable(), claim: Brief, evidence: EvidenceHandleV3Schema.nullable() });
export const SpeechSubmissionV3Schema = z.strictObject({ text: z.string().min(1).max(1_200).nullable(), acts: z.array(SpeechActSuggestionV3Schema).max(4), respondsTo: EvidenceHandlesV3Schema, rationale: z.string().max(300), memory: MemorySuggestionsV3Schema });
export const TargetChoiceSubmissionV3Schema = z.strictObject({ mode: z.enum(["direct", "uniform", "abstain"]), choiceHandles: z.array(z.string().min(1).max(8)).max(16), rationale: z.string().max(300), evidence: EvidenceHandlesV3Schema, memory: MemorySuggestionsV3Schema, reconsiderationQuestion: Brief.nullable() });
export type MemorySuggestionsV3 = z.infer<typeof MemorySuggestionsV3Schema>;
export type DiscussionPlanV3 = z.infer<typeof DiscussionPlanV3Schema>;
export type DiscussionBidV3 = z.infer<typeof DiscussionBidV3Schema>;
export type ListenerBidV3 = z.infer<typeof ListenerBidV3Schema>;
export type SpeechSubmissionV3 = z.infer<typeof SpeechSubmissionV3Schema>;
export type TargetChoiceSubmissionV3 = z.infer<typeof TargetChoiceSubmissionV3Schema>;
export type V3TaskKind = "journal_update" | "discussion_score" | "discussion_free_speech" | "discussion_bid" | "discussion_listen" | "discussion_speech" | "closing_response" | "vote_choice" | "night_choice" | "team_point_choice";

export const DecisionReportV2Schema = z.strictObject({
  observations: Refs,
  inferences: z.array(z.strictObject({ statement: Brief, sources: Refs })).max(4),
  alternatives: z.array(z.strictObject({ id: Id, description: Brief, advantage: Brief, drawback: Brief })).min(1).max(3),
  selectedAlternativeId: Id, proposal: ActionProposalV2Schema,
  confidence: z.number().min(0).max(1), summary: Brief,
  journalPatch: z.array(JournalOperationSchema).max(6),
  control: z.strictObject({ kind: z.enum(["commit", "continue"]), question: Brief.nullable(), reason: z.enum(["compare_alternative", "resolve_conflict", "plan_response", "coordination_tradeoff"]).nullable() }),
});
export type DecisionReportV2 = z.infer<typeof DecisionReportV2Schema>;
export type DecisionReportWithSpeakerIntentV1 = DecisionReportV2 & { speakerIntent: SpeakerIntentV1 };
/** Preserve shared definitions so per-packet citation enums are not repeated. */
export const providerJsonSchema=(schema:z.ZodType)=>z.toJSONSchema(schema,{target:"draft-7",reused:"ref"});
export function reportSchema(kind: ActionProposalV2["kind"], commitOnly = false, packet?: PlayerContextV2): z.ZodType<DecisionReportV2> {
  const proposal = ActionProposalV2Schema.options.find((option) => option.shape.kind.value === kind)!;
  // `commitOnly` remains a prompt and executor constraint. Keeping it out of the
  // provider schema preserves the exact same schema prefix for every turn in an
  // episode; the executor deterministically commits a valid final proposal even
  // if the model redundantly asks to continue.
  void commitOnly;
  const base=DecisionReportV2Schema.extend({ proposal });
  if(kind!=="discussion") return base;
  // Keep provider schemas stable across players and turns. Delivered source IDs are
  // intentionally checked by validateReport after parsing; baking them into enums
  // duplicated the same IDs throughout the schema and defeated prefix caching.
  const discussion=base;
  return packet?.rules.speakerSelection === "listener_auction" ? discussion.extend({speakerIntent:SpeakerIntentV1Schema}) as z.ZodType<DecisionReportV2> : discussion;
}
export interface ContextSourceV2 {
  id: string; type: string; day: number; scope: "public" | "player" | "team"; data: Record<string, unknown>;
  /** Stable, dense index in the public citable log. Never counts private activity. */
  publicIndex?: number;
  /** Stable index in this player's private delivery log; facts:self occupies R1. */
  privateIndex?: number;
  /** V3.1 sources in the shared cacheable public-history window. */
  cacheLayer?: "public";
  /**
   * V3.2 delivery tier. Every citable record is always delivered at some tier, so a
   * handle never stops resolving; compaction demotes fidelity instead of dropping the
   * record. Absent means `full`, which is the only V3.1 behaviour.
   */
  detail?: "full" | "digest" | "stub";
}
export interface PlayerContextV2 {
  schemaVersion: "player_context_v2";
  phase: z.infer<typeof GamePhaseSchema>; day: number;
  self: { id: string; name: string; personality?: string; role: z.infer<typeof RoleDefinitionSchema> };
  players: { id: string; name: string; alive: boolean; revealedRole?: string }[];
  knownAllies: { id: string; name: string }[];
  rules: Record<string, unknown>; sources: ContextSourceV2[];
  legalActions: { actionId: string; targets: string[]; min: number; max: number }[];
  legalTargets: string[];
  journal: PrivateJournalV2; responseDocket: string[]; closing: boolean;
}
export interface DecisionOpportunityV1 {
  id: string; gameId: string; playerId: string; kind: ActionProposalV2["kind"];
  phase: z.infer<typeof GamePhaseSchema>; day: number; epoch: string; viewId: string;
  baseJournalVersion: number; packet: PlayerContextV2; status: "open" | "pending" | "committed" | "paused" | "superseded";
  best: DecisionReportV2 | null; recovery: number; createdAt: string;
  taskType?: V3TaskKind; bestSubmission?: unknown;
  /** Overflow is a durable intermediate stage; only a validated replacement may commit. */
  journalCompaction?: { candidate: PrivateJournalV2; sourceReport: DecisionReportV2; sourceSubmission: unknown; sourceAttemptId: string; result?: PrivateJournalV2; attemptId?: string };
  /** Intermediate reasoning is durable but never a committed action. */
  jevState?: {
    stage: "reason" | "decide";
    evaluation: unknown;
    reasoning?: unknown;
    semanticIssues?: string[];
    semanticRejected?: boolean;
    semanticFinal?: { attemptId: string; report: DecisionReportV2; submission: unknown };
    semanticAcknowledgment?: { note: string; at: string };
  };
}
export interface PrivateDeliberationTurnV1 { decisionId: string; playerId: string; turnIndex: number; recovery: number; report: DecisionReportV2; viewId: string }
export interface UsageV2 { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens: number | null; cacheWriteInputTokens: number | null; reasoningTokens: number | null }
export const unknownUsage = (): UsageV2 => ({ inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null });
