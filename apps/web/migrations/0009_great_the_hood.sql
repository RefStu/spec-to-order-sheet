PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_order_sheet_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`order_sheet_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`item_id` text,
	`item_code_text` text,
	`customer_item_id` text,
	`customer_item_code_text` text,
	`secondary_code_text` text,
	`photo_file_id` text,
	`description_text` text,
	`material_id` text,
	`plating_id` text,
	`finish_id` text,
	`alloy_note` text,
	`weight_per_piece_mg` integer,
	`ring_size_id` text,
	`size_text` text,
	`quantity` integer,
	`unit_code` text,
	`ship_date` text,
	`remark` text,
	`remark_lang` text DEFAULT 'th' NOT NULL,
	`remark_ja` text,
	`cells_json` text,
	`revision_request_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_sheet_id`) REFERENCES `order_sheets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_order_sheet_lines`("id", "order_sheet_id", "line_no", "item_id", "item_code_text", "customer_item_id", "customer_item_code_text", "secondary_code_text", "photo_file_id", "description_text", "material_id", "plating_id", "finish_id", "alloy_note", "weight_per_piece_mg", "ring_size_id", "size_text", "quantity", "unit_code", "ship_date", "remark", "remark_lang", "remark_ja", "cells_json", "revision_request_id", "created_at", "updated_at") SELECT "id", "order_sheet_id", "line_no", "item_id", "item_code_text", "customer_item_id", "customer_item_code_text", "secondary_code_text", "photo_file_id", "description_text", "material_id", "plating_id", "finish_id", "alloy_note", "weight_per_piece_mg", "ring_size_id", "size_text", "quantity", "unit_code", "ship_date", "remark", "remark_lang", "remark_ja", "cells_json", "revision_request_id", "created_at", "updated_at" FROM `order_sheet_lines`;--> statement-breakpoint
DROP TABLE `order_sheet_lines`;--> statement-breakpoint
ALTER TABLE `__new_order_sheet_lines` RENAME TO `order_sheet_lines`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `order_sheet_lines_no_idx` ON `order_sheet_lines` (`order_sheet_id`,`line_no`);--> statement-breakpoint
CREATE INDEX `order_sheet_lines_item_idx` ON `order_sheet_lines` (`item_id`);--> statement-breakpoint
CREATE INDEX `order_sheet_lines_item_id_idx` ON `order_sheet_lines` (`item_id`);--> statement-breakpoint
CREATE INDEX `order_sheet_lines_customer_item_id_idx` ON `order_sheet_lines` (`customer_item_id`);--> statement-breakpoint
CREATE INDEX `order_sheet_lines_photo_file_id_idx` ON `order_sheet_lines` (`photo_file_id`);--> statement-breakpoint
CREATE INDEX `order_sheet_lines_material_id_idx` ON `order_sheet_lines` (`material_id`);--> statement-breakpoint
CREATE INDEX `order_sheet_lines_plating_id_idx` ON `order_sheet_lines` (`plating_id`);--> statement-breakpoint
CREATE INDEX `order_sheet_lines_finish_id_idx` ON `order_sheet_lines` (`finish_id`);--> statement-breakpoint
CREATE INDEX `order_sheet_lines_ring_size_id_idx` ON `order_sheet_lines` (`ring_size_id`);--> statement-breakpoint
CREATE INDEX `order_sheet_lines_unit_code_idx` ON `order_sheet_lines` (`unit_code`);--> statement-breakpoint
CREATE INDEX `order_sheet_lines_revision_request_id_idx` ON `order_sheet_lines` (`revision_request_id`);