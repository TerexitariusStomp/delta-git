CREATE TABLE `namespace_did_members` (
	`namespace_id` text NOT NULL,
	`did` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`namespace_id`, `did`),
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_namespace_did_members_did` ON `namespace_did_members` (`did`);--> statement-breakpoint
CREATE TABLE `did_sessions` (
	`jti` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`dpop_jkt` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`did`) REFERENCES `identities`(`did`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_did_sessions_did` ON `did_sessions` (`did`);--> statement-breakpoint
CREATE TABLE `identities` (
	`did` text PRIMARY KEY NOT NULL,
	`handle` text,
	`device_keys` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_identities_handle` ON `identities` (`handle`);--> statement-breakpoint
ALTER TABLE `agents` ADD `owner_did` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `kind` text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE `namespaces` ADD `owner_did` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `did` text;