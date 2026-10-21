import { afterEach, describe, expect, it } from "vitest";
import { LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { createActorHoldout } from "../packages/simulator/src/testing/actor-holdouts";
import { publicBallotRequest, publicDawnRequest } from "./lib/public-view-request";

const connections: DatabaseConnection[] = [];
afterEach(() => {
  while (connections.length) connections.pop()!.close();
});

const FUTURE = "FUTURE-AFTER-DECISION-6c4";
const CANARIES = ["CANARY-JOURNAL-7f3", "CANARY-BID-91c", "CANARY-PACK-2d8", "CANARY-BALLOT-5ab"];
/** Kinds the public view must never carry, whatever their payload. */
const PRIVATE_KINDS = [
  "inspection.delivered",
  "journal.v2_updated",
  "discussion.bid_submitted",
  "team.point",
  "vote.cast",
];

/** A recorded Seer ballot with private evidence, plus seeded private canaries before it. */
function fixture() {
  const db = openDatabase(":memory:");
  connections.push(db);
  const repo = new LabRepository(db);
  const holdout = createActorHoldout(repo, "uncertain-last-wolf");
  const { game, actor, packet } = holdout;
  const at = { day: packet.day, phase: packet.phase } as const;
  repo.appendEvent(game.id, {
    ...at,
    type: "journal.v2_updated",
    visibility: "player",
    audienceIds: [actor.id],
    payload: { playerId: actor.id, journal: { text: CANARIES[0], beliefs: [] } },
  });
  repo.appendEvent(game.id, {
    ...at,
    type: "discussion.bid_submitted",
    visibility: "player",
    audienceIds: [actor.id],
    payload: { playerId: actor.id, rationale: CANARIES[1], urge: 0.9 },
  });
  repo.appendEvent(game.id, {
    ...at,
    type: "team.point",
    visibility: "team",
    audienceIds: [],
    payload: { playerId: actor.id, targetId: holdout.target.id, note: CANARIES[2] },
  });
  // A sealed ballot from another seat, cast before this decision.
  const other = packet.legalTargets.find((id) => id !== holdout.target.id)!;
  repo.appendEvent(game.id, {
    ...at,
    type: "vote.cast",
    visibility: "player",
    audienceIds: [other],
    payload: { vote: { voterId: other, targetId: actor.id }, note: CANARIES[3] },
  });
  const decisionSequence = repo.listEvents(game.id).at(-1)!.sequence + 1;
  // The decision itself, its public resolution and later public play: none may be visible.
  repo.appendEvent(game.id, {
    ...at,
    type: "vote.cast",
    visibility: "player",
    audienceIds: [actor.id],
    payload: { vote: { voterId: actor.id, targetId: holdout.target.id } },
  });
  repo.appendEvent(game.id, {
    ...at,
    phase: "day_resolution",
    type: "vote.resolved",
    visibility: "public",
    payload: { ballots: [], targetId: null, note: FUTURE },
  });
  repo.appendEvent(game.id, {
    ...at,
    type: "speech.public",
    visibility: "public",
    payload: { playerId: other, text: FUTURE, acts: [], respondsTo: [], closing: false },
  });
  return { repo, holdout, decisionSequence, game: repo.getGame(game.id)! };
}

describe("public-view request builder", () => {
  it("asks an observer's question over the recorded ballot's legal options", () => {
    const { repo, holdout, decisionSequence, game } = fixture();
    const { request, options } = publicBallotRequest(repo, game, {
      actorId: holdout.actor.id,
      decisionSequence,
      legalTargets: holdout.packet.legalTargets,
      model: "jev-latest",
    });
    expect(request.model).toBe("jev-latest");
    expect(Object.keys(request.questions)).toEqual(["prediction"]);
    const question = request.questions.prediction!;
    expect(question).toMatchObject({
      type: "choice",
      instructions: `Using only this public record, predict what ${holdout.actor.name} will do in this vote.`,
    });
    const keys = [
      ...holdout.packet.legalTargets.map((_, i) => String.fromCharCode(97 + i)),
      "abstain",
    ];
    expect(Object.keys((question as { criteria: object }).criteria)).toEqual(keys);
    expect(options).toEqual({
      ...Object.fromEntries(holdout.packet.legalTargets.map((id, i) => [keys[i], id])),
      abstain: null,
    });
  });

  it("contains no private kinds, private evidence or seeded canaries", () => {
    const { repo, holdout, decisionSequence, game } = fixture();
    const { request } = publicBallotRequest(repo, game, {
      actorId: holdout.actor.id,
      decisionSequence,
      legalTargets: holdout.packet.legalTargets,
      model: "jev-latest",
    });
    // Guard against a vacuous pass: the view carries real events, all of them public.
    const events = (request.state as { events: Array<{ visibility: string }> }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.visibility === "public")).toBe(true);
    const text = JSON.stringify(request);
    for (const kind of PRIVATE_KINDS) expect(text).not.toContain(`"${kind}"`);
    for (const canary of CANARIES) expect(text).not.toContain(canary);
    // The Seer's own decision brief cites its private inspection; none of it may leak.
    expect(text).not.toContain(holdout.packet.journal.decisionBrief!.action);
  });

  it("predicts the public dawn outcome for a night action from the same projection", () => {
    const { repo, decisionSequence, game } = fixture();
    const { request, options } = publicDawnRequest(repo, game, {
      decisionSequence,
      model: "jev-latest",
    });
    const living = (request.state as { players: Array<{ id: string; alive: boolean }> }).players
      .filter((player) => player.alive)
      .map((player) => player.id);
    expect(Object.values(options)).toEqual([...living, null]);
    expect(Object.keys(options).at(-1)).toBe("no_death");
    expect(request.questions.prediction).toMatchObject({
      type: "choice",
      instructions: "Using only this public record, predict who will be found dead at dawn.",
    });
    const text = JSON.stringify(request);
    for (const canary of CANARIES) expect(text).not.toContain(canary);
  });

  it("never shows the decision, its resolution or anything later", () => {
    const { repo, holdout, decisionSequence, game } = fixture();
    const recorded = new Map(repo.listEvents(game.id).map((event) => [event.id, event.sequence]));
    const requests = [
      publicBallotRequest(repo, game, {
        actorId: holdout.actor.id,
        decisionSequence,
        legalTargets: holdout.packet.legalTargets,
        model: "jev-latest",
      }).request,
      publicDawnRequest(repo, game, { decisionSequence, model: "jev-latest" }).request,
    ];
    for (const request of requests) {
      const events = (request.state as { events: Array<{ id: string }> }).events;
      expect(events.length).toBeGreaterThan(0);
      // Observer views renumber sequences, so map each event back to its recorded sequence.
      const late = events.filter((event) => !(recorded.get(event.id)! < decisionSequence));
      expect(late.map((event) => event.id)).toEqual([]);
      expect(JSON.stringify(request)).not.toContain(FUTURE);
    }
  });
});
