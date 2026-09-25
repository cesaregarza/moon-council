import { z } from "zod";

// Validate the fields used in calculations; retain the rest of every audit receipt verbatim.
const measuredCount = z.number().int().nonnegative();
const duration = z.number().nonnegative();
export const EvaluationRows = z.array(
  z.looseObject({
    label: z.string().min(1),
    passed: z.boolean(),
    error: z.string().nullable(),
    latencyMs: duration,
    response: z
      .looseObject({
        model: z.string(),
        usage: z.looseObject({ input_tokens: measuredCount }).optional(),
      })
      .nullable(),
  }),
);
export type EvaluationRow = z.infer<typeof EvaluationRows>[number];

export const HoldoutReport = z.looseObject({
  results: z.array(
    z.looseObject({
      label: z.string().min(1),
      workflow: z.enum(["journal_v3", "journal_v4"]),
      choices: z.array(z.looseObject({ passes: z.boolean() })),
      attempts: z.array(
        z.looseObject({
          model: z.string(),
          usage: z.looseObject({ inputTokens: measuredCount.nullable() }),
          latencyMs: duration.nullable(),
        }),
      ),
      semanticReconsiderationsMeasured: measuredCount,
      addedLlmCallsMeasured: measuredCount,
    }),
  ),
});

export const ReflectionReport = z.looseObject({
  results: z.array(z.unknown()),
  luna: z.looseObject({
    usage: z.record(z.string(), z.unknown()),
    reflectionLatencyMs: duration,
    briefCharacters: z.object({ action: measuredCount, attention: measuredCount }),
    voteStatus: z.string(),
  }),
});
