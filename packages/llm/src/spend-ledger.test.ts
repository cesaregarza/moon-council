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
