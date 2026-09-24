import {
  InitiativeDecisionSchema,
  PlayerViewSchema,
  TeamPointDecisionSchema,
} from "@werewolf/contracts";
import { STARTER_ROLES } from "@werewolf/engine";
import { describe, expect, it } from "vitest";
import { CodexLoginProvider } from "./codex";

const liveIt = process.env.RUN_LIVE_CODEX === "1" ? it : it.skip;

describe("live Codex structured output", () => {
  liveIt(
    "accepts the initiative schema through the saved Codex login",
    async () => {
      const villager = structuredClone(STARTER_ROLES.find((role) => role.id === "villager")!);
      const view = PlayerViewSchema.parse({
        gameId: "live-codex-schema-smoke",
        phase: "day_discussion",
        day: 1,
        self: {
          id: "p1",
          name: "Player 1",
          alive: true,
          role: villager,
        },
        knownAllies: [],
        players: Array.from({ length: 5 }, (_, index) => ({
          id: `p${index + 1}`,
          name: `Player ${index + 1}`,
          alive: true,
        })),
        publicEvents: [],
        teamEvents: [],
        privateEvents: [],
        journal: {
          beliefs: [],
          goals: [],
          strategy: "",
          unresolvedQuestions: [],
        },
        availableActions: [],
      });
      const provider = new CodexLoginProvider();
      const result = await provider.decide({
        kind: "initiative",
        playerId: "p1",
        model: process.env.CODEX_MODEL ?? "gpt-5.6-luna",
        personality: "Concise and evidence-driven.",
        view,
        schemaName: "initiative",
        schema: InitiativeDecisionSchema,
        maxOutputTokens: 300,
      });

      expect(result.provider).toBe("codex");
      expect(result.data.kind).toBe("initiative");
      expect(result.data).toHaveProperty("replyToEventId");
      expect(result.data).toHaveProperty("topic");
      expect(result.usage.totalTokens).toBeGreaterThan(0);
    },
    240_000,
  );

  liveIt(
    "returns only a target and private journal for wolf coordination",
    async () => {
      const werewolf = structuredClone(STARTER_ROLES.find((role) => role.id === "werewolf")!);
      const targetIds = ["p3", "p4", "p5"];
      const view = PlayerViewSchema.parse({
        gameId: "live-codex-point-smoke",
        phase: "night_team",
        day: 1,
        self: {
          id: "p1",
          name: "Player 1",
          alive: true,
          role: werewolf,
        },
        knownAllies: [{ id: "p2", name: "Player 2" }],
        players: Array.from({ length: 5 }, (_, index) => ({
          id: `p${index + 1}`,
          name: `Player ${index + 1}`,
          alive: true,
        })),
        publicEvents: [],
        teamEvents: [
          {
            schemaVersion: "game_event_v1",
            id: "prior-point",
            gameId: "live-codex-point-smoke",
            sequence: 1,
            type: "team.pointed",
            phase: "night_team",
            day: 1,
            visibility: "team",
            audienceIds: ["p1", "p2"],
            payload: {
              team: "werewolves",
              playerId: "p2",
              targetId: "p3",
              targetName: "Player 3",
            },
            createdAt: new Date().toISOString(),
          },
        ],
        privateEvents: [],
        journal: {
          beliefs: [],
          goals: [],
          strategy: "",
          unresolvedQuestions: [],
        },
        availableActions: [],
      });
      const result = await new CodexLoginProvider().decide({
        kind: "team_point",
        playerId: "p1",
        model: process.env.CODEX_MODEL ?? "gpt-5.6-luna",
        personality: "Concise and evidence-driven.",
        view,
        schemaName: "team_point",
        schema: TeamPointDecisionSchema,
        maxOutputTokens: 300,
      });

      expect(result.data.kind).toBe("team_point");
      expect(targetIds).toContain(result.data.targetId);
      expect(result.data).not.toHaveProperty("text");
    },
    240_000,
  );
});
