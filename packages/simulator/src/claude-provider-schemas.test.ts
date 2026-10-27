import { describe, expect, it } from "vitest";
import type { PlayerContextV2 } from "@werewolf/contracts";
import { createHash } from "node:crypto";
import { providerJsonSchema } from "@werewolf/contracts";
import { claudeRequest, type DecisionRequest } from "@werewolf/llm";
import { sharedSystemBlocks } from "./claude-session-request";
import { journalCompactionRequest } from "./journal-compaction";
import { decisionRequestV31, decisionRequestV32, v31ApiResponseFormat } from "./request-v3-1";
import type { V3TaskSpec } from "./request-v3";
import { actorFixtures, actorPacket } from "./testing/actor-fixtures";

/**
 * CES-1578: every output schema the Anthropic provider would send must use only what Claude's
 * structured outputs support. The auction-every-turn speech schema once carried a `oneOf` (from a
 * discriminated union), and Anthropic rejected every request with HTTP 400.
 *
 * PROVIDER rules come from Anthropic's structured-output documentation: the supported keywords are
 * type, properties, required, additionalProperties, items, enum, const, anyOf, allOf, $ref/$defs
 * and a simple regex `pattern`; `oneOf`, `not` and `if`/`then`/`else` are not among them; numeric and
 * string-length constraints are not supported; every object must set additionalProperties false;
 * recursion is not supported. HOUSE rules are our stricter subset: no keyword outside the list
 * below, so a new keyword is a deliberate choice. `pattern` and non-recursive $ref/definitions
 * (the staged speech's acts and respondsTo items) are provider-supported and allowed; every $ref is
 * resolved and walked, and a $ref back into its own chain is a recursion violation.
 */
const PROVIDER_FORBIDDEN = new Set([
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
]);
const HOUSE_ALLOWED = new Set([
  "$schema",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "allOf",
  "pattern",
  "$ref",
  "definitions",
  "$defs",
  "description",
  "title",
  "default",
]);

/** Every keyword or shape Claude would reject, as `RULE path: problem`. */
function violations(
  schema: unknown,
  path = "$",
  seen = new Set<unknown>(),
  root: Record<string, unknown> = schema as Record<string, unknown>,
): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  if (seen.has(schema)) return [`PROVIDER ${path}: recursive schema`];
  seen.add(schema);
  const node = schema as Record<string, unknown>;
  const found = Object.keys(node).flatMap((key) =>
    PROVIDER_FORBIDDEN.has(key)
      ? [`PROVIDER ${path}: unsupported keyword ${key}`]
      : HOUSE_ALLOWED.has(key)
        ? []
        : [`HOUSE ${path}: keyword ${key} outside the house subset`],
  );
  if ((node.type === "object" || node.properties) && node.additionalProperties !== false)
    found.push(`PROVIDER ${path}: object without additionalProperties false`);
  const child = (value: unknown, at: string) =>
    found.push(...violations(value, at, new Set(seen), root));
  if (typeof node.$ref === "string") {
    const target = /^#\/(definitions|\$defs)\/(.+)$/.exec(node.$ref);
    const resolved = target
      ? (root[target[1]!] as Record<string, unknown>)?.[target[2]!]
      : undefined;
    if (!resolved) found.push(`PROVIDER ${path}: unresolvable $ref ${node.$ref}`);
    else child(resolved, `${path}->${node.$ref}`);
  }
  for (const [name, value] of Object.entries((node.properties ?? {}) as Record<string, unknown>))
    child(value, `${path}.properties.${name}`);
  if (node.items) child(node.items, `${path}.items`);
  for (const key of ["anyOf", "allOf", "oneOf"])
    for (const [index, value] of ((node[key] as unknown[]) ?? []).entries())
      child(value, `${path}.${key}[${index}]`);
  return found;
}

/** The schema claudeRequest sends in output_config.format for one prepared request. */
function sentSchema(prepared: {
  schema: DecisionRequest<unknown>["schema"];
  apiResponseFormat?: DecisionRequest<unknown>["apiResponseFormat"];
  prompt: DecisionRequest<unknown>["preparedPrompt"];
}): unknown {
  let body;
  try {
    body = claudeRequest(
      {
        kind: "decision_v3_1",
        model: "claude-haiku-5-5",
        schemaName: "schema-guard",
        schema: prepared.schema,
        apiResponseFormat: prepared.apiResponseFormat,
        maxOutputTokens: 500,
        preparedPrompt: prepared.prompt,
      },
      8192,
    );
  } catch (error) {
    return { refused: String(error) };
  }
  return (body.output_config as { format: { schema: unknown } }).format.schema;
}

const living = (packet: PlayerContextV2) =>
  packet.players.filter((p) => p.alive && p.id !== packet.self.id).map((p) => p.id);
