import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GameConfigV2Schema,
  emptyJournalV2,
  type GameConfigV2,
  type GameEventV1,
  type SpeakerIntentV1,
} from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase, type DatabaseConnection } from "@werewolf/db";
import { createGameState, shuffled } from "@werewolf/engine";
import {
  AskJevProvider,
  FakeDecisionProvider,
  type DecisionProvider,
  type JevRequest,
} from "@werewolf/llm";
import { buildApi } from "../../../apps/api/src/app";
import { observerEvents } from "../../../apps/api/src/observer";
import { auditGameV2 } from "./audit-v2";
import { buildContextV2, publicPayload } from "./context-v2";
import { lynchOutcome } from "./every-turn";
import { V2GameOrchestrator, type EveryTurnPolicies } from "./orchestrator-v2";
import { JOURNAL_EVIDENCE_TYPES } from "./player-brief";
import { v31ApiResponseFormat, v31SubmissionSchema, validateV31Submission } from "./request-v3-1";
import { publicRevision, rankSpeakerAuction, responseDockets } from "./scheduler-v2";
import { actorConfig } from "./testing/actor-fixtures";

/**
 * CES-1575: the `auction_every_turn` discussion mode. Every turn, every living player bids or
 * declines and the speaker auction alone picks who speaks. A speech may end by formally accusing
 * a living player. Every other living player (the accused included) is polled, on one snapshot,
 * on whether to second it; among several yes answers an urgency poll picks the seconder. A
 * seconded accusation goes to a public yes/no ballot of every living player, and a strict
 * majority of the living eliminates the accused. The scheduler only administers. Offline: fake
 * players, scripted Jev, and a test double for the one rule Cesar has not decided (how a day with
 * no lynch ends).
 */
const connections: DatabaseConnection[] = [];
const apis: Awaited<ReturnType<typeof buildApi>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (connections.length) connections.pop()!.close();
  while (apis.length) {
    const built = apis.pop()!;
    await built.app.close();
    built.connection.close();
  }
});

function everyTurnConfig(seed: string, turnBudgetFactor = 1): GameConfigV2 {
  const base = actorConfig();
  return GameConfigV2Schema.parse({
    ...base,
    seed,
    rules: { ...base.rules, firstCycle: "day_first" },
    discussion: { ...base.discussion, mode: "auction_every_turn", turnBudgetFactor },
    safety: { ...base.safety, maxCycles: 1, maxModelCalls: 10_000, maxWallClockMs: 86_400_000 },
  });
}

/** A test double for the undecided rule; production supplies none, so the mode cannot start. */
function policies(overrides: Partial<EveryTurnPolicies> = {}): EveryTurnPolicies {
  return { noLynchDayEnd: () => "end_day", ...overrides };
}

const hash = (value: string) => createHash("sha256").update(value).digest().readUInt32BE(0);
const seatOf = (input: string) => /\((p\d+)\), /.exec(input)?.[1];
/** Today's public speeches by seat, from the floor line in Jev's scheduling briefing. */
const spokenToday = (input: string, seat: string) =>
  Number(new RegExp(`\\(${seat}\\): (\\d+) public speeches`).exec(input)?.[1] ?? 0);
const score = (value: number) => ({
  type: "score",
  score: value,
  confidence: 1,
  probabilities: Object.fromEntries([0, 1, 2, 3, 4].map((n) => [n, n === value ? 1 : 0])),
});

interface Script {
  /** The seat's urgency score, 0 (declines) to 4. */
  urge: (seat: string, input: string) => number;
  /** Listening scores; by default they vary with the request so auctions differ. */
  listen?: (key: string, input: string) => number;
  /** The seat's answer to the seconding poll: "yes" or "no", or anything else for garbage. */
  second?: (seat: string) => string;
  /** The seat's urgency to second, 0 to 4. */
  secondUrgency?: (seat: string) => number;
  /** The seat's lynch ballot: "yes" or "no", or anything else for garbage. */
  ballot?: (seat: string) => string;
  /**
   * Called on every request with its procedure point (the urge, second, urgency or ballot
   * question it asks) and seat; a number returned is reported as that call's token usage.
   */
  onCall?: (point: string, seat: string) => number | void;
}
const POINTS = ["urge", "second", "urgency", "ballot"];

/** Scripted Jev, recording every request it is asked. */
function scriptedJev(script: Script) {
  const inputs: { seat: string | undefined; input: string }[] = [];
  const jev = new AskJevProvider(async (input) => {
    const request = JSON.parse(input) as JevRequest;
    const seat = seatOf(input) ?? "";
    inputs.push({ seat, input });
    const point = POINTS.find((key) => key in request.questions) ?? "other";
    const tokens = script.onCall?.(point, seat) ?? 1;
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([key, q]) => {
        if (key === "urge") return [key, score(script.urge(seat, input))];
        if (key === "urgency") return [key, score(script.secondUrgency?.(seat) ?? 2)];
        if (q.type === "noul") return [key, { type: "noul", noul: 0 }];
        if (q.type === "score")
          return [key, score(script.listen?.(key, input) ?? hash(`${key}:${input}`) % 5)];
        const handles = Object.keys(q.criteria as Record<string, unknown>);
        const choice =
          key === "second"
            ? (script.second?.(seat) ?? "no")
            : key === "ballot"
              ? (script.ballot?.(seat) ?? "no")
              : handles[0];
        const probabilities = Object.fromEntries(handles.map((h) => [h, h === choice ? 1 : 0]));
        return [key, { type: "choice", choice, confidence: 1, probabilities }];
      }),
    );
    return JSON.stringify({
      model: "fake",
      usage: { input_tokens: tokens, output_tokens: 1 },
      answers,
    });
  });
  return { jev, inputs };
}

type EndAction = { kind: "continue" } | { kind: "accuse"; targetId: string };
/** Fake players whose n-th speech (from 0) ends with `endAction(seat, n)`. */
function players(endAction: (seat: string, n: number) => EndAction = () => ({ kind: "continue" })) {
  const fake = new FakeDecisionProvider();
  let spoken = 0;
  const llm: DecisionProvider = {
    decide: async (request) => {
      const result = await fake.decide(request);
      if (request.schemaName !== "discussion_free_speech") return result;
      const data = { ...(result.data as object), endAction: endAction(request.playerId!, spoken) };
      spoken += 1;
      return { ...result, data: data as never };
    },
  };
  return llm;
}

