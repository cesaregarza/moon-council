import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { DecisionOpportunityV1 } from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { reduceGame } from "@werewolf/engine";
import { authorizedSources, buildContextV2 } from "./context-v2";
import { actorBriefing } from "./jev-actor";
import { currentDecisionBrief, journalEvidenceRevision } from "./player-brief";
import { decisionRequestV32 } from "./request-v3-1";

/**
 * CES-1558: games saved before revisions were keyed by event sequence still resume. Each fixture
 * is a game written by the pre-change code (main fe60af88, fake providers; see
 * testing/compat-fixtures/README.md) and paused with work in flight. The pending-ballot fixture
 * remains; the resume tests that loaded the others were retired in CES-1585, whose V2 seats no
 * longer accept their free-text personalities, and current-format tests cover those behaviors.
 */
const connections: DatabaseConnection[] = [];
afterEach(() => {
  while (connections.length) connections.pop()!.close();
});

interface CompatFixture {
  gameId: string;
  outageSeat?: string;
  decisionId?: string;
  open?: { id: string; taskType?: string; playerId: string; saved: boolean }[];
  rows: Record<string, Record<string, unknown>[]>;
}

const FIXTURES = join(__dirname, "testing", "compat-fixtures");

/**
 * A fixture: gzip-compressed JSON in base64 text, checked against the sha256 its README records
 * for the decoded file, so a corrupted or swapped fixture fails here, loudly.
 */
function readFixture(name: string): CompatFixture {
  const decoded = gunzipSync(
    Buffer.from(readFileSync(join(FIXTURES, `${name}.json.gz.b64`), "utf8"), "base64"),
  );
  const readme = readFileSync(join(FIXTURES, "README.md"), "utf8");
  const recorded = new RegExp("`" + name + "`.*`([0-9a-f]{64})`").exec(readme)?.[1];
  expect(createHash("sha256").update(decoded).digest("hex"), `${name} sha256`).toBe(recorded);
  return JSON.parse(decoded.toString("utf8"));
}

