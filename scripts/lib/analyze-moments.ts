import type { DecisionOpportunityV1, UsageV2 } from "@werewolf/contracts";
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
 * A moment's source: a committed ballot, or one night's kill, decided by the pack's points.
 * Other night roles' choices (inspect, protect) and non-kill pack points have no public
 * counterpart, so they are not moments (CES-1040 rulings on AC2 and on night scoring).
 */
export interface MomentSource {
  /** The ballot, or the pack's first kill point. */
  op: DecisionOpportunityV1;
  /** For a kill, every living wolf's point, in commit order. */
  pack?: DecisionOpportunityV1[];
  /** Sequence of the (first) commit event: the public view stops just before it. */
  decisionSequence: number;
  decisionEventId: string;
  moment: Omit<SurpriseMoment, "publicView">;
}

type AuditEvents = ReturnType<LabRepository["listEvents"]>;
interface Committed {
  op: DecisionOpportunityV1;
  commit: AuditEvents[number];
  selected: string;
  view: Record<string, number>;
}
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

function committed(
  store: DecisionStore,
  events: AuditEvents,
  op: DecisionOpportunityV1,
): Committed | null {
  const commit = events.find(
    (event) => event.type === "decision.committed" && event.payload.decisionId === op.id,
  );
  const view = commit ? privateView(store, op) : null;
  const selected = commit ? chosen(commit.payload.proposal) : null;
  return commit && view && selected ? { op, commit, selected, view } : null;
}

/** A kill point: the pack's eliminate action, offered to each wolf as a team point. */
function isKillPoint(op: DecisionOpportunityV1): boolean {
  if (op.taskType !== "team_point_choice") return false;
  const { self, legalActions } = op.packet;
  return (
    self.role.actions.find((action) => action.id === legalActions[0]?.actionId)?.effect ===
    "eliminate"
  );
}

/** The mean of the wolves' recorded distributions, over every option any of them gave. */
function meanView(views: Record<string, number>[]): Record<string, number> {
  const options = new Set(views.flatMap((view) => Object.keys(view)));
  return Object.fromEntries(
    [...options].map((option) => [
      option,
      views.reduce((sum, view) => sum + (view[option] ?? 0), 0) / views.length,
    ]),
  );
}

/**
 * One night's kill, as the pack decided it. Scored on the public dawn: the unanimous target if
 * it died, else whoever died, else "no_death". A save, a block or a split pack leaves the two
 * views describing different events, so the night carries no signal.
 */
function killMoment(points: Committed[], events: AuditEvents, resolvedAt: number): MomentSource {
  const pack = points.toSorted((a, b) => a.commit.sequence - b.commit.sequence);
  const first = pack[0]!;
  const selected = new Set(pack.map((point) => point.selected)).size === 1 ? first.selected : null;
  const deaths = events
    .filter(
      (event) =>
        event.type === "player.eliminated" &&
        event.visibility === "public" &&
        event.sequence > first.commit.sequence &&
        event.sequence < resolvedAt,
    )
    .map((event) => String(event.payload.playerId));
  const actual = selected && deaths.includes(selected) ? selected : (deaths[0] ?? "no_death");
  const noSignalReason =
    selected === null
      ? "the pack was not unanimous, so no kill target was selected"
      : actual !== selected
        ? `the dawn outcome (${actual}) is not the pack's target (${selected}): a save or a block`
        : undefined;
  return {
    op: first.op,
    pack: pack.map((point) => point.op),
    decisionSequence: first.commit.sequence,
    decisionEventId: first.commit.id,
    moment: {
      id: first.op.id,
      kind: "night_action",
      actorId: first.op.playerId,
      actorIds: pack.map((point) => point.op.playerId),
      actorAlignment: "werewolf",
      actual,
      ...(selected === null ? {} : { selected }),
      ...(noSignalReason ? { noSignalReason } : {}),
      wolfProbabilities: Object.fromEntries(
        pack.map((point) => [point.op.playerId, point.view[actual] ?? 0]),
      ),
      privateView: meanView(pack.map((point) => point.view)),
      verified: [],
    },
  };
}

