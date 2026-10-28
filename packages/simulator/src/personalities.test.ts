import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GameConfigV2Schema,
  MOTIVATION_KEYS,
  PERSONALITY_PRESETS,
  PersonalityProfileSchema,
  TRAIT_KEYS,
  emptyJournalV2,
  personalityDigest,
  seededPersonalityAssignment,
  seededPersonalityValues,
  sha256Hex,
  type PersonalityProfile,
  type PlayerContextV2,
} from "@werewolf/contracts";
import { DecisionStore, LabRepository, openDatabase } from "@werewolf/db";
import { createGameState, reduceGame } from "@werewolf/engine";
import { FakeDecisionProvider } from "@werewolf/llm";
import { dayStartBlock, sessionSystemBlocks, sharedSystemBlocks } from "./claude-session-request";
import { ClaudeSessions, sessionInstructionIdentity } from "./claude-session";
import { V2GameOrchestrator } from "./orchestrator-v2";
import { buildContextV2 } from "./context-v2";
import { actorBriefing } from "./jev-actor";
import { decisionRequestV2 } from "./request-v2";
import { decisionRequestV32, v31ApiResponseFormat } from "./request-v3-1";
import { actorConfig, actorPacket } from "./testing/actor-fixtures";

/**
 * CES-1585, personalities v1: each seat's personality is a frozen Profile in the config (traits,
 * motivations, the text the model reads, hashes). A Claude session sends it once, as its own
 * system block between the shared block 1 and block 2 (Cesar's layer order); other request
 * paths carry it in the private view; Jev gets a fixed numeric digest with the motivations.
 */
const words = (text: string) => text.trim().split(/\s+/).length;
const issuePaths = (input: unknown) => {
  const result = GameConfigV2Schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
};
const profileIssues = (input: unknown) => {
  const result = PersonalityProfileSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
};
const presets = Object.values(PERSONALITY_PRESETS) as PersonalityProfile[];

describe("personality presets (CES-1585)", () => {
  it("ships the five v1 presets plus rational and rambler, each a valid frozen profile", () => {
    expect(Object.keys(PERSONALITY_PRESETS).sort()).toEqual(
      [
        "careful-reasoner",
        "disruptor",
        "liar",
        "maverick",
        "rambler",
        "rational",
        "sacrificial-lamb",
      ].sort(),
    );
    for (const profile of presets) {
      expect(profileIssues(profile), profile.id).toEqual([]);
      expect(Object.keys(profile.traits).sort(), profile.id).toEqual([...TRAIT_KEYS].sort());
      expect(Object.keys(profile.motivations).sort(), profile.id).toEqual(
        [...MOTIVATION_KEYS].sort(),
      );
      expect(profile.textSha256, profile.id).toBe(sha256Hex(profile.text));
      expect(words(profile.text), profile.id).toBeGreaterThanOrEqual(40);
      expect(words(profile.text), profile.id).toBeLessThanOrEqual(200);
    }
  });

  it("keeps the Disruptor unsoftened and the removed caution line as one preset", () => {
    expect(PERSONALITY_PRESETS.disruptor.text).toContain("including your own team");
    expect(PERSONALITY_PRESETS.disruptor.text).toContain("Winning doesn't matter to you");
    expect(PERSONALITY_PRESETS["careful-reasoner"].text).toContain(
      "avoid treating absence of evidence as evidence of guilt",
    );
  });

  it("fails closed, naming the field, on a bad hash, value, motivation sum or length", () => {
    const base = PERSONALITY_PRESETS.liar;
    expect(profileIssues({ ...base, textSha256: "0".repeat(64) })).toContain("textSha256");
    expect(profileIssues({ ...base, traits: { ...base.traits, risk: 1.5 } })).toContain(
      "traits.risk",
    );
    expect(profileIssues({ ...base, motivations: { ...base.motivations, chaos: 0.9 } })).toContain(
      "motivations",
    );
    const short = "Too short to be a personality file.";
    expect(profileIssues({ ...base, text: short, textSha256: sha256Hex(short) })).toContain("text");
  });
});

