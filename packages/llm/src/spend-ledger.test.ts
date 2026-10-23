import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSpendLedger, SpendLedgerError, SpendLimitError } from "./spend-ledger";

const directories: string[] = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});
function file() {
  const directory = mkdtempSync(join(tmpdir(), "claude-ledger-"));
  directories.push(directory);
  return join(directory, "spend.json");
}
let clock = new Date("2026-10-22T12:00:00Z");
const now = () => clock;

describe("monthly Claude spend ledger", () => {
  it("refuses a reservation that would cross the $200 limit", () => {
    clock = new Date("2026-10-22T12:00:00Z");
    const ledger = new ClaudeSpendLedger(file(), 200, now);
    ledger.reserve("a", 150);
    ledger.settle("a", 120);
    ledger.reserve("b", 70);
    expect(() => ledger.reserve("c", 10.01)).toThrow(SpendLimitError);
    expect(ledger.status()).toMatchObject({ settledUsd: 120, reservedUsd: 70, remainingUsd: 10 });
  });

  it("settles reservations to the actual amount", () => {
    clock = new Date("2026-10-22T12:00:00Z");
    const ledger = new ClaudeSpendLedger(file(), 200, now);
    ledger.reserve("a", 5);
    ledger.settle("a", 0.25);
    expect(ledger.status()).toMatchObject({
      settledUsd: 0.25,
      reservedUsd: 0,
      openReservations: 0,
    });
  });

  it("starts a new UTC month at zero, keeping the old month's spend", () => {
    const path = file();
    clock = new Date("2026-10-31T23:59:00Z");
    const ledger = new ClaudeSpendLedger(path, 200, now);
    ledger.reserve("a", 199);
    ledger.settle("a", 199);
    clock = new Date("2026-11-01T00:01:00Z");
    expect(ledger.status()).toMatchObject({ month: "2026-11", settledUsd: 0, remainingUsd: 200 });
    expect(() => ledger.reserve("b", 100)).not.toThrow();
    expect(JSON.parse(readFileSync(path, "utf8")).months["2026-10"].settledUsd).toBe(199);
  });

  it("settles a swept reservation in its own month, replacing the worst case", () => {
    const path = file();
    clock = new Date("2026-10-31T23:30:00Z");
    const ledger = new ClaudeSpendLedger(path, 200, now);
    ledger.reserve("a", 5);
    clock = new Date("2026-11-01T00:45:00Z");
    ledger.reserve("sweeps", 0); // over an hour later: "a" is swept at its $5 worst case
    ledger.settle("sweeps", 0);
    ledger.settle("a", 0.25);
    const months = JSON.parse(readFileSync(path, "utf8")).months;
    expect(months["2026-10"].settledUsd).toBeCloseTo(0.25, 10);
    expect(months["2026-11"].settledUsd).toBe(0);
  });

  // Felix's Rule L: the ledger never stores a non-finite or negative amount.
  const INVALID = [Number.NaN, Number.POSITIVE_INFINITY, -1];

  it.each(INVALID)("refuses to reserve %s, leaving the file unchanged", (usd) => {
    clock = new Date("2026-10-22T12:00:00Z");
    const path = file();
    const ledger = new ClaudeSpendLedger(path, 200, now);
    ledger.reserve("a", 1);
    const before = readFileSync(path, "utf8");
    expect(() => ledger.reserve("b", usd)).toThrow(SpendLedgerError);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it.each(INVALID)("settles %s at the held reservation", (usd) => {
    clock = new Date("2026-10-22T12:00:00Z");
    const path = file();
    const ledger = new ClaudeSpendLedger(path, 200, now);
    ledger.reserve("a", 5);
    ledger.settle("a", usd);
    expect(readFileSync(path, "utf8")).not.toContain("null");
    expect(JSON.parse(readFileSync(path, "utf8")).months["2026-10"].settledUsd).toBe(5);
    expect(ledger.status()).toMatchObject({ settledUsd: 5, openReservations: 0 });
  });

  it.each(INVALID)("settles %s at a swept reservation's tombstone", (usd) => {
    const path = file();
    clock = new Date("2026-10-22T12:00:00Z");
    const ledger = new ClaudeSpendLedger(path, 200, now);
    ledger.reserve("a", 5);
    clock = new Date("2026-10-22T13:30:00Z");
    ledger.reserve("sweeps", 0);
    ledger.settle("sweeps", 0);
    ledger.settle("a", usd);
    expect(readFileSync(path, "utf8")).not.toContain("null");
    expect(JSON.parse(readFileSync(path, "utf8")).months["2026-10"].settledUsd).toBe(5);
    expect(ledger.status().settledUsd).toBe(5);
  });

  it.each(INVALID)("refuses to settle %s with nothing held, writing nothing", (usd) => {
    clock = new Date("2026-10-22T12:00:00Z");
    const path = file();
    const ledger = new ClaudeSpendLedger(path, 200, now);
    ledger.reserve("a", 1);
    const before = readFileSync(path, "utf8");
    expect(() => ledger.settle("ghost", usd)).toThrow(SpendLedgerError);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  // Rule L covers the stored result (Felix's ruling 497ec6b7): never write a state the reader
  // would reject.
  it("keeps the ledger readable when settlements would overflow the month", () => {
    // halcyon's sequence: two reservations, each settled at the largest finite amount.
    clock = new Date("2026-10-22T12:00:00Z");
    const path = file();
    const ledger = new ClaudeSpendLedger(path, 200, now);
    ledger.reserve("a", 0.05);
    ledger.reserve("b", 0.05);
    ledger.settle("a", Number.MAX_VALUE);
    ledger.settle("b", Number.MAX_VALUE);
    expect(readFileSync(path, "utf8")).not.toContain("null");
    expect(() => ledger.status()).not.toThrow();
    expect(Number.isFinite(ledger.status().settledUsd)).toBe(true);
  });

  it("refuses an update whose result would not be readable, leaving the file byte-identical", () => {
    clock = new Date("2026-10-22T12:00:00Z");
    const path = file();
    const ledger = new ClaudeSpendLedger(path, 200, now);
    ledger.reserve("a", 0.05);
    ledger.settle("a", Number.MAX_VALUE);
    const before = readFileSync(path);
    // Nothing is held for "ghost", and adding the amount would overflow the month.
    expect(() => ledger.settle("ghost", Number.MAX_VALUE)).toThrow(SpendLedgerError);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("refuses a reservation whose stored result the reader would reject, without settle", () => {
    // CES-1563: reaches update()'s stored-state check on its own. A clock past year 9999 makes
    // the month key "+010000" and a timestamp the schema rejects; the amount itself is valid, so
    // no amount check or settle fallback stands in for the stored-state check.
    const path = file();
    clock = new Date("2026-10-22T12:00:00Z");
    new ClaudeSpendLedger(path, 200, now).reserve("a", 1);
    const before = readFileSync(path);
    clock = new Date("+010000-01-01T00:00:00Z");
    expect(() => new ClaudeSpendLedger(path, 200, now).reserve("b", 1)).toThrow(SpendLedgerError);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("refuses calls on a corrupt ledger and never resets it to zero", () => {
    clock = new Date("2026-10-22T12:00:00Z");
    const path = file();
    writeFileSync(path, '{"schemaVersion":"claude_spend_ledger_v1","months":{"2026-10":');
    const ledger = new ClaudeSpendLedger(path, 200, now);
    expect(() => ledger.reserve("a", 1)).toThrow(SpendLedgerError);
    expect(() => ledger.status()).toThrow(SpendLedgerError);
    expect(readFileSync(path, "utf8")).toContain('"2026-10":');
  });

  it("refuses calls when the ledger path cannot be read", () => {
    const path = file();
    mkdirSync(path); // a directory where the file should be
    expect(() => new ClaudeSpendLedger(path, 200, now).reserve("a", 1)).toThrow(SpendLedgerError);
  });

  it("settles a reservation left by a crashed process at its worst case", () => {
    const path = file();
    clock = new Date("2026-10-22T12:00:00Z");
    const ledger = new ClaudeSpendLedger(path, 200, now);
    ledger.reserve("crashed", 3);
    clock = new Date("2026-10-22T13:30:00Z");
    ledger.reserve("next", 1);
    expect(ledger.status()).toMatchObject({ settledUsd: 3, reservedUsd: 1 });
  });
});
