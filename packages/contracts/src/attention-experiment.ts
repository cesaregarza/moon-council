import { z } from "zod";

export const AttentionExperimentSchema = z.strictObject({
  forcedUrgency: z.record(z.string().min(1).max(80), z.number().min(0).max(1)),
});
export type AttentionExperiment = z.infer<typeof AttentionExperimentSchema>;

export function validateAttentionExperiment(
  config: {
    seats: { id: string }[];
    decisionEngine: { mode: string; workflow: string };
    experiment?: AttentionExperiment;
  },
  ctx: z.RefinementCtx,
): void {
  if (!config.experiment) return;
  if (config.decisionEngine.mode !== "jev" || config.decisionEngine.workflow !== "journal_v4")
    ctx.addIssue({
      code: "custom",
      path: ["experiment"],
      message: "Urgency experiments require journal_v4 Jev decisions",
    });
  const ids = new Set(config.seats.map((seat) => seat.id));
  for (const id of Object.keys(config.experiment.forcedUrgency))
    if (!ids.has(id))
      ctx.addIssue({
        code: "custom",
        path: ["experiment", "forcedUrgency", id],
        message: "Unknown seat in urgency experiment",
      });
}

/** The setup form may renumber seats when cloning a saved game. */
export function clonedAttentionExperiment(
  source: { seats: { id: string }[]; experiment?: AttentionExperiment } | undefined,
  seats: { id: string }[],
): AttentionExperiment | undefined {
  if (!source?.experiment) return undefined;
  const forcedUrgency: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [index, original] of source.seats.entries()) {
    const value = Object.hasOwn(source.experiment.forcedUrgency, original.id)
      ? source.experiment.forcedUrgency[original.id]
      : undefined;
    const next = seats[index];
    if (value !== undefined && next) forcedUrgency[next.id] = value;
  }
  return { forcedUrgency };
}
