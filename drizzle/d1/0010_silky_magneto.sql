CREATE TABLE `casbin_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ptype` text NOT NULL,
	`v0` text,
	`v1` text,
	`v2` text,
	`v3` text,
	`v4` text,
	`v5` text
);
--> statement-breakpoint
CREATE INDEX `idx_casbin_rules_ptype` ON `casbin_rules` (`ptype`);--> statement-breakpoint
CREATE INDEX `idx_casbin_rules_v1` ON `casbin_rules` (`v1`);--> statement-breakpoint
CREATE TABLE `resource_group_items` (
	`group_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_ref` text NOT NULL,
	PRIMARY KEY(`group_id`, `resource_type`, `resource_ref`),
	FOREIGN KEY (`group_id`) REFERENCES `resource_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `resource_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_resource_groups_ns` ON `resource_groups` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE TABLE `service_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_service_accounts_ns` ON `service_accounts` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE TABLE `user_group_members` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `user_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_group_members_user` ON `user_group_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_groups_ns` ON `user_groups` (`namespace_id`,`identifier`);