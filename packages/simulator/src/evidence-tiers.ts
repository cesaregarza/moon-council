import type { ContextSourceV2 } from "@werewolf/contracts";

/**
 * V3.2 delivery tiers.
 *
 * Every citable record is delivered at one of these, so a handle never stops resolving and
 * a journal citation can never lose its provenance. Compaction demotes fidelity; it never
 * removes a record and never renumbers a handle.
 *
 * Only `speech.public` is ever demoted. Structural records — eliminations, revealed roles,
 * resolved votes, announcements, the ending — carry outcomes that cannot be reconstructed
 * from a summary, so they stay `full`. They no longer crowd speech out of the shared window
 * either: with a stub floor every speech is always delivered, so the budget only decides how
 * much of each speech is carried, not whether it appears.
 */
export type DeliveryTier = "full" | "digest" | "stub";

export const DEMOTABLE_TYPES = new Set(["speech.public"]);

export function tierOf(source: ContextSourceV2): DeliveryTier {
  return source.detail ?? "full";
}

export function isDemotable(source: ContextSourceV2): boolean {
  return DEMOTABLE_TYPES.has(source.type);
}

/** Truncate on a codepoint boundary so a digest never splits an astral character. */
function clip(text: string, chars: number): string {
  // Evidence budgets count codepoints, not grapheme clusters; preserve archived digest bytes.
  // oxlint-disable-next-line typescript/no-misused-spread
  const points = [...text];
  return points.length <= chars ? text : `${points.slice(0, chars).join("")}…`;
}

/**
 * Shape a record's payload for delivery at `tier`.
 *
 * `alias` maps a canonical event id to its delivered handle; nested references are dropped
 * when they resolve to nothing, exactly as the full rendering already does.
 */
export function tierPayload(
  source: ContextSourceV2,
  tier: DeliveryTier,
  digestChars: number,
  alias: (id: string) => string | undefined,
): Record<string, unknown> {
  if (!isDemotable(source)) return source.data;

  const speakerId = source.data.playerId;
  if (tier === "stub") return { speakerId };

  const acts = Array.isArray(source.data.acts)
    ? source.data.acts.map((value) => {
        const act = value as Record<string, unknown>;
        const evidence = typeof act.sourceId === "string" ? alias(act.sourceId) : undefined;
        return {
          kind: act.kind,
          targetId: act.targetId,
          ...(evidence?.startsWith("E") ? { evidence } : {}),
        };
      })
    : [];
  const respondsTo = Array.isArray(source.data.respondsTo)
    ? source.data.respondsTo
        .map((id) => (typeof id === "string" ? alias(id) : undefined))
        .filter((id): id is string => Boolean(id?.startsWith("E")))
    : [];
  const text = typeof source.data.text === "string" ? source.data.text : "";

  if (tier === "digest") {
    const clipped = clip(text, digestChars);
    return {
      speakerId,
      text: clipped,
      ...(clipped === text ? {} : { abridged: true }),
      acts,
      respondsTo,
    };
  }
  return {
    speakerId,
    speakerName: source.data.playerName,
    text,
    acts,
    respondsTo,
    closing: source.data.closing,
  };
}