/** Plays day 1 until it is over: night, a pause, or the game's end. */
async function playDay(
  config: GameConfigV2,
  jev: AskJevProvider,
  llm: DecisionProvider = players(),
  rules: EveryTurnPolicies | null = policies(),
) {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  const repository = new LabRepository(connection);
  const game = repository.createGame(config);
  new V2GameOrchestrator(repository, new FakeDecisionProvider()).initialize(game.id);
  const runner = new V2GameOrchestrator(repository, llm, jev, rules ?? undefined);
  repository.updateGame(game.id, { status: "running" });
  const over = () =>
    repository.getGame(game.id)!.status !== "running" ||
    repository
      .listEvents(game.id)
      .some(
        (e) => e.type === "phase.changed" && e.payload.to !== "day_discussion" && e.sequence > 2,
      );
  for (let step = 0; step < 400 && !over(); step += 1) await runner.runGameStep(game.id);
  return { repository, id: game.id, events: repository.listEvents(game.id) };
}

const living = (config: GameConfigV2) => config.seats.map((seat) => seat.id).sort();
const speeches = (events: GameEventV1[]) =>
  events.filter((e) => e.type === "speech.public" && e.day === 1);
const auctions = (events: GameEventV1[]) =>
  events.filter((e) => e.type === "discussion.auction_resolved" && e.day === 1);
const ofType = (events: GameEventV1[], type: string) => events.filter((e) => e.type === type);
const nextPhase = (events: GameEventV1[]) =>
  events.findLast((e) => e.type === "phase.changed")?.payload.to;

/** Each seat bids high until it has spoken today; equal listening, so the seeded order decides. */
const freshSpeakersFirst: Script = {
  urge: (seat, input) => (spokenToday(input, seat) ? 1 : 4),
  listen: () => 3,
};

describe("auction_every_turn: the turn loop", () => {
  it("refuses a config without the turn budget, and a game without the no-lynch policy", async () => {
    const base = actorConfig();
    expect(() =>
      GameConfigV2Schema.parse({
        ...base,
        discussion: { ...base.discussion, mode: "auction_every_turn" },
      }),
    ).toThrow();
    const { jev } = scriptedJev({ urge: () => 4 });
    const { repository, id, events } = await playDay(
      everyTurnConfig("no-policies"),
      jev,
      players(),
      null,
    );
    expect(repository.getGame(id)!.status).toBe("paused");
    expect(repository.getGame(id)!.error).toMatch(/no-lynch/);
    expect(speeches(events)).toEqual([]);
  });

  it("every turn, every living player bids and the top-ranked bid speaks (20 seeds)", async () => {
    for (let n = 0; n < 20; n += 1) {
      const config = everyTurnConfig(`auction-every-turn-${n}`, 0.5);
      const { jev } = scriptedJev({ urge: (seat, input) => hash(`${seat}:${input}`) % 5 });
      const { events } = await playDay(config, jev);
      const resolved = auctions(events);
      expect(resolved.length, `seed ${n}`).toBeGreaterThan(0);
      for (const auction of resolved) {
        const {
          stage,
          round,
          publicRevision: revision,
          intents,
          bias,
        } = auction.payload as {
          stage: string;
          round: number;
          publicRevision: string;
          intents: Record<string, SpeakerIntentV1>;
          bias: number;
        };
        expect(stage, `seed ${n}`).toBe("turn");
        expect(Object.keys(intents).sort(), `seed ${n}: every living player bids`).toEqual(
          living(config),
        );
        const tieOrder = shuffled(
          living(config),
          `${config.seed}:discussion:1:auction-v3:turn:${round}:${revision}`,
        );
        const ranked = rankSpeakerAuction(
          living(config),
          Object.entries(intents).map(([playerId, intent]) => ({ playerId, intent })),
          bias,
          tieOrder,
        );
        const top = ranked[0]?.playerId ?? null;
        expect(auction.payload.selectedPlayerId, `seed ${n} round ${round}`).toBe(top);
        if (top) {
          const speech = events.find(
            (e) => e.type === "speech.public" && e.sequence > auction.sequence,
          );
          expect(speech?.payload.playerId, `seed ${n} round ${round}: the winner speaks`).toBe(top);
        }
      }
    }
  }, 300_000);

  it("never makes a seat that always declines speak, and has no staged choreography", async () => {
    for (let n = 0; n < 3; n += 1) {
      const config = everyTurnConfig(`always-declines-${n}`);
      const { jev } = scriptedJev({
        urge: (seat, input) => (seat === "p3" ? 0 : 1 + (hash(input) % 4)),
      });
      const { events } = await playDay(config, jev);
      expect(speeches(events).length, `seed ${n}`).toBeGreaterThan(0);
      expect(speeches(events).filter((e) => e.payload.playerId === "p3")).toEqual([]);
      const staged = events.filter(
        (e) =>
          e.day === 1 &&
          (["opening", "followup", "closing"].includes(String(e.payload.stage)) ||
            e.type.startsWith("discussion.closing") ||
            (e.type === "speech.public" && e.payload.closing === true)),
      );
      expect(staged.map((e) => `${e.type}:${String(e.payload.stage)}`)).toEqual([]);
    }
  }, 120_000);

  it("shows a docket in the briefing without forcing the named player to speak", async () => {
    const config = everyTurnConfig("docket-briefing");
    // A seat's briefing lists only challenges owed to it; once it sees one, it never bids again.
    const silenced = new Set<string>();
    const { jev } = scriptedJev({
      urge: (seat, input) => {
        if (input.includes("Unanswered challenge")) silenced.add(seat);
        return silenced.has(seat) ? 0 : 1 + (hash(input) % 4);
      },
    });
    const { repository, id, events } = await playDay(config, jev);
    expect(silenced.size).toBeGreaterThan(0);
    for (const seat of silenced) {
      const challenge = speeches(events).find((e) =>
        (e.payload.acts as { kind: string; targetId: string | null }[]).some(
          (act) => act.kind === "challenge" && act.targetId === seat,
        ),
      );
      expect(challenge, `a challenge to ${seat}`).toBeDefined();
      const bids = new DecisionStore(repository)
        .opportunities(id)
        .filter((op) => op.playerId === seat && op.taskType === "discussion_score");
      expect(
        bids.some((op) => op.packet.responseDocket.includes(challenge!.id)),
        seat,
      ).toBe(true);
      expect(
        speeches(events).filter(
          (e) => e.payload.playerId === seat && e.sequence > challenge!.sequence,
        ),
        `${seat} is not forced to speak`,
      ).toEqual([]);
    }
  }, 120_000);

  it("asks the no-lynch policy after an all-decline round: ending the day goes to night", async () => {
    const asked: string[] = [];
    const { jev } = scriptedJev({ urge: () => 0 });
    const { events } = await playDay(
      everyTurnConfig("all-decline-ends"),
      jev,
      players(),
      policies({
        noLynchDayEnd: ({ reason }) => {
          asked.push(reason);
          return "end_day";
        },
      }),
    );
    expect(asked).toEqual(["all_declined"]);
    expect(auctions(events)).toHaveLength(1);
    expect(auctions(events)[0]!.payload.selectedPlayerId).toBeNull();
    expect(ofType(events, "discussion.ended").map((e) => [e.visibility, e.payload.reason])).toEqual(
      [["moderator", "no_lynch"]],
    );
    expect(ofType(events, "player.eliminated")).toEqual([]);
    expect(nextPhase(events)).toBe("night_team");
  }, 60_000);

  it("runs another turn when the no-lynch policy says so, until the turn budget pauses", async () => {
    // ceil(8 living * 0.25) = 2 turns.
    const { jev } = scriptedJev({ urge: () => 0 });
    const { repository, id, events } = await playDay(
      everyTurnConfig("all-decline-continues", 0.25),
      jev,
      players(),
      policies({ noLynchDayEnd: () => "next_turn" }),
    );
    expect(auctions(events).map((e) => e.payload.selectedPlayerId)).toEqual([null, null]);
    expect(ofType(events, "discussion.ended")).toEqual([]);
    expect(repository.getGame(id)!.status).toBe("paused");
    expect(repository.getGame(id)!.error).toMatch(/turn budget/);
  }, 60_000);

  it("pauses, fail-closed, when the day's turn budget is spent; it never forces an outcome", async () => {
    const { jev } = scriptedJev({ urge: (_seat, input) => 1 + (hash(input) % 4) });
    const { repository, id, events } = await playDay(everyTurnConfig("turn-budget", 0.25), jev);
    expect(speeches(events)).toHaveLength(2);
    expect(repository.getGame(id)!.status).toBe("paused");
    expect(ofType(events, "game.paused").at(-1)?.payload.reason).toMatch(/turn budget/);
    expect(nextPhase(events)).toBe("day_discussion");
  }, 60_000);
});

