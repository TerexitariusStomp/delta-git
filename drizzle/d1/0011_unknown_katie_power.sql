ALTER TABLE `namespace_memberships` ADD `role` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE `service_accounts` ADD `role` text DEFAULT 'developer' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_groups` ADD `role` text DEFAULT 'viewer' NOT NULL;