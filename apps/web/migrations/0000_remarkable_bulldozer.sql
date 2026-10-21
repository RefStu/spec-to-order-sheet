CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`topic` text NOT NULL,
	`result` text,
	`draft` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
