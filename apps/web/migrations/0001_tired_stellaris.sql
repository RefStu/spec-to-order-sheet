CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`name_en` text,
	`email` text NOT NULL,
	`department` text NOT NULL,
	`site` text NOT NULL,
	`locale` text DEFAULT 'ja' NOT NULL,
	`can_approve_order_sheet` integer DEFAULT false NOT NULL,
	`can_approve_revision` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_code_unique` ON `users` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `ai_extraction_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`ai_extraction_id` text NOT NULL,
	`target_table` text NOT NULL,
	`target_row_id` text,
	`target_column` text NOT NULL,
	`raw_value` text,
	`normalized_value` text,
	`confidence` integer NOT NULL,
	`needs_review` integer DEFAULT false NOT NULL,
	`page_no` integer,
	`bbox_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ai_extraction_id`) REFERENCES `ai_extractions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_extraction_fields_review_idx` ON `ai_extraction_fields` (`ai_extraction_id`,`needs_review`);--> statement-breakpoint
CREATE INDEX `ai_extraction_fields_target_idx` ON `ai_extraction_fields` (`target_table`,`target_row_id`);--> statement-breakpoint
CREATE TABLE `ai_extraction_payloads` (
	`id` text PRIMARY KEY NOT NULL,
	`ai_extraction_id` text NOT NULL,
	`raw_output` text NOT NULL,
	`prompt_snapshot` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ai_extraction_id`) REFERENCES `ai_extractions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ai_extractions` (
	`id` text PRIMARY KEY NOT NULL,
	`ai_job_id` text NOT NULL,
	`po_document_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`field_count` integer DEFAULT 0 NOT NULL,
	`low_confidence_count` integer DEFAULT 0 NOT NULL,
	`overall_confidence` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ai_job_id`) REFERENCES `ai_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_extractions_document_idx` ON `ai_extractions` (`po_document_id`,`version`);--> statement-breakpoint
CREATE INDEX `ai_extractions_po_document_id_idx` ON `ai_extractions` (`po_document_id`);--> statement-breakpoint
CREATE TABLE `ai_field_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`ai_extraction_field_id` text,
	`ai_job_id` text,
	`target_table` text NOT NULL,
	`target_row_id` text,
	`target_column` text NOT NULL,
	`before_value` text,
	`after_value` text,
	`error_kind` text NOT NULL,
	`corrected_by` text NOT NULL,
	`corrected_at` integer NOT NULL,
	`note` text,
	FOREIGN KEY (`ai_extraction_field_id`) REFERENCES `ai_extraction_fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ai_job_id`) REFERENCES `ai_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_field_corrections_kind_idx` ON `ai_field_corrections` (`error_kind`,`corrected_at`);--> statement-breakpoint
CREATE INDEX `ai_field_corrections_corrected_by_idx` ON `ai_field_corrections` (`corrected_by`);--> statement-breakpoint
CREATE TABLE `ai_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`input_file_id` text,
	`prompt_id` text,
	`model_name` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_micro` integer,
	`latency_ms` integer,
	`trace_id` text,
	`error_message` text,
	`queued_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`prompt_id`) REFERENCES `ai_prompts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_jobs_status_idx` ON `ai_jobs` (`status`,`queued_at`);--> statement-breakpoint
CREATE INDEX `ai_jobs_target_idx` ON `ai_jobs` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE INDEX `ai_jobs_input_file_id_idx` ON `ai_jobs` (`input_file_id`);--> statement-breakpoint
CREATE TABLE `ai_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`partner_id` text,
	`form_profile_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`body` text NOT NULL,
	`output_schema_json` text,
	`model_name` text,
	`is_active` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_prompts_version_idx` ON `ai_prompts` (`purpose`,`form_profile_id`,`version`);--> statement-breakpoint
