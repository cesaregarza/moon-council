import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { DecisionOpportunityV1, GameEventV1 } from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import {
  AskJevProvider,
  FakeDecisionProvider,
  type DecisionProvider,
  type JevRequest,
} from "@werewolf/llm";
import { V2GameOrchestrator } from "./orchestrator-v2";
import { acknowledgeSemanticAnomaly } from "./semantic-recovery";

/**
 * CES-1558: games saved before revisions were keyed by event sequence still resume. Each fixture
 * is a game written by the pre-change code (main fe60af88, fake providers; see
 * testing/compat-fixtures/README.md) and paused with work in flight. The new code must continue
 * that work without asking again, and must still treat genuinely changed evidence as stale.
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

/** The seat a Jev request is for (V3.2 criteria name the actor as "Name (pN), ..."). */
const seatOf = (request: JevRequest) => /\((p\d+)\), /.exec(JSON.stringify(request))?.[1];

/**
 * Fake players and a working Jev, each recording what they were asked. `voted` tells whether the
 * day's vote had already resolved when a player-model call was made.
 */
function providers(voted: () => boolean = () => false) {
  const llmCalls: { task: string; playerId: string | undefined; afterVote: boolean }[] = [];
  const jevCalls: { seat: string | undefined; input: string }[] = [];
  const fake = new FakeDecisionProvider();
  const llm: DecisionProvider = {
    decide: (request) => {
      llmCalls.push({ task: request.schemaName, playerId: request.playerId, afterVote: voted() });
      return fake.decide(request);
    },
  };
  const jev = new AskJevProvider(async (input) => {
    const request = JSON.parse(input) as JevRequest;
    jevCalls.push({ seat: seatOf(request), input });
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([key, q]) => {
        if (q.type === "noul") return [key, { type: "noul", noul: 0 }];
        if (q.type === "score")
          return [
            key,
            {
              type: "score",
              score: 3,
              confidence: 1,
              probabilities: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0 },
            },
          ];
        const handles = Object.keys(q.criteria as Record<string, unknown>);
        const probabilities = Object.fromEntries(
          handles.map((h, i) => [h, i === 0 ? 0.9 : 0.1 / (handles.length - 1)]),
        );
        return [key, { type: "choice", choice: handles[0], confidence: 1, probabilities }];
      }),
    );
    return JSON.stringify({ model: "fake", usage: { input_tokens: 1, output_tokens: 1 }, answers });
  });
  return { llm, jev, llmCalls, jevCalls };
}

/**
 * Resumes the paused game one committed decision at a time (the orchestrator's decision
 * stepping) until `done`, a stop, or a step cap, so each count covers only the work in question.
 */
async function resume(
  repository: LabRepository,
  gameId: string,
  driven: ReturnType<typeof providers>,
  done: (events: GameEventV1[]) => boolean,
) {
  const runner = new V2GameOrchestrator(repository, driven.llm, driven.jev);
  new DecisionStore(repository).put(gameId, "stepUnit", "decision");
  repository.updateGame(gameId, { status: "stepping", error: null });
  const stepping = () => repository.getGame(gameId)!.status === "stepping";
  for (let step = 0; step < 60 && !done(repository.listEvents(gameId)) && stepping(); step += 1)
    await runner.runGameStep(gameId);
  return repository.listEvents(gameId);
}

const decision = (store: DecisionStore, gameId: string, id: string) =>
  store.get<DecisionOpportunityV1>(gameId, `decision:${id}`);

