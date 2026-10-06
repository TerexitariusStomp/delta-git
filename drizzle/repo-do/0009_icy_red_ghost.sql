CREATE TABLE `discussion_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`discussion_id` text NOT NULL,
	`body` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_discussion_comments_discussion` ON `discussion_comments` (`discussion_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `discussions` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`category` text DEFAULT 'general' NOT NULL,
	`author` text NOT NULL,
	`answer_comment_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chk_discussions_category" CHECK("category" IN ('general','announcements','ideas','q-a','show-and-tell','polls')),
	CONSTRAINT "chk_discussions_number" CHECK("number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_discussions_number` ON `discussions` (`number`);--> statement-breakpoint
CREATE INDEX `idx_discussions_category` ON `discussions` (`category`,"number" desc);--> statement-breakpoint
CREATE INDEX `idx_discussions_created` ON `discussions` ("created_at" desc);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_reactions` (
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reaction` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`target_type`, `target_id`, `reaction`, `actor`),
	CONSTRAINT "chk_reactions_type" CHECK("target_type" IN ('issue','issue_comment','merge_intent','work_intent','discussion','discussion_comment')),
	CONSTRAINT "chk_reactions_kind" CHECK("reaction" IN ('+1','-1','laugh','hooray','confused','heart','rocket','eyes'))
);
--> statement-breakpoint
INSERT INTO `__new_reactions`("target_type", "target_id", "reaction", "actor", "created_at") SELECT "target_type", "target_id", "reaction", "actor", "created_at" FROM `reactions`;--> statement-breakpoint
DROP TABLE `reactions`;--> statement-breakpoint
ALTER TABLE `__new_reactions` RENAME TO `reactions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_reactions_target` ON `reactions` (`target_type`,`target_id`);