describe("auction_every_turn: accusations, seconding and the lynch vote", () => {
  /**
   * The first speaker not in `exclude` accuses Hollis (p8), or Gale (p7) if the speaker is
   * Hollis; every other speech continues.
   */
  const accuseOnce = (exclude: string[] = []) => {
    let accused = false;
    return players((seat) => {
      if (accused || exclude.includes(seat)) return { kind: "continue" };
      accused = true;
      return { kind: "accuse", targetId: seat === "p8" ? "p7" : "p8" };
    });
  };
  /** Everyone seconds at equal urgency; `yes` seats then vote yes and everyone else no. */
  const lynchVote = (yes: string[]): Script => ({
    ...freshSpeakersFirst,
    second: () => "yes",
    ballot: (seat) => (yes.includes(seat) ? "yes" : "no"),
  });
  const ops = (repository: LabRepository, id: string, taskType: string) =>
    new DecisionStore(repository).opportunities(id).filter((op) => op.taskType === taskType);
  const accusationOf = (events: GameEventV1[]) => {
    const raised = ofType(events, "accusation.raised")[0]!;
    expect(raised, "an accusation was raised").toBeDefined();
    return {
      raised,
      accuser: String(raised.payload.accuserId),
      target: String(raised.payload.targetId),
    };
  };

  it("polls every living player but the accuser, the accused included, on one snapshot", async () => {
    const { jev } = scriptedJev({ ...freshSpeakersFirst, second: () => "no" });
    const { repository, id, events } = await playDay(
      everyTurnConfig("second-poll", 0.5),
      jev,
      accuseOnce(),
    );
    const first = speeches(events)[0]!;
    const { raised, accuser, target } = accusationOf(events);
    expect(first.payload.endAction).toEqual({ kind: "accuse", targetId: target });
    expect(accuser).toBe(first.payload.playerId);
    expect(raised.visibility).toBe("public");
    const polled = ops(repository, id, "second_poll");
    expect(polled.map((op) => op.playerId).sort()).toEqual(
      living(everyTurnConfig("x")).filter((seat) => seat !== accuser),
    );
    expect(polled.map((op) => op.playerId)).toContain(target);
    // One frozen snapshot: every poll packet is built through the same latest public record,
    // and every poll opened before any answer was recorded, so no answer can see another.
    const sequence = new Map(events.map((e) => [e.id, e.sequence]));
    const latestPublic = polled.map((op) =>
      Math.max(
        ...op.packet.sources
          .filter((source) => source.scope === "public")
          .map((source) => sequence.get(source.id) ?? -1),
      ),
    );
    expect(new Set(latestPublic).size).toBe(1);
    const decisionIds = new Set(polled.map((op) => op.id));
    const opened = events.filter(
      (e) => e.type === "decision.opened" && decisionIds.has(String(e.payload.decisionId)),
    );
    const firstAnswer = events.find((e) => e.type === "accusation.poll_answered")!;
    expect(opened).toHaveLength(polled.length);
    expect(opened.every((e) => e.sequence < firstAnswer.sequence)).toBe(true);
    // No seconds: recorded publicly, no urgency poll, no ballots, and the auction resumes.
    const unseconded = ofType(events, "accusation.unseconded");
    expect(unseconded.map((e) => [e.visibility, e.payload.accusationId])).toEqual([
      ["public", raised.id],
    ]);
    expect(ops(repository, id, "second_urgency")).toEqual([]);
    expect(ofType(events, "lynch.ballot_cast")).toEqual([]);
    expect(auctions(events).some((e) => e.sequence > unseconded[0]!.sequence)).toBe(true);
  }, 120_000);

  it("lets a single yes second outright, with no urgency poll", async () => {
    const { jev } = scriptedJev({
      ...freshSpeakersFirst,
      second: (seat) => (seat === "p3" ? "yes" : "no"),
    });
    const { repository, id, events } = await playDay(
      everyTurnConfig("second-single", 0.5),
      jev,
      accuseOnce(["p3"]),
    );
    expect(ofType(events, "accusation.seconded").map((e) => e.payload.seconderId)).toEqual(["p3"]);
    expect(ops(repository, id, "second_urgency")).toEqual([]);
    expect(ops(repository, id, "lynch_ballot")).toHaveLength(8);
  }, 120_000);

  it("polls urgency among the yes answers only, and the most urgent seconds", async () => {
    const yes = ["p2", "p4", "p6"];
    const { jev } = scriptedJev({
      ...freshSpeakersFirst,
      second: (seat) => (yes.includes(seat) ? "yes" : "no"),
      secondUrgency: (seat) => (seat === "p4" ? 4 : 1),
    });
    const { repository, id, events } = await playDay(
      everyTurnConfig("second-urgency", 0.5),
      jev,
      accuseOnce(yes),
    );
    const { accuser } = accusationOf(events);
    expect(yes).not.toContain(accuser);
    expect(
      ops(repository, id, "second_urgency")
        .map((op) => op.playerId)
        .sort(),
    ).toEqual(yes);
    expect(ofType(events, "accusation.seconded").map((e) => e.payload.seconderId)).toEqual(["p4"]);
  }, 120_000);

  it("breaks an urgency tie by the seeded order, identically on replay", async () => {
    const run = async () => {
      const { jev } = scriptedJev({ ...freshSpeakersFirst, second: () => "yes" });
      return playDay(everyTurnConfig("second-tie", 0.5), jev, accuseOnce());
    };
    const first = await run();
    const second = await run();
    const { raised, accuser } = accusationOf(first.events);
    const yes = living(everyTurnConfig("x")).filter((seat) => seat !== accuser);
    const expected = shuffled(yes, `second-tie:discussion:1:second:${raised.sequence}`)[0];
    const seconder = (events: GameEventV1[]) =>
      ofType(events, "accusation.seconded").map((e) => e.payload.seconderId);
    expect(seconder(first.events)).toEqual([expected]);
    expect(seconder(second.events)).toEqual([expected]);
  }, 240_000);

  it("names only the seconder in public; answers and urgencies stay with the moderator", async () => {
    const yes = ["p2", "p4", "p6"];
    const { jev } = scriptedJev({
      ...freshSpeakersFirst,
      second: (seat) => (yes.includes(seat) ? "yes" : "no"),
      secondUrgency: (seat) => (seat === "p4" ? 4 : 1),
    });
    const { repository, id, events } = await playDay(
      everyTurnConfig("second-privacy", 0.5),
      jev,
      accuseOnce(yes),
    );
    const seconded = ofType(events, "accusation.seconded");
    expect(seconded.map((e) => [e.visibility, Object.keys(e.payload).sort()])).toEqual([
      ["public", ["accusationId", "seconderId", "seconderName", "targetId", "targetName"]],
    ]);
    const answers = events.filter(
      (e) => e.type === "accusation.poll_answered" || e.type === "accusation.urgency_answered",
    );
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.every((e) => e.visibility === "moderator")).toBe(true);
    const publicView = JSON.stringify(observerEvents(repository, id, { kind: "public" }));
    for (const hidden of ["poll_answered", "urgency_answered", '"urgency"', '"second"'])
      expect(publicView, hidden).not.toContain(hidden);
    // No player's briefing holds another's answers or scores.
    for (const op of new DecisionStore(repository).opportunities(id)) {
      const types = op.packet.sources.map((source) => source.type);
      expect(types).not.toContain("accusation.poll_answered");
      expect(types).not.toContain("accusation.urgency_answered");
    }
  }, 120_000);

  it("pauses without an outcome when a poll answer is still invalid after the retries", async () => {
    const { jev } = scriptedJev({
      ...freshSpeakersFirst,
      second: (seat) => (seat === "p4" ? "maybe" : "no"),
    });
    const { repository, id, events } = await playDay(
      everyTurnConfig("second-invalid", 0.5),
      jev,
      accuseOnce(["p4"]),
    );
    const { raised } = accusationOf(events);
    expect(repository.getGame(id)!.status).toBe("paused");
    expect(repository.getGame(id)!.error).toMatch(/exhausted decision retries/);
    expect(ofType(events, "accusation.seconded")).toEqual([]);
    expect(ofType(events, "accusation.unseconded")).toEqual([]);
    expect(ofType(events, "lynch.ballot_cast")).toEqual([]);
    expect(auctions(events).some((e) => e.sequence > raised.sequence)).toBe(false);
  }, 120_000);

  it("eliminates the accused at exactly a strict majority of the living, then goes to night", async () => {
    // 8 living: 5 yes is floor(8/2)+1. The accuser and the accused vote too.
    const { jev, inputs } = scriptedJev(lynchVote(["p1", "p2", "p3", "p4", "p5"]));
    const { events } = await playDay(everyTurnConfig("lynch-passes"), jev, accuseOnce());
    const { accuser, target } = accusationOf(events);
    const revealed = ofType(events, "lynch.ballots_revealed");
    expect(revealed.map((e) => e.visibility)).toEqual(["public"]);
    const cast = revealed[0]!.payload.ballots as Record<string, string>;
    expect(Object.keys(cast).sort()).toEqual(living(everyTurnConfig("x")));
    expect(cast[target]).toBeDefined();
    expect(cast[accuser]).toBeDefined();
    expect(Object.values(cast).filter((b) => b === "yes")).toHaveLength(5);
    expect(ofType(events, "lynch.resolved").map((e) => [e.payload.passed, e.payload.yes])).toEqual([
      [true, 5],
    ]);
    expect(
      ofType(events, "player.eliminated").map((e) => [e.payload.playerId, e.payload.cause]),
    ).toEqual([[target, "vote"]]);
    expect(ofType(events, "discussion.ended").map((e) => e.payload.reason)).toEqual([
      "lynch_passed",
    ]);
    expect(nextPhase(events)).toBe("night_team");
    // Each ballot was the player's own Jev decision, asked about the accused by name.
    const asked = inputs.filter((call) => call.input.includes('"ballot"'));
    expect(new Set(asked.map((call) => call.seat)).size).toBe(8);
  }, 180_000);

  it("fails at a tie, half the living, and returns to the auction", async () => {
    const { jev } = scriptedJev(lynchVote(["p1", "p2", "p3", "p4"]));
    const { events } = await playDay(everyTurnConfig("lynch-ties", 0.5), jev, accuseOnce());
    const resolved = ofType(events, "lynch.resolved");
    expect(resolved.map((e) => [e.visibility, e.payload.passed, e.payload.yes])).toEqual([
      ["public", false, 4],
    ]);
    expect(ofType(events, "player.eliminated")).toEqual([]);
    expect(auctions(events).some((e) => e.sequence > resolved[0]!.sequence)).toBe(true);
  }, 180_000);

  it("checks for a winner after a passing lynch: eliminating the last wolf ends the game", async () => {
    // Five seats: one wolf, a seer and three villagers, dealt by the seed. The wolf never bids,
    // so a village player speaks and accuses it, the others second, and all four vote yes.
    const base = everyTurnConfig("lynch-wins");
    const seats = base.seats.slice(0, 5);
    const config = GameConfigV2Schema.parse({
      ...base,
      seats,
      roleDeck: [0, 2, 4, 5, 6].map((index) => base.roleDeck[index]),
      modelSettings: Object.fromEntries(
        seats.map((seat) => [seat.id, base.modelSettings[seat.id]]),
      ),
    });
    const wolf = createGameState("dealt", config).players.find(
      (player) => player.role.alignment === "werewolf",
    )!.id;
    const { jev } = scriptedJev({
      urge: (seat) => (seat === wolf ? 0 : 4),
      listen: () => 3,
      second: (seat) => (seat === wolf ? "no" : "yes"),
      ballot: (seat) => (seat === wolf ? "no" : "yes"),
    });
    const { events } = await playDay(
      config,
      jev,
      players(() => ({ kind: "accuse", targetId: wolf })),
    );
    expect(ofType(events, "lynch.resolved").map((e) => [e.payload.passed, e.payload.yes])).toEqual([
      [true, 4],
    ]);
    const eliminated = ofType(events, "player.eliminated");
    expect(eliminated.map((e) => e.payload.playerId)).toEqual([wolf]);
    const ended = ofType(events, "game.ended");
    expect(ended.map((e) => e.payload.winnerAlignments)).toEqual([["village"]]);
    expect(ended[0]!.sequence).toBeGreaterThan(eliminated[0]!.sequence);
    expect(events.some((e) => e.type === "phase.changed" && e.payload.to === "night_team")).toBe(
      false,
    );
  }, 180_000);

  it("pauses without resolving when a ballot is still invalid after the retries", async () => {
    const { jev } = scriptedJev({
      ...lynchVote(["p1", "p2", "p3", "p5", "p6"]),
      ballot: (seat) => (seat === "p4" ? "abstain" : "yes"),
    });
    const { repository, id, events } = await playDay(
      everyTurnConfig("lynch-missing-ballot"),
      jev,
      accuseOnce(),
    );
    expect(ofType(events, "accusation.seconded")).toHaveLength(1);
    expect(repository.getGame(id)!.status).toBe("paused");
    expect(repository.getGame(id)!.error).toMatch(/exhausted decision retries/);
    expect(ofType(events, "lynch.ballots_revealed")).toEqual([]);
    expect(ofType(events, "lynch.resolved")).toEqual([]);
    expect(ofType(events, "player.eliminated")).toEqual([]);
  }, 180_000);

  it("passes the invariant audit on seeded games with accusations", async () => {
    for (let n = 0; n < 3; n += 1) {
      const { jev } = scriptedJev(lynchVote(n === 0 ? ["p1", "p2", "p3", "p4", "p5"] : ["p1"]));
      const { repository, id, events } = await playDay(
        everyTurnConfig(`audit-${n}`, 0.5),
        jev,
        accuseOnce(),
      );
      expect(ofType(events, "lynch.resolved").length, `seed ${n}`).toBe(1);
      expect(auditGameV2(repository, id).issues, `seed ${n}`).toEqual([]);
    }
  }, 300_000);
});

