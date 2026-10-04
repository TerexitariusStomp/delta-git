DROP TABLE `namespace_did_members`;--> statement-breakpoint
ALTER TABLE `identities` ADD `user_id` text NOT NULL REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `repositories` ADD `mirror_targets` text;