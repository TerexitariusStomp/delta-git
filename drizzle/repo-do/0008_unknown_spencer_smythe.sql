CREATE TABLE `issue_assignees` (
	`issue_id` text NOT NULL,
	`assignee` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `assignee`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_issue_assignees_user` ON `issue_assignees` (`assignee`);--> statement-breakpoint
CREATE TABLE `issue_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`body` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_issue_comments_issue` ON `issue_comments` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `issue_labels` (
	`issue_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`issue_id`, `label_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_issue_labels_label` ON `issue_labels` (`label_id`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`state` text DEFAULT 'open' NOT NULL,
	`state_reason` text,
	`author` text NOT NULL,
	`work_intent_id` text,
	`milestone_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	`closed_by` text,
	CONSTRAINT "chk_issues_state" CHECK("state" IN ('open','closed')),
	CONSTRAINT "chk_issues_state_reason" CHECK("state_reason" IS NULL OR "state_reason" IN ('completed','not_planned','reopened')),
	CONSTRAINT "chk_issues_number" CHECK("number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_issues_number` ON `issues` (`number`);--> statement-breakpoint
CREATE INDEX `idx_issues_state_number` ON `issues` (`state`,"number" desc);--> statement-breakpoint
CREATE INDEX `idx_issues_milestone` ON `issues` (`milestone_id`);--> statement-breakpoint
CREATE INDEX `idx_issues_work_intent` ON `issues` (`work_intent_id`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`description` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_labels_name` ON `labels` (`name`);--> statement-breakpoint
CREATE TABLE `milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`state` text DEFAULT 'open' NOT NULL,
	`due_on` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT "chk_milestones_state" CHECK("state" IN ('open','closed')),
	CONSTRAINT "chk_milestones_number" CHECK("number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_milestones_number` ON `milestones` (`number`);--> statement-breakpoint
CREATE INDEX `idx_milestones_state` ON `milestones` (`state`);--> statement-breakpoint
CREATE TABLE `reactions` (
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reaction` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`target_type`, `target_id`, `reaction`, `actor`),
	CONSTRAINT "chk_reactions_type" CHECK("target_type" IN ('issue','issue_comment','merge_intent','work_intent')),
	CONSTRAINT "chk_reactions_kind" CHECK("reaction" IN ('+1','-1','laugh','hooray','confused','heart','rocket','eyes'))
);
--> statement-breakpoint
CREATE INDEX `idx_reactions_target` ON `reactions` (`target_type`,`target_id`);