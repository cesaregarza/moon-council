export interface StudyScenario {
  id: string;
  task: string;
  choices: Record<string, string>;
  evidence: string[];
  lateEvidence?: { afterTurn: number; text: string };
  correct: string;
  decisiveEvidence: string;
}

/** Synthetic cases with explicit ground truth. Index 0 = subject, 1 = key witness. */
export const AUCTION_SCENARIOS: StudyScenario[] = [
  {
    id: "supplier",
    task: [
      "Choose one supplier for a public exhibit. A supplier is eligible only if its product",
      "passes the accessibility test AND it can deliver by Friday. Among eligible suppliers",
      "choose the lowest price. Public quotes: Amber $80, Birch $100, Cedar $90.",
      "The quoted Friday delivery dates and accessibility claims are unverified. Each",
      "participant has a different verified record. Share evidence to reach the correct choice.",
    ].join(" "),
    choices: { amber: "Amber", birch: "Birch", cedar: "Cedar" },
    evidence: [
      "Finance confirmed the quotes: Amber $80, Birch $100, Cedar $90. No discounts apply.",
      "The signed accessibility test says Amber FAILS. Birch and Cedar both PASS.",
      "The carrier's confirmed schedule is Amber Thursday, Birch Friday, Cedar next Tuesday.",
      "Procurement confirms that all quotes include tax and fees; there are no other suppliers.",
    ],
    correct: "birch",
    decisiveEvidence:
      "Amber fails accessibility; Cedar arrives after Friday; Birch alone qualifies.",
  },
  {
    id: "incident",
    task: [
      "Diagnose a synthetic service incident: cache configuration, database capacity, or client",
      "retry logic. Select the component supported by controlled causal evidence, prioritizing",
      "interventions over correlations. Public symptoms: latency and cache misses rose at noon",
      "after a cache configuration change. A controlled test is still running and may return",
      "during discussion. Each participant may hold different verified observations.",
    ].join(" "),
    choices: {
      cache: "Cache configuration",
      database: "Database capacity",
      client: "Client retry logic",
    },
    evidence: [
      "The incident dashboard confirms the public symptoms and their noon start. It does not establish a cause.",
      "Your controlled intervention test is still running. No result is available yet. Do not assume its result.",
      "Database CPU, lock waits and query latency remained at their normal baseline throughout the incident.",
      "Reverting the cache configuration did not reduce latency or request volume. This intervention did not fix the incident.",
    ],
    lateEvidence: {
      afterTurn: 6,
      text: "CONTROLLED TEST RESULT: With server configuration unchanged, disabling client retries removes the load spike and restores latency. Re-enabling the retries reproduces both symptoms. A duplicate retry loop is confirmed in the client.",
    },
    correct: "client",
    decisiveEvidence:
      "Disabling and re-enabling client retries removes and reproduces the incident.",
  },
  {
    id: "correction",
    task: [
      "Review a missed handoff using verified records. Choose the corrective action matching",
      "the actual failure: retrain the uploader, repair the notification service, or repair the",
      "reviewer's inbox. An UNVERIFIED initial account blames {{witness}} for uploading",
      "late. The handoff deadline was 17:00. An on-time upload should automatically trigger",
      "a notification within one minute. Distinguish claims from records and allow corrections.",
      "Participants hold different pieces of the incident record.",
    ].join(" "),
    choices: {
      uploader: "Retrain the uploader",
      notification: "Repair the notification service",
      inbox: "Repair the reviewer's inbox",
    },
    evidence: [
      "The review meeting's agenda repeats the unverified late-upload allegation. You have no independent verification of it.",
      "You are the evidence-holder blamed in the initial account. Your signed server receipt proves upload completion at 16:42, before the 17:00 deadline. You have the receipt, not merely a recollection.",
      "The notification service audit records a queue crash from 16:40 to 17:20. No upload notifications were sent in that interval.",
      "The reviewer's inbox was online and accepted a test notification at 16:50. No filtering rule blocked the relevant sender.",
    ],
    correct: "notification",
    decisiveEvidence:
      "The signed 16:42 upload receipt refutes lateness; the notification queue crashed.",
  },
];
