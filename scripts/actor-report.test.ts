import { describe, expect, it } from "vitest";
import { EvaluationRows, HoldoutReport } from "./lib/actor-report";

describe("actor report receipts", () => {
  it("retains failed and unknown-usage outcomes without inventing successful measurements", () => {
    const rows = [
      {
        label: "transport-failure",
        passed: false,
        error: "timeout",
        latencyMs: 12,
        response: null,
        raw: "receipt preserved",
      },
    ];
    expect(EvaluationRows.parse(rows)).toEqual(rows);
    const held = {
      results: [
        {
          label: "case",
          workflow: "journal_v4",
          choices: [],
          attempts: [
            { model: "jev", usage: { inputTokens: null }, latencyMs: null, raw: "evidence" },
          ],
          semanticReconsiderationsMeasured: 0,
          addedLlmCallsMeasured: 0,
          packet: { private: "synthetic" },
        },
      ],
    };
    expect(HoldoutReport.parse(held)).toEqual(held);
  });

  it("rejects missing outcomes and nonnumeric counts before computing a report", () => {
    expect(EvaluationRows.safeParse([{ label: "case", latencyMs: "12" }]).success).toBe(false);
    expect(HoldoutReport.safeParse({ results: [{ label: "case" }] }).success).toBe(false);
  });
});