CREATE INDEX `ai_prompts_partner_id_idx` ON `ai_prompts` (`partner_id`);--> statement-breakpoint
CREATE INDEX `ai_prompts_form_profile_id_idx` ON `ai_prompts` (`form_profile_id`);--> statement-breakpoint
CREATE INDEX `ai_prompts_created_by_idx` ON `ai_prompts` (`created_by`);--> statement-breakpoint
CREATE INDEX `ai_prompts_updated_by_idx` ON `ai_prompts` (`updated_by`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`step` integer DEFAULT 1 NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`decision` text DEFAULT 'pending' NOT NULL,
	`approver_id` text,
	`comment` text,
	`requested_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `approvals_target_idx` ON `approvals` (`target_kind`,`target_id`,`round`);--> statement-breakpoint
CREATE INDEX `approvals_pending_idx` ON `approvals` (`decision`,`requested_at`);--> statement-breakpoint
CREATE INDEX `approvals_approver_id_idx` ON `approvals` (`approver_id`);--> statement-breakpoint
CREATE TABLE `review_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`partner_id` text,
	`title` text NOT NULL,
	`detail` text,
	`priority` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assigned_to` text,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `review_tasks_queue_idx` ON `review_tasks` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `review_tasks_target_idx` ON `review_tasks` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE INDEX `review_tasks_partner_id_idx` ON `review_tasks` (`partner_id`);--> statement-breakpoint
CREATE INDEX `review_tasks_assigned_to_idx` ON `review_tasks` (`assigned_to`);--> statement-breakpoint
CREATE INDEX `review_tasks_resolved_by_idx` ON `review_tasks` (`resolved_by`);--> statement-breakpoint
CREATE TABLE `cases` (
	`id` text PRIMARY KEY NOT NULL,
	`case_no` text,
	`partner_id` text NOT NULL,
	`title` text,
	`spec_no` text,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cases_case_no_unique` ON `cases` (`case_no`);--> statement-breakpoint
CREATE INDEX `cases_partner_idx` ON `cases` (`partner_id`,`status`);--> statement-breakpoint
CREATE INDEX `cases_spec_no_idx` ON `cases` (`spec_no`);--> statement-breakpoint
CREATE INDEX `cases_partner_id_idx` ON `cases` (`partner_id`);--> statement-breakpoint
CREATE TABLE `customer_items` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`code` text NOT NULL,
	`code_kind` text DEFAULT 'primary' NOT NULL,
	`name_by_customer` text,
	`is_active` integer DEFAULT true NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_items_code_idx` ON `customer_items` (`partner_id`,`code`);--> statement-breakpoint
CREATE INDEX `customer_items_partner_id_idx` ON `customer_items` (`partner_id`);--> statement-breakpoint
CREATE TABLE `item_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`file_id` text NOT NULL,
	`kind` text DEFAULT 'main' NOT NULL,
	`caption` text,
	`sort_key` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `item_photos_file_id_idx` ON `item_photos` (`file_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`partner_id` text NOT NULL,
	`name_ja` text NOT NULL,
	`name_en` text,
	`category` text NOT NULL,
	`code_parts_json` text,
	`default_material_id` text,
	`default_plating_id` text,
	`default_finish_id` text,
	`route_template_id` text,
	`standard_weight_mg` integer,
	`main_photo_id` text,
	`size_range_note` text,
	`remark` text,
	`remark_th` text,
	`first_ordered_on` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_code_unique` ON `items` (`code`);--> statement-breakpoint
CREATE INDEX `items_partner_idx` ON `items` (`partner_id`,`category`);--> statement-breakpoint
CREATE INDEX `items_partner_id_idx` ON `items` (`partner_id`);--> statement-breakpoint
CREATE INDEX `items_default_material_id_idx` ON `items` (`default_material_id`);--> statement-breakpoint
CREATE INDEX `items_default_plating_id_idx` ON `items` (`default_plating_id`);--> statement-breakpoint
CREATE INDEX `items_default_finish_id_idx` ON `items` (`default_finish_id`);--> statement-breakpoint
CREATE INDEX `items_route_template_id_idx` ON `items` (`route_template_id`);--> statement-breakpoint
CREATE INDEX `items_main_photo_id_idx` ON `items` (`main_photo_id`);--> statement-breakpoint
CREATE TABLE `file_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`page_no` integer NOT NULL,
	`image_storage_key` text,
	`width_px` integer,
	`height_px` integer,
	`extracted_text` text,
	`layout_json` text,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_pages_no_idx` ON `file_pages` (`file_id`,`page_no`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`storage_key` text NOT NULL,
	`original_filename` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`page_count` integer,
	`sha256` text NOT NULL,
	`received_via` text DEFAULT 'upload' NOT NULL,
	`uploaded_by` text,
	`uploaded_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_storage_key_unique` ON `files` (`storage_key`);--> statement-breakpoint
CREATE INDEX `files_kind_idx` ON `files` (`kind`,`uploaded_at`);--> statement-breakpoint
CREATE INDEX `files_sha_idx` ON `files` (`sha256`);--> statement-breakpoint
CREATE INDEX `files_uploaded_by_idx` ON `files` (`uploaded_by`);--> statement-breakpoint
CREATE TABLE `finishes` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name_ja` text NOT NULL,
	`display_name` text NOT NULL,
	`caution_ja` text,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finishes_code_unique` ON `finishes` (`code`);--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`category` text NOT NULL,
	`karat_x10` integer,
	`color` text DEFAULT 'none' NOT NULL,
	`purity_permille` integer,
	`density_x1000` integer,
	`display_name` text NOT NULL,
	`remark` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `materials_code_unique` ON `materials` (`code`);--> statement-breakpoint
CREATE TABLE `platings` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name_ja` text NOT NULL,
	`display_name` text NOT NULL,
	`base_material_id` text,
	`thickness_micron_x100` integer,
	`is_active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`base_material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platings_code_unique` ON `platings` (`code`);--> statement-breakpoint
CREATE TABLE `process_route_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`process_id` text NOT NULL,
	`seq` integer NOT NULL,
	`duration_days` integer NOT NULL,
	`is_optional` integer DEFAULT false NOT NULL,
	`note` text,
	FOREIGN KEY (`template_id`) REFERENCES `process_route_templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`process_id`) REFERENCES `processes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `process_route_steps_seq_idx` ON `process_route_steps` (`template_id`,`seq`);--> statement-breakpoint
CREATE TABLE `process_route_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name_ja` text NOT NULL,
	`item_category` text,
	`partner_id` text,
	`total_days` integer,
	`is_default` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `process_route_templates_code_unique` ON `process_route_templates` (`code`);--> statement-breakpoint
CREATE INDEX `process_route_templates_partner_id_idx` ON `process_route_templates` (`partner_id`);--> statement-breakpoint
CREATE TABLE `processes` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name_en` text NOT NULL,
	`name_ja` text NOT NULL,
	`name_th` text,
	`kind` text DEFAULT 'production' NOT NULL,
	`default_seq` integer NOT NULL,
	`default_duration_days` integer DEFAULT 1 NOT NULL,
	`is_outsourced` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `processes_code_unique` ON `processes` (`code`);--> statement-breakpoint
CREATE TABLE `ring_sizes` (
	`id` text PRIMARY KEY NOT NULL,
	`standard` text DEFAULT 'jp' NOT NULL,
	`code` text NOT NULL,
	`display_text` text NOT NULL,
	`sort_key` integer NOT NULL,
	`inner_diameter_mm_x100` integer,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ring_sizes_code_unique` ON `ring_sizes` (`code`);--> statement-breakpoint
CREATE TABLE `stone_shapes` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name_ja` text NOT NULL,
	`display_name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stone_shapes_code_unique` ON `stone_shapes` (`code`);--> statement-breakpoint
CREATE TABLE `stone_sizes` (
	`id` text PRIMARY KEY NOT NULL,
	`notation` text NOT NULL,
	`code` text NOT NULL,
	`display_text` text NOT NULL,
	`carat_x1000` integer,
	`diameter_mm_x100` integer,
	`sort_key` integer NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stone_sizes_code_unique` ON `stone_sizes` (`code`);--> statement-breakpoint
CREATE TABLE `stone_types` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name_ja` text NOT NULL,
	`display_name` text NOT NULL,
	`is_diamond` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stone_types_code_unique` ON `stone_types` (`code`);--> statement-breakpoint
CREATE TABLE `units` (
	`code` text PRIMARY KEY NOT NULL,
	`name_ja` text NOT NULL,
	`name_en` text NOT NULL,
	`is_length` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_sheet_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`order_sheet_id` text NOT NULL,
	`order_sheet_line_id` text,
	`kind` text NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`message` text NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_sheet_id`) REFERENCES `order_sheets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_sheet_line_id`) REFERENCES `order_sheet_lines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_sheet_issues_severity_idx` ON `order_sheet_issues` (`order_sheet_id`,`severity`);--> statement-breakpoint
CREATE INDEX `order_sheet_issues_resolved_by_idx` ON `order_sheet_issues` (`resolved_by`);--> statement-breakpoint
CREATE TABLE `order_sheet_line_ids` (
	`id` text PRIMARY KEY NOT NULL,
	`order_sheet_line_id` text NOT NULL,
	`raw_text` text NOT NULL,
	`value_from` text,
	`value_to` text,
	`value_count` integer DEFAULT 1 NOT NULL,
	`sort_key` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`order_sheet_line_id`) REFERENCES `order_sheet_lines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_sheet_line_ids_line_idx` ON `order_sheet_line_ids` (`order_sheet_line_id`,`sort_key`);--> statement-breakpoint
CREATE TABLE `order_sheet_line_stones` (
	`id` text PRIMARY KEY NOT NULL,
	`order_sheet_line_id` text NOT NULL,
	`stone_type_id` text,
	`stone_shape_id` text,
	`stone_size_id` text,
	`position` text DEFAULT 'melee' NOT NULL,
	`pieces_per_unit` integer,
	`total_pieces` integer,
	`total_carat_x1000` integer,
	`supply_source` text DEFAULT 'in_house' NOT NULL,
	`grade_note` text,
	`display_text` text NOT NULL,
	`sort_key` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`order_sheet_line_id`) REFERENCES `order_sheet_lines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_sheet_line_stones_stone_type_id_idx` ON `order_sheet_line_stones` (`stone_type_id`);--> statement-breakpoint
CREATE INDEX `order_sheet_line_stones_stone_shape_id_idx` ON `order_sheet_line_stones` (`stone_shape_id`);--> statement-breakpoint
CREATE INDEX `order_sheet_line_stones_stone_size_id_idx` ON `order_sheet_line_stones` (`stone_size_id`);--> statement-breakpoint
CREATE TABLE `order_sheet_lines` (
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
	`quantity` integer NOT NULL,
	`unit_code` text NOT NULL,
	`ship_date` text,
	`remark` text,
	`remark_lang` text DEFAULT 'th' NOT NULL,
	`remark_ja` text,
	`revision_request_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_sheet_id`) REFERENCES `order_sheets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE INDEX `order_sheet_lines_revision_request_id_idx` ON `order_sheet_lines` (`revision_request_id`);--> statement-breakpoint
CREATE TABLE `order_sheets` (
	`id` text PRIMARY KEY NOT NULL,
	`po_no` text,
	`so_no` text,
	`partner_id` text NOT NULL,
	`case_id` text,
	`purchase_order_id` text,
	`customer_po_no` text,
	`customer_po_label` text DEFAULT 'customer_po' NOT NULL,
	`issued_on` text NOT NULL,
	`ship_date` text,
	`total_quantity` integer DEFAULT 0 NOT NULL,
	`total_unit_code` text,
	`planner_id` text,
	`route_template_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`generated_by` text DEFAULT 'human' NOT NULL,
	`source_ai_job_id` text,
	`pdf_file_id` text,
	`released_by` text,
	`released_at` integer,
	`note` text,
	`note_th` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_sheets_po_no_unique` ON `order_sheets` (`po_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_sheets_case_id_unique` ON `order_sheets` (`case_id`);--> statement-breakpoint
CREATE INDEX `order_sheets_partner_idx` ON `order_sheets` (`partner_id`,`ship_date`);--> statement-breakpoint
CREATE INDEX `order_sheets_status_idx` ON `order_sheets` (`status`,`ship_date`);--> statement-breakpoint
CREATE INDEX `order_sheets_partner_id_idx` ON `order_sheets` (`partner_id`);--> statement-breakpoint
CREATE INDEX `order_sheets_case_id_idx` ON `order_sheets` (`case_id`);--> statement-breakpoint
CREATE INDEX `order_sheets_purchase_order_id_idx` ON `order_sheets` (`purchase_order_id`);--> statement-breakpoint
CREATE INDEX `order_sheets_total_unit_code_idx` ON `order_sheets` (`total_unit_code`);--> statement-breakpoint
CREATE INDEX `order_sheets_planner_id_idx` ON `order_sheets` (`planner_id`);--> statement-breakpoint
CREATE INDEX `order_sheets_route_template_id_idx` ON `order_sheets` (`route_template_id`);--> statement-breakpoint
CREATE INDEX `order_sheets_source_ai_job_id_idx` ON `order_sheets` (`source_ai_job_id`);--> statement-breakpoint
CREATE INDEX `order_sheets_pdf_file_id_idx` ON `order_sheets` (`pdf_file_id`);--> statement-breakpoint
CREATE INDEX `order_sheets_released_by_idx` ON `order_sheets` (`released_by`);--> statement-breakpoint
CREATE TABLE `production_plan_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`production_plan_id` text NOT NULL,
	`process_id` text,
	`seq` integer NOT NULL,
	`label_override` text,
	`planned_start_on` text,
	`planned_stop_on` text,
	`planned_days` integer,
	`actual_start_on` text,
	`actual_stop_on` text,
	`is_skipped` integer DEFAULT false NOT NULL,
	`is_milestone` integer DEFAULT false NOT NULL,
	`is_outsourced` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`note` text,
	`note_th` text,
	FOREIGN KEY (`production_plan_id`) REFERENCES `production_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `production_plan_steps_seq_idx` ON `production_plan_steps` (`production_plan_id`,`seq`);--> statement-breakpoint
CREATE INDEX `production_plan_steps_process_id_idx` ON `production_plan_steps` (`process_id`);--> statement-breakpoint
CREATE TABLE `production_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`order_sheet_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`basis` text DEFAULT 'backward_from_ship' NOT NULL,
	`ship_date` text,
	`total_days` integer,
	`reason` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_sheet_id`) REFERENCES `order_sheets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `production_plans_version_idx` ON `production_plans` (`order_sheet_id`,`version`);--> statement-breakpoint
CREATE INDEX `production_plans_created_by_idx` ON `production_plans` (`created_by`);--> statement-breakpoint
CREATE TABLE `partner_form_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`doc_kind` text DEFAULT 'purchase_order' NOT NULL,
	`item_category` text,
	`production_method` text,
	`media` text DEFAULT 'pdf' NOT NULL,
	`has_order_groups` integer DEFAULT false NOT NULL,
	`has_size_breakdown` integer DEFAULT false NOT NULL,
	`has_stone_breakdown` integer DEFAULT false NOT NULL,
	`extraction_hint` text,
	`sample_file_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`valid_from` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`partner_id`) REFERENCES `partners`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `partner_form_profiles_code_idx` ON `partner_form_profiles` (`partner_id`,`code`,`version`);--> statement-breakpoint
CREATE INDEX `partner_form_profiles_kind_idx` ON `partner_form_profiles` (`doc_kind`,`item_category`,`production_method`);--> statement-breakpoint
CREATE INDEX `partner_form_profiles_sample_file_id_idx` ON `partner_form_profiles` (`sample_file_id`);--> statement-breakpoint
CREATE TABLE `partner_form_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`form_profile_id` text NOT NULL,
	`headings_json` text NOT NULL,
	`layout_json` text NOT NULL,
	`page_count` integer NOT NULL,
	`source_sha256` text,
	`extracted_by` text,
	`extracted_at` integer NOT NULL,
	`retention_until` text,
	`deleted_at` integer,
	FOREIGN KEY (`form_profile_id`) REFERENCES `partner_form_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `partner_form_samples_profile_idx` ON `partner_form_samples` (`form_profile_id`);--> statement-breakpoint
CREATE INDEX `partner_form_samples_sha_idx` ON `partner_form_samples` (`source_sha256`);--> statement-breakpoint
CREATE INDEX `partner_form_samples_extracted_by_idx` ON `partner_form_samples` (`extracted_by`);--> statement-breakpoint
CREATE TABLE `partners` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`name_en` text,
	`short_name` text NOT NULL,
	`country` text DEFAULT 'JP' NOT NULL,
	`address` text,
	`tel` text,
	`fax` text,
	`tax_mode` text DEFAULT 'excluded' NOT NULL,
	`default_lead_time_days` integer,
	`po_no_label` text DEFAULT 'customer_po' NOT NULL,
	`po_no_pattern` text,
	`inspection_due_days` integer,
	`auto_apply_threshold` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `partners_code_unique` ON `partners` (`code`);--> statement-breakpoint
CREATE TABLE `po_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`doc_kind` text DEFAULT 'purchase_order' NOT NULL,
	`partner_id` text,
	`form_confidence` integer,
	`status` text DEFAULT 'received' NOT NULL,
	`received_at` integer NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `po_documents_status_idx` ON `po_documents` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `po_documents_file_id_idx` ON `po_documents` (`file_id`);--> statement-breakpoint
CREATE INDEX `po_documents_partner_id_idx` ON `po_documents` (`partner_id`);--> statement-breakpoint
CREATE TABLE `purchase_order_line_stones` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_order_line_id` text NOT NULL,
	`stone_type_id` text,
	`stone_shape_id` text,
	`stone_size_id` text,
	`position` text DEFAULT 'melee' NOT NULL,
	`pieces_per_unit` integer,
	`total_pieces` integer,
	`total_carat_x1000` integer,
	`supply_source` text DEFAULT 'in_house' NOT NULL,
	`display_text` text,
	`raw_text` text,
	FOREIGN KEY (`purchase_order_line_id`) REFERENCES `purchase_order_lines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `purchase_order_line_stones_stone_type_id_idx` ON `purchase_order_line_stones` (`stone_type_id`);--> statement-breakpoint
CREATE INDEX `purchase_order_line_stones_stone_shape_id_idx` ON `purchase_order_line_stones` (`stone_shape_id`);--> statement-breakpoint
CREATE INDEX `purchase_order_line_stones_stone_size_id_idx` ON `purchase_order_line_stones` (`stone_size_id`);--> statement-breakpoint
CREATE TABLE `purchase_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_order_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`customer_line_no` text,
	`raw_product_name` text,
	`raw_item_code` text,
	`raw_model_no` text,
	`raw_material_text` text,
	`raw_size_text` text,
	`raw_color_text` text,
	`resolved_item_id` text,
	`resolved_customer_item_id` text,
	`resolve_method` text,
	`resolve_score` integer,
	`material_id` text,
	`plating_id` text,
	`finish_id` text,
	`ring_size_id` text,
	`size_text` text,
	`quantity` integer NOT NULL,
	`unit_code` text NOT NULL,
	`unit_price` integer,
	`unit_price_scale` integer DEFAULT 0 NOT NULL,
	`processing_fee` integer,
	`material_fee` integer,
	`parts_fee` integer,
	`amount` integer,
	`supply_kind` text,
	`requested_ship_date` text,
	`requested_arrival_date` text,
	`engraving_text` text,
	`remark` text,
	`review_status` text DEFAULT 'auto' NOT NULL,
	`source_page_no` integer,
	`source_bbox_json` text,
	`converted_quantity` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_order_lines_no_idx` ON `purchase_order_lines` (`purchase_order_id`,`line_no`);--> statement-breakpoint
CREATE INDEX `purchase_order_lines_item_idx` ON `purchase_order_lines` (`resolved_item_id`);--> statement-breakpoint
CREATE INDEX `purchase_order_lines_review_idx` ON `purchase_order_lines` (`review_status`);--> statement-breakpoint
CREATE INDEX `purchase_order_lines_resolved_item_id_idx` ON `purchase_order_lines` (`resolved_item_id`);--> statement-breakpoint
CREATE INDEX `purchase_order_lines_resolved_customer_item_id_idx` ON `purchase_order_lines` (`resolved_customer_item_id`);--> statement-breakpoint
CREATE INDEX `purchase_order_lines_material_id_idx` ON `purchase_order_lines` (`material_id`);--> statement-breakpoint
CREATE INDEX `purchase_order_lines_plating_id_idx` ON `purchase_order_lines` (`plating_id`);--> statement-breakpoint
CREATE INDEX `purchase_order_lines_finish_id_idx` ON `purchase_order_lines` (`finish_id`);--> statement-breakpoint
CREATE INDEX `purchase_order_lines_ring_size_id_idx` ON `purchase_order_lines` (`ring_size_id`);--> statement-breakpoint
CREATE INDEX `purchase_order_lines_unit_code_idx` ON `purchase_order_lines` (`unit_code`);--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`po_document_id` text,
	`case_id` text,
	`partner_id` text NOT NULL,
	`customer_po_no` text NOT NULL,
	`ordered_on` text,
	`requested_ship_date` text,
	`requested_arrival_date` text,
	`payment_term_text` text,
	`inspection_due_text` text,
	`contact_name_raw` text,
	`tax_mode` text DEFAULT 'excluded' NOT NULL,
	`total_amount` integer,
	`total_quantity` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`raw_json` text,
	`confirmed_by` text,
	`confirmed_at` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`po_document_id`) REFERENCES `po_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_orders_po_no_idx` ON `purchase_orders` (`partner_id`,`customer_po_no`);--> statement-breakpoint
