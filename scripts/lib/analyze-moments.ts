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
import {
  between,
  isKillPoint,
  readPackNights,
  type AuditEvents,
  type Committed,
  type FinalPoint,
  type PackNight,
} from "./pack-night";
import type { Decider } from "./analyze-citations";
import { validUsd } from "./analysis-spend";

/**
 * A moment's source: a committed ballot, or one night's kill, decided by the pack's points.
 * Other night roles' choices (inspect, protect) and non-kill pack points have no public
 * counterpart, so they are not moments (CES-1040 rulings on AC2 and on night scoring).
 */
export interface MomentSource {
  /** The ballot, or the pack's first final-round kill point (absent if none was recorded). */
  op?: DecisionOpportunityV1;
  /** For a kill, each living wolf's final-round point, in commit order. */
  pack?: DecisionOpportunityV1[];
  /** Sequence of the (first) commit event: the public view stops just before it. */
  decisionSequence: number;
  decisionEventId: string;
  /** Who decided, and when: each one's citations are checked against their own view then. */
  deciders: Decider[];
  moment: Omit<SurpriseMoment, "publicView">;
}

/** The last validated Jev attempt for a decision, as a distribution over player IDs. */
function privateView(
  store: DecisionStore,
  op: DecisionOpportunityV1,
): Record<string, number> | null {
  const attempt = store
    .attempts(op.gameId, op.id)
    .findLast((item) => item.provider === "jev" && item.status === "valid" && item.response);
  const answer = attempt ? JSON.parse(attempt.response!).answers?.targets : undefined;
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
  const selected = commit ? chosen(commit.payload.proposal) : null;
  return commit && selected ? { op, commit, selected, view: privateView(store, op) } : null;
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

function noSignalReason(night: PackNight, actual: string): string | undefined {
  if (night.inconsistency) return night.inconsistency;
  if (night.finals.some(({ point }) => !point?.view))
    return "incomplete pack distributions: a living wolf has no valid final-round record";
  if (night.selected === null) return "the pack was not unanimous, so no kill target was selected";
  if (actual !== night.selected)
    return `the dawn outcome (${actual}) is not the pack's target (${night.selected}): a save or a block`;
  return undefined;
}

/**
 * One night's kill, as the pack decided it in its final round. Scored on the public dawn: the
 * unanimous target if it died, else whoever died, else "no_death". The private probability is
 * the mean over every living wolf's final distribution, never over a subset. A save, a block,
 * a split pack, a missing record or a malformed membership leaves no signal; the night is never
 * dropped.
 */
function killMoment(night: PackNight, events: AuditEvents): MomentSource {
  const present = night.finals.filter(
    (final): final is FinalPoint & { point: Committed; pointedAt: number } =>
      final.point !== undefined && final.pointedAt !== undefined,
  );
  const deaths = events
    .filter(
      (event) =>
        event.type === "player.eliminated" &&
        event.visibility === "public" &&
        between(event, night.agreedAt, night.resolvedAt),
    )
    .map((event) => String(event.payload.playerId));
  const { selected } = night;
  const actual = selected && deaths.includes(selected) ? selected : (deaths[0] ?? "no_death");
  const reason = noSignalReason(night, actual);
  const views = present.flatMap(({ point }) => (point.view ? [point.view] : []));
  // Never a mean over a subset of the pack.
  const complete = !night.inconsistency && views.length > 0 && views.length === night.finals.length;
  return {
    op: present[0]?.point.op,
    pack: present.map(({ point }) => point.op),
    // A scored night's public prediction stops at the freeze, before any night outcome.
    decisionSequence: night.agreedAt,
    decisionEventId: night.id,
    deciders: present.map(({ wolfId, pointedAt }) => ({
      actorId: wolfId,
      decisionSequence: pointedAt,
    })),
    moment: {
      id: `kill:${night.id}`,
      kind: "night_action",
      actorId: night.finals[0]?.wolfId ?? "pack",
      actorIds: night.finals.map(({ wolfId }) => wolfId),
      actorAlignment: "werewolf",
      actual,
      ...(selected === null ? {} : { selected }),
      ...(reason ? { noSignalReason: reason } : {}),
      wolfProbabilities: Object.fromEntries(
        present.flatMap(({ wolfId, point }) =>
          point.view ? [[wolfId, point.view[actual] ?? 0]] : [],
        ),
      ),
      privateView: complete ? meanView(views) : {},
      verified: [],
    },
  };
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
    if (op.taskType !== "vote_choice" || !actor || !view) return [];
    return [
      {
        op,
        decisionSequence: commit.sequence,
        decisionEventId: commit.id,
        deciders: [{ actorId: op.playerId, decisionSequence: commit.sequence }],
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
  const killOps = store.opportunities(game.id).filter(isKillPoint);
  const nights = readPackNights(
    decisions.filter((entry) => isKillPoint(entry.op)),
    killOps,
    events,
  );
  return [...ballots, ...nights.map((night) => killMoment(night, events))];
}

/** One Jev call's reported usage; cost is null unless the provider reports it. */
export interface JevCallUsage {
  momentId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

/**
 * Jev predicts each decision from the public record alone: one call per moment that can carry
 * a signal, none for a moment that already has none.
 */
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
    // A moment already without signal (a broken pack invariant, a save) costs no Jev call.
    if (source.moment.noSignalReason) {
      classified.push(classifyMoment({ ...source.moment, publicView: {} }));
      continue;
    }
    const built =
      source.moment.kind === "ballot"
        ? publicBallotRequest(repository, game, {
            actorId: source.moment.actorId,
            decisionSequence: source.decisionSequence,
            legalTargets: source.op?.packet.legalTargets ?? [],
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
  let costUnknown = false;
  const result = await jev.decide({
    kind: "jev",
    model: request.model,
    schemaName: "jev_public_view",
    schema,
    maxOutputTokens: null,
    preparedPrompt: { instructions: "", input: JSON.stringify(request) },
    onUsage: (usage) => (reported = usage),
    onProviderMetadata: (metadata) => {
      // Unknown is sticky: a later valid report cannot clear an earlier invalid one.
      if (validUsd(metadata.costUsd) && !costUnknown) costUsd = metadata.costUsd;
      else if (metadata.costUsd !== undefined) {
        costUnknown = true;
        costUsd = null;
      }
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
