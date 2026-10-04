PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_work_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`created_by` text NOT NULL,
	`kind` text DEFAULT 'work' NOT NULL,
	`source_uri` text,
	`status` text NOT NULL,
	`claimed_by` text,
	`claim_expires_at` integer,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT "chk_work_intents_status" CHECK("status" IN ('open','claimed','closed','verified')),
	CONSTRAINT "chk_work_intents_kind" CHECK("kind" IN ('work','idea','issue','verify'))
);
--> statement-breakpoint
INSERT INTO `__new_work_intents`("id", "title", "body", "created_by", "kind", "source_uri", "status", "claimed_by", "claim_expires_at", "created_at", "closed_at") SELECT "id", "title", "body", "created_by", "kind", "source_uri", "status", "claimed_by", "claim_expires_at", "created_at", "closed_at" FROM `work_intents`;--> statement-breakpoint
DROP TABLE `work_intents`;--> statement-breakpoint
ALTER TABLE `__new_work_intents` RENAME TO `work_intents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_work_intents_status` ON `work_intents` (`status`);--> statement-breakpoint
CREATE INDEX `idx_work_intents_kind_status` ON `work_intents` (`kind`,`status`);