describe("games saved before sequence-keyed revisions", () => {
  it("resumes a paused vote: commits the saved ballots with no reflection, the seat's brief intact", async () => {
    const { fixture, repository, store } = load("pending-ballot");
    const seat = fixture.outageSeat!;
    const brief = store.journal(fixture.gameId, seat).decisionBrief;
    expect(brief?.action).toBeTruthy();
    const voted = () =>
      repository.listEvents(fixture.gameId).some((e) => e.type === "vote.resolved");
    const driven = providers(voted);
    const events = await resume(repository, fixture.gameId, driven, (all) =>
      all.some((e) => e.type === "vote.resolved"),
    );
    expect(
      events.some((e) => e.type === "vote.resolved"),
      repository.getGame(fixture.gameId)?.error ?? "",
    ).toBe(true);
    // No reflection, or any other player-model call, before the vote resolved. (Decision stepping
    // may run on into the night's own refresh after it, which is new evidence.)
    expect(driven.llmCalls.filter((call) => !call.afterVote)).toEqual([]);
    // Every ballot saved before the pause is committed as it was.
    const saved = fixture.open!.filter((op) => op.saved && op.taskType === "vote_choice");
    expect(saved.length).toBeGreaterThan(0);
    for (const op of saved)
      expect(decision(store, fixture.gameId, op.id)?.status).toBe("committed");
    // The first new decision, the failed voter's ballot, carries the seat's existing brief.
    const ballot = driven.jevCalls.find((call) => call.seat === seat);
    expect(ballot?.input).toContain(brief!.action);
  });

  it("resumes a paused refresh: continues the open reflection under its saved key, once", async () => {
    const { fixture, repository, store } = load("mid-refresh");
    const seat = fixture.outageSeat!;
    const open = fixture.open!.find((op) => op.playerId === seat)!;
    expect(open.taskType).toBe("journal_update");
    const driven = providers();
    await resume(
      repository,
      fixture.gameId,
      driven,
      () => decision(store, fixture.gameId, open.id)?.status === "committed",
    );
    expect(decision(store, fixture.gameId, open.id)?.status).toBe("committed");
    const reflections = driven.llmCalls.filter(
      (call) => call.task === "journal_update" && call.playerId === seat,
    );
    expect(reflections).toHaveLength(1);
  });

  it("resumes a paused auction: resolves it from its saved bids, asking only the missing bidder", async () => {
    const { fixture, repository } = load("mid-auction");
    const seat = fixture.outageSeat!;
    const before = repository.listEvents(fixture.gameId);
    const submitted = before.filter((e) => e.type === "discussion.bid_submitted");
    const inFlight = String(submitted.at(-1)!.payload.auctionKey);
    const resolvedBefore = before.filter((e) => e.type === "discussion.auction_resolved").length;
    const driven = providers();
    const events = await resume(
      repository,
      fixture.gameId,
      driven,
      (all) => all.filter((e) => e.type === "discussion.auction_resolved").length > resolvedBefore,
    );
    const resolution = events.filter((e) => e.type === "discussion.auction_resolved")[
      resolvedBefore
    ];
    expect(resolution?.payload.auctionKey).toBe(inFlight);
    // Only the bidder whose bid failed was asked; the saved bids were not asked again.
    const asked = [...new Set(driven.jevCalls.map((call) => call.seat))];
    expect(asked).toEqual([seat]);
  });

  it("acknowledges a paused semantic anomaly: commits the recorded abstention with no model call", () => {
    const { fixture, repository } = load("semantic-ballot");
    const attempts = () => new DecisionStore(repository).attempts(fixture.gameId).length;
    const before = attempts();
    let result: unknown;
    expect(() => {
      result = acknowledgeSemanticAnomaly(
        repository,
        fixture.gameId,
        fixture.decisionId!,
        "Reviewed the final model receipt",
      );
    }).not.toThrow();
    expect(result).toMatchObject({ status: "committed" });
    expect(attempts()).toBe(before);
  });

  it("still treats a saved ballot as stale once its evidence really changed", () => {
    const { fixture, repository } = load("semantic-ballot");
    const state = repository.listEvents(fixture.gameId).at(-1)!;
    repository.appendEvent(fixture.gameId, {
      day: state.day,
      phase: state.phase,
      type: "speech.public",
      visibility: "public",
      payload: { playerId: "p2", text: "A new claim.", acts: [], respondsTo: [], closing: false },
    });
    expect(() =>
      acknowledgeSemanticAnomaly(
        repository,
        fixture.gameId,
        fixture.decisionId!,
        "Reviewed the final model receipt",
      ),
    ).toThrow(/stale/);
  });
});
