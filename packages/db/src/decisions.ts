import { randomUUID } from "node:crypto";
import { emptyJournalV2, type DecisionOpportunityV1, type PrivateJournalV2, type UsageV2, unknownUsage } from "@werewolf/contracts";
import { reduceGame, type EngineEventInput } from "@werewolf/engine";
import type { LabRepository } from "./repository";

export interface ProviderAttemptRecord {
  id: string; gameId: string; decisionId: string; playerId: string; recovery: number;
  status: "started" | "received" | "valid" | "invalid" | "unknown";
  optional: boolean; startedAt: string; endedAt: string | null; latencyMs: number | null;
  model: string; provider: string; reasoningEffort: string; outputLimitEnforced: boolean;
  request: { instructions: string; publicInput?: string; privateInput?: string; sharedInput?: string; input: string; schema: unknown; layerHashes?: Record<string,string|null> };
  usage: UsageV2; error: string | null; response: string | null;
  promptVersion: string; schemaVersion: string;
}

/** SQLite adapter for V2 checkpoints. Engine events remain the replay authority. */
export class DecisionStore {
  constructor(readonly repository: LabRepository) {}
  atomic<T>(fn: () => T): T { return this.repository.connection.sqlite.transaction(fn).immediate(); }
  get<T>(gameId: string, key: string): T | undefined {
    const row = this.repository.connection.sqlite.prepare("SELECT value_json FROM agent_records WHERE game_id=? AND record_key=?").get(gameId, key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : undefined;
  }
  put(gameId: string, key: string, value: unknown): void {
    this.repository.connection.sqlite.prepare("INSERT INTO agent_records(game_id,record_key,value_json) VALUES(?,?,?) ON CONFLICT(game_id,record_key) DO UPDATE SET value_json=excluded.value_json").run(gameId, key, JSON.stringify(value));
  }
  activeRuntimeMs(gameId: string): number {
    const started = this.get<number|null>(gameId,"runtimeStartedAt");
    return (this.get<number>(gameId,"runtimeMs") ?? 0)+(started == null ? 0 : Math.max(0,Date.now()-started));
  }
  journal(gameId: string, playerId: string, at = Infinity): PrivateJournalV2 {
    const event = this.repository.listEvents(gameId).findLast(e => e.sequence <= at && e.type === "journal.v2_updated" && e.payload.playerId === playerId);
    return event ? event.payload.journal as PrivateJournalV2 : emptyJournalV2();
  }
  opportunities(gameId: string): DecisionOpportunityV1[] {
    const rows = this.repository.connection.sqlite.prepare("SELECT value_json FROM agent_records WHERE game_id=? AND record_key LIKE 'decision:%' ORDER BY rowid").all(gameId) as { value_json: string }[];
    return rows.map(row => JSON.parse(row.value_json));
  }
  save(opportunity: DecisionOpportunityV1): void { this.put(opportunity.gameId, `decision:${opportunity.id}`, opportunity); }
  beginAttempt(opportunity: Pick<DecisionOpportunityV1,"id"|"gameId"|"playerId"|"phase"|"day"|"recovery">, fields: Pick<ProviderAttemptRecord, "model" | "provider" | "reasoningEffort" | "request" | "optional"> & Partial<Pick<ProviderAttemptRecord,"promptVersion"|"schemaVersion">>): ProviderAttemptRecord {
    return this.atomic(() => {
      const attempt: ProviderAttemptRecord = { ...fields, promptVersion:fields.promptVersion??"player_prompt_v2.2",schemaVersion:fields.schemaVersion??"private_decision_v2.stable",id: randomUUID(), gameId: opportunity.gameId, decisionId: opportunity.id, playerId: opportunity.playerId, recovery: opportunity.recovery, status: "started", startedAt: new Date().toISOString(), endedAt: null, latencyMs: null, outputLimitEnforced: fields.provider !== "codex", usage: unknownUsage(), error: null, response:null };
      this.repository.connection.sqlite.prepare("INSERT INTO provider_attempts(id,game_id,decision_id,player_id,status,value_json) VALUES(?,?,?,?,?,?)").run(attempt.id, attempt.gameId, attempt.decisionId, attempt.playerId, attempt.status, JSON.stringify(attempt));
      this.repository.appendEvent(attempt.gameId, { type: "model.attempt_started", phase: opportunity.phase, day: opportunity.day, visibility: "moderator", payload: { attemptId: attempt.id, decisionId: opportunity.id, playerId: opportunity.playerId, optional: fields.optional } });
      return attempt;
    });
  }
  updateAttempt(attempt: ProviderAttemptRecord): void {
    this.repository.connection.sqlite.prepare("UPDATE provider_attempts SET status=?,value_json=? WHERE id=?").run(attempt.status, JSON.stringify(attempt), attempt.id);
  }
  attempts(gameId: string, decisionId?: string): ProviderAttemptRecord[] {
    const rows = (decisionId
      ? this.repository.connection.sqlite.prepare("SELECT value_json FROM provider_attempts WHERE game_id=? AND decision_id=? ORDER BY rowid").all(gameId, decisionId)
      : this.repository.connection.sqlite.prepare("SELECT value_json FROM provider_attempts WHERE game_id=? ORDER BY rowid").all(gameId)) as { value_json: string }[];
    return rows.map(row => JSON.parse(row.value_json));
  }
  commit(opportunity: DecisionOpportunityV1, journal: PrivateJournalV2, events: EngineEventInput[]): boolean {
    return this.atomic(() => {
      const stored = this.get<DecisionOpportunityV1>(opportunity.gameId, `decision:${opportunity.id}`);
      if (stored?.status === "committed") return false;
      if (stored?.recovery !== opportunity.recovery || stored?.viewId !== opportunity.viewId) throw new Error("stale_decision: execution episode superseded");
      const game = this.repository.getGame(opportunity.gameId)!;
      if (!["running", "stepping"].includes(game.status)) return false;
      const state = reduceGame(game.id, this.repository.listEvents(game.id));
      if (`${state.day}:${state.phase}` !== opportunity.epoch || this.journal(game.id, opportunity.playerId).version !== opportunity.baseJournalVersion) throw new Error("stale_decision");
      this.repository.appendEvents(game.id, events);
      this.repository.appendEvent(game.id, { type: "journal.v2_updated", phase: opportunity.phase, day: opportunity.day, visibility: "player", audienceIds: [opportunity.playerId], payload: { playerId: opportunity.playerId, decisionId: opportunity.id, journal, patch: opportunity.best?.journalPatch ?? [] } });
      this.repository.appendEvent(game.id, { type: "decision.committed", phase: opportunity.phase, day: opportunity.day, visibility: "player", audienceIds: [opportunity.playerId], payload: { playerId: opportunity.playerId, decisionId: opportunity.id, proposal: opportunity.best?.proposal } });
      this.save({ ...opportunity, status: "committed" });
      return true;
    });
  }
  acquire(gameId: string, owner: string): boolean {
    return this.atomic(() => {
      const result = this.repository.connection.sqlite.prepare("INSERT INTO runner_leases(game_id,owner,expires_at) VALUES(?,?,?) ON CONFLICT(game_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE runner_leases.expires_at<? OR runner_leases.owner=excluded.owner").run(gameId, owner, Date.now() + 30_000, Date.now());
      return result.changes === 1;
    });
  }
  renew(gameId: string, owner: string): void { this.repository.connection.sqlite.prepare("UPDATE runner_leases SET expires_at=? WHERE game_id=? AND owner=?").run(Date.now() + 30_000, gameId, owner); }
  release(gameId: string, owner: string): void { this.repository.connection.sqlite.prepare("DELETE FROM runner_leases WHERE game_id=? AND owner=?").run(gameId, owner); }
  runGame(experimentId: string, index: number): string | undefined {
    return (this.repository.connection.sqlite.prepare("SELECT game_id FROM experiment_runs WHERE experiment_id=? AND run_index=?").get(experimentId, index) as { game_id: string } | undefined)?.game_id;
  }
  staleJobs(now=Date.now()): {id:string;kind:"game"|"experiment";target_id:string}[] {
    return this.repository.connection.sqlite.prepare("SELECT j.id,j.kind,j.target_id FROM jobs j WHERE j.status='running' AND j.updated_at<? AND NOT EXISTS (SELECT 1 FROM runner_leases l WHERE l.expires_at>? AND (l.game_id=j.target_id OR (j.kind='experiment' AND l.game_id IN (SELECT id FROM games WHERE experiment_id=j.target_id))))").all(new Date(now-30_000).toISOString(),now) as {id:string;kind:"game"|"experiment";target_id:string}[];
  }
  registerRun(experimentId: string, index: number, gameId: string): void { this.repository.connection.sqlite.prepare("INSERT INTO experiment_runs(experiment_id,run_index,game_id) VALUES(?,?,?)").run(experimentId,index,gameId); }
}
