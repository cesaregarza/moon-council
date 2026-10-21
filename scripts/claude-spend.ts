import { ClaudeSpendLedger } from "@werewolf/llm";

/** Prints this month's Claude spend from the machine's ledger. Reads only; makes no API call. */
const status = new ClaudeSpendLedger().status();
console.log(
  [
    `Claude spend ${status.month} (UTC): settled $${status.settledUsd.toFixed(4)}, reserved $${status.reservedUsd.toFixed(4)} in ${status.openReservations} open call(s)`,
    `Limit $${status.limitUsd.toFixed(2)}; remaining $${status.remainingUsd.toFixed(4)}`,
    `Ledger: ${status.path}`,
  ].join("\n"),
);
