CREATE TABLE agent_records (
  game_id TEXT NOT NULL REFERENCES games(id),
  record_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY(game_id, record_key)
);
--> statement-breakpoint
CREATE TABLE provider_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id),
  decision_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  status TEXT NOT NULL,
  value_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX attempts_game ON provider_attempts(game_id, decision_id);
--> statement-breakpoint
CREATE TABLE experiment_runs (
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  run_index INTEGER NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id),
  PRIMARY KEY(experiment_id, run_index)
);
--> statement-breakpoint
CREATE TABLE runner_leases (
  game_id TEXT PRIMARY KEY NOT NULL REFERENCES games(id),
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
