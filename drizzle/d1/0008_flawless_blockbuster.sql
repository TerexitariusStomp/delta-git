ALTER TABLE `agents` ADD `family` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `model` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `family_verified` integer DEFAULT 0 NOT NULL;