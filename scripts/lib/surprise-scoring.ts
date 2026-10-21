/**
 * Pure scoring for the post-game surprise analyzer. A moment is one decision with
 * two distributions over the same legal options: the public view (what the public record alone
 * predicts) and the private view (what Jev recorded when the player decided). No model calls.
 */

export type MomentKind = "ballot" | "night_action" | "pack_point";
export type MomentClass =
  "private_knowledge" | "herd_over_knowledge" | "noise_or_error" | "routine" | "no_signal";

export interface SurpriseMoment {
  id: string;
  kind: MomentKind;
  actorId: string;
  actorAlignment: "village" | "werewolf";
  /** Option key actually chosen: a player ID or "abstain". */
  actual: string;
  publicView: Record<string, number>;
  privateView: Record<string, number>;
  /** The actor's own verified results, e.g. Seer inspections, known before deciding. */
  verified: Array<{ targetId: string; alignment: "village" | "werewolf" }>;
}

export const SURPRISE_THRESHOLDS = {
  /** p(actual) at or below this is surprising; at or above `expected` is expected. */
  surprising: 0.2,
  expected: 0.5,
  /** Normalized entropy at or above this makes a public prediction near-flat: no signal. */
  flat: 0.95,
  /** Floor so an option given probability 0 has finite surprisal. */
  minProbability: 1e-6,
};
type Thresholds = typeof SURPRISE_THRESHOLDS;

/** Class order for review: knowledge contradictions first, then hidden information, then noise. */
const REVIEW_ORDER: MomentClass[] = ["herd_over_knowledge", "private_knowledge", "noise_or_error"];

function surprisal(view: Record<string, number>, option: string, t: Thresholds) {
  return -Math.log(Math.max(view[option] ?? 0, t.minProbability));
}

function normalizedEntropy(view: Record<string, number>) {
  const probabilities = Object.values(view).filter((p) => p > 0);
  if (Object.keys(view).length < 2) return 0;
  const entropy = -probabilities.reduce((sum, p) => sum + p * Math.log(p), 0);
  return entropy / Math.log(Object.keys(view).length);
}

/**
 * A village actor's ballot contradicts its own verified results when it targets a player it
 * verified as village, or passes over a verified wolf that is still a legal target. A wolf's
 * ballot is deception, not a contradiction; other moment kinds are not tagged yet.
 */
export function contradictsOwnKnowledge(moment: SurpriseMoment): boolean {
  if (moment.kind !== "ballot" || moment.actorAlignment !== "village") return false;
  const legal = new Set(Object.keys(moment.publicView));
  return moment.verified.some((result) =>
    result.alignment === "village"
      ? result.targetId === moment.actual
      : legal.has(result.targetId) && result.targetId !== moment.actual,
  );
}

export function scoreMoment(moment: SurpriseMoment, t: Thresholds = SURPRISE_THRESHOLDS) {
  return {
    publicProbability: moment.publicView[moment.actual] ?? 0,
    publicSurprisal: surprisal(moment.publicView, moment.actual, t),
    privateProbability: moment.privateView[moment.actual] ?? 0,
    privateSurprisal: surprisal(moment.privateView, moment.actual, t),
    publicFlatness: normalizedEntropy(moment.publicView),
    contradictsOwnKnowledge: contradictsOwnKnowledge(moment),
  };
}
export type MomentScore = ReturnType<typeof scoreMoment>;

function momentClass(score: MomentScore, t: Thresholds): MomentClass {
  const publicSurprising = score.publicProbability <= t.surprising;
  if (score.contradictsOwnKnowledge && !publicSurprising) return "herd_over_knowledge";
  if (score.publicFlatness >= t.flat) return "no_signal";
  const privateExpected = score.privateProbability >= t.expected;
  const privateImprobable = score.privateProbability <= t.surprising;
  if (publicSurprising) {
    if (privateExpected) return "private_knowledge";
    if (privateImprobable || score.contradictsOwnKnowledge) return "noise_or_error";
  }
  if (score.publicProbability >= t.expected && privateImprobable) return "herd_over_knowledge";
  return "routine";
}

export function classifyMoment(moment: SurpriseMoment, t: Thresholds = SURPRISE_THRESHOLDS) {
  const score = scoreMoment(moment, t);
  return { ...moment, score, class: momentClass(score, t) };
}
export type ClassifiedMoment = ReturnType<typeof classifyMoment>;

/** Noteworthy moments by class, then by the stronger of the two surprisals; capped for review. */
export function rankNoteworthy(moments: ClassifiedMoment[], cap: number): ClassifiedMoment[] {
  const strength = (m: ClassifiedMoment) =>
    Math.max(m.score.publicSurprisal, m.score.privateSurprisal);
  return moments
    .filter((m) => REVIEW_ORDER.includes(m.class))
    .sort(
      (a, b) =>
        REVIEW_ORDER.indexOf(a.class) - REVIEW_ORDER.indexOf(b.class) || strength(b) - strength(a),
    )
    .slice(0, cap);
}