/** Kill points grouped by the night resolution that follows them: one moment per night. */
function killMoments(points: Committed[], events: AuditEvents): MomentSource[] {
  const nights = new Map<number, Committed[]>();
  for (const point of points) {
    const resolved = events.find(
      (event) => event.type === "night.resolved" && event.sequence > point.commit.sequence,
    );
    if (resolved) nights.set(resolved.sequence, [...(nights.get(resolved.sequence) ?? []), point]);
  }
  return [...nights].map(([resolvedAt, pack]) => killMoment(pack, events, resolvedAt));
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
  const decisions = store.opportunities(game.id).flatMap((op) => {
    const entry = committed(store, events, op);
    return entry ? [entry] : [];
  });
  const ballots = decisions.flatMap(({ op, commit, selected, view }): MomentSource[] => {
    const actor = state.players.find((player) => player.id === op.playerId);
    if (op.taskType !== "vote_choice" || !actor) return [];
    return [
      {
        op,
        decisionSequence: commit.sequence,
        decisionEventId: commit.id,
        moment: {
          id: op.id,
          kind: "ballot",
          actorId: op.playerId,
          actorAlignment: actor.role.alignment as "village" | "werewolf",
          actual: selected,
          privateView: view,
          verified: verifiedResults(op, alignmentOf),
        },
      },
    ];
  });
  return [
    ...ballots,
    ...killMoments(
      decisions.filter((entry) => isKillPoint(entry.op)),
      events,
    ),
  ];
}

/** One Jev call's reported usage; cost is null unless the provider reports it. */
export interface JevCallUsage {
  momentId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

/** Jev predicts each decision from the public record alone. One call per moment. */
export async function publicViews(
  repository: LabRepository,
  game: GameRecord,
  sources: MomentSource[],
  jev: DecisionProvider,
  model: string,
): Promise<{ moments: ClassifiedMoment[]; jevCalls: JevCallUsage[] }> {
  const classified: ClassifiedMoment[] = [];
  const jevCalls: JevCallUsage[] = [];
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
    const { response, usage } = await askJev(jev, built.request);
    jevCalls.push({ momentId: source.moment.id, ...usage });
    const answer = response.answers.prediction;
    if (answer?.type !== "choice") continue;
    const publicView = Object.fromEntries(
      Object.entries(answer.probabilities).map(([handle, p]) => [
        built.options[handle] ?? (handle === "no_death" ? "no_death" : "abstain"),
        p,
      ]),
    );
    classified.push(classifyMoment({ ...source.moment, publicView }));
  }
  return { moments: classified, jevCalls };
}

async function askJev(jev: DecisionProvider, request: JevRequest) {
  const schema = jevResponseSchema(request);
  let reported: UsageV2 | undefined;
  let costUsd: number | null = null;
  const result = await jev.decide({
    kind: "jev",
    model: request.model,
    schemaName: "jev_public_view",
    schema,
    maxOutputTokens: null,
    preparedPrompt: { instructions: "", input: JSON.stringify(request) },
    onUsage: (usage) => (reported = usage),
    onProviderMetadata: (metadata) => {
      if (typeof metadata.costUsd === "number") costUsd = metadata.costUsd;
    },
  });
  const usage = reported ?? result.usage;
  return {
    response: schema.parse(result.data),
    usage: {
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      totalTokens: usage.totalTokens ?? null,
      costUsd,
    },
  };
}

/** The top noteworthy moments, then routine ones sampled for the recall check. */
export function selectForReview(
  moments: ClassifiedMoment[],
  options: { cap: number; recall: number; seed: string },
) {
  const noteworthy = rankNoteworthy(moments, options.cap);
  const routine = shuffled(
    moments.filter((moment) => moment.class === "routine"),
    `${options.seed}:recall`,
  ).slice(0, options.recall);
  return { noteworthy, recall: routine };
}
