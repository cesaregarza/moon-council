import { AttentionExperimentSchema } from "@werewolf/contracts";

export function ExperimentSummary({ config }: { config: unknown }) {
  if (!config || typeof config !== "object" || !("experiment" in config)) return null;
  const parsed = AttentionExperimentSchema.safeParse(config.experiment);
  if (!parsed.success) return null;
  return (
    <aside className="panel" aria-label="Experiment settings">
      <strong>Forced urgency experiment</strong>
      <p>
        {Object.entries(parsed.data.forcedUrgency)
          .map(([id, urge]) => `${id}: ${urge}`)
          .join(" · ")}
      </p>
      <p>Applies while eligible. Original Jev scores are preserved in bid records.</p>
    </aside>
  );
}
