CREATE TABLE `commit_status` (
	`sha` text NOT NULL,
	`context` text NOT NULL,
	`state` text NOT NULL,
	`description` text,
	`target_url` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`sha`, `context`),
	CONSTRAINT "chk_commit_status_state" CHECK("state" IN ('pending','success','failure','error'))
);
--> statement-breakpoint
CREATE TABLE `merge_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`target_ref` text NOT NULL,
	`base_oid` text NOT NULL,
	`delta_ref` text NOT NULL,
	`delta_oid` text NOT NULL,
	`actor` text NOT NULL,
	`status` text NOT NULL,
	`conflicts` text,
	`result_oid` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`resolved_at` integer,
	CONSTRAINT "chk_merge_intents_status" CHECK("status" IN ('open','merging','adjudicating','merged','conflict','expired','rejected'))
);
--> statement-breakpoint
CREATE INDEX `idx_merge_intents_status_expiry` ON `merge_intents` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_merge_intents_target_status` ON `merge_intents` (`target_ref`,`status`);--> statement-breakpoint
CREATE TABLE `merge_votes` (
	`intent_id` text NOT NULL,
	`seat` integer NOT NULL,
	`voter_did` text NOT NULL,
	`resolution_digest` text NOT NULL,
	`rationale` text,
	`signature` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`intent_id`, `seat`),
	CONSTRAINT "chk_merge_votes_seat" CHECK("seat" >= 1)
);
--> statement-breakpoint
CREATE INDEX `idx_merge_votes_intent_digest` ON `merge_votes` (`intent_id`,`resolution_digest`);--> statement-breakpoint
CREATE TABLE `op_log` (
	`seq` integer PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`prev_hash` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_op_log_seq" CHECK("seq" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_op_log_kind_created` ON `op_log` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `repo_secrets` (
	`name` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_subs` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`secret` text,
	`created_by` text NOT NULL,
	`active` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_webhook_subs_active" CHECK("active" IN (0,1))
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_subs_active` ON `webhook_subs` (`active`);--> statement-breakpoint
CREATE TABLE `work_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`created_by` text NOT NULL,
	`status` text NOT NULL,
	`claimed_by` text,
	`claim_expires_at` integer,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT "chk_work_intents_status" CHECK("status" IN ('open','claimed','closed'))
);
--> statement-breakpoint
CREATE INDEX `idx_work_intents_status` ON `work_intents` (`status`);