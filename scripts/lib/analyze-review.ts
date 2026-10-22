import type { GameEventV1 } from "@werewolf/contracts";
import type { DecisionProvider } from "@werewolf/llm";
import { z } from "zod";
import { estimatedTokens } from "../../packages/simulator/src/request-v2";
import { checkCitations } from "./analyze-citations";
import type { MomentSource } from "./analyze-moments";
import type { ClassifiedMoment } from "./surprise-scoring";

export const ReviewSchema = z.strictObject({
  explanation: z.string().min(1).max(2_000),
  citedEventIds: z.array(z.string()).max(16),
  knowledgeClaims: z
    .array(
      z.strictObject({ claim: z.string().max(400), eventIds: z.array(z.string()).min(1).max(8) }),
    )
    .max(8),
  regressionCandidate: z.boolean(),
});
export type MomentReview = z.infer<typeof ReviewSchema>;

export const REVIEW_INSTRUCTIONS = `You are reviewing one decision from a recorded Werewolf game played by AI agents. The input is moderator data: the acting player's authorized view at the time (each record with its event ID), the distribution a model predicted from the public record alone, the distribution the player's own decision model recorded, the action actually taken, and every player's true role.
Explain the decision from the player's knowledge at the time, not from the true roles. Say whether hidden information, an error, or herd behaviour shaped it. Cite event IDs exactly as given. Put every statement about what the player knew or saw in knowledgeClaims, citing only events from the player's authorized view. Set regressionCandidate when this decision would make a good fixed test case for future versions.`;

export interface ReviewItem {
  source: MomentSource;
  moment: ClassifiedMoment;
  recall: boolean;
}

export type ReviewOutcome =
  | { status: "accepted" | "rejected_citation"; review: MomentReview; issues: string[] }
  | { status: "skipped_budget" | "failed"; error?: string };

/** Moderator-level evidence for one moment; never shown to players. */
function dossier(item: ReviewItem, roles: Record<string, string>) {
  const { op } = item.source;
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
    publicPrediction: item.moment.publicView,
    recordedDecision: item.moment.privateView,
    actorView: op.packet.sources
      .filter((source) => !source.id.startsWith("facts:"))
      .map((source) => ({
        eventId: source.id,
        type: source.type,
        day: source.day,
        data: source.data,
      })),
    trueRoles: roles,
  };
}

export interface ReviewOptions {
  provider: DecisionProvider;
  model: string;
  maxOutputTokens: number;
  /** Total review tokens (input and output); a review that could pass it is skipped. */
  tokenBudget: number;
  events: GameEventV1[];
  roles: Record<string, string>;
}

export async function reviewMoments(items: ReviewItem[], options: ReviewOptions) {
  const usage = { calls: 0, tokens: 0, costUsd: 0 };
  const outcomes: ReviewOutcome[] = [];
  for (const item of items) {
    const prompt = {
      instructions: REVIEW_INSTRUCTIONS,
      input: JSON.stringify(dossier(item, options.roles)),
    };
    const worstCase = estimatedTokens(prompt) + options.maxOutputTokens;
    if (usage.tokens + worstCase > Number.MAX_SAFE_INTEGER) {
      outcomes.push({ status: "skipped_budget" });
      continue;
    }
    usage.calls += 1;
    let spent = worstCase;
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
        onUsage: (reported) => (spent = reported.totalTokens ?? worstCase),
        onProviderMetadata: (metadata) => {
          if (typeof metadata.costUsd === "number") usage.costUsd += metadata.costUsd;
        },
      });
      const review = ReviewSchema.parse(result.data);
      const check = checkCitations(
        review,
        options.events,
        item.moment.actorId,
        item.source.decisionSequence,
      );
      outcomes.push({
        status: check.accepted ? "accepted" : "rejected_citation",
        review,
        issues: check.issues,
      });
    } catch (error) {
      outcomes.push({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      usage.tokens += spent;
    }
  }
  return { outcomes, usage };
}
