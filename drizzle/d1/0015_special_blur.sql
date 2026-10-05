CREATE TABLE `certificates` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`domain` text NOT NULL,
	`issuer` text,
	`expires_at` integer NOT NULL,
	`auto_renew` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_certs_ns_domain` ON `certificates` (`namespace_id`,`domain`);--> statement-breakpoint
CREATE INDEX `idx_certs_expiry` ON `certificates` (`expires_at`);--> statement-breakpoint
CREATE TABLE `chaos_experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`repository_id` text,
	`kind` text NOT NULL,
	`spec` text DEFAULT '{}' NOT NULL,
	`last_run_at` integer,
	`last_outcome` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_chaos_ns_ident` ON `chaos_experiments` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_chaos_ns` ON `chaos_experiments` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `cost_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`provider` text NOT NULL,
	`service` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_costs_ns` ON `cost_snapshots` (`namespace_id`,`period_start`);--> statement-breakpoint
CREATE TABLE `downtimes` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`monitor_id` text,
	`reason` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_downtimes_ns` ON `downtimes` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `incident_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`body` text NOT NULL,
	`status` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_iupdates_incident` ON `incident_updates` (`incident_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`title` text NOT NULL,
	`severity` text DEFAULT 'sev3' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`summary` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_incidents_ns` ON `incidents` (`namespace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `monitor_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer,
	`status_code` integer,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mchecks_monitor` ON `monitor_checks` (`monitor_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`url` text NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`expected_status` integer DEFAULT 200 NOT NULL,
	`interval_sec` integer DEFAULT 300 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_status` text,
	`last_latency_ms` integer,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_monitors_ns_ident` ON `monitors` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_monitors_ns` ON `monitors` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `slos` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`identifier` text NOT NULL,
	`monitor_id` text,
	`target_pct` integer NOT NULL,
	`window_days` integer DEFAULT 30 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_slos_ns_ident` ON `slos` (`namespace_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_slos_ns` ON `slos` (`namespace_id`);