import type { GameEventV1, SpeakerIntentV1 } from "@werewolf/contracts";
import { shuffled, type GameState } from "@werewolf/engine";

export type DiscussionStage = "opening" | "followup" | "closing";
export const publicRevision = (events: GameEventV1[]): string =>
  events
    .filter(
      (e) =>
        e.type === "speech.public" ||
        e.type === "vote.resolved" ||
        e.type === "player.eliminated" ||
        e.type === "role.revealed",
    )
    .at(-1)?.id ?? "initial";
export function responseDockets(state: GameState, events: GameEventV1[]): Record<string, string[]> {
  const result: Record<string, string[]> = Object.fromEntries(
    state.players.filter((p) => p.alive).map((p) => [p.id, []]),
  );
  for (const event of events.filter((e) => e.day === state.day)) {
    if (event.type === "speech.public" && !event.payload.closing) {
      const acts = (event.payload.acts ?? []) as { kind: string; targetId: string | null }[];
      for (const player of state.players.filter(
        (p) => p.alive && p.id !== event.payload.playerId,
      )) {
        const formal = acts.some(
          (a) => ["accusation", "challenge"].includes(a.kind) && a.targetId === player.id,
        );
        const mentioned = String(event.payload.text)
          .toLowerCase()
          .includes(player.name.toLowerCase());
        if (formal || mentioned) result[player.id]!.push(event.id);
      }
    }
    if (event.type === "discussion.completed") {
      const id = String(event.payload.playerId);
      const addressed = new Set((event.payload.docket as string[]) ?? []);
      if (result[id]) result[id] = result[id]!.filter((ref) => !addressed.has(ref));
    }
  }
  return result;
}
export interface DiscussionWork {
  playerId: string;
  stage: DiscussionStage;
  key: string;
  docket: string[];
}
export interface DiscussionAuctionPlan {
  stage: Exclude<DiscussionStage, "closing">;
  round: number;
  candidates: string[];
  listeners: string[];
  dockets: Record<string, string[]>;
}

/** Build one frozen listener-auction round. Provider latency never participates in this ordering. */
export function discussionAuctionPlan(
  state: GameState,
  events: GameEventV1[],
): DiscussionAuctionPlan | null {
  const dayEvents = events.filter((e) => e.day === state.day),
    done = dayEvents.filter((e) => e.type === "discussion.completed");
  const living = state.players
      .filter((p) => p.alive)
      .map((p) => p.id)
      .sort(),
    dockets = responseDockets(state, events);
  const opened = new Set(
    done.filter((e) => e.payload.stage === "opening").map((e) => String(e.payload.playerId)),
  );
  const opening = living.filter((id) => !opened.has(id));
  if (opening.length)
    return {
      stage: "opening",
      round: opened.size,
      candidates: opening,
      listeners: living,
      dockets,
    };
  const followups = done.filter((e) => e.payload.stage === "followup"),
    revision = publicRevision(events);
  const readiness = dayEvents.filter(
    (event) => event.type === "discussion.completed" || event.type === "discussion.bid_submitted",
  );
  const ready = living.filter((id) => {
    const last = readiness
      .filter((event) => event.payload.playerId === id && event.payload.publicRevision === revision)
      .at(-1);
    const value =
      last?.type === "discussion.bid_submitted"
        ? (last.payload.submission as { ready?: boolean } | undefined)?.ready
        : last?.payload.ready;
    return value === true;
  });
  const owed = living.filter((id) => dockets[id]!.length > 0);
  if (
    ready.length >= Math.ceil(living.length * state.config.discussion.readyQuorum) &&
    !owed.length
  )
    return null;
  if (followups.length >= Math.ceil(living.length * state.config.discussion.maxFollowUpSlotsFactor))
    return null;
  const lastSpeaker = dayEvents.filter((e) => e.type === "speech.public").at(-1)?.payload.playerId;
  let candidates = living.filter(
    (id) =>
      id !== lastSpeaker &&
      followups.filter((e) => e.payload.playerId === id).length <
        state.config.discussion.maxFollowUpsPerPlayer,
  );
  if (owed.length) candidates = candidates.filter((id) => owed.includes(id));
  return candidates.length
    ? { stage: "followup", round: followups.length, candidates, listeners: living, dockets }
    : null;
}

