import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DecisionReportV2Schema,
  DiscussionBidV3Schema,
  GameConfigV2Schema,
  ListenerBidV3Schema,
  RATIONALE_INSTRUCTIONS,
  RationaleSchema,
  SpeechSubmissionV3Schema,
  TargetChoiceSubmissionV3Schema,
  emptyJournalV2,
  providerJsonSchema,
  reportSchema,
} from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { DOCTOR_V2, STARTER_ROLES, reduceGame } from "@werewolf/engine";
import {
  FakeDecisionProvider,
  claudeRequest,
  type DecisionProvider,
  type DecisionRequest,
} from "@werewolf/llm";
import { buildContextV2, contentHash } from "./context-v2";
import { DecisionExecutorV2 } from "./decisions-v2";
import { V2GameOrchestrator } from "./orchestrator-v2";
import {
  decisionRequestV31,
  decisionRequestV32,
  normalizeV31Submission,
  validateV31Submission,
} from "./request-v3-1";
import type { V3TaskSpec } from "./request-v3";
import { actorConfig, actorPacket } from "./testing/actor-fixtures";

const lengths = [300, 305, 599, 600];
const variants = [
  { protocol: "agent_v3_1", build: decisionRequestV31 },
  { protocol: "agent_claude_session_v1", build: decisionRequestV32 },
] as const;
const tasks: V3TaskSpec[] = [
  { type: "journal_update", revision: "rationale-test", sourceIds: [] },
  { type: "discussion_free_speech", revision: "rationale-test", ready: false },
  { type: "closing_response", revision: "rationale-test" },
];
const memory = { journalUpdate: null, decisionBrief: null };
function envelope(task: V3TaskSpec, rationale: string) {
  return {
    task: task.type,
    rationale,
    memory:
      task.type === "journal_update"
        ? {
            ...memory,
            decisionBrief: {
              action: "Wait for more evidence.",
              attention: "Hear the quiet seats.",
            },
          }
        : memory,
    speech:
      task.type === "journal_update"
        ? null
        : { text: "A concise public observation.", acts: [], respondsTo: [] },
  };
}

