PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`created_by` text NOT NULL,
	`slug` text NOT NULL,
	`do_name` text NOT NULL,
	`did` text,
	`mirror_targets` text,
	`visibility` text NOT NULL,
	`encrypted` integer DEFAULT 0 NOT NULL,
	`description` text,
	`website` text,
	`forked_from_id` text,
	`is_gist` integer DEFAULT 0 NOT NULL,
	`backend` text DEFAULT 'do' NOT NULL,
	`artifacts_name` text,
	`artifacts_remote` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_repositories_visibility" CHECK("visibility" IN ('public','private','internal'))
);
--> statement-breakpoint
INSERT INTO `__new_repositories`("id", "namespace_id", "created_by", "slug", "do_name", "did", "mirror_targets", "visibility", "encrypted", "description", "website", "forked_from_id", "is_gist", "backend", "artifacts_name", "artifacts_remote", "created_at", "updated_at") SELECT "id", "namespace_id", "created_by", "slug", "do_name", "did", "mirror_targets", "visibility", "encrypted", "description", "website", "forked_from_id", "is_gist", "backend", "artifacts_name", "artifacts_remote", "created_at", "updated_at" FROM `repositories`;--> statement-breakpoint
DROP TABLE `repositories`;--> statement-breakpoint
ALTER TABLE `__new_repositories` RENAME TO `repositories`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_repositories_namespace_slug` ON `repositories` (`namespace_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_repositories_do_name` ON `repositories` (`do_name`);--> statement-breakpoint
CREATE INDEX `idx_repositories_forked_from` ON `repositories` (`forked_from_id`);--> statement-breakpoint
CREATE INDEX `idx_repositories_namespace_updated` ON `repositories` (`namespace_id`,`updated_at`,`slug`);