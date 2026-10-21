import type { JournalPolicy } from "./study-journal";
import { z } from "zod";
import { shuffled } from "@werewolf/engine";
import { jevPrompt, playerPrompt, type StudyPlayer } from "./auction-study-agents";
import { SOLVER_GOAL, OBSTRUCTION_GOAL } from "./chain-study-design";
import fixtures from "../fixtures/auction-bid-cases.json";

const Context = z.strictObject({
  label: z.string().min(1),
  records: z.array(z.string().min(1)).min(1),
  priorJournal: z.string().min(1),
  authoredJournal: z.string().min(1),
  speeches: z
    .array(
      z.strictObject({
        turn: z.number().int().positive(),
        playerId: z.enum(["p1", "p2", "p3", "p4"]),
        text: z.string().min(1),
      }),
    )
    .length(4),
  objective: z.enum(["solver", "obstructor"]),
});
const Pair = z.strictObject({
  id: z.string().regex(/^[a-z_]+$/),
  question: z.enum(["urge", "listen_p2"]),
  expected: z.enum(["a_gt_b", "a_lt_b", "exploratory"]),
  hypothesis: z.string().min(1),
  limitation: z.string().min(1),
  a: Context,
  b: Context,
});
export const PAIRS = z.array(Pair).length(8).parse(fixtures);
export type BidPair = z.infer<typeof Pair>;
export type BidContext = z.infer<typeof Context>;
export type BidMode = "authored" | "luna" | "memory-v2";
export const BID_PROTOCOL = "auction-bid-pairs-v1";
export const JOURNAL_PROTOCOL = "auction-journal-comparison-v1";
export const JOURNAL_MAX_CALLS = PAIRS.length * 2 * 4;
export const MAX_CALLS = PAIRS.length * 2 * 3;
export const ORDER_SEED = "auction-bid-pairs-v1-order";
export const NEAR_TIE = 0.02;
export const TASK = {
  task: "Recover a fictional archive by composing authenticated records: A selects a code; B maps code to node; C maps node to seal; D maps seal to cartridge. Labels carry no other meaning. Only records listed in YOUR VERIFIED RECORDS have reached you; future deliveries are not observations. Public claims may be mistaken. You have received no private backup unless it is listed in YOUR VERIFIED RECORDS; a peer's reported copy remains a public claim. Participants can share their evidence freely. There are 12 public turns.",
  choices: { R1: "R1", R2: "R2", R3: "R3", R4: "R4", R5: "R5", R6: "R6", R7: "R7", R8: "R8" },
  // Match the clue-chain protocol's actor-objective branch without adding belief probes.
  routeProbes: {},
};
export function playersFor(context: BidContext, journal: string): StudyPlayer[] {
  return ["Ada", "Ben", "Cleo", "Dax"].map((name, i) => ({
    id: `p${i + 1}`,
    name,
    personality:
      "Speak clearly and concisely in service of your private objective. Choose your own words and tactic.",
    evidence: i === 0 ? [...context.records] : [],
    journal: i === 0 ? journal : "",
    objective: i === 0 && context.objective === "obstructor" ? OBSTRUCTION_GOAL : SOLVER_GOAL,
  }));
}
export function bidRequest(context: BidContext, journal: string) {
  const players = playersFor(context, journal);
  return jevPrompt(players[0]!, players, TASK, context.speeches, false, { turns: 12 }, 4);
}
export function journalRequest(context: BidContext, policy: JournalPolicy = "legacy") {
  const players = playersFor(context, context.priorJournal);
  return playerPrompt(players[0]!, players, TASK, context.speeches, "journal", 12, policy);
}
export function orderedContexts() {
  return shuffled(
    PAIRS.flatMap((pair) =>
      (["a", "b"] as const).map((variant) => ({
        id: `${pair.id}-${variant}`,
        pairId: pair.id,
        variant,
        context: pair[variant],
      })),
    ),
    ORDER_SEED,
  );
}
