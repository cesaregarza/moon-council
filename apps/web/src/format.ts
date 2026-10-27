const COUNT_SUFFIXES = ["", "K", "M", "B", "T"] as const;

export function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (magnitude < 1_000) return Math.round(value).toLocaleString("en-US");

  let tier = Math.min(Math.floor(Math.log10(magnitude) / 3), COUNT_SUFFIXES.length - 1);
  let scaled = value / 1_000 ** tier;
  let fractionDigits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
  let rounded = Number(scaled.toFixed(fractionDigits));
  if (Math.abs(rounded) >= 1_000 && tier < COUNT_SUFFIXES.length - 1) {
    tier += 1;
    scaled = value / 1_000 ** tier;
    fractionDigits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
    rounded = Number(scaled.toFixed(fractionDigits));
  }
  return `${rounded.toLocaleString("en-US", { maximumFractionDigits: fractionDigits })}${COUNT_SUFFIXES[tier]}`;
}

/**
 * The observer's label for a speech's social acts, as recorded games show it, or null for a
 * speech with none: an auction-every-turn speech carries no acts (CES-1575).
 */
export function speechActLabel(
  payload: Record<string, unknown>,
  nameOf: (id: string) => string,
): string | null {
  if (!Array.isArray(payload.acts)) return null;
  const acts = payload.acts as { kind: string; targetId: string | null }[];
  return `${acts
    .map((act) => `${act.kind.replaceAll("_", " ")} ${act.targetId ? nameOf(act.targetId) : ""}`)
    .join(" · ")} · Claims are unverified`;
}
