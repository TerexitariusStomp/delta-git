CREATE TABLE `arena_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`do_name` text NOT NULL,
	`owner_slug` text NOT NULL,
	`repo_slug` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'building' NOT NULL,
	`entry_count` integer DEFAULT 0 NOT NULL,
	`ends_at` integer,
	`judge_ends_at` integer,
	`winner_entry_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_arena_matches_status` ON `arena_matches` (`status`,`ends_at`);--> statement-breakpoint
CREATE INDEX `idx_arena_matches_repo` ON `arena_matches` (`repository_id`);