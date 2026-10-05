CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`type` text NOT NULL,
	`sealed_handle` text,
	`endpoint` text,
	`description` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_connectors_ns_ident` ON `connectors` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_connectors_ns` ON `connectors` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `delegate_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`last_seen_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_delegates_ns_ident` ON `delegate_agents` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_delegates_ns` ON `delegate_agents` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `external_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`repository_id` text,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_tickets_ns` ON `external_tickets` (`namespace_id`);--> statement-breakpoint
CREATE INDEX `idx_tickets_repo` ON `external_tickets` (`repository_id`);--> statement-breakpoint
CREATE TABLE `file_store` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`name` text NOT NULL,
	`r2_key` text NOT NULL,
	`size` integer NOT NULL,
	`content_type` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_files_ns_name` ON `file_store` (`namespace_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_files_ns` ON `file_store` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `freeze_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`schedule` text NOT NULL,
	`applies_to` text DEFAULT 'all' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_freeze_ns_ident` ON `freeze_windows` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_freeze_ns` ON `freeze_windows` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `gitops_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`repository_id` text NOT NULL,
	`branch` text DEFAULT 'main' NOT NULL,
	`target_environment` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_sync_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_gitops_ns_ident` ON `gitops_targets` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_gitops_repo` ON `gitops_targets` (`repository_id`);--> statement-breakpoint
CREATE TABLE `iac_states` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`name` text NOT NULL,
	`r2_key` text,
	`version` integer DEFAULT 0 NOT NULL,
	`lock_id` text,
	`lock_info` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_iac_ns_name` ON `iac_states` (`namespace_id`,`name`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`document` text NOT NULL,
	`applies_to` text DEFAULT 'all' NOT NULL,
	`enforcement` text DEFAULT 'warn' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_policies_ns_ident` ON `policies` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_policies_ns` ON `policies` (`namespace_id`);