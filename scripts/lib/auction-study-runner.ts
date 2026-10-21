import { mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { shuffled } from "@werewolf/engine";
import { jevResponseSchema, type JevResponse } from "@werewolf/llm";
import type { SpeakerIntentV1 } from "@werewolf/contracts";
import { rankSpeakerAuction } from "../../packages/simulator/src/speaker-auction";
import {
  studyPlayers,
  playerPrompt,
  jevPrompt,
  JournalSchema,
  SpeechSchema,
  type StudyPlayer,
  type StudySpeech,
} from "./auction-study-agents";
import type { StudyManifest, StudyRun } from "./auction-study-design";
import { StudyProviders } from "./auction-study-provider";

export interface StudyAuction {
  turn: number;
  candidates: string[];
  tieOrder: string[];
  original: Array<{ playerId: string; intent: SpeakerIntentV1 }>;
  effective: Array<{ playerId: string; intent: SpeakerIntentV1 }>;
  scores: ReturnType<typeof rankSpeakerAuction>;
  selected: string | null;
  unforcedWinner: string | null;
}
export type StudyAnswer = {
  playerId: string;
  answer: string;
  probabilities: Record<string, number>;
  route?: Record<string, { choice: string; probabilities: Record<string, number> }>;
};

export interface StudyCheckpoint {
  run: StudyRun;
  status: "running" | "complete" | "failed";
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  players: StudyPlayer[];
  speeches: StudySpeech[];
  auctions: StudyAuction[];
  journals: Array<{ afterTurn: number; playerId: string; journal: string; reason: string }>;
  answers: StudyAnswer[];
  initialAnswers: StudyAnswer[];
  lateEvidenceDelivered: boolean;
}
export async function saveJson(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
async function batch<T>(values: T[], action: (value: T) => Promise<void>) {
  const results = await Promise.allSettled(values.map(action));
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
function expectedScore(answer: JevResponse["answers"][string]): number {
  if (answer.type !== "score") throw new Error("Expected a Jev score");
  const probabilities = Object.entries(answer.probabilities);
  const total = probabilities.reduce((sum, [, p]) => sum + p, 0);
  return probabilities.reduce((sum, [level, p]) => sum + Number(level) * p, 0) / (4 * total);
}
function bidIntent(response: JevResponse): SpeakerIntentV1 {
  const urge = expectedScore(response.answers.urge!);
  return {
    urge,
    wantsToSpeak: urge > 0,
    willingnessToListen: Object.entries(response.answers)
      .filter(([key]) => key.startsWith("listen_"))
      .map(([key, answer]) => ({
        playerId: key.slice("listen_".length),
        willingness: expectedScore(answer),
      })),
  };
}

export async function runStudyDiscussion(
  directory: string,
  manifest: StudyManifest,
  run: StudyRun,
) {
  await mkdir(directory, { mode: 0o700 });
  const definition = manifest.scenarios.find((item) => item.id === run.scenarioId)!;
  const witnessName = ["Ada", "Ben", "Cleo", "Dax"][Number(run.witnessId.slice(1)) - 1]!;
  const scenario = { ...definition, task: definition.task.replaceAll("{{witness}}", witnessName) };
  const state: StudyCheckpoint = {
    run,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    players: studyPlayers(run, scenario),
    speeches: [],
    auctions: [],
    journals: [],
    answers: [],
    initialAnswers: [],
    lateEvidenceDelivered: false,
  };
  const path = join(directory, "checkpoint.json");
  const save = () => saveJson(path, state);
  await save();
  try {
    const providers = new StudyProviders(directory, manifest);
    const reflect = async (players: StudyPlayer[], turn: number, reason: string) => {
      await batch(players, async (player) => {
        const result = await providers.call({
          kind: "decision_v3_1",
          playerId: player.id,
          gameId: run.id,
          model: manifest.model,
          reasoningEffort: manifest.effort,
          schemaName: "study_journal",
          schema: JournalSchema,
          maxOutputTokens: null,
          preparedPrompt: playerPrompt(
            player,
            state.players,
            scenario,
            state.speeches,
            "journal",
            manifest.turns,
            manifest.journalPolicy,
          ),
        });
        player.journal = result.journal;
        state.journals.push({
          afterTurn: turn,
          playerId: player.id,
          journal: result.journal,
          reason,
        });
      });
      await save();
    };
    const ask = async (player: StudyPlayer, final: boolean) => {
      const request = jevPrompt(
        player,
        state.players,
        scenario,
        state.speeches,
        final,
        manifest,
        state.auctions.length,
      );
      return providers.call({
        kind: "jev",
        playerId: player.id,
        model: request.model,
        schemaName: "study_jev",
        schema: jevResponseSchema(request),
        maxOutputTokens: null,
        preparedPrompt: { instructions: "", input: JSON.stringify(request) },
      });
    };
    const judge = async () => {
      const answers: StudyAnswer[] = [];
      await batch(state.players, async (player) => {
        const response = await ask(player, true);
        const answer = response.answers.answer!;
        if (answer.type !== "choice") throw new Error("Expected a final choice");
        answers.push({
          playerId: player.id,
          answer: answer.choice,
          probabilities: answer.probabilities,
          ...(scenario.routeProbes
            ? {
                route: Object.fromEntries(
                  Object.keys(scenario.routeProbes).map((key) => {
                    const link = response.answers[key]!;
                    if (link.type !== "choice") throw new Error("Expected a route choice");
                    return [key, { choice: link.choice, probabilities: link.probabilities }];
                  }),
                ),
              }
            : {}),
        });
      });
      answers.sort((a, b) => a.playerId.localeCompare(b.playerId));
      return answers;
    };
    await reflect(state.players, 0, "initial evidence");
    state.initialAnswers = await judge();
    await save();
    for (let turn = 1; turn <= manifest.turns; turn++) {
      if (scenario.lateEvidence && turn === scenario.lateEvidence.afterTurn + 1) {
        const recipientId =
          scenario.lateEvidence.recipientIndex === undefined
            ? run.witnessId
            : run.evidenceOrder[scenario.lateEvidence.recipientIndex]!;
        const witness = state.players.find((player) => player.id === recipientId)!;
        witness.evidence.push(scenario.lateEvidence.text);
        state.lateEvidenceDelivered = true;
        await reflect([witness], turn - 1, "private evidence arrival");
      }
      const original: StudyAuction["original"] = [];
      await batch(state.players, async (player) => {
        original.push({ playerId: player.id, intent: bidIntent(await ask(player, false)) });
      });
      original.sort((a, b) => a.playerId.localeCompare(b.playerId));
      const candidates = state.players
        .map((player) => player.id)
        .filter((id) => id !== state.speeches.at(-1)?.playerId);
      const tieOrder = shuffled(candidates, `${run.seed}:${run.scenarioId}:auction:${turn}`);
      const effective = original.map((bid) => ({
        ...bid,
        intent:
          bid.playerId === run.targetId &&
          run.condition.endsWith("forced") &&
          candidates.includes(bid.playerId)
            ? { ...bid.intent, urge: 1, wantsToSpeak: true }
            : bid.intent,
      }));
      const scores = rankSpeakerAuction(candidates, effective, manifest.bias, tieOrder);
      const selected = scores[0]?.playerId ?? null;
      state.auctions.push({
        turn,
        candidates,
        tieOrder,
        original,
        effective,
        scores,
        selected,
        unforcedWinner:
          rankSpeakerAuction(candidates, original, manifest.bias, tieOrder)[0]?.playerId ?? null,
      });
      await save();
      if (selected) {
        const player = state.players.find((item) => item.id === selected)!;
        const speech = await providers.call({
          kind: "speech",
          playerId: selected,
          gameId: run.id,
          model: manifest.model,
          reasoningEffort: manifest.effort,
          schemaName: "study_speech",
          schema: SpeechSchema,
          maxOutputTokens: null,
          preparedPrompt: playerPrompt(
            player,
            state.players,
            scenario,
            state.speeches,
            "speech",
            manifest.turns,
            manifest.journalPolicy,
          ),
        });
        state.speeches.push({ turn, playerId: selected, text: speech.text });
        await save();
        await reflect(state.players, turn, "public speech");
      }
      console.log(JSON.stringify({ kind: "turn", run: run.id, turn, selected }));
    }
    state.answers = await judge();
    state.status = "complete";
  } catch (error) {
    state.status = "failed";
    state.error = error instanceof Error ? error.message : String(error);
  }
  state.endedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({ kind: "finished", run: run.id, status: state.status, error: state.error }),
  );
  return state;
}