describe("auction_every_turn: records, schemas and dockets", () => {
  const event = (
    type: string,
    payload: Record<string, unknown>,
    visibility: GameEventV1["visibility"] = "public",
    sequence = 5,
  ): GameEventV1 => ({
    schemaVersion: "game_event_v1",
    id: `${type}-${sequence}`,
    gameId: "g",
    sequence,
    day: 1,
    phase: "day_discussion",
    type,
    visibility,
    audienceIds: [],
    payload,
    createdAt: "1970-01-01T00:00:00.000Z",
  });
  const speech = (text: string, extra: Record<string, unknown> = {}) =>
    event("speech.public", {
      playerId: "p2",
      playerName: "Briar",
      text,
      acts: [],
      respondsTo: [],
      closing: false,
      ...extra,
    });
  const stateFor = (config: GameConfigV2) => {
    const state = createGameState("g", config);
    state.phase = "day_discussion";
    state.day = 1;
    return state;
  };
  const withEli = (config: GameConfigV2) =>
    stateFor({
      ...config,
      seats: config.seats.map((seat) => (seat.id === "p5" ? { ...seat, name: "Eli" } : seat)),
    });

  it("matches docket names on whole words in the new mode only", () => {
    const believe = [speech("I believe the quiet ones are hiding something.")];
    const everyTurn = withEli(everyTurnConfig("dockets"));
    expect(responseDockets(everyTurn, believe).p5).toEqual([]);
    expect(responseDockets(everyTurn, [speech("Eli, where were you?")]).p5).toEqual([
      "speech.public-5",
    ]);
    // The staged mode keeps its recorded substring behaviour, so old games replay unchanged.
    expect(responseDockets(withEli(actorConfig()), believe).p5).toEqual(["speech.public-5"]);
  });

  const packetFor = (config: GameConfigV2, playerId = "p1") =>
    buildContextV2(stateFor(config), [], playerId, emptyJournalV2(), "speech", "discussion");
  const task = { type: "discussion_free_speech", ready: true, revision: "1" } as const;
  const submission = {
    text: "Hollis has dodged every question.",
    acts: [],
    respondsTo: [],
    rationale: "Press the suspect.",
    memory: { journalUpdate: null, decisionBrief: null },
  };

  it("requires an endAction on the new mode's speeches only, accusing a living other player", () => {
    const packet = packetFor(everyTurnConfig("schema"));
    const everyTurn = v31SubmissionSchema(packet, task);
    expect(everyTurn.safeParse(submission).success).toBe(false);
    for (const endAction of [{ kind: "continue" }, { kind: "accuse", targetId: "p8" }])
      expect(everyTurn.safeParse({ ...submission, endAction }).success, endAction.kind).toBe(true);
    expect(everyTurn.safeParse({ ...submission, endAction: { kind: "call_vote" } }).success).toBe(
      false,
    );
    const accusing = (targetId: string) =>
      validateV31Submission(packet, task, {
        ...submission,
        endAction: { kind: "accuse", targetId },
      } as never);
    expect(accusing("p8")).toEqual([]);
    expect(accusing("p1").join(" ")).toMatch(/accusation/);
    const staged = v31SubmissionSchema(packetFor(actorConfig()), task);
    expect(staged.safeParse(submission).success).toBe(true);
    expect(staged.safeParse({ ...submission, endAction: { kind: "continue" } }).success).toBe(
      false,
    );
    // The journal response envelope carries it too.
    const format = v31ApiResponseFormat(packet, task)!;
    let decoded: unknown;
    expect(() => {
      decoded = format.decode({
        task: "discussion_free_speech",
        memory: { journalUpdate: null, decisionBrief: null },
        speech: {
          text: submission.text,
          acts: [],
          respondsTo: [],
          endAction: { kind: "accuse", targetId: "p8" },
        },
        rationale: submission.rationale,
      });
    }).not.toThrow();
    expect(decoded).toMatchObject({ endAction: { kind: "accuse", targetId: "p8" } });
  });

  it("takes a lynch ballot as yes or no only; abstaining is not a ballot", () => {
    const config = everyTurnConfig("ballot-schema");
    const accused = event("accusation.raised", {
      accuserId: "p2",
      accuserName: "Briar",
      targetId: "p8",
      targetName: "Hollis",
    });
    const packet = buildContextV2(
      stateFor(config),
      [accused],
      "p8",
      emptyJournalV2(),
      "lynch",
      "lynch_ballot" as never,
    );
    const ballot = v31SubmissionSchema(packet, {
      type: "lynch_ballot",
      accusationId: accused.id,
      targetId: "p8",
    } as never);
    const base = {
      rationale: "Decide as the player.",
      evidence: [],
      memory: { journalUpdate: null, decisionBrief: null },
    };
    expect(ballot.safeParse({ ...base, ballot: "yes" }).success).toBe(true);
    expect(ballot.safeParse({ ...base, ballot: "no" }).success).toBe(true);
    expect(ballot.safeParse({ ...base, ballot: "abstain" }).success).toBe(false);
    expect(ballot.safeParse(base).success).toBe(false);
  });

  it("makes the accusation and lynch records public evidence, and discussion.ended inert", () => {
    const records = [
      event(
        "accusation.raised",
        { accuserId: "p2", accuserName: "Briar", targetId: "p8", targetName: "Hollis" },
        "public",
        6,
      ),
      event(
        "accusation.seconded",
        {
          accusationId: "a",
          targetId: "p8",
          targetName: "Hollis",
          seconderId: "p3",
          seconderName: "Cato",
        },
        "public",
        7,
      ),
      event("accusation.unseconded", { accusationId: "a", targetId: "p8" }, "public", 8),
      event(
        "lynch.ballots_revealed",
        { accusationId: "a", targetId: "p8", ballots: { p1: "yes" } },
        "public",
        9,
      ),
      event(
        "lynch.resolved",
        {
          accusationId: "a",
          targetId: "p8",
          targetName: "Hollis",
          yes: 1,
          no: 0,
          living: 8,
          passed: false,
        },
        "public",
        10,
      ),
    ];
    const first = speech("Hollis has dodged every question.", {
      endAction: { kind: "accuse", targetId: "p8" },
    });
    expect(publicPayload(first)).toMatchObject({ endAction: { kind: "accuse", targetId: "p8" } });
    for (const record of records) {
      expect(publicRevision([first, record]), record.type).toBe(String(record.sequence));
      expect(JOURNAL_EVIDENCE_TYPES.has(record.type), record.type).toBe(true);
      expect(publicPayload(record), record.type).toEqual(record.payload);
    }
    // Moderator records: never public evidence, never a revision of the public record.
    for (const [type, payload] of [
      ["discussion.ended", { reason: "no_lynch" }],
      ["accusation.poll_answered", { accusationId: "a", playerId: "p3", second: true }],
      ["accusation.urgency_answered", { accusationId: "a", playerId: "p3", urgency: 0.75 }],
    ] as const) {
      const record = event(type, payload, "moderator", 11);
      expect(publicRevision([first, record]), type).toBe(publicRevision([first]));
      expect(JOURNAL_EVIDENCE_TYPES.has(type), type).toBe(false);
      expect(publicPayload(record), type).toEqual({});
    }
  });

  it("shows accusations and ballots to observers and hides discussion.ended from all but the moderator", async () => {
    const { jev } = scriptedJev({
      ...freshSpeakersFirst,
      second: () => "yes",
      ballot: (seat) => (["p1", "p2", "p3", "p4", "p5"].includes(seat) ? "yes" : "no"),
    });
    const { repository, id, events } = await playDay(
      everyTurnConfig("observer"),
      jev,
      players((seat, n) =>
        n === 0 ? { kind: "accuse", targetId: seat === "p8" ? "p7" : "p8" } : { kind: "continue" },
      ),
      policies(),
    );
    expect(ofType(events, "discussion.ended")).toHaveLength(1);
    const publicView = observerEvents(repository, id, { kind: "public" });
    expect(publicView.some((e) => e.type === "discussion.ended")).toBe(false);
    expect(publicView.find((e) => e.type === "speech.public")?.payload.endAction).toMatchObject({
      kind: "accuse",
    });
    for (const type of [
      "accusation.raised",
      "accusation.seconded",
      "lynch.ballots_revealed",
      "lynch.resolved",
    ])
      expect(
        publicView.some((e) => e.type === type),
        type,
      ).toBe(true);
    expect(publicView.some((e) => e.type === "lynch.ballot_cast")).toBe(false);
    const moderator = observerEvents(repository, id, { kind: "moderator" });
    expect(moderator.some((e) => e.type === "discussion.ended")).toBe(true);
  }, 180_000);
});

