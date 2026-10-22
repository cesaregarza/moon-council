import {
  providerJsonSchema,
  type DecisionOpportunityV1,
  type GameEventV1,
} from "@werewolf/contracts";
import type { DecisionProvider } from "@werewolf/llm";
import { z } from "zod";
import { actorBriefing } from "../../packages/simulator/src/jev-actor";
import { currentDecisionBrief } from "../../packages/simulator/src/player-brief";
import { checkCitations } from "./analyze-citations";
import type { MomentSource } from "./analyze-moments";
import type { ClassifiedMoment } from "./surprise-scoring";

export const ReviewSchema = z.strictObject({
  explanation: z.string().min(1).max(2_000),
  citedEventIds: z.array(z.string()).max(16),
  knowledgeClaims: z
    .array(
      z.strictObject({
        claim: z.string().max(400),
        eventIds: z.array(z.string()).min(1).max(8),
        /** Whose knowledge the claim states (one player); null for every deciding player. */
        subjectId: z.string().nullable(),
      }),
    )
    .max(8),
  /** What the player could not see (true roles, others' private actions); never cited. */
  groundTruth: z.string().max(1_000),
  regressionCandidate: z.boolean(),
});
export type MomentReview = z.infer<typeof ReviewSchema>;
const REVIEW_JSON_SCHEMA = providerJsonSchema(ReviewSchema);

export const REVIEW_INSTRUCTIONS = `You are reviewing one decision from a recorded Werewolf game played by AI agents. The input is moderator data: the acting player's authorized view at the time (each record with its event ID), the distribution a model predicted from the public record alone, the distribution the player's own decision model recorded, the action actually taken, and every player's true role.
The input also holds the briefing the player's decision model received: its current reasoning and verified facts.
Explain the decision from the player's knowledge at the time, not from the true roles. Say whether hidden information, an error, or herd behaviour shaped it. Cite event IDs exactly as given, and only events from the player's authorized view: every cited ID is checked against what the player could see before deciding. Put every statement about what the player knew or saw in knowledgeClaims, each naming its subjectId: the player whose knowledge it states (for a pack kill, one wolf), or null for knowledge every deciding player shared. Each claim is checked against its subject's own view. Put anything the player could not see, such as true roles or other players' private actions, only in groundTruth, with no citations. Set regressionCandidate when this decision would make a good fixed test case for future versions.`;

export interface ReviewItem {
  source: MomentSource;
  moment: ClassifiedMoment;
  recall: boolean;
}

export type ReviewOutcome =
  | { status: "accepted" | "rejected_citation"; review: MomentReview; issues: string[] }
  | { status: "skipped_budget" | "failed"; error?: string };

/** Review providers whose output cap is not enforced (Codex), so a token budget cannot hold. */
const UNENFORCED_OUTPUT_LIMIT_KINDS = new Set(["codex", "codex_direct"]);
export class UnenforcedOutputLimitError extends Error {
  override name = "UnenforcedOutputLimitError";
}
export function assertReviewProviderBounded(kind: string): void {
  if (UNENFORCED_OUTPUT_LIMIT_KINDS.has(kind))
    throw new UnenforcedOutputLimitError(
      `Review provider ${kind} does not enforce an output limit, so the review token budget cannot be held`,
    );
}

/**
 * The actor's briefing exactly as Jev received it, rebuilt by the same builder from the
 * decision-time packet; null when that packet had no current brief.
 */
function decisionBriefing(op: DecisionOpportunityV1 | undefined) {
  return op && currentDecisionBrief(op.packet) && op.playerId === op.packet.self.id
    ? actorBriefing(op)
    : null;
}

