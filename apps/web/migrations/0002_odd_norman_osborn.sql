DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD `case_id` text;--> statement-breakpoint
CREATE INDEX `ai_jobs_case_idx` ON `ai_jobs` (`case_id`,`queued_at`);