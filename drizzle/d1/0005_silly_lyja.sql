ALTER TABLE `repositories` ADD `backend` text DEFAULT 'do' NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `artifacts_name` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `artifacts_remote` text;