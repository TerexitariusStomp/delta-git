CREATE TABLE `agents` (
	`did` text PRIMARY KEY NOT NULL,
	`pubkey` text NOT NULL,
	`label` text,
	`rep` integer DEFAULT 0 NOT NULL,
	`banned` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	CONSTRAINT "chk_agents_banned" CHECK("banned" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agents_pubkey` ON `agents` (`pubkey`);--> statement-breakpoint
CREATE INDEX `idx_agents_rep` ON `agents` (`rep`);