describe("seeded values and assignment (CES-1585)", () => {
  it("derives the same values from the same seed, in range, motivations summing to 1", () => {
    const a = seededPersonalityValues("sample-1");
    expect(seededPersonalityValues("sample-1")).toEqual(a);
    expect(seededPersonalityValues("sample-2")).not.toEqual(a);
    for (const key of TRAIT_KEYS) {
      expect(a.traits[key]).toBeGreaterThanOrEqual(0);
      expect(a.traits[key]).toBeLessThanOrEqual(1);
    }
    const sum = MOTIVATION_KEYS.reduce((n, key) => n + a.motivations[key], 0);
    expect(Math.abs(sum - 1)).toBeLessThanOrEqual(0.011);
  });

  it("draws motivations uniformly over the simplex: a dominant one is common, not rare", () => {
    // Normalized uniforms make a motivation above 0.5 rare (about 17%); normalized -ln(u)
    // gives about 50%.
    let dominant = 0;
    for (let n = 0; n < 2_000; n += 1) {
      const { motivations } = seededPersonalityValues(`simplex-${n}`);
      if (MOTIVATION_KEYS.some((key) => motivations[key] > 0.5)) dominant += 1;
    }
    expect(dominant / 2_000).toBeGreaterThan(0.4);
  });

  it("assigns the same profiles to seats from the same seed, duplicates allowed", () => {
    const seats = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
    const pool = [PERSONALITY_PRESETS.liar, PERSONALITY_PRESETS.disruptor];
    const first = seededPersonalityAssignment("assign-seed", pool, seats);
    expect(seededPersonalityAssignment("assign-seed", pool, seats)).toEqual(first);
    expect(first).toHaveLength(8);
    expect(new Set(first.map((p) => p.id)).size).toBeLessThan(8);
  });

  it("refuses a seeded config whose seats differ from the draw, and accepts the draw", () => {
    const base = actorConfig();
    const pool = [
      PERSONALITY_PRESETS.liar,
      PERSONALITY_PRESETS.maverick,
      PERSONALITY_PRESETS.disruptor,
    ];
    const drawn = seededPersonalityAssignment(
      "config-seed",
      pool,
      base.seats.map((s) => s.id),
    );
    const config = {
      ...base,
      seats: base.seats.map((seat, i) => ({ ...seat, personality: drawn[i] })),
      personalities: { assignment: { kind: "seeded", seed: "config-seed", pool } },
    };
    expect(issuePaths(config)).toEqual([]);
    const swapped = {
      ...config,
      seats: config.seats.map((seat, i) =>
        i === 0 ? { ...seat, personality: PERSONALITY_PRESETS.rational } : seat,
      ),
    };
    expect(issuePaths(swapped).join(" ")).toMatch(/seats\.0\.personality/);
    expect(
      issuePaths({ ...base, seats: base.seats.map((s) => ({ ...s, personality: "free text" })) })
        .length,
    ).toBeGreaterThan(0);
  });

  it("keeps the frozen profile and its identity through a stored round trip", () => {
    const base = actorConfig();
    const config = GameConfigV2Schema.parse({
      ...base,
      seats: base.seats.map((seat) => ({ ...seat, personality: PERSONALITY_PRESETS.maverick })),
      personalities: { assignment: { kind: "explicit" } },
    });
    const stored = GameConfigV2Schema.parse(JSON.parse(JSON.stringify(config)));
    expect(stored).toEqual(config);
    expect(stored.seats[0]!.personality).toEqual(PERSONALITY_PRESETS.maverick);
  });
});

