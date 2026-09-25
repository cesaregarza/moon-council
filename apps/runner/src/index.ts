import { randomUUID } from "node:crypto";
import { DecisionStore, LabRepository, openDatabase } from "@werewolf/db";
import { reduceGame, STARTER_ROLES } from "@werewolf/engine";
import { loadProviderEnvironment, createDecisionProvider, resolveDefaultModel, selectedProviderKind } from "@werewolf/llm";
import { runExperiment, V2GameOrchestrator, recoverStaleWork } from "@werewolf/simulator";

loadProviderEnvironment();

const connection = openDatabase();
const repository = new LabRepository(connection);
repository.seedRoles(STARTER_ROLES);
const providerKind = selectedProviderKind();
const defaultModel = resolveDefaultModel(providerKind);
const provider = createDecisionProvider(providerKind);
const v2Orchestrator = new V2GameOrchestrator(repository, provider);
const decisionStore = new DecisionStore(repository);
const owner = randomUUID();
let stopping = false;
let activeExperimentId: string | undefined;

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));


async function processNextJob(): Promise<boolean> {
  const job = repository.claimJob();
  if (!job) return false;
  let leasedGameId: string | undefined;
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  try {
    if (job.kind === "experiment") {
      const experiment = repository.getExperiment(job.targetId);
      if (experiment?.spec.schemaVersion === "experiment_v2" && Object.values(experiment.spec.baseConfig.modelSettings).some(settings => settings.provider !== providerKind)) {
        const reason = `Frozen experiment provider differs from runner (${providerKind}); restore its original provider.`;
        repository.updateExperiment(job.targetId, { status: "paused", error: reason });
        repository.finishJob(job.id, reason);
        return true;
      }
      activeExperimentId=job.targetId;
      await runExperiment(repository, provider, job.targetId, defaultModel);
      repository.finishJob(job.id);
      return true;
    }

    const before = repository.getGame(job.targetId);
    if (!before) throw new Error(`Unknown game ${job.targetId}`);
    if(before.config.schemaVersion !== "game_config_v2"){repository.finishJob(job.id,"legacy replay-only game cannot resume");return true;}
    if (!decisionStore.acquire(before.id, owner)) {
      repository.finishJob(job.id, "runner lease unavailable; another worker owns this game");
      return true;
    }
    leasedGameId = before.id;
    if (Object.values(before.config.modelSettings).some(settings => settings.provider !== providerKind)) {
      const state = reduceGame(before.id, repository.listEvents(before.id));
      const reason = `Frozen game provider differs from runner (${providerKind}); create a new game or restore its original provider.`;
      repository.appendEvent(before.id, { type: "game.paused", phase: state.phase, day: state.day, visibility: "public", payload: { reason } });
      repository.updateGame(before.id, { status: "paused", error: reason });
      repository.finishJob(job.id, reason);
      return true;
    }
    renewTimer = setInterval(() => decisionStore.renew(before.id, owner), 10_000);
    const wasStepping = before.status === "stepping";
    await v2Orchestrator.runGameStep(job.targetId);
    const after = repository.getGame(job.targetId);
    repository.finishJob(job.id);
    if (!after) return true;

    if (wasStepping && !["completed", "budget_exhausted", "aborted", "failed", "paused"].includes(after.status)) {
      const events = repository.listEvents(after.id);
      const state = reduceGame(after.id, events);
      repository.appendEvent(after.id, {
        type: "game.paused",
        phase: state.phase,
        day: state.day,
        visibility: "public",
        payload: { reason: "single-step complete" },
      });
      repository.updateGame(after.id, { status: "paused" });
    } else if (after.status === "running" && (!after.experimentId || repository.getExperiment(after.experimentId)?.status !== "paused")) {
      if (after.speedMs > 0) await delay(after.speedMs);
      repository.enqueueJob("game", after.id);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    repository.finishJob(job.id, message);
    if (job.kind === "game") repository.updateGame(job.targetId, { status: "failed", error: message });
    else repository.updateExperiment(job.targetId, { status: "failed", error: message });
    return true;
  } finally {
    if(job.kind === "experiment") activeExperimentId=undefined;
    if (renewTimer) clearInterval(renewTimer);
    if (leasedGameId) decisionStore.release(leasedGameId, owner);
  }
}

async function run(): Promise<void> {
  while (!stopping) {
    recoverStaleWork(repository);
    const worked = await processNextJob();
    if (!worked) await delay(250);
  }
}

function shutdown(): void {
  stopping = true;
  if(activeExperimentId) repository.updateExperiment(activeExperimentId,{status:"paused",error:"runner shutting down"});
  for(const game of repository.listGames(100)) {
    const lease=connection.sqlite.prepare("SELECT owner FROM runner_leases WHERE game_id=?").get(game.id) as {owner:string}|undefined;
    if((lease?.owner === owner || Boolean(activeExperimentId && game.experimentId === activeExperimentId)) && ["running","stepping"].includes(game.status)) {
      const state=reduceGame(game.id,repository.listEvents(game.id));
      repository.appendEvent(game.id,{type:"game.paused",phase:state.phase,day:state.day,visibility:"public",payload:{reason:"runner shutting down"}});
      repository.updateGame(game.id,{status:"paused",error:"runner shutting down"});
    }
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Werewolf runner ready · provider=${providerKind} · model=${defaultModel} · db=${connection.path}`);
await run();
connection.close();