function tasks(packet: PlayerContextV2): V3TaskSpec[] {
  const candidateIds = living(packet);
  return [
    { type: "journal_update", revision: "r", sourceIds: [] },
    { type: "discussion_free_speech", ready: false, revision: "r" },
    { type: "closing_response", revision: "r" },
    { type: "discussion_bid", eligible: true, candidateIds, revision: "r" },
    { type: "discussion_listen", eligible: false, candidateIds, revision: "r" },
    { type: "discussion_score", eligible: true, candidateIds, revision: "r" },
    { type: "vote_choice", proposalKind: "vote" },
    { type: "second_poll", accusationId: "a", targetId: candidateIds[0]! },
    { type: "second_urgency", accusationId: "a", targetId: candidateIds[0]! },
    { type: "lynch_ballot", accusationId: "a", targetId: candidateIds[0]! },
  ];
}
/** Packets for each workflow and discussion mode the provider can serve. */
function packets(): { label: string; packet: PlayerContextV2 }[] {
  const staged = actorPacket();
  const everyTurn = actorPacket();
  everyTurn.rules = { ...everyTurn.rules, discussionMode: "auction_every_turn" };
  const llmEngine = actorPacket();
  const { jevWorkflow: _workflow, ...rules } = llmEngine.rules;
  llmEngine.rules = rules;
  return [
    { label: "staged journal_v4", packet: staged },
    { label: "auction_every_turn journal_v4", packet: everyTurn },
    { label: "staged llm engine", packet: llmEngine },
  ];
}

describe("schemas sent to Claude use only supported structured-output keywords (CES-1578)", () => {
  const cases = packets().flatMap(({ label, packet }) =>
    tasks(packet).flatMap((task) =>
      (
        [
          ["agent_v3_1", decisionRequestV31],
          ["agent_v3_2 and the Claude session", decisionRequestV32],
        ] as const
      ).map(([protocol, build]) => ({
        name: `${label}, ${protocol}, ${task.type}`,
        packet,
        task,
        build,
      })),
    ),
  );

  it.each(cases)("$name", ({ packet, task, build }) => {
    let prepared;
    try {
      prepared = build(packet, task, false, null, null);
    } catch {
      return; // a task this packet's workflow cannot ask has no request to send
    }
    expect(violations(sentSchema(prepared))).toEqual([]);
  });

  it.each(actorFixtures().map((fixture) => ({ name: fixture.label, ...fixture })))(
    "actor fixture $name",
    ({ packet, task }) => {
      const spec = {
        type: task,
        proposalKind:
          task === "night_choice"
            ? "night_action"
            : task === "team_point_choice"
              ? "team_point"
              : "vote",
        eligible: true,
        candidateIds: living(packet),
        revision: "r",
      } as unknown as V3TaskSpec;
      expect(violations(sentSchema(decisionRequestV32(packet, spec, false, null, null)))).toEqual(
        [],
      );
    },
  );

  it("covers the auction-every-turn speech envelope that Anthropic rejected", () => {
    const { packet } = packets()[1]!;
    const task = { type: "discussion_free_speech", ready: false, revision: "r" } as const;
    expect(
      JSON.stringify(sentSchema(decisionRequestV32(packet, task, false, null, null))),
    ).toContain("endAction");
  });

  it("covers both journal compaction schemas", () => {
    const base = actorPacket().journal;
    for (const candidate of [{ ...base, text: "Notes." }, base]) {
      const compaction = {
        candidate,
        sourceReport: {} as never,
        sourceSubmission: {},
        sourceAttemptId: "a",
      } as never;
      const request = journalCompactionRequest(compaction, 16_000, 8192, null, false);
      expect(violations(sentSchema({ ...request, prompt: request.prompt as never }))).toEqual([]);
    }
  });
});

/**
 * A Claude session's instruction identity, as claude-session.ts computes it from what
 * decisions-v2 passes: system block 1 and the canonical response schema (before the Anthropic
 * transform). A changed identity renews a session opened under older code.
 */
function sessionIdentity(packet: PlayerContextV2) {
  const task = { type: "discussion_free_speech", ready: false, revision: "r" } as const;
  const prompt = decisionRequestV32(packet, task, false, null, null).prompt;
  const format = v31ApiResponseFormat(packet, task)!;
  const responseSchema = JSON.stringify(providerJsonSchema(format.schema));
  const block = sharedSystemBlocks(packet, prompt.instructions, format.instructions)[0];
  return {
    responseSchema,
    identity: createHash("sha256")
      .update(JSON.stringify([block, responseSchema]))
      .digest("hex"),
  };
}

describe("Claude session identity follows the canonical schema (CES-1578)", () => {
  /** Identities at main 1dc80ae7, before the fix. */
  const AT_1DC80AE7 = {
    staged: "531fd564f7879079037bb1a2f8f1d8db175bdb099c8da96890f98f06f8cb54e8",
    everyTurn: "6b103d4f793c6bd607c0592d28214210aacc6d6ec5f31c4a3c3900563bc9373b",
  };

  it("renews new-mode sessions: the canonical schema has no oneOf, so the identity changed", () => {
    const { packet } = packets()[1]!;
    const current = sessionIdentity(packet);
    expect(current.responseSchema).not.toContain("oneOf");
    expect(current.identity).not.toBe(AT_1DC80AE7.everyTurn);
  });

  it("keeps staged session identities as they were", () => {
    const { packet } = packets()[0]!;
    expect(sessionIdentity(packet).identity).toBe(AT_1DC80AE7.staged);
  });
});
