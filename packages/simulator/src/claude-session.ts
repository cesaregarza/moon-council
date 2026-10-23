import type { PlayerContextV2, UsageV2 } from "@werewolf/contracts";
import type { DecisionStore } from "@werewolf/db";
import {
  dayStartBlock,
  orderedSources,
  sharedPrefixKey,
  sharedSystemBlocks,
  turnText,
  type ClaudeHarness,
  type ClaudeReplyContent,
} from "./claude-session-request";
import { isTokenCount } from "@werewolf/llm";
import { z } from "zod";
import { estimatedTokens } from "./request-v2";

/**
 * One seat's conversation for one game day (CES-1556), stored in the game database so a resumed
 * game rebuilds the identical bytes. Only answered turns are stored.
 */
export interface ClaudeSessionRecord {
  schemaVersion: "claude_session_v1";
  /** The owning game and seat: a record is replayed only for exactly these (Rule O). */
  gameId: string;
  id: string;
  playerId: string;
  day: number;
  ordinal: number;
  model: string;
  /** Pinned for the whole session: a changed effort invalidates the messages cache. */
  effort: string;
  systemBlocks: [string, string];
  dayStart: string;
  openCursor: number;
  turnCursor: number;
  turns: { kind: string; user: string; assistant: ClaudeReplyContent }[];
  /** Prompt size of the latest answered request (cache reads and writes included). */
  lastPromptTokens: number | null;
  /**
   * That request plus its reply: what the next request re-sends before its new turn, and its
   * spend ceiling. Null when either was unreported, which opens a new session.
   */
  lastTotalTokens: number | null;
  closed: boolean;
}

/** Prompt size at which a new session starts; Haiku 5.5's price rises above 100K tokens. */
export const SESSION_TOKEN_LIMITS: Readonly<Record<string, number>> = {
  "claude-haiku-5-5": 90_000,
};
const DEFAULT_SESSION_TOKEN_LIMIT = 400_000;
const FIVE_MINUTES = { type: "ephemeral", ttl: "5m" } as const;

export interface SessionCall {
  gameId: string;
  playerId: string;
  packet: PlayerContextV2;
  model: string;
  effort: string;
  kind: string;
  /** l0 of the v3.2 request and the response envelope's instructions. */
  instructions: string;
  formatInstructions: string;
  /** l3 of the v3.2 request: the task, commitOnly, previous and repair. */
  requestInput: string;
}

export interface SessionTurn {
  harness: ClaudeHarness;
  /** Always the session's pinned effort, whatever the call asked for. */
  effort: string;
  metadata: { id: string; turn: number; expectedCacheRead: number | null };
  /** Stores an answered reply as the next turn. Unanswered calls store nothing. */
  commit(reply: { content: ClaudeReplyContent; stopReason: string | null; usage: UsageV2 }): void;
}

const TokenCount = z.custom<number>(isTokenCount, "not a token count");

/** The stored shape a record must have before any of it is replayed. */
const SessionRecordSchema = z.strictObject({
  schemaVersion: z.literal("claude_session_v1"),
  gameId: z.string(),
  id: z.string(),
  playerId: z.string(),
  day: z.number().int(),
  ordinal: z.number().int().positive(),
  model: z.string(),
  effort: z.string(),
  systemBlocks: z.tuple([z.string(), z.string()]),
  dayStart: z.string(),
  openCursor: z.number().int(),
  turnCursor: z.number().int(),
  turns: z.array(
    z.strictObject({ kind: z.string(), user: z.string(), assistant: z.array(z.unknown()) }),
  ),
  // Stored counts are null (unreported) or valid token counts; anything else refuses the record.
  lastPromptTokens: TokenCount.nullable(),
  lastTotalTokens: TokenCount.nullable(),
  closed: z.boolean(),
});

const ANOMALIES_KEY = "claude-session-anomalies";
const currentKey = (playerId: string) => `claude-session-current:${playerId}`;
const recordKey = (id: string) => `claude-session:${id}`;

export class ClaudeSessions {
  constructor(private readonly store: DecisionStore) {}

  /**
   * The seat's current session, only if its record passes the schema and belongs to this game
   * and this seat (Rule O). Otherwise nothing is replayed: the pointer is dropped, an anomaly is
   * recorded for audit, and the seat's next call opens a fresh session from its own data.
   */
  load(gameId: string, playerId: string): ClaudeSessionRecord | undefined {
    const id = this.store.get<string>(gameId, currentKey(playerId));
    if (!id) return undefined;
    const parsed = SessionRecordSchema.safeParse(this.store.get(gameId, recordKey(id)));
    const reason = !parsed.success
      ? "record missing or schema-invalid"
      : parsed.data.gameId !== gameId
        ? `record belongs to game ${parsed.data.gameId}`
        : parsed.data.playerId !== playerId
          ? `record belongs to seat ${parsed.data.playerId}`
          : undefined;
    if (!reason) return parsed.data as ClaudeSessionRecord;
    const anomalies = this.store.get<unknown[]>(gameId, ANOMALIES_KEY) ?? [];
    this.store.put(gameId, ANOMALIES_KEY, [...anomalies, { playerId, pointer: id, reason }]);
    this.store.put(gameId, currentKey(playerId), null);
    return undefined;
  }

