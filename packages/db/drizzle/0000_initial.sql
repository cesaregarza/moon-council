CREATE TABLE IF NOT EXISTS `roles` (
  `id` text NOT NULL,
  `version` integer NOT NULL,
  `name` text NOT NULL,
  `alignment` text NOT NULL,
  `definition_json` text NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY(`id`, `version`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `games` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `status` text NOT NULL,
  `config_json` text NOT NULL,
  `experiment_id` text,
  `outcome_json` text,
  `error` text,
  `speed_ms` integer NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `games_status_idx` ON `games` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `games_experiment_idx` ON `games` (`experiment_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `events` (
  `row_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `id` text NOT NULL,
  `game_id` text NOT NULL,
  `sequence` integer NOT NULL,
  `type` text NOT NULL,
  `phase` text NOT NULL,
  `day` integer NOT NULL,
  `visibility` text NOT NULL,
  `audience_json` text NOT NULL,
  `payload_json` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `events_id_idx` ON `events` (`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `events_game_sequence_idx` ON `events` (`game_id`, `sequence`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `events_game_idx` ON `events` (`game_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `journals` (
  `game_id` text NOT NULL,
  `player_id` text NOT NULL,
  `journal_json` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY(`game_id`, `player_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `target_id` text NOT NULL,
  `status` text NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `error` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `jobs_queue_idx` ON `jobs` (`status`, `created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `experiments` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `status` text NOT NULL,
  `spec_json` text NOT NULL,
  `summary_json` text,
  `error` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `experiments_status_idx` ON `experiments` (`status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `usage` (
  `row_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `game_id` text NOT NULL,
  `player_id` text,
  `provider` text NOT NULL,
  `model` text NOT NULL,
  `input_tokens` integer NOT NULL,
  `output_tokens` integer NOT NULL,
  `total_tokens` integer NOT NULL,
  `estimated_cost_micros` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `usage_game_idx` ON `usage` (`game_id`);

