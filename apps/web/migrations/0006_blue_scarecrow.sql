CREATE TABLE `order_sheet_line_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`order_sheet_line_id` text NOT NULL,
	`file_id` text NOT NULL,
	`revision_request_id` text,
	`sort_key` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`order_sheet_line_id`) REFERENCES `order_sheet_lines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_sheet_line_photos_file_idx` ON `order_sheet_line_photos` (`order_sheet_line_id`,`file_id`);--> statement-breakpoint
CREATE INDEX `order_sheet_line_photos_line_idx` ON `order_sheet_line_photos` (`order_sheet_line_id`,`sort_key`);--> statement-breakpoint
CREATE INDEX `order_sheet_line_photos_file_id_idx` ON `order_sheet_line_photos` (`file_id`);