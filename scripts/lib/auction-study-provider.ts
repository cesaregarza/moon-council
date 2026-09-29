import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  AskJevProvider,
  OpenAIResponsesProvider,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  type JevRequest,
} from "@werewolf/llm";
import type { StudyManifest } from "./auction-study-design";

class MechanicsProvider implements DecisionProvider {
  async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    let value: unknown;
    if (request.kind === "jev") {
      const input = JSON.parse(request.preparedPrompt!.input) as JevRequest;
      value = {
        model: "mechanics-only",
        answers: Object.fromEntries(
          Object.entries(input.questions).map(([id, question]) => {
            if (question.type === "choice") {
              const keys = Object.keys(question.criteria);
              return [
                id,
                {
                  type: "choice",
                  choice: keys[0],
                  confidence: 1,
                  probabilities: Object.fromEntries(keys.map((key, i) => [key, Number(i === 0)])),
                },
              ];
            }
            if (question.type !== "score") throw new Error("Unexpected mechanics question");
            return [
              id,
              {
                type: "score",
                score: 2,
                confidence: 1,
                probabilities: Object.fromEntries(
                  question.criteria.map((_, i) => [String(i), Number(i === 2)]),
                ),
              },
            ];
          }),
        ),
      };
    } else
      value =
        request.schemaName === "study_journal"
          ? { journal: "Mechanics fixture: no social inference. Inspect the provided evidence." }
          : { text: "Mechanics fixture: this synthetic speech is not a live behavioral result." };
    return {
      data: request.schema.parse(value),
      provider: "fake",
      model: "mechanics-only",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}

/** Durable per-attempt ledger; failed responses and unknown usage remain visible. No hidden retries. */
export class StudyProviders {
  private readonly llm: DecisionProvider;
  private readonly jev: DecisionProvider;
  private count = 0;
  private readonly start = Date.now();
  constructor(
    private readonly directory: string,
    private readonly manifest: StudyManifest,
  ) {
    this.llm = manifest.live ? new OpenAIResponsesProvider() : new MechanicsProvider();
    this.jev = manifest.live ? new AskJevProvider() : new MechanicsProvider();
  }
  async call<T>(request: DecisionRequest<T>): Promise<T> {
    if (
      this.count >= 16 + this.manifest.turns * 9 ||
      Date.now() - this.start > this.manifest.maxMinutes * 60000
    )
      throw new Error("Study attempt or wall-time budget exhausted");
    const attempt = ++this.count;
    const started = Date.now();
    const path = join(this.directory, "attempts.jsonl");
    const record = (stage: string, data: unknown) =>
      appendFileSync(
        path,
        JSON.stringify({
          attempt,
          stage,
          at: new Date().toISOString(),
          playerId: request.playerId,
          kind: request.kind,
          data,
        }) + "\n",
        { mode: 0o600 },
      );
    record("started", { model: request.model, prompt: request.preparedPrompt });
    try {
      const provider = request.kind === "jev" ? this.jev : this.llm;
      const result = await provider.decide({
        ...request,
        maxOutputTokens: null,
        timeoutMs: Math.max(
          1,
          Math.min(180000, this.manifest.maxMinutes * 60000 - (Date.now() - this.start)),
        ),
        onProviderRequest: (body) => record("request", body),
        onRawResponse: (response) => record("response", response),
        onUsage: (usage, metadata) => record("usage", { ...usage, ...metadata }),
        onProviderMetadata: (metadata) => record("metadata", metadata),
      });
      record("completed", {
        model: result.model,
        provider: result.provider,
        elapsedMs: Date.now() - started,
      });
      return result.data;
    } catch (error) {
      record("failed", {
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - started,
      });
      throw error;
    }
  }
}