export interface SpeakerAuctionBid {
  playerId: string;
  intent: SpeakerIntentV1;
}
export interface SpeakerAuctionScore {
  playerId: string;
  urge: number;
  listenerInterest: number;
  normalizedListenerInterest: number;
  priority: number;
}
export function rankSpeakerAuction(
  candidates: string[],
  bids: SpeakerAuctionBid[],
  bias: number,
  tieOrder: string[],
): SpeakerAuctionScore[] {
  const byListener = new Map(bids.map((b) => [b.playerId, b.intent]));
  const willing = candidates.filter((playerId) => byListener.get(playerId)?.wantsToSpeak);
  const raw = new Map(
    willing.map((speaker) => {
      const ratings = bids
        .filter((b) => b.playerId !== speaker)
        .flatMap((b) => {
          const willingness = b.intent.willingnessToListen.find(
            (w) => w.playerId === speaker,
          )?.willingness;
          return willingness === undefined ? [] : [willingness];
        });
      return [
        speaker,
        ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0,
      ] as const;
    }),
  );
  const total = [...raw.values()].reduce((a, b) => a + b, 0);
  return willing
    .map((playerId) => {
      const listenerInterest = raw.get(playerId) ?? 0,
        normalizedListenerInterest =
          total > 0 ? listenerInterest / total : 1 / Math.max(1, willing.length);
      const urge = byListener.get(playerId)?.urge ?? 0;
      return {
        playerId,
        urge,
        listenerInterest,
        normalizedListenerInterest,
        priority: (bias + urge) * normalizedListenerInterest,
      };
    })
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        tieOrder.indexOf(a.playerId) - tieOrder.indexOf(b.playerId) ||
        a.playerId.localeCompare(b.playerId),
    );
}
export function nextDiscussionWork(state: GameState, events: GameEventV1[]): DiscussionWork | null {
  const dayEvents = events.filter((e) => e.day === state.day);
  const done = dayEvents.filter((e) => e.type === "discussion.completed");
  const living = state.players.filter((p) => p.alive).map((p) => p.id);
  const opening = shuffled(living, `${state.config.seed}:discussion:${state.day}:opening`);
  const dockets = responseDockets(state, events);
  const next = opening.find(
    (id) => !done.some((e) => e.payload.playerId === id && e.payload.stage === "opening"),
  );
  if (next)
    return { playerId: next, stage: "opening", key: `opening:${next}`, docket: dockets[next]! };
  const followups = done.filter((e) => e.payload.stage === "followup");
  const revision = publicRevision(events);
  const ready = living.filter((id) => {
    const last = done.filter((e) => e.payload.playerId === id).at(-1);
    return last?.payload.ready === true && last.payload.publicRevision === revision;
  });
  const owed = living.some((id) => dockets[id]!.length > 0);
  if (ready.length >= Math.ceil(living.length * state.config.discussion.readyQuorum) && !owed)
    return null;
  if (followups.length >= Math.ceil(living.length * state.config.discussion.maxFollowUpSlotsFactor))
    return null;
  const lastSpeaker = dayEvents.filter((e) => e.type === "speech.public").at(-1)?.payload.playerId;
  const tieOrder = shuffled(
    living,
    `${state.config.seed}:discussion:${state.day}:ties:${followups.length}`,
  );
  const candidates = living
    .filter(
      (id) =>
        id !== lastSpeaker &&
        followups.filter((e) => e.payload.playerId === id).length <
          state.config.discussion.maxFollowUpsPerPlayer,
    )
    .map((id) => {
      const lastIndex = done.findLastIndex((e) => e.payload.playerId === id);
      const last = done[lastIndex];
      const interests = (last?.payload.interests as string[]) ?? [];
      const lastSeq = last?.sequence ?? -1;
      const relevantClaim =
        interests.includes("claims") &&
        dayEvents.some(
          (e) =>
            e.sequence > lastSeq &&
            e.type === "speech.public" &&
            ((e.payload.acts as { kind: string }[]) ?? []).some((a) =>
              ["role_claim", "result_claim"].includes(a.kind),
            ),
        );
      return { id, priority: dockets[id]!.length ? 2 : relevantClaim ? 1 : 0, lastIndex };
    })
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.lastIndex - b.lastIndex ||
        tieOrder.indexOf(a.id) - tieOrder.indexOf(b.id),
    );
  const chosen = candidates[0];
  return chosen
    ? {
        playerId: chosen.id,
        stage: "followup",
        key: `followup:${followups.length}:${chosen.id}`,
        docket: dockets[chosen.id]!,
      }
    : null;
}
