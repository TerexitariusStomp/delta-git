CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`path` text NOT NULL,
	`r2_key` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`content_type` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_artifacts_repo_nvp` ON `artifacts` (`repository_id`,`name`,`version`,`path`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_repo_name` ON `artifacts` (`repository_id`,`name`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'pre_production' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_environments_ns_ident` ON `environments` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_environments_ns` ON `environments` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_user_created` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_notifications_user_unread` ON `notifications` (`user_id`,`read_at`);