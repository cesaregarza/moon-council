import { z } from "zod";
import { PrivateJournalV2Schema } from "@werewolf/contracts";
import { journalText } from "./freeform-journal";

const Count = z.number().finite().nonnegative().nullable().optional();
const BundleSchema = z.object({
  schemaVersion: z.enum([
    "werewolf_research_bundle_v2",
    "werewolf_research_bundle_v3",
    "werewolf_research_bundle_v3_1",
    "werewolf_research_bundle_v4",
  ]),
  attempts: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      optional: z.boolean(),
      latencyMs: Count,
      model: z.string(),
      reasoningEffort: z.string(),
      usage: z.object({
        inputTokens: Count,
        outputTokens: Count,
        totalTokens: Count,
        cachedInputTokens: Count,
        reasoningTokens: Count,
      }),
    }),
  ),
  events: z.array(
    z.object({
      id: z.string(),
      sequence: z.number().optional(),
      day: z.number(),
      phase: z.string(),
      type: z.string(),
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
});

/** Read an exported artifact only. Never query the provider or modify game state. */
export function inspectResearchBundle(
  value: unknown,
  options: {
    matches?: string[];
    day?: number;
    limit?: number;
    offset?: number;
    eventTypes?: string[];
    player?: string;
  } = {},
) {
  const bundle = BundleSchema.parse(value);
  const { matches = [], day, limit = 30, offset = 0, eventTypes = [], player } = options;
  if (
    eventTypes.some((term) => !term.trim()) ||
    player === "" ||
    matches.some((term) => !term.trim()) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    (day !== undefined && (!Number.isInteger(day) || day < 0))
  )
    throw new Error("Invalid inspection filters");
  const attempts = [...new Map(bundle.attempts.map((a) => [a.id, a])).values()];
  const latency = attempts
    .flatMap((a) => (a.latencyMs == null ? [] : [a.latencyMs]))
    .sort((a, b) => a - b);
  const median = latency.length
    ? (latency[Math.floor((latency.length - 1) / 2)]! + latency[Math.floor(latency.length / 2)]!) /
      2
    : null;
  const tokenFields = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "reasoningTokens",
  ] as const;
  const usage = Object.fromEntries(
    tokenFields.map((key) => [
      key,
      {
        knownTotal: attempts.reduce((n, a) => n + (a.usage[key] ?? 0), 0),
        unknownAttempts: attempts.filter((a) => a.usage[key] == null).length,
      },
    ]),
  );
  const records = bundle.events.flatMap((event) => {
    if (day !== undefined && event.day !== day) return [];
    if (eventTypes.length && !eventTypes.includes(event.type)) return [];
    const p = event.payload;
    if (player !== undefined && p.playerId !== player) return [];
    let content: unknown;
    if (eventTypes.length) content = p;
    else if (event.type === "speech.public") content = { text: p.text, acts: p.acts };
    else if (event.type === "journal.v2_updated") content = p.patch;
    else if (event.type === "decision.reported") {
      const report = p.report as Record<string, unknown> | undefined;
      content = {
        taskType: p.taskType,
        submission: p.submission,
        summary: report?.summary,
        inferences: report?.inferences,
        journalPatch: report?.journalPatch,
        continuation: p.continuation,
      };
    } else return [];
    const search = JSON.stringify(content)?.toLocaleLowerCase("en-US") ?? "";
    if (
      (!matches.length && !eventTypes.length) ||
      (matches.length && !matches.some((term) => search.includes(term.toLocaleLowerCase("en-US"))))
    )
      return [];
    return [
      {
        eventId: event.id,
        sequence: event.sequence,
        day: event.day,
        phase: event.phase,
        type: event.type,
        playerId: p.playerId,
        decisionId: p.decisionId,
        content,
      },
    ];
  });
  return {
    schemaVersion: "bundle_inspection_v1",
    attempts: attempts.length,
    models: [...new Set(attempts.map((a) => a.model + " / " + a.reasoningEffort))],
    latency: {
      recorded: latency.length,
      totalMs: latency.reduce((a, b) => a + b, 0),
      medianMs: median,
      maxMs: latency.at(-1) ?? null,
      invalidMs: attempts
        .filter((a) => a.status === "invalid")
        .reduce((n, a) => n + (a.latencyMs ?? 0), 0),
      optionalMs: attempts.filter((a) => a.optional).reduce((n, a) => n + (a.latencyMs ?? 0), 0),
    },
    optionalAttempts: attempts.filter((a) => a.optional).length,
    statusCounts: Object.fromEntries(
      [...new Set(attempts.map((a) => a.status))]
        .sort()
        .map((status) => [status, attempts.filter((a) => a.status === status).length]),
    ),
    usage,
    matchedRecords: records.length,
    offset,
    records: records.slice(offset, offset + limit),
  };
}

/** Latest saved notes, without summarizing or rewriting the player's prose. */
export function journalSnapshotMarkdown(value: unknown, player?: string): string {
  if (player !== undefined && !player.trim()) throw new Error("Empty journal player filter");
  const { events } = BundleSchema.pick({ events: true }).parse(value);
  const roster = events.find((e) => e.type === "game.created")?.payload.players;
  const players = z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        role: z.object({ name: z.string() }).optional(),
      }),
    )
    .parse(roster ?? []);
  const latest = new Map<
    string,
    {
      event: (typeof events)[number];
      journal: z.infer<typeof PrivateJournalV2Schema>;
      order: number;
    }
  >();
  for (const [index, event] of events.entries()) {
    if (event.type !== "journal.v2_updated") continue;
    const id = z.string().parse(event.payload.playerId);
    if (player !== undefined && id !== player) continue;
    const order = event.sequence ?? index;
    if (latest.has(id) && latest.get(id)!.order > order) continue;
    latest.set(id, { event, journal: PrivateJournalV2Schema.parse(event.payload.journal), order });
  }
  if (!latest.size) throw new Error("No matching saved journals");
  const entries = [...latest]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, { event, journal }]) => {
      const person = players.find((p) => p.id === id);
      return `## ${person?.name ?? id}${person?.role ? ` — ${person.role.name}` : ""}\n\nSaved version ${journal.version}; day ${event.day}, ${event.phase}; source event ${event.id}.\n\n${journalText(journal)}`;
    });
  return (
    "# Saved private journals\n\nPrivate game information. Each entry is the latest saved journal in this bundle, not a fresh reflection on subsequent events. Prose is verbatim; archived structured journals use the standard text renderer.\n\n" +
    entries.join("\n\n---\n\n") +
    "\n"
  );
}
