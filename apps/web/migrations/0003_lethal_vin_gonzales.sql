DROP INDEX `purchase_orders_po_no_idx`;--> statement-breakpoint
CREATE INDEX `purchase_orders_po_document_idx` ON `purchase_orders` (`po_document_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_orders_po_no_idx` ON `purchase_orders` (`partner_id`,`customer_po_no`) WHERE "purchase_orders"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE `po_documents` ADD `form_profile_id` text;--> statement-breakpoint
CREATE INDEX `po_documents_form_profile_id_idx` ON `po_documents` (`form_profile_id`);