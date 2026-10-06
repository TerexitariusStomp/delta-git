CREATE TABLE `release_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_release_assets_size" CHECK("size" >= 0),
	CONSTRAINT "chk_release_assets_downloads" CHECK("download_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_release_assets_name` ON `release_assets` (`release_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_release_assets_release` ON `release_assets` (`release_id`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`tag_name` text NOT NULL,
	`target_oid` text,
	`name` text NOT NULL,
	`body` text,
	`draft` integer DEFAULT 0 NOT NULL,
	`prerelease` integer DEFAULT 0 NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chk_releases_draft" CHECK("draft" IN (0,1)),
	CONSTRAINT "chk_releases_prerelease" CHECK("prerelease" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_releases_tag` ON `releases` (`tag_name`);--> statement-breakpoint
CREATE INDEX `idx_releases_created` ON `releases` ("created_at" desc);