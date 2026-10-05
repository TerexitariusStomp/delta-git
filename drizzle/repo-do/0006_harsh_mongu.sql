CREATE TABLE `match_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`entrant_did` text NOT NULL,
	`workspace_name` text NOT NULL,
	`head_oid` text,
	`push_count` integer DEFAULT 0 NOT NULL,
	`first_push_at` integer,
	`last_push_at` integer,
	`auto_score` integer DEFAULT 0 NOT NULL,
	`vote_count` integer DEFAULT 0 NOT NULL,
	`won` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_match_entries_match` ON `match_entries` (`match_id`);--> statement-breakpoint
CREATE INDEX `idx_match_entries_did` ON `match_entries` (`entrant_did`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_match_entries_match_did` ON `match_entries` (`match_id`,`entrant_did`);--> statement-breakpoint
CREATE TABLE `match_votes` (
	`match_id` text NOT NULL,
	`voter_did` text NOT NULL,
	`entry_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`match_id`, `voter_did`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_match_votes_entry` ON `match_votes` (`entry_id`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`do_name` text NOT NULL,
	`title` text NOT NULL,
	`spec` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`window_minutes` integer NOT NULL,
	`judge_minutes` integer NOT NULL,
	`max_entrants` integer NOT NULL,
	`prize_rep` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ends_at` integer,
	`judge_ends_at` integer,
	`winner_entry_id` text,
	CONSTRAINT "chk_matches_status" CHECK("status" IN ('open','building','judging','resolved','expired'))
);
--> statement-breakpoint
CREATE INDEX `idx_matches_status` ON `matches` (`status`,`ends_at`);--> statement-breakpoint
CREATE TABLE `processed_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`artifacts_name` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`owner_did` text NOT NULL,
	`work_intent_id` text,
	`match_id` text,
	`head_oid` text,
	`push_count` integer DEFAULT 0 NOT NULL,
	`first_push_at` integer,
	`last_push_at` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_workspaces_kind" CHECK("kind" IN ('task','arena')),
	CONSTRAINT "chk_workspaces_status" CHECK("status" IN ('open','merged','expired','deleted'))
);
--> statement-breakpoint
CREATE INDEX `idx_workspaces_match` ON `workspaces` (`match_id`);--> statement-breakpoint
CREATE INDEX `idx_workspaces_status` ON `workspaces` (`status`);--> statement-breakpoint
ALTER TABLE `work_intents` ADD `result` text;