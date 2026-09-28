import type { AuditEvent } from "../game-audit";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const array = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(object) : []);
const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const fraction = (count: number, total: number): number => (total ? count / total : 0);

function ranks(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((value) => (sorted.indexOf(value) + sorted.lastIndexOf(value)) / 2 + 1);
}

/** Average ranks for ties. Missing/constant series are undefined, not zero correlation. */
export function spearman(pairs: Array<[number, number]>): number | null {
  if (pairs.length < 3) return null;
  const x = ranks(pairs.map(([value]) => value)),
    y = ranks(pairs.map(([, value]) => value));
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const mx = mean(x),
    my = mean(y);
  const covariance = x.reduce((sum, value, i) => sum + (value - mx) * (y[i]! - my), 0);
  const variance = (values: number[], m: number) =>
    values.reduce((sum, value) => sum + (value - m) ** 2, 0);
  const denominator = Math.sqrt(variance(x, mx) * variance(y, my));
  return denominator ? Math.max(-1, Math.min(1, covariance / denominator)) : null;
}

function attentionNotes(events: AuditEvent[], before: number, listenerId: string) {
  const update = events.findLast(
    (event) =>
      event.sequence < before &&
      event.type === "journal.v2_updated" &&
      event.payload.playerId === listenerId,
  );
  const brief = object(object(update?.payload.journal).decisionBrief);
  return {
    journalSequence: update?.sequence ?? null,
    attention: typeof brief.attention === "string" ? brief.attention : null,
  };
}

function auctionSnapshot(
  auction: AuditEvent,
  nextSequence: number,
  events: AuditEvent[],
  playerIds: string[],
  speeches: AuditEvent[],
) {
  const scores = array(auction.payload.scores);
  const declines = Array.isArray(auction.payload.declinedCandidateIds)
    ? auction.payload.declinedCandidateIds.map(String)
    : [];
  const intents = object(auction.payload.intents);
  const prior = speeches.filter((event) => event.sequence < auction.sequence);
  const after = speeches.filter((event) => event.sequence < nextSequence);
  const bids = events.filter(
    (event) =>
      event.type === "discussion.bid_submitted" &&
      event.day === auction.day &&
      event.sequence < auction.sequence &&
      event.payload.auctionKey === auction.payload.auctionKey,
  );
  return {
    sequence: auction.sequence,
    auctionKey: auction.payload.auctionKey,
    stage: auction.payload.stage,
    round: auction.payload.round,
    selectedPlayerId: auction.payload.selectedPlayerId ?? null,
    priorSpeeches: prior.length,
    speechesAfterAuction: after.length,
    players: playerIds.map((playerId) => {
      const score = scores.find((item) => item.playerId === playerId);
      const intent = object(intents[playerId]);
      const bid = bids.findLast((event) => event.payload.playerId === playerId);
      return {
        playerId,
        eligible: Boolean(score) || declines.includes(playerId),
        selected: auction.payload.selectedPlayerId === playerId,
        declined: declines.includes(playerId),
        urge: numeric(score?.urge ?? intent.urge),
        urgencyOverride: bid?.payload.urgencyOverride ?? null,
        listenerInterest: numeric(score?.listenerInterest),
        normalizedListenerInterest: numeric(score?.normalizedListenerInterest),
        priority: numeric(score?.priority),
        priorFloorShare: fraction(
          prior.filter((event) => event.payload.playerId === playerId).length,
          prior.length,
        ),
        floorShareAfterAuction: fraction(
          after.filter((event) => event.payload.playerId === playerId).length,
          after.length,
        ),
      };
    }),
    listeners: Object.entries(intents).map(([listenerId, value]) => ({
      playerId: listenerId,
      ...attentionNotes(events, auction.sequence, listenerId),
      ratings: array(object(value).willingnessToListen)
        .filter((rating) => rating.playerId !== listenerId)
        .map((rating) => ({
          playerId: String(rating.playerId),
          willingness: numeric(rating.willingness),
        })),
    })),
  };
}

export function summarizeAttention(events: AuditEvent[]) {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const created = ordered.find((event) => event.type === "game.created");
  const players = array(created?.payload.players);
  const config = object(created?.payload.config);
  const auctions = ordered.filter((event) => event.type === "discussion.auction_resolved");
  return {
    experiment: config.experiment ?? null,
    floorUnit: "committed non-closing public speeches",
    correlation:
      "Spearman: prior floor share versus raw listener interest, eligible scored auctions only; null for fewer than three observations or constant ranks. Association does not establish causation.",
    journalUpdates: ordered
      .filter((event) => event.type === "journal.v2_updated")
      .flatMap((event) => {
        const brief = object(object(event.payload.journal).decisionBrief);
        return typeof brief.attention === "string"
          ? [
              {
                sequence: event.sequence,
                day: event.day,
                playerId: String(event.payload.playerId),
                attention: brief.attention,
              },
            ]
          : [];
      }),
    days: [...new Set(auctions.map((event) => event.day))]
      .sort((a, b) => a - b)
      .map((day) => {
        const speeches = ordered.filter(
          (event) => event.day === day && event.type === "speech.public" && !event.payload.closing,
        );
        const dayAuctions = auctions.filter((event) => event.day === day);
        const snapshots = dayAuctions.map((auction, index) =>
          auctionSnapshot(
            auction,
            dayAuctions[index + 1]?.sequence ?? Infinity,
            ordered,
            players.map((player) => String(player.id)),
            speeches,
          ),
        );
        const floor = players.map((player) => {
          const count = speeches.filter((event) => event.payload.playerId === player.id).length;
          const observations = snapshots.flatMap((snapshot) =>
            snapshot.players.filter(
              (row) => row.playerId === player.id && row.eligible && row.listenerInterest !== null,
            ),
          );
          return {
            playerId: String(player.id),
            name: String(player.name),
            alignment: String(object(player.role).alignment),
            role: String(object(player.role).name),
            speeches: count,
            floorShare: fraction(count, speeches.length),
            observations: observations.length,
            priorFloorInterestSpearman: spearman(
              observations.map((row) => [row.priorFloorShare, row.listenerInterest!]),
            ),
          };
        });
        const group = (key: "alignment" | "role") =>
          [...new Set(floor.map((player) => player[key]))].sort().map((name) => {
            const count = floor
              .filter((player) => player[key] === name)
              .reduce((sum, player) => sum + player.speeches, 0);
            return { name, speeches: count, floorShare: fraction(count, speeches.length) };
          });
        return {
          day,
          auctions: snapshots,
          players: floor,
          byAlignment: group("alignment"),
          byRole: group("role"),
        };
      }),
  };
}