describe("delivery: private layer, never the shared blocks (CES-1585)", () => {
  const config = (() => {
    const base = actorConfig();
    const people = [
      PERSONALITY_PRESETS.disruptor,
      PERSONALITY_PRESETS["careful-reasoner"],
      PERSONALITY_PRESETS.liar,
    ];
    return GameConfigV2Schema.parse({
      ...base,
      seats: base.seats.map((seat, i) => ({ ...seat, personality: people[i % people.length] })),
      personalities: { assignment: { kind: "explicit" } },
    });
  })();
  const packetFor = (playerId: string) => {
    const state = createGameState("g", config);
    state.phase = "day_discussion";
    state.day = 2;
    return buildContextV2(state, [], playerId, emptyJournalV2(), "k", "discussion");
  };
  const task = { type: "discussion_free_speech", ready: false, revision: "1" } as const;
  const blocks = (packet: PlayerContextV2) =>
    sharedSystemBlocks(
      packet,
      decisionRequestV32(packet, task, false, null, null).prompt.instructions,
      v31ApiResponseFormat(packet, task)!.instructions,
    );

  it("keeps block 1 and block 2 byte-identical across seats with different personalities", () => {
    const [a, b] = [blocks(packetFor("p1")), blocks(packetFor("p2"))];
    expect(a[0]).toBe(b[0]);
    expect(a[1]).toBe(b[1]);
    for (const text of [PERSONALITY_PRESETS.disruptor.text, PERSONALITY_PRESETS.liar.text]) {
      expect(a[0]).not.toContain(text);
      expect(a[1]).not.toContain(text);
    }
  });

  it("sends the personality once, as its own system block between block 1 and block 2", () => {
    const packet = packetFor("p1");
    const instructions = decisionRequestV32(packet, task, false, null, null).prompt.instructions;
    const format = v31ApiResponseFormat(packet, task)!.instructions;
    const system = sessionSystemBlocks(packet, instructions, format);
    const [one, two] = sharedSystemBlocks(packet, instructions, format);
    expect(system).toHaveLength(3);
    expect(system[0]).toBe(one);
    expect(system[1]).toContain(PERSONALITY_PRESETS.disruptor.text);
    expect(system[2]).toBe(two);
    const start = dayStartBlock(packet, 0);
    expect(start).not.toContain(PERSONALITY_PRESETS.disruptor.text.slice(0, 40));
    expect(JSON.stringify(packet.self)).not.toContain("personality");
    // A seat without a personality keeps the two shared blocks only.
    const plain = buildContextV2(
      createGameState("g", GameConfigV2Schema.parse(actorConfig())),
      [],
      "p1",
      emptyJournalV2(),
      "k",
      "discussion",
    );
    expect(sessionSystemBlocks(plain, instructions, format)).toHaveLength(2);
  });

  it("carries the text in the V2 private view and a fixed 12-value digest in the Jev state", () => {
    const packet = packetFor("p2");
    const v2 = JSON.stringify(decisionRequestV2(packet, "discussion", "gated").prompt);
    expect(v2).toContain(JSON.stringify(PERSONALITY_PRESETS["careful-reasoner"].text).slice(1, 60));
    const actor = actorPacket();
    actor.personality = PERSONALITY_PRESETS.disruptor;
    const brief = actorBriefing({
      packet: actor,
      playerId: actor.self.id,
      taskType: "discussion_score",
    });
    expect(brief.personality).toBe(personalityDigest(PERSONALITY_PRESETS.disruptor));
    const digest = personalityDigest(PERSONALITY_PRESETS.disruptor);
    expect(digest.startsWith("The Disruptor: ")).toBe(true);
    const order = digest
      .slice("The Disruptor: ".length)
      .split(", ")
      .map((part) => part.split(" ")[0]);
    expect(order).toEqual([...TRAIT_KEYS, ...MOTIVATION_KEYS]);
    expect(JSON.stringify(brief)).not.toContain(PERSONALITY_PRESETS.disruptor.text);
    // The motivations are the character's own: no universal "help your team win" overrides them.
    expect(digest).toContain("chaos 0.70");
    expect(JSON.stringify(brief)).toMatch(/even (where|when) (they|it) conflict/);
  });

  it("puts the personality hash in the session identity: seats differ, a resume does not", () => {
    const call = (packet: PlayerContextV2) => ({
      gameId: "g",
      playerId: packet.self.id,
      packet,
      model: "claude-sonnet-5-5",
      effort: "medium",
      kind: "discussion",
      instructions: decisionRequestV32(packet, task, false, null, null).prompt.instructions,
      formatInstructions: v31ApiResponseFormat(packet, task)!.instructions,
      requestInput: "{}",
    });
    const one = sessionInstructionIdentity(call(packetFor("p1")));
    expect(sessionInstructionIdentity(call(packetFor("p1")))).toBe(one);
    expect(sessionInstructionIdentity(call(packetFor("p2")))).not.toBe(one);
  });
});

