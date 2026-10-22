import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export class SpendLimitError extends Error {}
/** The ledger could not be read, parsed or locked; calls are refused rather than counted as zero. */
export class SpendLedgerError extends Error {}

export const DEFAULT_MONTHLY_LIMIT_USD = 200;
/** The ledger stores only finite, non-negative amounts (Rule L). */
const validAmount = (usd: number) => Number.isFinite(usd) && usd >= 0;
/** A reservation this old belongs to a process that died mid-call; it settles at its worst case. */
const STALE_RESERVATION_MS = 60 * 60_000;
const LOCK_WAIT_MS = 5_000;

const Month = z.strictObject({
  settledUsd: z.number().nonnegative(),
  reservations: z.record(
    z.string(),
    z.strictObject({ usd: z.number().nonnegative(), at: z.string().datetime() }),
  ),
  /** Reservations swept at their worst case, by ID, so a late settle can replace that amount. */
  swept: z.record(z.string(), z.number().nonnegative()).default({}),
});
const Ledger = z.strictObject({
  schemaVersion: z.literal("claude_spend_ledger_v1"),
  months: z.record(z.string().regex(/^\d{4}-\d{2}$/), Month),
});
type LedgerFile = z.infer<typeof Ledger>;

export function defaultLedgerPath(): string {
  return (
    process.env.MOON_COUNCIL_SPEND_LEDGER?.trim() ||
    join(homedir(), ".moon-council", "claude-spend.json")
  );
}

export function monthlyLimitUsd(value = process.env.MOON_COUNCIL_CLAUDE_MONTHLY_LIMIT_USD): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MONTHLY_LIMIT_USD;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0)
    throw new SpendLedgerError(`Invalid MOON_COUNCIL_CLAUDE_MONTHLY_LIMIT_USD: ${value}`);
  return limit;
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Monthly Claude spend on the machine that holds the key (UTC calendar months). The file lives
 * outside the repository and game databases. Every change happens under an exclusive lock file.
 */
export class ClaudeSpendLedger {
  constructor(
    readonly path = defaultLedgerPath(),
    readonly limitUsd = monthlyLimitUsd(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Admit `usd` against the current month, or throw before any request is sent. */
  reserve(id: string, usd: number): void {
    if (!validAmount(usd))
      throw new SpendLedgerError(`Refusing to reserve an invalid Claude amount: ${usd}`);
    this.update((ledger) => {
      const month = this.month(ledger);
      const open = Object.values(month.reservations).reduce((sum, r) => sum + r.usd, 0);
      if (month.settledUsd + open + usd > this.limitUsd)
        throw new SpendLimitError(
          `Claude monthly limit $${this.limitUsd} reached: settled $${month.settledUsd.toFixed(4)}, open $${open.toFixed(4)}, this call $${usd.toFixed(4)}`,
        );
      month.reservations[id] = { usd, at: this.now().toISOString() };
    });
  }

  /**
   * Replace a reservation with the actual cost, in the month it was reserved. A reservation already
   * swept at its worst case has that amount replaced instead.
   */
  settle(id: string, usd: number): void {
    this.update((ledger) => {
      const months = Object.values(ledger.months);
      const open = months.find((month) => month.reservations[id]);
      const swept = months.find((month) => month.swept[id] !== undefined);
      const month = open ?? swept ?? this.month(ledger);
      // Rule L: an invalid amount settles at what is held, never as a number of its own.
      const held = open ? open.reservations[id]!.usd : swept?.swept[id];
      if (!validAmount(usd)) {
        if (held === undefined)
          throw new SpendLedgerError(`Refusing to settle an invalid Claude amount: ${usd}`);
        usd = held;
      }
      if (!open && swept) {
        month.settledUsd = Math.max(0, month.settledUsd - swept.swept[id]!);
        delete month.swept[id];
      }
      delete month.reservations[id];
      month.settledUsd += usd;
    });
  }

  status() {
    const ledger = this.read();
    const key = this.key();
    const month = ledger.months[key] ?? { settledUsd: 0, reservations: {} };
    const reservedUsd = Object.values(month.reservations).reduce((sum, r) => sum + r.usd, 0);
    return {
      month: key,
      limitUsd: this.limitUsd,
      settledUsd: month.settledUsd,
      reservedUsd,
      openReservations: Object.keys(month.reservations).length,
      remainingUsd: Math.max(0, this.limitUsd - month.settledUsd - reservedUsd),
      path: this.path,
    };
  }

  private key(): string {
    return this.now().toISOString().slice(0, 7);
  }

  private month(ledger: LedgerFile) {
    return (ledger.months[this.key()] ??= { settledUsd: 0, reservations: {}, swept: {} });
  }

  private read(): LedgerFile {
    if (!existsSync(this.path)) return { schemaVersion: "claude_spend_ledger_v1", months: {} };
    try {
      return Ledger.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      throw new SpendLedgerError(
        `Claude spend ledger ${this.path} is unreadable or corrupt; refusing calls until it is repaired`,
        { cause: error },
      );
    }
  }

  private update(change: (ledger: LedgerFile) => void): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    let fd: number | undefined;
    for (const started = Date.now(); fd === undefined; sleep(20)) {
      try {
        fd = openSync(lock, "wx", 0o600);
      } catch {
        if (Date.now() - started > LOCK_WAIT_MS)
          throw new SpendLedgerError(
            `Claude spend ledger lock ${lock} is held; remove it only if no game is running`,
          );
      }
    }
    try {
      const ledger = this.read();
      const cutoff = this.now().getTime() - STALE_RESERVATION_MS;
      for (const month of Object.values(ledger.months))
        for (const [id, reservation] of Object.entries(month.reservations))
          if (Date.parse(reservation.at) < cutoff) {
            month.settledUsd += reservation.usd;
            month.swept[id] = reservation.usd;
            delete month.reservations[id];
          }
      change(ledger);
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
}
