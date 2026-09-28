import {
  GameConfigV2Schema,
  PERSONALITY_PRESETS,
  STANDARD_ROLE_IDS,
  seatName,
} from "@werewolf/contracts";
import { createGameState, DOCTOR_V2, STARTER_ROLES } from "@werewolf/engine";
import { AskJevProvider, type JevRequest } from "@werewolf/llm";

export interface AttentionRunOptions {
  model: string;
  effort: string;
  seed: string;
  live: boolean;
  maxCalls: number;
  maxMinutes: number;
}

/** Paired arms share every setting except one personality and its urgency override. */
export function attentionConfigs(options: AttentionRunOptions) {
  const seats = STANDARD_ROLE_IDS.map((_, i) => ({
    id: `p${i + 1}`,
    name: seatName(i),
    personality: PERSONALITY_PRESETS.rational.text,
  }));
  const control = GameConfigV2Schema.parse({
    schemaVersion: "game_config_v2",
    protocolVersion: "agent_v3_1",
    preset: "standard-8-v2",
    name: "Attention control: evidence-focused",
    seed: options.seed,
    seats,
    roleDeck: STANDARD_ROLE_IDS.map((id) =>
      id === "doctor" ? DOCTOR_V2 : STARTER_ROLES.find((role) => role.id === id),
    ),
    rules: { firstCycle: "day_first" },
    discussion: { speakerSelection: "listener_auction", maxParallelDecisions: 4 },
    deliberation: { maxJournalTokens: 16000, maxContextTokens: 32000 },
    decisionEngine: { mode: "jev", workflow: "journal_v4" },
    maxTotalTokens: null,
    safety: {
      maxModelCalls: options.maxCalls,
      maxWallClockMs: options.maxMinutes * 60000,
      maxOutputTokens: 8192,
    },
    speedMs: 0,
    modelSettings: Object.fromEntries(
      seats.map((seat) => [
        seat.id,
        {
          model: options.live ? options.model : "fake-model",
          reasoningEffort: options.effort,
          provider: options.live ? "openai" : "fake",
        },
      ]),
    ),
  });
  // Fix a plain villager in both arms, without exposing this selection to players.
  const targetId = createGameState("preview", control).players.find(
    (player) => player.role.id === "villager",
  )!.id;
  const treatment = GameConfigV2Schema.parse({
    ...control,
    name: "Attention treatment: persistent rambler",
    seats: control.seats.map((seat) =>
      seat.id === targetId ? { ...seat, personality: PERSONALITY_PRESETS.rambler.text } : seat,
    ),
    experiment: { forcedUrgency: { [targetId]: 1 } },
  });
  return { targetId, control, treatment };
}

/** Offline mechanics fixture only; these ratings do not simulate social behavior. */
export function syntheticAttentionJev() {
  return new AskJevProvider(async (input) => {
    const request = JSON.parse(input) as JevRequest;
    return JSON.stringify({
      model: "synthetic-attention",
      usage: { input_tokens: 0, output_tokens: 0 },
      answers: Object.fromEntries(
        Object.entries(request.questions).map(([key, question]) => {
          if (question.type === "noul") return [key, { type: "noul", noul: 0 }];
          if (question.type === "score")
            return [
              key,
              {
                type: "score",
                score: 2,
                confidence: 1,
                probabilities: Object.fromEntries(
                  question.criteria.map((_, i) => [String(i), Number(i === 2)]),
                ),
              },
            ];
          const keys = Object.keys(question.criteria);
          return [
            key,
            {
              type: "choice",
              choice: keys[0],
              confidence: 1,
              probabilities: Object.fromEntries(keys.map((value, i) => [value, Number(i === 0)])),
            },
          ];
        }),
      ),
    });
  });
}