/** Moderator-level evidence for one moment; never shown to players. */
function dossier(item: ReviewItem, roles: Record<string, string>) {
  const { op, pack } = item.source;
  return {
    moment: {
      id: item.moment.id,
      kind: item.moment.kind,
      actorId: item.moment.actorId,
      actual: item.moment.actual,
      class: item.moment.class,
      scores: item.moment.score,
    },
    decisionEventId: item.source.decisionEventId,
    ...(item.moment.selected ? { selected: item.moment.selected } : {}),
    ...(item.moment.wolfProbabilities ? { wolfProbabilities: item.moment.wolfProbabilities } : {}),
    publicPrediction: item.moment.publicView,
    recordedDecision: item.moment.privateView,
    ...(pack
      ? {
          actorBriefings: Object.fromEntries(
            pack.map((wolf) => [wolf.playerId, decisionBriefing(wolf)]),
          ),
        }
      : { actorBriefing: decisionBriefing(op) }),
    actorView: [
      ...new Map(
        (pack ?? (op ? [op] : []))
          .flatMap((decision) => decision.packet.sources)
          .filter((source) => !source.id.startsWith("facts:"))
          .map((source) => [
            source.id,
            { eventId: source.id, type: source.type, day: source.day, data: source.data },
          ]),
      ).values(),
    ],
    trueRoles: roles,
  };
}

export interface ReviewOptions {
  provider: DecisionProvider;
  model: string;
  /** Must be enforced by the provider; Codex kinds are refused before any call. */
  maxOutputTokens: number;
  /** Total review tokens (input and output); a review that could pass it is skipped. */
  tokenBudget: number;
  events: GameEventV1[];
  roles: Record<string, string>;
}

/** One review call: settled tokens are the reported usage, or the worst case when unknown. */
async function reviewOne(
  item: ReviewItem,
  prompt: { instructions: string; input: string },
  worstCase: number,
  options: ReviewOptions,
) {
  const call = { spent: worstCase, costUsd: 0, enforced: true };
  try {
    const result = await options.provider.decide({
      // A generic prepared-prompt decision: providers send preparedPrompt as given.
      kind: "decision_v3_1",
      model: options.model,
      schemaName: "moment_review",
      schema: ReviewSchema,
      maxOutputTokens: options.maxOutputTokens,
      reasoningEffort: "high",
      preparedPrompt: prompt,
      onUsage: (reported, metadata) => {
        // Sticky: once a call reports an unenforced cap, a later callback cannot clear it.
        // Unreported or invalid usage keeps the worst case; accounting never becomes NaN.
        const total = reported.totalTokens;
        call.spent =
          typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : worstCase;
        call.enforced = call.enforced && metadata.outputLimitEnforced;
      },
      onProviderMetadata: (metadata) => {
        if (typeof metadata.costUsd === "number") call.costUsd += metadata.costUsd;
      },
    });
    if (!call.enforced)
      throw new UnenforcedOutputLimitError(
        "Review provider reported an unenforced output limit; no further reviews are admitted",
      );
    const review = ReviewSchema.parse(result.data);
    const check = checkCitations(review, options.events, item.source.deciders);
    const outcome: ReviewOutcome = {
      status: check.accepted ? "accepted" : "rejected_citation",
      review,
      issues: check.issues,
    };
    return { ...call, outcome };
  } catch (error) {
    const outcome: ReviewOutcome = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
    return { ...call, outcome };
  }
}

/**
 * Reviews items in order. A review is admitted only if the remaining budget covers its prompt
 * and response schema, bounded by their UTF-8 bytes (a token is never shorter than a byte),
 * plus the output cap.
 */
export async function reviewMoments(items: ReviewItem[], options: ReviewOptions) {
  const usage = { calls: 0, tokens: 0, costUsd: 0 };
  const outcomes: ReviewOutcome[] = [];
  let bounded = true;
  for (const item of items) {
    const prompt = {
      instructions: REVIEW_INSTRUCTIONS,
      input: JSON.stringify(dossier(item, options.roles)),
    };
    const worstCase =
      Buffer.byteLength(JSON.stringify({ prompt, schema: REVIEW_JSON_SCHEMA }), "utf8") +
      options.maxOutputTokens;
    if (!bounded || usage.tokens + worstCase > options.tokenBudget) {
      outcomes.push({ status: "skipped_budget" });
      continue;
    }
    usage.calls += 1;
    const call = await reviewOne(item, prompt, worstCase, options);
    usage.tokens += call.spent;
    usage.costUsd += call.costUsd;
    bounded = call.enforced;
    outcomes.push(call.outcome);
  }
  return { outcomes, usage };
}