describe("auction_every_turn: required setup is checked before any work (round 2)", () => {
  /** The runner's construction: a provider, no Jev provider, no policies. Counts every call. */
  const counted = () => {
    const fake = new FakeDecisionProvider();
    const calls: string[] = [];
    const provider: DecisionProvider = {
      decide: (request) => {
        calls.push(request.kind);
        return fake.decide(request);
      },
    };
    return { provider, calls };
  };
  const setup = async (firstCycle: "day_first" | "night_first") => {
    const built = await buildApi({ databaseUrl: ":memory:" });
    apis.push(built);
    const base = everyTurnConfig(`setup-${firstCycle}`);
    const config = GameConfigV2Schema.parse({ ...base, rules: { ...base.rules, firstCycle } });
    const game = built.repository.createGame(config);
    const { provider, calls } = counted();
    const runner = new V2GameOrchestrator(built.repository, provider);
    return { built, id: game.id, runner, calls };
  };
  const expectRefusedWithoutWork = (
    built: Awaited<ReturnType<typeof buildApi>>,
    id: string,
    calls: string[],
    after: string[],
  ) => {
    const store = new DecisionStore(built.repository);
    expect(calls).toEqual([]);
    expect(store.opportunities(id)).toEqual([]);
    expect(store.attempts(id)).toEqual([]);
    const events = built.repository.listEvents(id);
    expect(events[0]!.type).toBe("game.created");
    expect(events.slice(1).map((e) => e.type)).toEqual(after);
    expect(String(events.at(-1)!.payload.reason)).toMatch(/open rule N/);
    expect(built.repository.getGame(id)!.status).toBe("paused");
  };

  for (const firstCycle of ["day_first", "night_first"] as const)
    it(`refuses a ${firstCycle} game without the no-lynch policy before any work, and on resume`, async () => {
      const { built, id, runner, calls } = await setup(firstCycle);
      await runner.runGameStep(id);
      expectRefusedWithoutWork(built, id, calls, ["game.paused"]);
      // Resume through the operator control path: it refuses again, still without any work.
      const resumed = await built.app.inject({
        method: "POST",
        url: `/api/v1/games/${id}/control`,
        payload: { action: "resume" },
      });
      expect(resumed.statusCode).toBe(200);
      await runner.runGameStep(id);
      expectRefusedWithoutWork(built, id, calls, ["game.paused", "game.resumed", "game.paused"]);
    });

  it("starts with the policy, and leaves staged games without one unaffected", async () => {
    const { built, id } = await setup("day_first");
    const { jev } = scriptedJev({ urge: () => 2 });
    /** Decision stepping: each run stops after one committed decision. */
    const stepOnce = async (runner: V2GameOrchestrator, gameId: string) => {
      new DecisionStore(built.repository).put(gameId, "stepUnit", "decision");
      built.repository.updateGame(gameId, { status: "stepping" });
      for (let step = 0; step < 5; step += 1) await runner.runGameStep(gameId);
    };
    const { provider, calls } = counted();
    await stepOnce(new V2GameOrchestrator(built.repository, provider, jev, policies()), id);
    expect(calls.length).toBeGreaterThan(0);
    expect(built.repository.listEvents(id).some((e) => e.type === "game.started")).toBe(true);
    const refusals = built.repository
      .listEvents(id)
      .filter((e) => e.type === "game.paused" && /open rule N/.test(String(e.payload.reason)));
    expect(refusals).toEqual([]);
    const staged = built.repository.createGame(
      GameConfigV2Schema.parse({ ...actorConfig(), rules: { firstCycle: "day_first" } }),
    );
    const plain = counted();
    await stepOnce(new V2GameOrchestrator(built.repository, plain.provider, jev), staged.id);
    expect(plain.calls.length).toBeGreaterThan(0);
    expect(built.repository.getGame(staged.id)!.status).not.toBe("paused");
  }, 120_000);
});

