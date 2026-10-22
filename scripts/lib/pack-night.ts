import type { DecisionOpportunityV1 } from "@werewolf/contracts";
import type { LabRepository } from "@werewolf/db";
import { reduceGame } from "@werewolf/engine";

/**
 * Pack nights for the post-game analyzer (CES-1040). A wolf kill is one night's pack decision,
 * read from the orchestrator's own records: the last `team.point` round before the single
 * `team.agreement_frozen`, each wolf's decision behind its point, and the dawn that follows.
 * The seven v1 invariants are checked here and nowhere else; records that satisfy all seven
 * are trusted (Felix's ruling 0a07760e).
 */

export type AuditEvents = ReturnType<LabRepository["listEvents"]>;
/** A committed decision: its op, its commit event, its choice and its recorded view. */
export interface Committed {
  op: DecisionOpportunityV1;
  commit: AuditEvents[number];
  selected: string;
  /** Null when the decision has no valid recorded Jev distribution. */
  view: Record<string, number> | null;
}

/** A kill point: the pack's eliminate action, offered to each wolf as a team point. */
export function isKillPoint(op: DecisionOpportunityV1): boolean {
  if (op.taskType !== "team_point_choice") return false;
  const { self, legalActions } = op.packet;
  return (
    self.role.actions.find((action) => action.id === legalActions[0]?.actionId)?.effect ===
    "eliminate"
  );
}

/** One living wolf at the pack's final round: its `team.point` and the decision behind it. */
export interface FinalPoint {
  wolfId: string;
  /** Sequence of the wolf's final-round `team.point`, the first event of its commit. */
  pointedAt: number | undefined;
  point: Committed | undefined;
}

/** A night's pack decision, as the orchestrator froze it after the pack's last round. */
export interface PackNight {
  id: string;
  finals: FinalPoint[];
  /** The broken invariant, when the night's records are inconsistent; never repaired. */
  inconsistency: string | undefined;
  /** The unanimous target, or null when the pack never agreed. */
  selected: string | null;
  agreedAt: number;
  resolvedAt: number;
}

export const between = (event: AuditEvent, after: number, before: number) =>
  event.sequence > after && event.sequence < before;

/**
 * The commit behind a `team.point`: the decision store writes a commit's action events first,
 * so it is the wolf's next `decision.committed`, with no other point of its own in between.
 */
function commitAfter(mark: AuditEvent, events: AuditEvents) {
  const next = events.find(
    (event) =>
      event.sequence > mark.sequence &&
      event.payload.playerId === mark.payload.playerId &&
      (event.type === "decision.committed" || event.type === "team.point"),
  );
  return next?.type === "decision.committed" ? next : undefined;
}

/** Wolves alive when the pack froze, from the authoritative state at that point. */
function livingWolves(events: AuditEvents, agreedAt: number): string[] {
  const before = events.filter((event) => event.sequence < agreedAt);
  return reduceGame(events[0]?.gameId ?? "", before)
    .players.filter((player) => player.alive && player.role.alignment === "werewolf")
    .map((player) => player.id);
}

/** The first night invariant the records break, if any (CES-1040 ruling on damaged records). */
function packInconsistency(
  agreements: AuditEvent[],
  deciders: string[],
  finalMarks: AuditEvent[],
  links: { lateCommit: boolean; ownershipMismatch: boolean; unbound: boolean },
  living: string[],
): string | undefined {
  const marked = finalMarks.map((mark) => String(mark.payload.playerId));
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && a.toSorted().join() === b.toSorted().join();
  const broken = [
    agreements.length !== 1 && `${agreements.length} agreements for one night`,
    !deciders.length && "no deciders recorded for the pack",
    (new Set(deciders).size !== deciders.length || new Set(marked).size !== marked.length) &&
      "a duplicated decider in the pack's final round",
    !sameSet([...new Set(deciders)], living) && "the pack's members differ from the living wolves",
    links.lateCommit && "a final decision committed after the freeze",
    links.ownershipMismatch && "ownership mismatch: a decision belongs to another player",
    links.unbound &&
      "commit binding: a committed op without exactly one commit, or a final point bound to an older op",
  ].find((issue): issue is string => typeof issue === "string");
  return broken && `inconsistent pack records: ${broken}`;
}

/**
 * Commit binding (invariant 7): each committed kill-point op of a pack member that night has
 * exactly one `decision.committed`, and each wolf's final point is bound to that wolf's latest
 * committed kill-point op of the night, in the store's `createdAt` order.
 */