CREATE INDEX `purchase_orders_status_idx` ON `purchase_orders` (`status`,`requested_ship_date`);--> statement-breakpoint
CREATE INDEX `purchase_orders_case_id_idx` ON `purchase_orders` (`case_id`);--> statement-breakpoint
CREATE INDEX `purchase_orders_partner_id_idx` ON `purchase_orders` (`partner_id`);--> statement-breakpoint
CREATE INDEX `purchase_orders_confirmed_by_idx` ON `purchase_orders` (`confirmed_by`);--> statement-breakpoint
CREATE TABLE `revision_request_specs` (
	`id` text PRIMARY KEY NOT NULL,
	`revision_request_id` text NOT NULL,
	`material_id` text,
	`material_code_text` text,
	`purity_text` text,
	`certification` text DEFAULT 'none' NOT NULL,
	`plating_id` text,
	`finish_id` text,
	`ring_size_id` text,
	`size_text` text,
	`full_length_mm_x100` integer,
	`chain_spec_text` text,
	`finding_text` text,
	`engraving_text` text,
	`engraving_method` text DEFAULT 'none' NOT NULL,
	`engraving_position` text,
	`total_stone_weight_carat_x1000` integer,
	`spec_weight_mg` integer,
	`melt_production_place` text,
	`mold_production_place` text,
	`final_finish_place` text,
	`sample_arrival_on` text,
	`finish_caution` text,
	`remark` text,
	FOREIGN KEY (`revision_request_id`) REFERENCES `revision_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `revision_request_specs_material_id_idx` ON `revision_request_specs` (`material_id`);--> statement-breakpoint
CREATE INDEX `revision_request_specs_plating_id_idx` ON `revision_request_specs` (`plating_id`);--> statement-breakpoint
CREATE INDEX `revision_request_specs_finish_id_idx` ON `revision_request_specs` (`finish_id`);--> statement-breakpoint
CREATE INDEX `revision_request_specs_ring_size_id_idx` ON `revision_request_specs` (`ring_size_id`);--> statement-breakpoint
CREATE TABLE `revision_request_stones` (
	`id` text PRIMARY KEY NOT NULL,
	`revision_request_id` text NOT NULL,
	`stone_type_id` text,
	`stone_shape_id` text,
	`stone_size_id` text,
	`position` text DEFAULT 'melee' NOT NULL,
	`pieces` integer NOT NULL,
	`supply_source` text DEFAULT 'in_house' NOT NULL,
	`remark` text,
	`sort_key` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`revision_request_id`) REFERENCES `revision_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `revision_request_stones_stone_type_id_idx` ON `revision_request_stones` (`stone_type_id`);--> statement-breakpoint
CREATE INDEX `revision_request_stones_stone_shape_id_idx` ON `revision_request_stones` (`stone_shape_id`);--> statement-breakpoint
CREATE INDEX `revision_request_stones_stone_size_id_idx` ON `revision_request_stones` (`stone_size_id`);--> statement-breakpoint
CREATE TABLE `revision_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`request_no` text,
	`spec_no` text,
	`revision_of_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`partner_id` text NOT NULL,
	`case_id` text,
	`item_id` text,
	`customer_item_id` text,
	`order_sheet_id` text,
	`purchase_order_id` text,
	`source_po_document_id` text,
	`request_type` text DEFAULT 'new_spec' NOT NULL,
	`order_category` text,
	`processing_detail` text,
	`deliver_to` text,
	`customer_code_text` text,
	`customer_mgmt_code` text,
	`production_name` text,
	`reason` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`generated_by` text DEFAULT 'human' NOT NULL,
	`source_ai_job_id` text,
	`requested_by` text,
	`requested_at` integer NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`applied_at` integer,
	`pdf_file_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `revision_requests_request_no_unique` ON `revision_requests` (`request_no`);--> statement-breakpoint
CREATE INDEX `revision_requests_partner_idx` ON `revision_requests` (`partner_id`,`status`);--> statement-breakpoint
CREATE INDEX `revision_requests_item_idx` ON `revision_requests` (`item_id`,`version`);--> statement-breakpoint
CREATE INDEX `revision_requests_spec_no_idx` ON `revision_requests` (`partner_id`,`spec_no`);--> statement-breakpoint
CREATE INDEX `revision_requests_partner_id_idx` ON `revision_requests` (`partner_id`);--> statement-breakpoint
CREATE INDEX `revision_requests_case_id_idx` ON `revision_requests` (`case_id`);--> statement-breakpoint
CREATE INDEX `revision_requests_item_id_idx` ON `revision_requests` (`item_id`);--> statement-breakpoint
CREATE INDEX `revision_requests_customer_item_id_idx` ON `revision_requests` (`customer_item_id`);--> statement-breakpoint
CREATE INDEX `revision_requests_order_sheet_id_idx` ON `revision_requests` (`order_sheet_id`);--> statement-breakpoint
CREATE INDEX `revision_requests_purchase_order_id_idx` ON `revision_requests` (`purchase_order_id`);--> statement-breakpoint
CREATE INDEX `revision_requests_source_po_document_id_idx` ON `revision_requests` (`source_po_document_id`);--> statement-breakpoint
CREATE INDEX `revision_requests_source_ai_job_id_idx` ON `revision_requests` (`source_ai_job_id`);--> statement-breakpoint
CREATE INDEX `revision_requests_requested_by_idx` ON `revision_requests` (`requested_by`);--> statement-breakpoint
CREATE INDEX `revision_requests_approved_by_idx` ON `revision_requests` (`approved_by`);--> statement-breakpoint
CREATE INDEX `revision_requests_pdf_file_id_idx` ON `revision_requests` (`pdf_file_id`);