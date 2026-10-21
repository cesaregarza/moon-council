import type { SpeakerIntentV1 } from "@werewolf/contracts";
import { rankSpeakerAuction } from "../../packages/simulator/src/speaker-auction";

export const IDS = ["p1", "p2", "p3", "p4"];
export const POLICIES = ["auction", "urgency", "cyclic"] as const;
export const CONDITIONS = ["cooperative", "max-rambler", "zero-rater"] as const;
export const SIGNALS = ["observed-memory", "flat-interest"] as const;
export type Policy = (typeof POLICIES)[number];
export type Condition = (typeof CONDITIONS)[number];
export type Signal = (typeof SIGNALS)[number];
export interface ControlFact {
  id: string;
  owner: string;
  available: number;
  text: string;
}
export interface ControlSpeech {
  turn: number;
  playerId: string;
  fact: { id: string; text: string } | null;
  kind: "disclosure" | "ramble" | "no-information";
  text: string;
}
export interface ControlView {
  playerId: string;
  own: { id: string; text: string } | null;
  publicSpeeches: ControlSpeech[];
}
export function controlFacts(staggered: boolean): ControlFact[] {
  return [
    { id: "A", owner: "p1", available: 1, text: "The selected archive code is K5." },
    { id: "B", owner: "p2", available: staggered ? 4 : 1, text: "K5 maps to node N4." },
    { id: "C", owner: "p3", available: staggered ? 7 : 1, text: "N4 maps to cartridge R7." },
  ];
}
/** Only delivered own facts and public observations cross the actor boundary. */
export function controlView(
  playerId: string,
  turn: number,
  facts: ControlFact[],
  speeches: ControlSpeech[],
): ControlView {
  const own = facts.find(
    (fact) =>
      fact.owner === playerId &&
      fact.available <= turn &&
      !speeches.some((s) => s.fact?.id === fact.id),
  );
  return {
    playerId,
    own: own ? { id: own.id, text: own.text } : null,
    publicSpeeches: structuredClone(speeches),
  };
}
function observedInterest(view: ControlView, peer: string): number {
  // Every script explicitly exhausts its current record on disclosure; new private arrivals
  // remain unknown to peers until disclosed. No hidden profile or future fact is consulted.
  return view.publicSpeeches.some((speech) => speech.playerId === peer) ? 0.05 : 0.7;
}
export function controlJournal(view: ControlView): string {
  const publicFacts = view.publicSpeeches.flatMap((s) => (s.fact ? [s.fact.text] : []));
  return [
    `My unshared delivered evidence: ${view.own?.text ?? "None currently."}`,
    `Already public: ${publicFacts.join(" ") || "No facts disclosed."}`,
    ...IDS.filter((id) => id !== view.playerId).map((id) => {
      const latest = view.publicSpeeches.filter((s) => s.playerId === id).at(-1);
      return latest
        ? `${id}: at turn ${latest.turn}, ${latest.kind === "ramble" ? "added no task information" : "exhausted their currently delivered information"}. A later private arrival is not observable to me yet.`
        : `${id}: not heard yet; their private evidence and personality are unknown to me.`;
    }),
  ].join("\n");
}
export function controlBid(
  view: ControlView,
  condition: Condition,
  signal: Signal,
): SpeakerIntentV1 {
  const target = condition === "max-rambler" && view.playerId === "p4";
  const urge = target ? 1 : view.own ? 0.8 : 0.05;
  return {
    urge,
    wantsToSpeak: true,
    willingnessToListen: IDS.filter((id) => id !== view.playerId).map((playerId) => ({
      playerId,
      willingness:
        condition === "zero-rater" && view.playerId === "p2"
          ? 0
          : signal === "flat-interest"
            ? 0.7
            : observedInterest(view, playerId),
    })),
  };
}
export function chooseControlledSpeaker(
  policy: Policy,
  candidates: string[],
  bids: Array<{ playerId: string; intent: SpeakerIntentV1 }>,
  order: string[],
  cursor: number,
) {
  if (policy === "auction") return rankSpeakerAuction(candidates, bids, 0.25, order)[0]!.playerId;
  if (policy === "urgency")
    return [...candidates].sort(
      (a, b) =>
        bids.find((x) => x.playerId === b)!.intent.urge -
          bids.find((x) => x.playerId === a)!.intent.urge || order.indexOf(a) - order.indexOf(b),
    )[0]!;
  for (let offset = 0; offset < order.length; offset++) {
    const id = order[(cursor + offset) % order.length]!;
    if (candidates.includes(id)) return id;
  }
  throw new Error("No eligible cyclic speaker");
}
function scriptedSpeech(view: ControlView, condition: Condition, turn: number): ControlSpeech {
  if (view.own)
    return {
      turn,
      playerId: view.playerId,
      fact: view.own,
      kind: "disclosure",
      text: `${view.own.text} I have no additional delivered information right now.`,
    };
  const ramble = condition === "max-rambler" && view.playerId === "p4";
  return {
    turn,
    playerId: view.playerId,
    fact: null,
    kind: ramble ? "ramble" : "no-information",
    text: ramble
      ? "Let me repeat a story about folders, tea, and walking around the pond. ".repeat(18)
      : "I have no additional delivered information right now.",
  };
}
export function runControlledDiscussion(
  policy: Policy,
  condition: Condition,
  signal: Signal,
  order: string[],
  staggered = false,
) {
  if (new Set(order).size !== 4 || IDS.some((id) => !order.includes(id)))
    throw new Error("Invalid seat order");
  const facts = controlFacts(staggered),
    speeches: ControlSpeech[] = [];
  const opportunities: Record<string, number> = Object.fromEntries(facts.map((f) => [f.id, 0]));
  const delivery: Record<string, { turn: number; eligiblePassovers: number }> = {};
  const auctions = [];
  let cursor = 0;
  for (let turn = 1; turn <= 12; turn++) {
    const candidates = IDS.filter((id) => id !== speeches.at(-1)?.playerId);
    const views = IDS.map((id) => controlView(id, turn, facts, speeches));
    const bids = views.map((view) => ({
      playerId: view.playerId,
      intent: controlBid(view, condition, signal),
    }));
    for (const fact of facts)
      if (!delivery[fact.id] && fact.available <= turn && candidates.includes(fact.owner))
        opportunities[fact.id]!++;
    const selected = chooseControlledSpeaker(policy, candidates, bids, order, cursor);
    cursor = (order.indexOf(selected) + 1) % order.length;
    const speech = scriptedSpeech(
      views.find((view) => view.playerId === selected)!,
      condition,
      turn,
    );
    if (speech.fact)
      delivery[speech.fact.id] = { turn, eligiblePassovers: opportunities[speech.fact.id]! - 1 };
    auctions.push({
      turn,
      selected,
      candidates,
      bids,
      journals: views.map((view) => ({ playerId: view.playerId, text: controlJournal(view) })),
    });
    speeches.push(speech);
  }
  const completionTurn =
    Object.keys(delivery).length === facts.length
      ? Math.max(...Object.values(delivery).map((d) => d.turn))
      : null;
  const targetId = condition === "zero-rater" ? "p2" : "p4";
  return {
    policy,
    condition,
    signal,
    order,
    staggered,
    completionTurn,
    targetId,
    disclosures: facts.map((fact) => ({
      id: fact.id,
      available: fact.available,
      turn: delivery[fact.id]?.turn ?? null,
      eligiblePassovers: delivery[fact.id]?.eligiblePassovers ?? null,
      eligibleOpportunities: opportunities[fact.id],
      censored: !delivery[fact.id],
    })),
    uninformativeBeforeCompletion: speeches.filter(
      (s) => !s.fact && s.turn <= (completionTurn ?? 12),
    ).length,
    targetTurns: speeches.filter((s) => s.playerId === targetId).length,
    targetCharacters: speeches
      .filter((s) => s.playerId === targetId)
      .reduce((sum, s) => sum + s.text.length, 0),
    speeches,
    auctions,
  };
}
export function permutations(items: string[]): string[][] {
  return items.length
    ? items.flatMap((id) =>
        permutations(items.filter((x) => x !== id)).map((rest) => [id, ...rest]),
      )
    : [[]];
}
export function controlStudy() {
  return CONDITIONS.flatMap((condition) =>
    SIGNALS.flatMap((signal) =>
      [false, true].flatMap((staggered) =>
        POLICIES.flatMap((policy) =>
          permutations(IDS).map((order) =>
            runControlledDiscussion(policy, condition, signal, order, staggered),
          ),
        ),
      ),
    ),
  );
}
