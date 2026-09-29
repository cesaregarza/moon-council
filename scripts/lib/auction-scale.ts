import { createHash } from "node:crypto";
import { chooseControlledSpeaker, permutations, POLICIES, type Policy } from "./auction-control";
import {
  dependencyPackets,
  dependencyView,
  dependencyBid,
  dependencySpeech,
  validateDependencyPublication,
  dependencyService,
  DEPENDENCY_SIGNALS,
  type DependencySignal,
  type DependencySpeech,
} from "./auction-dependency";

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
/** Initial wait averages (N+1)/2; each of k-1 distinct successors adds N/2. */
export function expectedOrderedCyclicCompletion(count: number, holders: number): number {
  if (!Number.isInteger(count) || !Number.isInteger(holders) || holders < 1 || holders > count)
    throw new Error("Invalid roster or holder count");
  return (holders * count + 1) / 2;
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
  signal: DependencySignal;
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
/** Each result is produced only after its public predecessor activates the holder's packet. */
export function runScaleCase(input: ScaleInput) {
  const { count, holders, condition, signal, policy, order } = input;
  const ids = validateScaleInput(input);
  const packets = dependencyPackets(ids.slice(0, holders));
  const byOwner = new Map(packets.map((p) => [p.owner, p]));
  const events: DependencySpeech[] = [];
  const slotBudget = count * holders;
  let cursor = 0;
  for (let turn = 1; turn <= slotBudget; turn++) {
    const candidates = ids.filter((id) => id !== events.at(-1)?.playerId);
    const publicSnapshot = events.slice();
    const views = ids.map((id) => dependencyView(id, byOwner.get(id), publicSnapshot));
    const bids = views.map((view) => ({
      playerId: view.playerId,
      intent: dependencyBid(view, ids, condition, signal),
    }));
    const selected = chooseControlledSpeaker(policy, candidates, bids, order, cursor);
    cursor = (order.indexOf(selected) + 1) % count;
    const speech = dependencySpeech(
      views.find((v) => v.playerId === selected)!,
      turn,
      condition === "max-rambler" ? ids.at(-1)! : null,
    );
    validateDependencyPublication(speech, byOwner.get(selected), events);
    events.push(speech);
    if (speech.result?.id === packets.at(-1)!.id) break;
  }
  return {
    ...input,
    completion: events.at(-1)?.result?.id === packets.at(-1)!.id ? events.length : null,
    slotBudget,
    speakers: events.map((e) => e.playerId),
    events,
    disclosures: dependencyService(packets, events),
  };
}
export interface ScaleJob extends ScaleInput {
  profile: ScaleProfile;
}
export function scaleJobs(): ScaleJob[] {
  return SCALE_COUNTS.flatMap((count) =>
    SCALE_PROFILES.flatMap((profile) =>
      SCALE_CONDITIONS.flatMap((condition) =>
        DEPENDENCY_SIGNALS.flatMap((signal) =>
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
            overOneCycle: completed.filter((n) => n > count).length,
            overTwoCycles: completed.filter((n) => n > 2 * count).length,
            maxCompletion: completed.length ? Math.max(...completed) : null,
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
      exactUniformOrderedCyclicMean: expectedOrderedCyclicCompletion(count, holders),
      outcomes,
    };
  });
}
