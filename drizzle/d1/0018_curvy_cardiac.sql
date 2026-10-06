CREATE TABLE `follows` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`namespace_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_follows_user_namespace` ON `follows` (`user_id`,`namespace_id`);--> statement-breakpoint
CREATE INDEX `idx_follows_namespace` ON `follows` (`namespace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `repo_topics` (
	`repository_id` text NOT NULL,
	`topic` text NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_repo_topics_topic" CHECK("topic" GLOB '[a-z0-9][a-z0-9-]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_repo_topics_repo_topic` ON `repo_topics` (`repository_id`,`topic`);--> statement-breakpoint
CREATE INDEX `idx_repo_topics_topic` ON `repo_topics` (`topic`,`repository_id`);--> statement-breakpoint
CREATE TABLE `stars` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_stars_user_repo` ON `stars` (`user_id`,`repository_id`);--> statement-breakpoint
CREATE INDEX `idx_stars_repo` ON `stars` (`repository_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `repositories` ADD `website` text;