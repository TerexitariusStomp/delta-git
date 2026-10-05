CREATE TABLE `epoch_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`epoch_id` text NOT NULL,
	`from_did` text NOT NULL,
	`to_did` text NOT NULL,
	`amount` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`epoch_id`) REFERENCES `epochs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_epoch_alloc_amount" CHECK("amount" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_epoch_allocations_epoch` ON `epoch_allocations` (`epoch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_epoch_alloc` ON `epoch_allocations` (`epoch_id`,`from_did`,`to_did`);--> statement-breakpoint
CREATE TABLE `epochs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`budget` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT "chk_epochs_status" CHECK("status" IN ('open','closed'))
);
--> statement-breakpoint
CREATE INDEX `idx_epochs_status` ON `epochs` (`status`,`ends_at`);--> statement-breakpoint
CREATE TABLE `vouches` (
	`id` text PRIMARY KEY NOT NULL,
	`from_did` text NOT NULL,
	`to_did` text NOT NULL,
	`kind` text NOT NULL,
	`message` text,
	`signature` text,
	`rep_delta` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_vouches_kind" CHECK("kind" IN ('praise','vouch','flag'))
);
--> statement-breakpoint
CREATE INDEX `idx_vouches_to` ON `vouches` (`to_did`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_vouches_from` ON `vouches` (`from_did`,`created_at`);--> statement-breakpoint
ALTER TABLE `identities` ADD `rep` integer DEFAULT 0 NOT NULL;