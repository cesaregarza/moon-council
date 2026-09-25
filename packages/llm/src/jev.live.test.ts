import { expect, it } from "vitest";
import { AskJevProvider, jevResponseSchema, type JevRequest } from "./jev";

it.skipIf(process.env.RUN_LIVE_JEV !== "1")(
  "evaluates synthetic Werewolf choices through the installed Ask Jev CLI",
  async () => {
    const request: JevRequest = {
      model: "jev-latest",
      state: {
        game: "Synthetic Werewolf fixture",
        ownRole: "seer",
        faction: "village",
        legalTargets: ["Ada", "Ben"],
        authorizedInspection: { player: "Ada", alignment: "werewolf" },
        journal: "An authorized inspection identified Ada. Ben's alignment is unknown.",
      },
      questions: {
        vote: {
          type: "choice",
          instructions:
            "Choose the legal elimination vote that best advances the village's objective, using only this player's information.",
          criteria: { ada: "Vote for Ada", ben: "Vote for Ben", abstain: "Abstain" },
        },
        urgency: {
          type: "score",
          instructions: "Rate the urgency of publicly discussing this inspection before voting.",
          criteria: ["No urgency", "Some urgency", "High urgency"],
        },
        needs_reasoning: {
          type: "noul",
          instructions:
            "Would one additional LLM comparison materially improve the vote choice given this evidence?",
        },
      },
    };
    const start = Date.now();
    const result = await new AskJevProvider().decide({
      kind: "jev",
      model: request.model,
      schemaName: "synthetic_jev",
      schema: jevResponseSchema(request),
      preparedPrompt: { instructions: "Typed fixture", input: JSON.stringify(request) },
      maxOutputTokens: 200,
    });
    expect(result.data.answers.vote?.type).toBe("choice");
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    console.info(
      JSON.stringify({
        provider: result.provider,
        model: result.model,
        latencyMs: Date.now() - start,
        totalTokens: result.usage.totalTokens,
      }),
    );
  },
  30_000,
);