describe("auction_every_turn: resource ceilings during the procedures (round 2)", () => {
  type Point = "urge" | "second" | "urgency" | "ballot";
  interface Call {
    point: string;
    seat: string;
    attempts: number;
  }
  /** The first speaker accuses Hollis (p8), or Gale (p7) if the speaker is Hollis. */
  const accuseFirst = () =>
    players((seat, n) =>
      n === 0 ? { kind: "accuse", targetId: seat === "p8" ? "p7" : "p8" } : { kind: "continue" },
    );
  /** Everyone seconds, urgency ranked by seat, and five seats vote yes. */
  const script: Script = {
    ...freshSpeakersFirst,
    second: () => "yes",
    secondUrgency: (seat) => Number(seat.slice(1)) % 5,
    ballot: (seat) => (["p1", "p2", "p3", "p4", "p5"].includes(seat) ? "yes" : "no"),
  };
  /**
   * When each procedure has resolved. The bids are those of the second auction round: the
   * model-call ceiling cannot be set below 20, which the first round's bids come before.
   */
  const done: Record<Point, (events: GameEventV1[]) => boolean> = {
    urge: (events) => auctions(events).length > 1,
    second: (events) => ofType(events, "accusation.seconded").length > 0,
    urgency: (events) => ofType(events, "accusation.seconded").length > 0,
    ballot: (events) => ofType(events, "lynch.resolved").length > 0,
  };
  /** The procedure's result, without random IDs. */
  const outcome = (point: Point, events: GameEventV1[]) => {
    const strip = ({ accusationId: _a, auctionKey: _k, ...rest }: Record<string, unknown>) => rest;
    if (point === "urge") return strip(auctions(events)[1]!.payload);
    if (point !== "ballot") return strip(ofType(events, "accusation.seconded")[0]!.payload);
    return [
      strip(ofType(events, "lynch.ballots_revealed")[0]!.payload),
      strip(ofType(events, "lynch.resolved")[0]!.payload),
    ];
  };
  const taskOf: Record<Point, string> = {
    urge: "discussion_score",
    second: "second_poll",
    urgency: "second_urgency",
    ballot: "lynch_ballot",
  };

  /** One accusation game in an API database, so the operator's extend_budget runs as in use. */
  async function ceilingGame(
    point: Point,
    limits: { maxTotalTokens?: number; maxModelCalls?: number },
    onCall?: (call: Call, nth: number) => number | void,
  ) {
    const built = await buildApi({ databaseUrl: ":memory:" });
    apis.push(built);
    const base = everyTurnConfig("ceilings", 0.5);
    // The default active-runtime limit, so an operator extension can raise it.
    const config = GameConfigV2Schema.parse({
      ...base,
      maxTotalTokens: limits.maxTotalTokens ?? base.maxTotalTokens,
      safety: {
        ...base.safety,
        maxModelCalls: limits.maxModelCalls ?? 10_000,
        maxWallClockMs: 1_800_000,
      },
    });
    const game = built.repository.createGame(config);
    const store = new DecisionStore(built.repository);
    const calls: Call[] = [];
    const { jev } = scriptedJev({
      ...script,
      onCall: (point, seat) => {
        calls.push({ point, seat, attempts: store.attempts(game.id).length });
        return onCall?.(calls.at(-1)!, calls.filter((call) => call.point === point).length);
      },
    });
    new V2GameOrchestrator(built.repository, new FakeDecisionProvider()).initialize(game.id);
    // The bids are measured in a day without accusations, which a first-speech lynch would end.
    const speakers = point === "urge" ? players() : accuseFirst();
    const runner = new V2GameOrchestrator(built.repository, speakers, jev, policies());
    built.repository.updateGame(game.id, { status: "running" });
    const events = () => built.repository.listEvents(game.id);
    const status = () => built.repository.getGame(game.id)!.status;
    return {
      config,
      store,
      id: game.id,
      calls,
      events,
      status,
      run: async (until: (events: GameEventV1[]) => boolean) => {
        for (let step = 0; step < 400 && status() === "running" && !until(events()); step += 1)
          await runner.runGameStep(game.id);
      },
      extend: (payload: Record<string, unknown>) =>
        built.app.inject({
          method: "POST",
          url: `/api/v1/games/${game.id}/control`,
          payload: { action: "extend_budget", ...payload },
        }),
    };
  }
  /**
   * The procedure's answers by seat, as validated proposals. For the bids, only the second
   * auction round's: each seat bid in the first round too.
   */
  const answers = (store: DecisionStore, id: string, point: Point, events: GameEventV1[]) => {
    const after = point === "urge" ? auctions(events)[0]!.sequence : -1;
    const opened = new Map(
      events
        .filter((e) => e.type === "decision.opened")
        .map((e) => [String(e.payload.decisionId), e.sequence]),
    );
    return Object.fromEntries(
      store
        .opportunities(id)
        .filter((op) => op.taskType === taskOf[point] && op.best && opened.get(op.id)! > after)
        .map((op) => [op.playerId, op.best!.proposal]),
    );
  };
  /** The seats asked in the procedure, in order: for the bids, those of the second round. */
  const procedureSeats = (calls: Call[], point: Point) =>
    seatsAsked(calls, point).slice(point === "urge" ? 8 : 0);
  /** The uninterrupted run each stop is compared with, played once per procedure. */
  const references = new Map<Point, ReturnType<typeof referenceRun>>();
  const referenceRun = async (point: Point) => {
    const game = await ceilingGame(point, {});
    await game.run(done[point]);
    expect(done[point](game.events()), `${point} resolves without a stop`).toBe(true);
    return {
      config: game.config,
      calls: [...game.calls],
      events: game.events(),
      answers: answers(game.store, game.id, point, game.events()),
    };
  };
  const reference = (point: Point) => {
    if (!references.has(point)) references.set(point, referenceRun(point));
    return references.get(point)!;
  };
  const seatsAsked = (calls: Call[], point: Point) =>
    calls.filter((call) => call.point === point).map((call) => call.seat);
  /** The nth call of each procedure that the stops land on: some answers are in, some are not. */
  const STOP: Record<Point, number> = { urge: 11, second: 3, urgency: 3, ballot: 4 };

  for (const point of ["urge", "second", "urgency", "ballot"] as const)
    for (const ceiling of ["tokens", "runtime"] as const)
      it(`resumes the ${point} procedure after the ${ceiling} ceiling, keeping every answer`, async () => {
        const ref = await reference(point);
        const realNow = Date.now.bind(Date);
        let offset = 0;
        vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
        const game = await ceilingGame(point, {}, (call, nth) => {
          if (call.point !== point || nth !== STOP[point]) return;
          if (ceiling === "runtime") offset += 2 * ref.config.safety.maxWallClockMs;
          return ceiling === "tokens" ? 10 * ref.config.maxTotalTokens! : undefined;
        });
        await game.run(done[point]);
        expect(game.status()).toBe("budget_exhausted");
        expect(done[point](game.events())).toBe(false);
        expect(seatsAsked(game.calls, point)).toEqual(
          seatsAsked(ref.calls, point).slice(0, STOP[point]),
        );
        const extended = await game.extend({
          maxTotalTokens: 100_000_000,
          maxWallClockMs: 86_400_000,
        });
        expect(extended.statusCode).toBe(200);
        await game.run(done[point]);
        expect(done[point](game.events())).toBe(true);
        // Each seat asked once, in the same order as the uninterrupted run: no answer asked again.
        expect(seatsAsked(game.calls, point)).toEqual(seatsAsked(ref.calls, point));
        expect(outcome(point, game.events())).toEqual(outcome(point, ref.events));
        const denominator =
          point === "ballot"
            ? living(everyTurnConfig("x"))
            : point === "second"
              ? living(everyTurnConfig("x")).filter(
                  (seat) =>
                    seat !==
                    String(ofType(game.events(), "accusation.raised")[0]!.payload.accuserId),
                )
              : undefined;
        if (denominator)
          expect(
            game.store
              .opportunities(game.id)
              .filter((op) => op.taskType === taskOf[point])
              .map((op) => op.playerId)
              .sort(),
          ).toEqual(denominator);
      }, 180_000);

  for (const point of ["urge", "second", "urgency", "ballot"] as const)
    it(`resolves nothing when the model-call ceiling stops the ${point} procedure`, async () => {
      const ref = await reference(point);
      const target = ref.calls.filter((call) => call.point === point)[STOP[point] - 1]!;
      const game = await ceilingGame(point, { maxModelCalls: target.attempts });
      await game.run(done[point]);
      expect(game.status()).toBe("budget_exhausted");
      const events = game.events();
      // Nothing the interrupted procedure decides is recorded.
      const unresolved =
        point === "ballot"
          ? ["lynch.ballots_revealed", "lynch.resolved"]
          : [
              "accusation.seconded",
              "accusation.unseconded",
              "lynch.ballots_revealed",
              "lynch.resolved",
            ];
      for (const type of unresolved) expect(ofType(events, type), type).toEqual([]);
      if (point === "urge")
        expect(auctions(events), "no speaker from a partial round").toHaveLength(1);
      // The answers validated before the stop stay as they were; nothing else was answered.
      const asked = procedureSeats(game.calls, point);
      expect(asked).toEqual(procedureSeats(ref.calls, point).slice(0, asked.length));
      expect(asked.length).toBeLessThan(procedureSeats(ref.calls, point).length);
      const kept = answers(game.store, game.id, point, events);
      expect(Object.keys(kept).sort()).toEqual([...asked].sort());
      for (const seat of asked) expect(kept[seat], seat).toEqual(ref.answers[seat]);
    }, 180_000);
});

