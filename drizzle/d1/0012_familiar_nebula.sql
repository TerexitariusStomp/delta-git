CREATE TABLE `scan_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`head_oid` text NOT NULL,
	`actor` text NOT NULL,
	`status` text NOT NULL,
	`tools` text NOT NULL,
	`duration_ms` integer,
	`ran_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_scan_runs_repo_head` ON `scan_runs` (`repository_id`,`head_oid`);--> statement-breakpoint
CREATE INDEX `idx_scan_runs_repo_ran` ON `scan_runs` (`repository_id`,`ran_at`);