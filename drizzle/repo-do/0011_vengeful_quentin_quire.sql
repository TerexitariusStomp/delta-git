CREATE TABLE `project_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`column_id` text NOT NULL,
	`kind` text NOT NULL,
	`issue_number` integer,
	`note` text,
	`position` integer NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`column_id`) REFERENCES `project_columns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_project_cards_kind" CHECK("kind" IN ('issue','note'))
);
--> statement-breakpoint
CREATE INDEX `idx_project_cards_column` ON `project_cards` (`column_id`,`position`);--> statement-breakpoint
CREATE TABLE `project_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_project_columns_project` ON `project_columns` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`state` text DEFAULT 'open' NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chk_projects_state" CHECK("state" IN ('open','closed')),
	CONSTRAINT "chk_projects_number" CHECK("number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_projects_number` ON `projects` (`number`);--> statement-breakpoint
CREATE INDEX `idx_projects_state` ON `projects` (`state`,"number" desc);