describe("rationale tolerance", () => {
  for (const [name, schema] of [
    ["rationale", RationaleSchema],
    ["bid", DiscussionBidV3Schema.shape.rationale],
    ["listener bid", ListenerBidV3Schema.shape.rationale],
    ["speech", SpeechSubmissionV3Schema.shape.rationale],
    ["target choice", TargetChoiceSubmissionV3Schema.shape.rationale],
    ["normalized summary", DecisionReportV2Schema.shape.summary],
  ] as const) {
    it.each(lengths)(`${name}: preserves accepted text and rejects 600+ (%i)`, (length) => {
      const text = "x".repeat(length);
      const result = schema.safeParse(text);
      expect(result.success).toBe(length < 600);
      if (result.success) expect(result.data).toBe(text);
    });
  }

  it("preserves the archived V2 provider summary limit", () => {
    const packet = actorPacket();
    const task = tasks[0]!;
    const built = decisionRequestV31(packet, task, true, null, null);
    const submission = built.schema.parse(
      built.apiResponseFormat!.decode(envelope(task, "A concise rationale.")),
    );
    const report = normalizeV31Submission(packet, task, submission, "rationale", true);
    const legacy = reportSchema(report.proposal.kind);
    expect(legacy.safeParse({ ...report, summary: "x".repeat(240) }).success).toBe(true);
    expect(legacy.safeParse({ ...report, summary: "x".repeat(241) }).success).toBe(false);
  });

  it("retains existing Unicode counting and does not trim or truncate", () => {
    const accepted = "🌙".repeat(598) + " ";
    expect(accepted.length).toBe(1197);
    expect(RationaleSchema.parse(accepted)).toBe(accepted);
    expect(RationaleSchema.safeParse("🌙".repeat(599)).success).toBe(true);
    expect(RationaleSchema.safeParse("🌙".repeat(600)).success).toBe(false);
  });

  for (const variant of variants) {
    for (const task of tasks) {
      it.each(lengths)(
        `${variant.protocol} ${task.type}: consistent local/API bounds (%i)`,
        (length) => {
          const packet = actorPacket();
          const built = variant.build(packet, task, true, null, null);
          const format = built.apiResponseFormat!;
          const text = "x".repeat(length);
          if (length === 600) {
            expect(() => format.decode(envelope(task, text))).toThrow();
            const value = envelope(task, text);
            const local =
              task.type === "journal_update"
                ? { memory: value.memory, rationale: text }
                : { ...value.speech, memory: value.memory, rationale: text };
            expect(built.schema.safeParse(local).success).toBe(false);
            return;
          }
          const submission = built.schema.parse(format.decode(envelope(task, text)));
          const report = normalizeV31Submission(packet, task, submission, "rationale", true);
          expect(submission.rationale).toBe(text);
          expect(DecisionReportV2Schema.parse(report).summary).toBe(text);
        },
      );

      it(`${variant.protocol} ${task.type}: states target and ceiling in the prompt and Claude schema`, () => {
        const built = variant.build(actorPacket(), task, true, null, null);
        expect(built.prompt.instructions).toContain(RATIONALE_INSTRUCTIONS);
        const original = z
          .object({
            properties: z.object({
              rationale: z.object({
                maxLength: z.literal(599),
                description: z.literal(RATIONALE_INSTRUCTIONS),
              }),
            }),
          })
          .parse(providerJsonSchema(built.apiResponseFormat!.schema));
        expect(original.properties.rationale.maxLength).toBe(599);
        const body = claudeRequest(
          {
            kind: "decision_v3_1",
            model: "claude-haiku-5-5",
            schemaName: task.type,
            maxOutputTokens: 8192,
            schema: built.schema,
            preparedPrompt: built.prompt,
            apiResponseFormat: built.apiResponseFormat,
          },
          8192,
        );
        const format = body.output_config?.format;
        if (format?.type !== "json_schema") throw new Error("Expected JSON schema format");
        const wire = z
          .object({
            properties: z.object({
              rationale: z.object({
                description: z.literal(RATIONALE_INSTRUCTIONS),
                maxLength: z.undefined().optional(),
              }),
            }),
          })
          .parse(format.schema);
        expect(wire.properties.rationale.description).toContain("300");
        expect(wire.properties.rationale.description).toContain("599");
        expect(wire.properties.rationale.description).toContain("600");
      });
    }
  }

  it("keeps action-array, claim and reference constraints at a valid long rationale", () => {
    const task = tasks[1]!;
    const built = decisionRequestV31(actorPacket(), task, true, null, null);
    const base = envelope(task, "x".repeat(599));
    const act = { kind: "accusation", targetId: "p2", claim: "A public claim.", evidence: null };
    const speech = { text: "An observation.", respondsTo: [], acts: [act] };
    expect(() => built.apiResponseFormat!.decode({ ...base, speech })).not.toThrow();
    expect(() =>
      built.apiResponseFormat!.decode({
        ...base,
        speech: { ...speech, acts: Array.from({ length: 5 }, () => act) },
      }),
    ).toThrow();
    expect(() =>
      built.apiResponseFormat!.decode({
        ...base,
        speech: { ...speech, acts: [{ ...act, claim: "x".repeat(241) }] },
      }),
    ).toThrow();
    expect(() =>
      built.apiResponseFormat!.decode({ ...base, speech: { ...speech, respondsTo: ["E0"] } }),
    ).toThrow();
  });
});

const connections: DatabaseConnection[] = [];
afterEach(() => {
  while (connections.length) connections.pop()!.close();
});

