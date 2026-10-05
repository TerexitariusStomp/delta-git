CREATE TABLE `catalog_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`kind` text DEFAULT 'service' NOT NULL,
	`repository_id` text,
	`owner` text,
	`description` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_catalog_ns_ident` ON `catalog_entities` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_catalog_ns` ON `catalog_entities` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `dashboards` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`layout` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dash_ns_ident` ON `dashboards` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_dash_ns` ON `dashboards` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `database_records` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`engine` text DEFAULT 'postgres' NOT NULL,
	`host` text,
	`status` text DEFAULT 'provisioned' NOT NULL,
	`migrations` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dbrec_ns_ident` ON `database_records` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_dbrec_ns` ON `database_records` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `dev_environments` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`repository_id` text,
	`status` text DEFAULT 'stopped' NOT NULL,
	`machine_type` text DEFAULT 'standard' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_devenv_ns_ident` ON `dev_environments` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_devenv_ns` ON `dev_environments` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `security_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`repository_id` text,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`findings` integer DEFAULT 0 NOT NULL,
	`report` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_sectests_ns` ON `security_tests` (`namespace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sectests_repo` ON `security_tests` (`repository_id`);--> statement-breakpoint
CREATE TABLE `supply_chain_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`kind` text NOT NULL,
	`commit_oid` text,
	`document` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_supply_ns` ON `supply_chain_docs` (`namespace_id`);--> statement-breakpoint
CREATE INDEX `idx_supply_repo` ON `supply_chain_docs` (`repository_id`);