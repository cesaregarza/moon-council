import type { DecisionOpportunityV1 } from "@werewolf/contracts";
import type { DecisionStore, GameRecord, LabRepository } from "@werewolf/db";
import { reduceGame, shuffled } from "@werewolf/engine";
import { jevResponseSchema, type DecisionProvider, type JevRequest } from "@werewolf/llm";
import { publicBallotRequest, publicDawnRequest } from "./public-view-request";
import {
  classifyMoment,
  rankNoteworthy,
  type ClassifiedMoment,
  type SurpriseMoment,
} from "./surprise-scoring";

/**
 * Collects every committed ballot and night action that has a recorded Jev distribution.
 * Pack points are team-private and have no public view, so they are not moments (CES-1040
 * ruling on AC2).
 */
export interface MomentSource {
  op: DecisionOpportunityV1;
  /** Sequence of the decision's commit event: the public view stops just before it. */
  decisionSequence: number;
  decisionEventId: string;
  moment: Omit<SurpriseMoment, "publicView">;
}

const KINDS = { vote_choice: "ballot", night_choice: "night_action" } as const;

/** The last validated Jev attempt for a decision, as a distribution over player IDs. */
function privateView(
  store: DecisionStore,
  op: DecisionOpportunityV1,
): Record<string, number> | null {
  const attempt = store
    .attempts(op.gameId, op.id)
    .findLast((item) => item.provider === "jev" && item.status === "valid" && item.response);
  const answer = attempt ? JSON.parse(attempt.response!).answers?.target : undefined;
  if (!answer || answer.type !== "choice") return null;
  return Object.fromEntries(
    Object.entries(answer.probabilities as Record<string, number>).map(([handle, p]) => [
      handle === "abstain"
        ? "abstain"
        : (op.packet.legalTargets[handle.charCodeAt(0) - 97] ?? handle),
      p,
    ]),
  );
}

function chosen(proposal: unknown): string | null {
  const targets = (proposal as { targets?: { mode?: string; playerIds?: string[] } | null })
    .targets;
  if (!targets || targets.mode === "abstain" || !targets.playerIds?.length) return "abstain";
  return targets.playerIds[0] ?? null;
}

/** Verified results the actor held: inspections it received, as alignments. */
function verifiedResults(op: DecisionOpportunityV1, alignmentOf: (result: string) => string) {
  return op.packet.sources
    .filter((source) => source.type === "inspection.delivered")
    .filter((source) => source.data.actorId === op.playerId)
    .map((source) => ({
      targetId: String(source.data.targetId),
      alignment: alignmentOf(String(source.data.result)) as "village" | "werewolf",
    }));
}

export function collectMoments(
  repository: LabRepository,
  store: DecisionStore,
  game: GameRecord,
): MomentSource[] {
  const events = repository.listEvents(game.id);
  const state = reduceGame(game.id, events);
  const deck = game.config.schemaVersion === "game_config_v2" ? game.config.roleDeck : [];
  const alignmentOf = (result: string) =>
    ["village", "werewolf"].includes(result)
      ? result
      : (deck.find((role) => role.name === result)?.alignment ?? "village");
  return store.opportunities(game.id).flatMap((op) => {
    const kind = KINDS[op.taskType as keyof typeof KINDS];
    const commit = events.find(
      (event) => event.type === "decision.committed" && event.payload.decisionId === op.id,
    );
    const view = kind && commit ? privateView(store, op) : null;
    const actual = commit ? chosen(commit.payload.proposal) : null;
    const actor = state.players.find((player) => player.id === op.playerId);
    if (!kind || !commit || !view || !actual || !actor) return [];
    return [
      {
        op,
        decisionSequence: commit.sequence,
        decisionEventId: commit.id,
        moment: {
          id: op.id,
          kind,
          actorId: op.playerId,
          actorAlignment: actor.role.alignment as "village" | "werewolf",
          actual,
          privateView: view,
          verified: verifiedResults(op, alignmentOf),
        },
      },
    ];
  });
}

/** Jev predicts each decision from the public record alone. One call per moment. */
export async function publicViews(
  repository: LabRepository,
  game: GameRecord,
  sources: MomentSource[],
  jev: DecisionProvider,
  model: string,
): Promise<ClassifiedMoment[]> {
  const classified: ClassifiedMoment[] = [];
  for (const source of sources) {
    const built =
      source.moment.kind === "ballot"
        ? publicBallotRequest(repository, game, {
            actorId: source.moment.actorId,
            decisionSequence: source.decisionSequence,
            legalTargets: source.op.packet.legalTargets,
            model,
          })
        : publicDawnRequest(repository, game, {
            decisionSequence: source.decisionSequence,
            model,
          });
    const answer = (await askJev(jev, built.request)).answers.prediction;
    if (answer?.type !== "choice") continue;
    const publicView = Object.fromEntries(
      Object.entries(answer.probabilities).map(([handle, p]) => [
        built.options[handle] ?? (handle === "no_death" ? "no_death" : "abstain"),
        p,
      ]),
    );
    classified.push(classifyMoment({ ...source.moment, publicView }));
  }
  return classified;
}

async function askJev(jev: DecisionProvider, request: JevRequest) {
  const schema = jevResponseSchema(request);
  const result = await jev.decide({
    kind: "jev",
    model: request.model,
    schemaName: "jev_public_view",
    schema,
    maxOutputTokens: null,
    preparedPrompt: { instructions: "", input: JSON.stringify(request) },
  });
  return schema.parse(result.data);
}

/** The top noteworthy moments, then routine ones sampled for the recall check. */
export function selectForReview(
  moments: ClassifiedMoment[],
  options: { cap: number; recall: number; seed: string },
) {
  const noteworthy = rankNoteworthy(moments, Number.MAX_SAFE_INTEGER);
  const routine = shuffled(
    moments.filter((moment) => moment.class === "routine"),
    `${options.seed}:recall`,
  ).slice(0, options.recall);
  return { noteworthy, recall: routine };
}
