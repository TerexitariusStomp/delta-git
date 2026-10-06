CREATE TABLE `repo_watchers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_watchers_user_repo` ON `repo_watchers` (`user_id`,`repository_id`);--> statement-breakpoint
CREATE INDEX `idx_watchers_repo` ON `repo_watchers` (`repository_id`,`created_at`);