import { createHash } from "node:crypto";
import type { SpeakerIntentV1 } from "@werewolf/contracts";

export const DEPENDENCY_SIGNALS = ["conditional-memory", "flat-interest"] as const;
export type DependencySignal = (typeof DEPENDENCY_SIGNALS)[number];
export type DependencyCondition = "cooperative" | "max-rambler";
export interface DependencyPacket {
  id: string;
  owner: string;
  requires: string | null;
  privateInput: string;
}
export interface DependencyResult {
  id: string;
  input: { id: string; value: string } | null;
  value: string;
}
export interface DependencySpeech {
  turn: number;
  playerId: string;
  kind: "result" | "waiting" | "ramble" | "no-information";
  result: DependencyResult | null;
  waitingFor: string | null;
}
export interface DependencyView {
  playerId: string;
  step: string | null;
  waitingFor: string | null;
  ready: DependencyResult | null;
  publicSpeeches: readonly DependencySpeech[];
}
export function dependencyPackets(owners: string[]): DependencyPacket[] {
  return owners.map((owner, i) => ({
    id: String.fromCharCode(65 + i),
    owner,
    requires: i ? String.fromCharCode(64 + i) : null,
    privateInput: `fictional-private-transform:${owner}:${i}`,
  }));
}
function publishedResult(id: string, events: readonly DependencySpeech[]) {
  return events.find((e) => e.result?.id === id)?.result ?? null;
}
/** A usable result requires the actual public predecessor value, not a future gate name. */
function readyResult(packet: DependencyPacket, events: readonly DependencySpeech[]) {
  if (publishedResult(packet.id, events)) return null;
  const parent = packet.requires ? publishedResult(packet.requires, events) : null;
  if (packet.requires && !parent) return null;
  return {
    id: packet.id,
    input: parent ? { id: parent.id, value: parent.value } : null,
    value: createHash("sha256")
      .update(`${packet.privateInput}:${parent?.value ?? "start"}`)
      .digest("hex")
      .slice(0, 16),
  };
}
/** Accepts only this actor's packet; peer packets and future outputs never enter the view. */
export function dependencyView(
  playerId: string,
  packet: DependencyPacket | undefined,
  publicSpeeches: readonly DependencySpeech[],
): DependencyView {
  if (packet && packet.owner !== playerId) throw new Error("Foreign private packet");
  const ready = packet ? readyResult(packet, publicSpeeches) : null;
  const waitingFor =
    packet?.requires && !publishedResult(packet.requires, publicSpeeches) ? packet.requires : null;
  return { playerId, step: packet?.id ?? null, ready, waitingFor, publicSpeeches };
}
export function dependencyInterest(
  peer: string,
  events: readonly DependencySpeech[],
  signal: DependencySignal,
): number {
  if (signal === "flat-interest") return 0.7;
  const last = events.findLast((e) => e.playerId === peer);
  if (!last) return 0.7;
  if (last.kind === "waiting" && last.waitingFor && publishedResult(last.waitingFor, events))
    return 0.7;
  return 0.05;
}
export function dependencyBid(
  view: DependencyView,
  ids: string[],
  condition: DependencyCondition,
  signal: DependencySignal,
): SpeakerIntentV1 {
  return {
    urge: condition === "max-rambler" && view.playerId === ids.at(-1) ? 1 : view.ready ? 0.8 : 0.05,
    wantsToSpeak: true,
    willingnessToListen: ids
      .filter((id) => id !== view.playerId)
      .map((playerId) => ({
        playerId,
        willingness: dependencyInterest(playerId, view.publicSpeeches, signal),
      })),
  };
}
export function dependencySpeech(
  view: DependencyView,
  turn: number,
  rambler: string | null,
): DependencySpeech {
  if (view.playerId === rambler)
    return { turn, playerId: view.playerId, kind: "ramble", result: null, waitingFor: null };
  return {
    turn,
    playerId: view.playerId,
    kind: view.ready ? "result" : view.waitingFor ? "waiting" : "no-information",
    result: view.ready,
    waitingFor: view.waitingFor,
  };
}
/** Reject a forged, duplicate, or premature result before it can activate the next step. */
export function validateDependencyPublication(
  speech: DependencySpeech,
  packet: DependencyPacket | undefined,
  events: readonly DependencySpeech[],
): void {
  if (speech.kind !== "result") {
    if (speech.result) throw new Error("A blocked turn cannot publish a result");
    return;
  }
  const expected = packet ? readyResult(packet, events) : null;
  if (
    !packet ||
    packet.owner !== speech.playerId ||
    !expected ||
    speech.result?.id !== expected.id ||
    speech.result.value !== expected.value ||
    speech.result.input?.id !== expected.input?.id ||
    speech.result.input?.value !== expected.input?.value
  )
    throw new Error("Invalid or premature dependency result");
}
export function dependencyService(packets: DependencyPacket[], events: DependencySpeech[]) {
  return packets.map((packet) => {
    const parent = events.find((e) => e.result?.id === packet.requires);
    const readyAt = packet.requires ? (parent ? parent.turn + 1 : null) : 1;
    const result = events.find((e) => e.result?.id === packet.id);
    const opportunities = events.filter(
      (e, i) =>
        readyAt !== null &&
        e.turn >= readyAt &&
        e.turn <= (result?.turn ?? Infinity) &&
        events[i - 1]?.playerId !== packet.owner,
    ).length;
    return {
      id: packet.id,
      playerId: packet.owner,
      requires: packet.requires,
      readyAt,
      turn: result?.turn ?? null,
      eligibleOpportunities: opportunities,
      eligiblePassovers: result ? opportunities - 1 : null,
      censored: !result,
    };
  });
}
