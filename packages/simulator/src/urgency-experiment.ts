import type { GameConfigV2, SpeakerIntentV1 } from "@werewolf/contracts";

/** Apply after scoring, without altering the provider attempt or listener preferences. */
export function experimentSpeakerIntent(
  config: GameConfigV2,
  playerId: string,
  eligible: boolean,
  original: SpeakerIntentV1,
) {
  const overrides = config.experiment?.forcedUrgency;
  if (!eligible || !overrides || !Object.hasOwn(overrides, playerId)) return { intent: original };
  const forced = overrides[playerId]!;
  return {
    intent: { ...original, urge: forced, wantsToSpeak: forced > 0 },
    urgencyOverride: {
      source: "experiment" as const,
      originalUrge: original.urge,
      originalWantsToSpeak: original.wantsToSpeak,
      forcedUrge: forced,
    },
  };
}
