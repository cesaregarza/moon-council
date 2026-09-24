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
