CREATE TABLE `eval_corpus` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`intent_id` text,
	`engine` text NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`outcome` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_eval_corpus_repo` ON `eval_corpus` (`repository_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_eval_corpus_intent` ON `eval_corpus` (`intent_id`);