/**
 * A real resume (CES-1585): a game with seeded profiles is written to a database file, closed, and
 * rebuilt from that file. The exact profiles, their hashes, the request identity and the open
 * Claude session all survive; nothing is redrawn and no session or turn is redone.
 */
describe("a frozen profile across a database resume", () => {
  it("keeps the profiles, the identity and the session exactly as stored", () => {
    const base = actorConfig();
    const pool = [PERSONALITY_PRESETS.disruptor, PERSONALITY_PRESETS.liar];
    const drawn = seededPersonalityAssignment(
      "resume-seed",
      pool,
      base.seats.map((seat) => seat.id),
    );
    const config = GameConfigV2Schema.parse({
      ...base,
      seats: base.seats.map((seat, i) => ({ ...seat, personality: drawn[i] })),
      personalities: { assignment: { kind: "seeded", seed: "resume-seed", pool } },
    });
    const path = join(mkdtempSync(join(tmpdir(), "personality-resume-")), "game.db");
    const task = { type: "discussion_free_speech", ready: false, revision: "1" } as const;
    const open = () => {
      const connection = openDatabase(path);
      const repository = new LabRepository(connection);
      return { connection, repository, store: new DecisionStore(repository) };
    };
    const callFor = (repository: LabRepository, gameId: string) => {
      const state = reduceGame(gameId, repository.listEvents(gameId));
      const packet = buildContextV2(state, [], "p1", emptyJournalV2(), "k", "discussion");
      return {
        gameId,
        playerId: "p1",
        packet,
        model: "claude-sonnet-5-5",
        effort: "medium",
        kind: "discussion",
        instructions: decisionRequestV32(packet, task, false, null, null).prompt.instructions,
        formatInstructions: v31ApiResponseFormat(packet, task)!.instructions,
        requestInput: "{}",
      };
    };
    const first = open();
    const game = first.repository.createGame(config);
    new V2GameOrchestrator(first.repository, new FakeDecisionProvider()).initialize(game.id);
    const before = callFor(first.repository, game.id);
    const turn = new ClaudeSessions(first.store).begin(before);
    turn.commit({
      content: [{ type: "text", text: "{}" }] as never,
      stopReason: "end_turn",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningTokens: 0,
      },
    });
    first.connection.close();

    const second = open();
    const stored = second.repository.getGame(game.id)!.config as typeof config;
    expect(stored).toEqual(config);
    stored.seats.forEach((seat, i) => {
      expect(seat.personality).toEqual(drawn[i]);
      expect(seat.personality!.textSha256).toBe(sha256Hex(seat.personality!.text));
    });
    const after = callFor(second.repository, game.id);
    expect(after.packet.personality).toEqual(before.packet.personality);
    expect(sessionInstructionIdentity(after)).toBe(sessionInstructionIdentity(before));
    const resumed = new ClaudeSessions(second.store).begin(after);
    expect(resumed.metadata).toMatchObject({ id: turn.metadata.id, turn: 1 });
    expect(resumed.harness.system).toEqual(turn.harness.system);
    second.connection.close();
  });
});