  /** After a compaction the journal changed outside the session, so the next call reopens. */
  close(gameId: string, playerId: string): void {
    const record = this.load(gameId, playerId);
    if (record && !record.closed) this.save(gameId, { ...record, closed: true });
  }

  begin(call: SessionCall): SessionTurn {
    let record = this.load(call.gameId, call.playerId);
    let turn = record && turnText(call.packet, record, call.requestInput);
    if (!record || !turn || this.mustRenew(record, call, turn.text)) {
      record = this.open(call, record);
      turn = turnText(call.packet, record, call.requestInput);
    }
    const opened = record;
    const pending = turn;
    return {
      harness: this.harness(opened, pending.text),
      effort: opened.effort,
      metadata: {
        id: opened.id,
        turn: opened.turns.length,
        expectedCacheRead: opened.turns.length ? opened.lastPromptTokens : null,
      },
      commit: (reply) => {
        if (reply.stopReason !== "end_turn" || !reply.content.length) return;
        const latest = this.load(call.gameId, call.playerId);
        // Turns are only ever appended. A turn built from a stale record would rewrite history.
        if (latest?.id !== opened.id || latest.turns.length !== opened.turns.length)
          throw new Error(`Claude session ${opened.id} changed while a turn was in flight`);
        this.save(call.gameId, {
          ...latest,
          turns: [
            ...latest.turns,
            { kind: call.kind, user: pending.text, assistant: reply.content },
          ],
          turnCursor: pending.cursor,
          lastPromptTokens: reply.usage.inputTokens,
          lastTotalTokens:
            reply.usage.inputTokens === null || reply.usage.outputTokens === null
              ? null
              : reply.usage.inputTokens + reply.usage.outputTokens,
        });
      },
    };
  }

  /**
   * A new day, a compaction, a model change or the size threshold opens a session. A different
   * per-call effort does not: effort is pinned at opening, because changing it would invalidate
   * the messages cache.
   */
  private mustRenew(record: ClaudeSessionRecord, call: SessionCall, turn: string): boolean {
    const limit = SESSION_TOKEN_LIMITS[call.model] ?? DEFAULT_SESSION_TOKEN_LIMIT;
    return (
      record.closed ||
      record.day !== call.packet.day ||
      record.model !== call.model ||
      record.lastTotalTokens === null ||
      record.lastTotalTokens + estimatedTokens(turn) > limit
    );
  }

  private open(call: SessionCall, previous: ClaudeSessionRecord | undefined): ClaudeSessionRecord {
    let ordinal = (previous?.ordinal ?? 0) + 1;
    // A fresh session after a discarded pointer never overwrites an existing record.
    const idOf = (n: number) => `${call.playerId}:d${call.packet.day}:s${n}`;
    while (this.store.get(call.gameId, recordKey(idOf(ordinal))) !== undefined) ordinal += 1;
    const openCursor = orderedSources(call.packet).length - 1;
    const record: ClaudeSessionRecord = {
      schemaVersion: "claude_session_v1",
      gameId: call.gameId,
      id: idOf(ordinal),
      playerId: call.playerId,
      day: call.packet.day,
      ordinal,
      model: call.model,
      effort: call.effort,
      systemBlocks: sharedSystemBlocks(call.packet, call.instructions, call.formatInstructions),
      dayStart: dayStartBlock(call.packet, openCursor),
      openCursor,
      turnCursor: -1,
      turns: [],
      lastPromptTokens: null,
      lastTotalTokens: 0,
      closed: false,
    };
    this.save(call.gameId, record);
    return record;
  }

  private save(gameId: string, record: ClaudeSessionRecord): void {
    this.store.put(gameId, recordKey(record.id), record);
    this.store.put(gameId, currentKey(record.playerId), record.id);
  }

  /**
   * The request is the stored history plus one new user turn. Earlier turns are replayed
   * byte-for-byte, thinking blocks and signatures included: editing any of them would miss the
   * cache from that point and invalidate every later thinking block.
   */
  private harness(record: ClaudeSessionRecord, pendingTurn: string): ClaudeHarness {
    const text = (value: string, cached = false) => ({
      type: "text" as const,
      text: value,
      ...(cached ? { cache_control: FIVE_MINUTES } : {}),
    });
    return {
      system: [text(record.systemBlocks[0], true), text(record.systemBlocks[1], true)],
      messages: [
        { role: "user", content: [text(record.dayStart, true)] },
        ...record.turns.flatMap((turn) => [
          { role: "user" as const, content: [text(turn.user)] },
          { role: "assistant" as const, content: turn.assistant },
        ]),
        { role: "user", content: [text(pendingTurn)] },
      ],
      automaticCache: true,
      ...(record.turns.length && record.lastTotalTokens !== null
        ? { replayedTokens: record.lastTotalTokens }
        : {}),
      ...(record.turns.length === 0
        ? { warmGateKey: sharedPrefixKey(record.model, record.systemBlocks) }
        : {}),
    };
  }
}
