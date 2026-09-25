import { describe, expect, it } from "vitest";
import { GameConfigSchema } from "@werewolf/contracts";
import { LabRepository, openDatabase } from "@werewolf/db";
import { STARTER_ROLES } from "@werewolf/engine";
import type { DecisionProvider } from "@werewolf/llm";
import { GameOrchestrator } from "./index";

describe("provider-wide failure handling", () => {
  it("pauses after failures from three distinct seats", async () => {
    const connection = openDatabase(":memory:");
    try {
      const repository = new LabRepository(connection);
      repository.seedRoles(STARTER_ROLES);
      const ids = ["werewolf", "seer", "doctor", "roleblocker", "villager"];
      const config = GameConfigSchema.parse({
        schemaVersion: "game_config_v1",
        name: "Outage test",
        seed: "outage",
        seats: ids.map((_, index) => ({ id: `p${index}`, name: `P${index}`, personality: "Test" })),
        roleDeck: ids.map((id) => structuredClone(STARTER_ROLES.find((role) => role.id === id)!)),
        speedMs: 0,
      });
      const provider: DecisionProvider = {
        async decide() {
          throw new Error("provider unavailable");
        },
      };
      const game = repository.createGame(config);
      const orchestrator = new GameOrchestrator(repository, provider, "offline-model");
      orchestrator.initializeGame(game);
      repository.updateGame(game.id, { status: "running" });

      await orchestrator.runGameStep(game.id);
      await orchestrator.runGameStep(game.id);
      await orchestrator.runGameStep(game.id);

      expect(repository.getGame(game.id)?.status).toBe("paused");
      expect(repository.listEvents(game.id).some((event) => event.type === "game.paused")).toBe(
        true,
      );
    } finally {
      connection.close();
    }
  });
});
