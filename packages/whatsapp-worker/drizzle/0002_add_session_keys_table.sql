CREATE TABLE `whatsapp_session_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`key_type` text NOT NULL,
	`key_id` text NOT NULL,
	`key_data` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_session_keys_type_id` ON `whatsapp_session_keys` (`session_id`,`key_type`,`key_id`);--> statement-breakpoint
ALTER TABLE `whatsapp_sessions` DROP COLUMN `keys_data`;