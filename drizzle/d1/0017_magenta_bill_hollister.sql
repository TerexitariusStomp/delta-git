CREATE TABLE `feature_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`state` integer DEFAULT 0 NOT NULL,
	`targets` text DEFAULT '[]' NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_flags_ns_ident` ON `feature_flags` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_flags_ns` ON `feature_flags` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`subject` text NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_overrides_ns` ON `overrides` (`namespace_id`);--> statement-breakpoint
ALTER TABLE `gitops_targets` ADD `last_sync_oid` text;