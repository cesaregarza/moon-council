import { createHash } from "node:crypto";
import {
  chooseControlledSpeaker,
  controlBid,
  permutations,
  POLICIES,
  SIGNALS,
  type ControlSpeech,
  type Policy,
  type Signal,
} from "./auction-control";

export const SCALE_COUNTS = [4, 8, 12, 16] as const;
export const SCALE_PROFILES = ["fixed-three", "three-quarters", "all-but-one"] as const;
export const SCALE_CONDITIONS = ["cooperative", "max-rambler"] as const;
export type ScaleProfile = (typeof SCALE_PROFILES)[number];
export type ScaleCondition = (typeof SCALE_CONDITIONS)[number];
export function roster(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `p${i + 1}`);
}
export function clueCount(count: number, profile: ScaleProfile): number {
  if (profile === "fixed-three") return 3;
  return profile === "three-quarters" ? (3 * count) / 4 : count - 1;
}
/** Expected last position of k distinct necessary holders in a uniform random order. */
export function expectedCyclicCompletion(count: number, holders: number): number {
  if (!Number.isInteger(count) || !Number.isInteger(holders) || holders < 1 || holders > count)
    throw new Error("Invalid roster or holder count");
  return (holders * (count + 1)) / (holders + 1);
}
/** Hash-sort sampling is deterministic. Every cell of a group size reuses these orders. */
export function scaleOrders(count: number): string[][] {
  if (!SCALE_COUNTS.some((n) => n === count)) throw new Error("Unsupported scale count");
  const ids = roster(count);
  if (count === 4) return permutations(ids);
  const seen = new Set<string>();
  const orders: string[][] = [];
  for (let attempt = 0; orders.length < 96 && attempt < 10000; attempt++) {
    const order = ids
      .map((id) => ({
        id,
        key: createHash("sha256")
          .update(`auction-scale-v1:${count}:${attempt}:${id}`)
          .digest("hex"),
      }))
      .sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id))
      .map((x) => x.id);
    const key = order.join(",");
    if (!seen.has(key)) {
      seen.add(key);
      orders.push(order);
    }
  }
  if (orders.length !== 96) throw new Error("Could not construct the fixed seat sample");
  return orders;
}
export interface ScaleInput {
  count: number;
  holders: number;
  condition: ScaleCondition;
  signal: Signal;
  policy: Policy;
  order: string[];
}
function validateScaleInput({ count, holders, order }: ScaleInput): string[] {
  if (
    !SCALE_COUNTS.some((n) => n === count) ||
    !Number.isInteger(holders) ||
    holders < 1 ||
    holders >= count
  )
    throw new Error("Invalid scaling scenario");
  const ids = roster(count);
  if (
    order.length !== count ||
    new Set(order).size !== count ||
    ids.some((id) => !order.includes(id))
  )
    throw new Error("Invalid seat order");
  return ids;
}
/** All necessary facts are present initially; no scripted comprehension or delivery delay. */
export function runScaleCase(input: ScaleInput) {
  const { count, holders, condition, signal, policy, order } = input;
  const ids = validateScaleInput(input);
  const holderIds = ids.slice(0, holders);
  const delivered = new Set<string>();
  const speeches: ControlSpeech[] = [];
  let cursor = 0;
  for (let turn = 1; turn <= 2 * count; turn++) {
    const candidates = ids.filter((id) => id !== speeches.at(-1)?.playerId);
    const views = ids.map((playerId) => ({
      playerId,
      own:
        holderIds.includes(playerId) && !delivered.has(playerId)
          ? { id: playerId, text: `Necessary fact held by ${playerId}.` }
          : null,
      publicSpeeches: speeches,
    }));
    const bids = views.map((view) => ({
      playerId: view.playerId,
      intent: controlBid(view, condition, signal, ids),
    }));
    const selected = chooseControlledSpeaker(policy, candidates, bids, order, cursor);
    cursor = (order.indexOf(selected) + 1) % count;
    const fact = views.find((v) => v.playerId === selected)!.own;
    const ramble = condition === "max-rambler" && selected === ids.at(-1);
    speeches.push({
      turn,
      playerId: selected,
      fact,
      kind: fact ? "disclosure" : ramble ? "ramble" : "no-information",
      text: fact?.text ?? "No new task information.",
    });
    if (fact) delivered.add(selected);
    if (delivered.size === holders) break;
  }
  return {
    ...input,
    completion: delivered.size === holders ? speeches.length : null,
    slotBudget: 2 * count,
    speakers: speeches.map((s) => s.playerId),
    disclosures: holderIds.map((id) => ({
      playerId: id,
      turn: speeches.find((s) => s.fact?.id === id)?.turn ?? null,
    })),
  };
}
export interface ScaleJob extends ScaleInput {
  profile: ScaleProfile;
}
export function scaleJobs(): ScaleJob[] {
  return SCALE_COUNTS.flatMap((count) =>
    SCALE_PROFILES.flatMap((profile) =>
      SCALE_CONDITIONS.flatMap((condition) =>
        SIGNALS.flatMap((signal) =>
          POLICIES.flatMap((policy) =>
            scaleOrders(count).map((order) => ({
              count,
              holders: clueCount(count, profile),
              profile,
              condition,
              signal,
              policy,
              order,
            })),
          ),
        ),
      ),
    ),
  );
}
export type ScaleRun = ReturnType<typeof runScaleCase> & { profile: ScaleProfile };
export function scaleSummary(runs: ScaleRun[]) {
  const groups = new Map<string, ScaleRun[]>();
  for (const run of runs) {
    const key = [run.count, run.profile, run.condition, run.signal].join(":");
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const { count, holders, profile, condition, signal } = group[0]!;
    const outcomes = Object.fromEntries(
      POLICIES.map((policy) => {
        const cells = group.filter((r) => r.policy === policy);
        const completed = cells.flatMap((r) => (r.completion === null ? [] : [r.completion]));
        return [
          policy,
          {
            cases: cells.length,
            incomplete: cells.length - completed.length,
            completedMean: completed.length
              ? completed.reduce((a, b) => a + b, 0) / completed.length
              : null,
          },
        ];
      }),
    );
    return {
      count,
      holders,
      profile,
      condition,
      signal,
      exactUniformCyclicMean: expectedCyclicCompletion(count, holders),
      outcomes,
    };
  });
}