function commitsBound(
  agreement: AuditEvent,
  deciders: string[],
  finals: FinalPoint[],
  killOps: DecisionOpportunityV1[],
  events: AuditEvents,
): boolean {
  const nightOps = killOps
    .filter(
      (op) =>
        deciders.includes(op.playerId) &&
        op.status === "committed" &&
        op.day === agreement.day &&
        op.phase.startsWith("night"),
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const commits = (op: DecisionOpportunityV1) =>
    events.filter(
      (event) => event.type === "decision.committed" && event.payload.decisionId === op.id,
    ).length;
  if (nightOps.some((op) => commits(op) !== 1)) return false;
  return finals.every(({ wolfId, point }) => {
    const latest = nightOps.filter((op) => op.playerId === wolfId).at(-1);
    return !point || point.op.id === latest?.id;
  });
}

/**
 * Reads one resolved night. Only the final round counts: the last `team.point` round before the
 * (single) agreement; every point and decision used must fall inside the night, before the
 * freeze. Any broken invariant leaves the night no_signal; earlier rounds never stand in.
 */
function packNight(
  agreements: AuditEvent[],
  opened: number,
  resolvedAt: number,
  events: AuditEvents,
  byCommit: Map<string, Committed>,
  killOps: DecisionOpportunityV1[],
): PackNight {
  const agreement = agreements[0]!;
  const marks = events.filter(
    (event) => event.type === "team.point" && between(event, opened, agreement.sequence),
  );
  const finalRound = marks.at(-1)?.payload.round;
  const finalMarks = marks.filter((mark) => mark.payload.round === finalRound);
  const { payload } = agreement;
  const deciders = Array.isArray(payload.actorIds) ? payload.actorIds.map(String) : [];
  const links = { lateCommit: false, ownershipMismatch: false, unbound: false };
  const finals = deciders.map((wolfId) => {
    const mark = finalMarks.find((event) => event.payload.playerId === wolfId);
    const commit = mark && commitAfter(mark, events);
    if (commit && commit.sequence > agreement.sequence) links.lateCommit = true;
    const point =
      commit && commit.sequence < agreement.sequence ? byCommit.get(commit.id) : undefined;
    // The decision behind a wolf's point must be that wolf's own: its op and its brief.
    if (point && (point.op.playerId !== wolfId || point.op.packet.self.id !== wolfId))
      links.ownershipMismatch = true;
    return { wolfId, pointedAt: mark?.sequence, point };
  });
  links.unbound = !commitsBound(agreement, deciders, finals, killOps, events);
  const living = livingWolves(events, agreement.sequence);
  return {
    id: agreement.id,
    finals,
    inconsistency: packInconsistency(agreements, deciders, finalMarks, links, living),
    selected:
      payload.reason === "unanimous" && typeof payload.targetId === "string"
        ? payload.targetId
        : null,
    agreedAt: agreement.sequence,
    resolvedAt,
  };
}
export type AuditEvent = AuditEvents[number];

function missingFreeze(resolved: AuditEvent, opened: number): PackNight {
  return {
    id: resolved.id,
    finals: [],
    inconsistency: "inconsistent pack records: missing freeze",
    selected: null,
    agreedAt: opened,
    resolvedAt: resolved.sequence,
  };
}

/**
 * The single entry point: one pack night per resolved night that held pack activity, never
 * more. Each night is read with the seven v1 invariants (CES-1040 rulings); a broken invariant
 * is returned as the night's `inconsistency`, never repaired.
 */
export function readPackNights(
  points: Committed[],
  killOps: DecisionOpportunityV1[],
  events: AuditEvents,
): PackNight[] {
  const byCommit = new Map(points.map((point) => [point.commit.id, point]));
  const resolutions = events.filter((event) => event.type === "night.resolved");
  return resolutions.flatMap((resolved, index) => {
    const opened = resolutions[index - 1]?.sequence ?? -1;
    const agreements = events.filter(
      (event) =>
        event.type === "team.agreement_frozen" && between(event, opened, resolved.sequence),
    );
    if (agreements.length)
      return [packNight(agreements, opened, resolved.sequence, events, byCommit, killOps)];
    // Pack points or decisions with no freeze: the night is kept, never silently skipped.
    const activity = events.filter(
      (event) => event.type === "team.point" && between(event, opened, resolved.sequence),
    );
    const decided = points.some((point) => between(point.commit, opened, resolved.sequence));
    if (!activity.length && !decided) return [];
    return [missingFreeze(resolved, opened)];
  });
}
