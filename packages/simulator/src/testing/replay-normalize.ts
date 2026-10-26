import type { GameEventV1 } from "@werewolf/contracts";

/** Random IDs: UUIDs and 32-hex IDs. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{32}\b/g;
/** A view ID hashes a packet that holds source event IDs, so it differs with them; masked by name. */
const VIEW_ID = /"viewId":"([0-9a-f]{64})"/g;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** Measured wall-clock durations, which no two runs share. */
const DURATION = /"(latencyMs|elapsedMs|durationMs)":\d+/g;

/**
 * The run's events with every random ID and view ID renamed by first appearance (so two runs
 * compare equal exactly when they differ only in those), and wall-clock times and durations
 * masked. Other hashes, such as journal evidence revisions, are compared as they are.
 */
export function apartFromIds(events: GameEventV1[]) {
  const names = new Map<string, string>();
  const text = JSON.stringify(
    events.map(({ id, gameId, createdAt: _createdAt, ...event }) => ({ id, gameId, ...event })),
  )
    .replace(UUID, (raw) => {
      if (!names.has(raw)) names.set(raw, `id${names.size}`);
      return names.get(raw)!;
    })
    .replace(VIEW_ID, (_match, raw: string) => {
      if (!names.has(raw)) names.set(raw, `view${names.size}`);
      return `"viewId":"${names.get(raw)!}"`;
    })
    .replace(TIME, "<time>")
    .replace(DURATION, '"$1":0');
  return JSON.parse(text) as unknown[];
}
