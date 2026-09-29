import { studyUsage } from "./auction-study-usage";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONDITIONS, sha256, type StudyManifest } from "./auction-study-design";
import type { StudyCheckpoint } from "./auction-study-runner";

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const fraction = (n: number, d: number) => (d ? n / d : null);
export function discussionMetrics(state: StudyCheckpoint, manifest: StudyManifest) {
  const run = state.run;
  const scenario = manifest.scenarios.find((item) => item.id === run.scenarioId)!;
  const targetSpeeches = state.speeches.filter((speech) => speech.playerId === run.targetId);
  const eligible = state.auctions.filter((auction) => auction.candidates.includes(run.targetId));
  const trajectory = state.auctions.map((auction) => {
    const listeners = auction.original
      .filter((bid) => bid.playerId !== run.targetId)
      .map((bid) => ({
        playerId: bid.playerId,
        rating: bid.intent.willingnessToListen.find((rating) => rating.playerId === run.targetId)!
          .willingness,
        journal:
          state.journals
            .filter(
              (journal) => journal.playerId === bid.playerId && journal.afterTurn < auction.turn,
            )
            .at(-1)?.journal ?? null,
      }));
    return {
      turn: auction.turn,
      listeners,
      meanRating: mean(listeners.map((listener) => listener.rating))!,
      eligible: auction.candidates.includes(run.targetId),
      selected: auction.selected === run.targetId,
      originalUrge: auction.original.find((bid) => bid.playerId === run.targetId)!.intent.urge,
      effectiveUrge: auction.effective.find((bid) => bid.playerId === run.targetId)!.intent.urge,
      changedWinner: auction.selected !== auction.unforcedWinner,
    };
  });
  const counts = Object.keys(scenario.choices)
    .map((answer) => ({
      answer,
      count: state.answers.filter((item) => item.answer === answer).length,
    }))
    .sort((a, b) => b.count - a.count);
  const groupChoice = counts[0]!.count > counts[1]!.count ? counts[0]!.answer : null;
  const firstRating = trajectory[0]?.meanRating ?? null;
  const lastRating = trajectory.at(-1)?.meanRating ?? null;
  const witnessAfter = state.speeches.find(
    (speech) =>
      speech.playerId === run.witnessId && speech.turn > (scenario.lateEvidence?.afterTurn ?? 0),
  );
  return {
    id: run.id,
    seed: run.seed,
    scenarioId: run.scenarioId,
    condition: run.condition,
    status: state.status,
    metrics: {
      floorShare: fraction(targetSpeeches.length, state.speeches.length),
      characterShare: fraction(
        targetSpeeches.reduce((sum, speech) => sum + speech.text.length, 0),
        state.speeches.reduce((sum, speech) => sum + speech.text.length, 0),
      ),
      eligibleWinRate: fraction(
        eligible.filter((auction) => auction.selected === run.targetId).length,
        eligible.length,
      ),
      ratingChange: firstRating === null || lastRating === null ? null : lastRating - firstRating,
      initialAccuracy: fraction(
        state.initialAnswers.filter((answer) => answer.answer === scenario.correct).length,
        state.initialAnswers.length,
      ),
      accuracy: fraction(
        state.answers.filter((answer) => answer.answer === scenario.correct).length,
        state.answers.length,
      ),
      brier: mean(
        state.answers.map((answer) =>
          Object.keys(scenario.choices).reduce(
            (sum, choice) =>
              sum + (answer.probabilities[choice]! - Number(choice === scenario.correct)) ** 2,
            0,
          ),
        ),
      ),
      witnessWait: witnessAfter
        ? witnessAfter.turn - (scenario.lateEvidence?.afterTurn ?? 0)
        : null,
    },
    groupChoice,
    groupCorrect: groupChoice === null ? null : groupChoice === scenario.correct,
    targetSpeeches: targetSpeeches.length,
    totalSpeeches: state.speeches.length,
    eligibleAuctions: eligible.length,
    eligibleLosses: eligible.filter(
      (auction) =>
        auction.selected !== run.targetId &&
        auction.effective.find((bid) => bid.playerId === run.targetId)!.intent.wantsToSpeak,
    ).length,
    declines: eligible.filter(
      (auction) =>
        !auction.effective.find((bid) => bid.playerId === run.targetId)!.intent.wantsToSpeak,
    ).length,
    ineligibleAuctions: state.auctions.length - eligible.length,
    changedWinners: trajectory.filter((row) => row.changedWinner).length,
    witnessNeverHeardAfterEvidence: !witnessAfter,
    trajectory,
  };
}
export type DiscussionMetrics = ReturnType<typeof discussionMetrics>;
export function factorialEffects(rows: DiscussionMetrics[]) {
  const blocks = [...new Set(rows.map((row) => `${row.scenarioId}\n${row.seed}`))];
  return blocks.map((block) => {
    const [scenarioId, seed] = block.split("\n");
    const cells = CONDITIONS.map((condition) =>
      rows.filter(
        (row) =>
          row.scenarioId === scenarioId &&
          row.seed === seed &&
          row.condition === condition &&
          row.status === "complete",
      ),
    );
    if (cells.some((cell) => cell.length !== 1))
      return { scenarioId, seed, complete: false, effects: null };
    const keys = Object.keys(cells[0]![0]!.metrics) as Array<keyof DiscussionMetrics["metrics"]>;
    const effects = Object.fromEntries(
      keys.map((key) => {
        const values = cells.map((cell) => cell[0]!.metrics[key]);
        if (values.some((value) => value === null)) return [key, null];
        const [a, b, c, d] = values as [number, number, number, number];
        return [
          key,
          {
            urgency: (b - a + (d - c)) / 2,
            rambling: (c - a + (d - b)) / 2,
            interaction: d - c - (b - a),
          },
        ];
      }),
    );
    return { scenarioId, seed, complete: true, effects };
  });
}
export async function loadCheckpoints(root: string, manifest: StudyManifest) {
  const states: StudyCheckpoint[] = [];
  for (const run of manifest.runs) {
    const path = join(root, run.id, "checkpoint.json");
    if (!existsSync(path)) continue;
    const state = JSON.parse(await readFile(path, "utf8")) as StudyCheckpoint;
    if (JSON.stringify(state.run) !== JSON.stringify(run))
      throw new Error("Checkpoint/manifest mismatch");
    states.push(state);
  }
  return states;
}
const pct = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
export async function writeStudyReport(root: string, manifest: StudyManifest) {
  const states = await loadCheckpoints(root, manifest);
  const rows = states.map((state) => discussionMetrics(state, manifest));
  const effects = factorialEffects(rows);
  const usage = await Promise.all(
    manifest.runs.map(async (run) => ({
      id: run.id,
      usage: await studyUsage(join(root, run.id, "attempts.jsonl")),
    })),
  );
  const table = [
    "| Task | Condition | Status | Floor | Characters | Listener Δ | Correct answers | Witness wait |",
    "|---|---|---|---:|---:|---:|---:|---:|",
    ...rows.map(
      (row) =>
        `| ${row.scenarioId} | ${row.condition} | ${row.status} | ${pct(row.metrics.floorShare)} | ${pct(row.metrics.characterShare)} | ${row.metrics.ratingChange?.toFixed(3) ?? "—"} | ${pct(row.metrics.accuracy)} | ${row.metrics.witnessWait ?? "never"} |`,
    ),
  ];
  const report = [
    "# Speech auction study",
    "",
    manifest.live ? "Live Luna/Jev pilot." : "OFFLINE MECHANICS ONLY — no behavioral evidence.",
    "",
    `${states.filter((state) => state.status === "complete").length}/${manifest.runs.length} discussions complete. Source: ${manifest.sourceCommit}.`,
    "",
    "Four conditions cross public speaking style with forced urgency. Each task/seed is one matched block, not a collection of independent auction observations. Different tasks are not seed replications. This pilot does not establish statistical significance or generalization.",
    "",
    ...table,
    "",
    "Floor is committed speeches; character share counts UTF-16 code units (a text-length proxy, not speaking time). Listener change is the final pre-speech auction minus the first; final-speech reactions are in checkpoint journals, not in that numeric endpoint. Witness wait is turns from evidence availability to their first speech, not proof that the evidence was communicated. Never-heard observations are censored, not zero.",
    "",
    "Final answers are private simultaneous choices. Correctness uses the synthetic case's explicit solution. Brier score is the sum of squared errors across options (lower is better); group choice uses unique plurality, with ties left undefined. See analysis.json for within-block factorial contrasts, eligibility, original/effective urgency, and frozen-auction counterfactuals.",
    "",
    "A changed counterfactual winner holds all recorded beliefs and ratings fixed; it is not a replay of an alternate conversation. Rambling is an assigned instruction, not a verified outcome. Longer speech alone does not demonstrate low signal. The condition-blinded coding packet supports a separate manipulation check; no automatic quality ratings are invented.",
    "",
    "Protocol: four cooperative participants, 12 turns by default, no guaranteed openings or personal turn caps, previous speaker excluded, priority=(0.25+urgency)×normalized listener interest. This reuses Moon Council's ranking function; it intentionally does not reproduce Werewolf's eligibility and termination policy.",
    "",
    "Private artifacts: manifest.json freezes task records and settings; each checkpoint contains isolated journals, bids, transcript, and final answers; attempts.jsonl retains exact provider inputs/responses and usage. Failed and interrupted runs stay visible and are not automatically replaced. No results from the earlier Werewolf pair are pooled here.",
    "",
  ];
  await writeFile(
    join(root, "analysis.json"),
    JSON.stringify({ rows, effects, usage, expectedRuns: manifest.runs.length }, null, 2),
    { mode: 0o600 },
  );
  await writeFile(join(root, "report.md"), report.join("\n"), { mode: 0o600 });
  const packet = states
    .flatMap((state) =>
      state.speeches.map((speech) => ({
        id: sha256(`${state.run.id}:${speech.turn}`).slice(0, 16),
        discussion: sha256(state.run.id).slice(0, 12),
        turn: speech.turn,
        speaker: speech.playerId,
        text: speech.text,
        relevance: null,
        novelty: null,
        offTopic: null,
        rationale: "",
      })),
    )
    .sort((a, b) => a.discussion.localeCompare(b.discussion) || a.turn - b.turn);
  // Never overwrite human annotations on regeneration.
  const codingPath = join(root, "coding-packet.json");
  if (!existsSync(codingPath))
    await writeFile(
      codingPath,
      JSON.stringify(
        {
          rubric:
            "Read complete discussions in turn order. relevance: 0 unrelated, 1 partly useful, 2 directly useful; novelty: 0 repeats, 1 new but peripheral, 2 new actionable evidence/reasoning/correction; offTopic: 0 none, 1 minority, 2 majority. Score independently of agreement. Cite text in rationale. Null = unreviewed. Condition/subject hidden; content may reveal assignment.",
          speeches: packet,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  return {
    complete: rows.filter((row) => row.status === "complete").length,
    expected: manifest.runs.length,
  };
}
