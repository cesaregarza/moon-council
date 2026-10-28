import { describe, expect, it } from "vitest";
import { GameConfigV2Schema, emptyJournalV2, type PlayerContextV2 } from "@werewolf/contracts";
import { createGameState } from "@werewolf/engine";
import { dayStartBlock } from "./claude-session-request";
import { buildContextV2 } from "./context-v2";
import { jevBriefing } from "./jev-briefing";
import { actorConfig } from "./testing/actor-fixtures";

/**
 * CES-1584: a long prose journal no longer stops a game at the context limit. The journal
 * delivered with one request is trimmed, oldest entries first at entry boundaries, behind an
 * explicit marker; the stored journal is untouched, and the build is deterministic. It still
 * fails closed when the request does not fit even without the journal.
 */
const MARKER = "[earlier notes omitted to fit the context limit]";
const entry = (n: number) =>
  `Day ${Math.ceil(n / 4)}, day_discussion:\nNote ${n}. ${"Reasoning about who spoke and why. ".repeat(18)}`;
const journal = (entries: number) => ({
  ...emptyJournalV2(),
  text: Array.from({ length: entries }, (_, i) => entry(i + 1)).join("\n\n"),
});
/**
 * The production sizer of a journal_v4 request is its Jev briefing (orchestrator-v2); a fixed
 * 4,000 tokens stands in for the response schema.
 */
const briefingTokens = (packet: PlayerContextV2) =>
  4_000 + Math.ceil(Buffer.byteLength(JSON.stringify(jevBriefing(packet, undefined)), "utf8") / 3);
const build = (maxContextTokens: number, text: ReturnType<typeof journal>) => {
  const base = actorConfig();
  const state = createGameState(
    "g",
    GameConfigV2Schema.parse({
      ...base,
      deliberation: { ...base.deliberation, maxContextTokens },
    }),
  );
  state.phase = "day_discussion";
  state.day = 3;
  return buildContextV2(state, [], "p1", text, "trim-key", "discussion", [], false, briefingTokens);
};
/** The briefing size with no journal at all: the floor plus schema. */
const floor = briefingTokens(build(32_000, journal(0)));

describe("journal trimming at the context limit (CES-1584)", () => {
  it("trims the delivered journal oldest-first behind a marker, keeping the stored journal", () => {
    const stored = journal(40);
    const limit = floor + 2_000;
    let packet: PlayerContextV2 | undefined;
    expect(() => (packet = build(limit, stored))).not.toThrow();
    expect(briefingTokens(packet!)).toBeLessThanOrEqual(limit);
    const delivered = String(jevBriefing(packet!, undefined).journal);
    expect(delivered.startsWith(`${MARKER}\n\n`)).toBe(true);
    expect(delivered).toContain(entry(40));
    expect(delivered).not.toContain(entry(1));
    // Whole entries only: every delivered entry is one of the stored ones, newest kept.
    const kept = delivered.slice(MARKER.length + 2).split("\n\n");
    expect(stored.text.endsWith(kept.join("\n\n"))).toBe(true);
    // The stored journal, which updates are applied to, is untouched.
    expect(packet!.journal.text).toBe(stored.text);
    // Deterministic: the same inputs omit the same entries.
    expect(String(jevBriefing(build(limit, stored), undefined).journal)).toBe(delivered);
  });

  it("delivers the same trimmed journal in the Claude session's day-start block", () => {
    const packet = build(floor + 2_000, journal(40));
    const block = JSON.parse(dayStartBlock(packet, 0)) as { DAY_START: { journal: string } };
    expect(block.DAY_START.journal).toBe(String(jevBriefing(packet, undefined).journal));
  });

  it("omits every entry, behind the marker, when only the newest one is still too large", () => {
    const stored = { ...emptyJournalV2(), text: entry(1).repeat(12) };
    const packet = build(floor + 500, stored);
    expect(String(jevBriefing(packet, undefined).journal)).toBe(MARKER);
    expect(packet.journal.text).toBe(stored.text);
  });

  it("leaves a journal that fits as it is", () => {
    const stored = journal(3);
    const packet = build(32_000, stored);
    expect(String(jevBriefing(packet, undefined).journal)).toBe(stored.text);
  });

  it("still fails closed when the request cannot fit even without the journal", () => {
    expect(() => build(floor - 50, journal(40))).toThrow(/^context_limit: /);
  });
});