describe("auction_every_turn: the lynch denominator and the docket contract (round 2)", () => {
  const outcomeOf = lynchOutcome as (
    ballots: Record<string, "yes" | "no">,
    livingPlayerIds: string[],
  ) => ReturnType<typeof lynchOutcome>;
  const roster = ["p1", "p2", "p3", "p4"];

  it("takes the denominator from the living roster and refuses a missing or extra ballot", () => {
    expect(outcomeOf({ p1: "yes", p2: "yes", p3: "yes", p4: "no" }, roster)).toEqual({
      yes: 3,
      no: 1,
      living: 4,
      passed: true,
    });
    expect(outcomeOf({ p1: "yes", p2: "yes", p3: "no", p4: "no" }, roster).passed).toBe(false);
    // Two yes of a partial map would be a majority of the map, never of the living.
    expect(() => outcomeOf({ p1: "yes", p2: "yes", p3: "no" }, roster)).toThrow(/ballot/);
    expect(() =>
      outcomeOf({ p1: "yes", p2: "yes", p3: "no", p4: "no", p9: "yes" }, roster),
    ).toThrow(/ballot/);
  });

  it("pins the docket contract: a decline clears what the seat was shown", async () => {
    // A seat that sees a challenge to it declines that turn; its docket entry is then gone from
    // its next briefing unless it is challenged again. The public speech and journals remain.
    const silenced = new Set<string>();
    const { jev } = scriptedJev({
      urge: (seat, input) => {
        if (input.includes("Unanswered challenge")) silenced.add(seat);
        return silenced.has(seat) ? 0 : 1 + (hash(input) % 4);
      },
    });
    const { repository, id, events } = await playDay(everyTurnConfig("docket-contract"), jev);
    const store = new DecisionStore(repository);
    const opened = new Map(
      events
        .filter((e) => e.type === "decision.opened")
        .map((e) => [String(e.payload.decisionId), e.sequence]),
    );
    let pinned = 0;
    for (const seat of silenced) {
      const challenges = speeches(events).filter((e) =>
        (e.payload.acts as { kind: string; targetId: string | null }[]).some(
          (act) => act.kind === "challenge" && act.targetId === seat,
        ),
      );
      const bids = store
        .opportunities(id)
        .filter((op) => op.playerId === seat && op.taskType === "discussion_score")
        .sort((a, b) => opened.get(a.id)! - opened.get(b.id)!);
      const first = challenges[0]!;
      const shown = bids.findIndex((op) => op.packet.responseDocket.includes(first.id));
      expect(shown, `${seat} is shown the challenge`).toBeGreaterThanOrEqual(0);
      const next = bids[shown + 1];
      if (!next) continue;
      expect(next.packet.responseDocket, `${seat}'s next briefing`).not.toContain(first.id);
      pinned += 1;
    }
    expect(pinned).toBeGreaterThan(0);
  }, 120_000);
});