/** Loads a fixture's rows, exactly as the old code stored them, into a fresh database. */
function load(name: string) {
  const fixture = readFixture(name);
  const connection = openDatabase(":memory:");
  connections.push(connection);
  const order = ["games", ...Object.keys(fixture.rows).filter((table) => table !== "games")];
  for (const table of order) {
    const rows = fixture.rows[table] ?? [];
    if (!rows.length) continue;
    const columns = Object.keys(rows[0]!);
    const insert = connection.sqlite.prepare(
      `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows) insert.run(...columns.map((column) => row[column]));
  }
  const repository = new LabRepository(connection);
  return { fixture, repository, store: new DecisionStore(repository) };
}

const decision = (store: DecisionStore, gameId: string, id: string) =>
  store.get<DecisionOpportunityV1>(gameId, `decision:${id}`);

describe("games saved before sequence-keyed revisions", () => {
  it("builds a new packet for a seat with a current pre-change brief: the legacy stamp, the brief used", () => {
    const { fixture, repository, store } = load("pending-ballot");
    const events = repository.listEvents(fixture.gameId);
    const state = reduceGame(fixture.gameId, events);
    // Seats whose stored brief is current, in the old ID-keyed scheme the pre-change code wrote.
    const seats = state.players
      .filter((p) => p.alive)
      .map((p) => {
        const sources = authorizedSources(state, events, p.id);
        return {
          id: p.id,
          brief: store.journal(fixture.gameId, p.id).decisionBrief,
          legacy: journalEvidenceRevision(sources, []),
          current: journalEvidenceRevision(sources, events),
        };
      })
      .filter((seat) => seat.brief?.evidenceRevision === seat.legacy);
    expect(seats.length).toBeGreaterThan(0);
    for (const seat of seats) {
      expect(seat.legacy).not.toBe(seat.current);
      // A new decision, never asked before the pause, so its packet is built now.
      const packet = buildContextV2(
        state,
        events,
        seat.id,
        store.journal(fixture.gameId, seat.id),
        `compat:new-packet:${seat.id}`,
        "vote",
      );
      expect(packet.rules.journalRevision, seat.id).toBe(seat.legacy);
      expect(currentDecisionBrief(packet), seat.id).toEqual(seat.brief);
    }
  });
});

/**
 * CES-1575 part 3: an auction-every-turn game saved by the base code (main 19017ee8; see
 * testing/compat-fixtures/README.md) still holds the social bookkeeping that mode no longer keeps:
 * Gale's speech carries a challenge act against Briar, and Briar's paused score bid persists a
 * response docket naming that speech. Resumed by the current code, no agent input may restate it,
 * and nothing stored is rewritten. Bodies are compared case- and whitespace-insensitively.
 */
describe("an auction-every-turn game saved with response dockets", () => {
  const flat = (text: string) => text.toLowerCase().replace(/\s+/g, "");
  const CLAIM = flat("Please explain your current read.");
  // The derived reminder line. The seat's own journal, written by its model, may say "unanswered".
  const REMINDER = /unanswered(challenge|accusation)by/;
  const savedBid = () => {
    const loaded = load("saved-bid");
    const op = decision(loaded.store, loaded.fixture.gameId, loaded.fixture.decisionId!)!;
    return { ...loaded, op };
  };

  it("holds a saved score bid whose persisted docket names an annotated challenge", () => {
    const { fixture, op } = savedBid();
    expect(op.taskType).toBe("discussion_score");
    expect(op.playerId).toBe(fixture.outageSeat);
    expect(op.packet.rules.discussionMode).toBe("auction_every_turn");
    const docketed = op.packet.sources.filter((s) => op.packet.responseDocket.includes(s.id));
    expect(docketed.map((s) => (s.data.acts as { kind: string }[])[0]?.kind)).toEqual([
      "challenge",
    ]);
  });

  it("renders a listen opportunity on the restored packet without the docket", () => {
    const { op } = savedBid();
    const text = flat(
      JSON.stringify(actorBriefing({ ...op, taskType: "discussion_listen" } as never)),
    );
    expect(text).not.toMatch(REMINDER);
    expect(text).not.toContain(CLAIM);
  });

  it("renders a speech request on the restored packet without the annotations or the docket", () => {
    const { op } = savedBid();
    // Demoted to a stub, the docketed speech is not re-delivered because the docket cites it.
    const packet = {
      ...op.packet,
      sources: op.packet.sources.map((s) =>
        op.packet.responseDocket.includes(s.id) ? { ...s, detail: "stub" as const } : s,
      ),
      journal: { ...op.packet.journal, beliefs: [], hypotheses: [], attentionNotes: [] },
    };
    const request = decisionRequestV32(
      packet,
      { type: "discussion_free_speech", ready: false, revision: "resume" },
      false,
      null,
      null,
    );
    const text = flat(
      Object.values(request.prompt)
        .filter((p) => typeof p === "string")
        .join("\n"),
    );
    expect(text).not.toContain(flat("what concrete observation"));
    const full = decisionRequestV32(
      op.packet,
      { type: "discussion_free_speech", ready: false, revision: "resume" },
      false,
      null,
      null,
    );
    const fullText = flat(
      Object.values(full.prompt)
        .filter((p) => typeof p === "string")
        .join("\n"),
    );
    expect(fullText).toContain(flat("what concrete observation"));
    expect(fullText).not.toMatch(/\\?"(acts|respondsto|responsedocket)\\?":/);
    expect(fullText).not.toContain(CLAIM);
  });

  it("still renders the reminder for the same packet in the staged mode", () => {
    const { op } = savedBid();
    const { discussionMode: _mode, ...rules } = op.packet.rules;
    const staged = { ...op, packet: { ...op.packet, rules } };
    expect(actorBriefing(staged as never).verifiedFacts).toContain(
      "Unanswered challenge by Gale to Briar: Please explain your current read. (unverified claim).",
    );
  });
});