describe.each(variants)("$protocol rationale persistence through the executor", (variant) => {
  it.each(lengths)(
    "commits accepted text verbatim; 600 fails bounded validation (%i)",
    async (length) => {
      const connection = openDatabase(":memory:");
      connections.push(connection);
      const repository = new LabRepository(connection);
      repository.seedRoles([...STARTER_ROLES, DOCTOR_V2]);
      const base = actorConfig();
      const config = GameConfigV2Schema.parse({
        ...base,
        protocolVersion: variant.protocol,
        maxSpendUsd: 5,
        modelSettings: Object.fromEntries(
          base.seats.map((seat) => [
            seat.id,
            { model: "claude-haiku-5-5", provider: "anthropic", reasoningEffort: "medium" },
          ]),
        ),
      });
      const game = repository.createGame(config);
      new V2GameOrchestrator(repository, new FakeDecisionProvider()).initialize(game.id);
      repository.updateGame(game.id, { status: "running" });
      const events = repository.listEvents(game.id);
      const state = reduceGame(game.id, events);
      const packet = buildContextV2(state, events, "p1", emptyJournalV2(), "reflection", "pass");
      const store = new DecisionStore(repository);
      const opportunity = {
        id: "rationale-reflection",
        gameId: game.id,
        playerId: "p1",
        kind: "pass" as const,
        phase: state.phase,
        day: state.day,
        epoch: `${state.day}:${state.phase}`,
        viewId: contentHash(packet),
        baseJournalVersion: 0,
        packet,
        status: "open" as const,
        best: null,
        recovery: 0,
        createdAt: new Date().toISOString(),
        taskType: "journal_update" as const,
      };
      store.save(opportunity);
      const task = tasks[0]!;
      const text = "x".repeat(length);
      let calls = 0;
      const provider: DecisionProvider = {
        async decide<T>(request: DecisionRequest<T>) {
          calls++;
          const body = claudeRequest(request, 8192);
          expect(JSON.stringify(body.system)).toContain(RATIONALE_INSTRUCTIONS);
          request.admitSpend?.(0.01);
          const usage = {
            inputTokens: 100,
            outputTokens: 10,
            totalTokens: 110,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningTokens: null,
          };
          request.onUsage?.(usage, {
            provider: "anthropic",
            model: request.model,
            outputLimitEnforced: true,
          });
          request.onProviderMetadata?.({ costUsd: 0.000015, attempts: 1 });
          const value = envelope(task, text);
          request.onClaudeReply?.({
            content: [{ type: "text", text: JSON.stringify(value), citations: null }],
            stopReason: "end_turn",
            usage,
          });
          return {
            data: request.schema.parse(request.apiResponseFormat!.decode(value)),
            provider: "anthropic",
            model: request.model,
            usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
          };
        },
      };
      const execution = new DecisionExecutorV2(repository, provider).execute({
        opportunity,
        mandatoryRemaining: 1,
        validateCurrent: () => true,
        eventsForCommit: () => [],
        requestForAttempt: (commitOnly, previous, repair) => {
          const built = variant.build(packet, task, commitOnly, previous, repair);
          return {
            ...built,
            schemaName: task.type,
            providerKind: "decision_v3_1",
            normalize: (value) =>
              normalizeV31Submission(
                packet,
                task,
                built.schema.parse(value),
                opportunity.id,
                commitOnly,
              ),
            validateSubmission: (value) =>
              validateV31Submission(packet, task, built.schema.parse(value)),
          };
        },
      });
      if (length === 600) {
        await expect(execution).rejects.toThrow("exhausted decision retries");
        expect(calls).toBe(2);
        expect(store.opportunities(game.id)[0]?.status).toBe("paused");
        expect(
          repository.listEvents(game.id).filter((event) => event.type === "decision.committed"),
        ).toHaveLength(0);
      } else {
        await expect(execution).resolves.toBe(true);
        expect(calls).toBe(1);
        const stored = store.opportunities(game.id)[0]!;
        expect(stored.status).toBe("committed");
        expect(stored.best?.summary).toBe(text);
        expect(z.object({ rationale: z.string() }).parse(stored.bestSubmission).rationale).toBe(
          text,
        );
      }
    },
  );
});
