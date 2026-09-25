import { z } from "zod";

const RecordSchema = z.record(z.string(), z.unknown());
const BundleSchema = z.object({
  attempts: z.array(z.object({
    id: z.string(), decisionId: z.string(), provider: z.string(), status: z.string(),
    promptVersion: z.string(), request: z.object({ input: z.string() }),
    response: z.string().nullable().optional(), error: z.unknown().optional(),
  })),
  decisions: z.array(z.object({ opportunity: z.object({
    id: z.string(), playerId: z.string(), day: z.number(), taskType: z.string(),
    packet: z.object({ self: z.object({ name: z.string() }) }),
    bestSubmission: z.unknown().optional(),
  }) })),
  events: z.array(z.object({ sequence: z.number(), type: z.string(), payload: RecordSchema })),
});

function jsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try { return RecordSchema.parse(JSON.parse(value)); } catch { return null; }
}

function summarizeEvaluation(response: Record<string, unknown> | null) {
  if (!response) return null;
  const answers = z.record(z.string(), RecordSchema).parse(response.answers);
  return Object.fromEntries(Object.entries(answers).filter(([key]) => !key.startsWith("listen_")).map(([key, answer]) => {
    if (answer.type !== "choice") return [key, answer.noul ?? answer.score];
    const probabilities = z.record(z.string(), z.number()).parse(answer.probabilities);
    return [key, { choice: answer.choice, confidence: answer.confidence,
      top: Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3) }];
  }));
}

/** Offline evidence extraction, not an automated judgment of strategy or correctness. */
export function reviewJevDecisions(value: unknown, options: { day?: number; player?: string; decision?: string; task?: string; evidence?: boolean } = {}) {
  const bundle = BundleSchema.parse(value);
  if (options.day !== undefined && (!Number.isInteger(options.day) || options.day < 1)) throw new Error("Invalid review day");
  if (options.player === "" || options.decision === "" || options.task === "") throw new Error("Empty review filter");
  const attempts = [...new Map(bundle.attempts.map(a => [a.id, a])).values()];
  const records = bundle.decisions.flatMap(({ opportunity: op }) => {
    if (options.day !== undefined && options.day !== op.day || options.player && options.player !== op.playerId || options.decision && options.decision !== op.id || options.task && options.task !== op.taskType) return [];
    const calls = attempts.filter(a => a.decisionId === op.id);
    const evaluations = calls.filter(a => a.provider === "jev" && a.status === "valid");
    if (!evaluations.length) return [];
    const first = evaluations[0]!;
    const request = jsonObject(first.request.input);
    if (!request) throw new Error(`Invalid Jev request: ${first.id}`);
    const state = RecordSchema.parse(request.state);
    const questions = z.record(z.string(), RecordSchema).parse(request.questions);
    const reasoning = calls.filter(a => a.promptVersion === "jev_reasoning_v1" && a.status === "valid").map(a => ({ attemptId: a.id, response: jsonObject(a.response) }));
    const sequence = bundle.events.find(e => e.type === "decision.opened" && e.payload.decisionId === op.id)?.sequence ?? null;
    return [{
      sequence, decisionId: op.id, day: op.day, playerId: op.playerId, name: op.packet.self.name, task: op.taskType,
      workflow: first.promptVersion === "jev_actions_v4" ? "journal_v4" : first.promptVersion === "jev_actions_v3" ? "journal_v3" : first.promptVersion === "jev_actions_v2" ? "journal_v2" : "legacy_v1",
      reasoningAvailable: state.reasoningAvailable, reasoned: reasoning.length > 0,
      initial: summarizeEvaluation(jsonObject(first.response)),
      final: summarizeEvaluation(jsonObject(evaluations.at(-1)!.response)),
      legalChoices: state.legalChoices ?? questions.target?.criteria ?? null,
      reasoning,
      semanticAssessments: bundle.events.filter(e=>e.type==="decision.semantic_assessed"&&e.payload.decisionId===op.id).map(e=>e.payload),
      submission: op.bestSubmission,
      invalidAttempts: calls.filter(a => a.status === "invalid").map(a => ({ attemptId: a.id, provider: a.provider, error: a.error })),
      ...(options.evidence ? { evidence: { attemptId: first.id, questions, ...(state.currentReasoning !== undefined ? {perspective:state.perspective,currentReasoning:state.currentReasoning,verifiedFacts:state.verifiedFacts,situation:state.situation} : {}), ...(state.journal !== undefined ? {journal:state.journal,situation:state.situation,facts:state.facts} : {}), public: state.public, private: state.private, task: state.task, plans: questions.plan?.criteria ?? null } } : {}),
    }];
  }).sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity) || a.decisionId.localeCompare(b.decisionId));
  return { decisions: records.length, journalDecisions: records.filter(r=>r.workflow!=="legacy_v1").length, reasoned: records.filter(r => r.reasoned).length,
    directWithGate: records.filter(r => !r.reasoned && r.reasoningAvailable === true).length,
    directWithoutGate: records.filter(r => !r.reasoned && r.reasoningAvailable === false).length, records };
}

/** Export one recorded CLI input unchanged; never call a model or load credentials. */
export function extractJevInput(value: unknown, options: { decision: string; attempt?: string }): string {
  if (!options.decision.trim() || options.attempt !== undefined && !options.attempt.trim()) throw new Error("Empty Jev input selector");
  const bundle = BundleSchema.pick({ attempts: true }).parse(value);
  const calls = [...new Map(bundle.attempts.map(a => [a.id, a])).values()].filter(a =>
    a.provider === "jev" && a.decisionId === options.decision &&
    (options.attempt === undefined ? a.status === "valid" : a.id === options.attempt));
  if (calls.length !== 1) throw new Error(`Expected one Jev input, found ${calls.length}; use --attempt to select an exact recorded attempt`);
  const input = calls[0]!.request.input;
  if (!jsonObject(input)) throw new Error("Recorded Jev input is not a JSON object");
  return input;
}
