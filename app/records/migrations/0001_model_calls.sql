CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`hash` text NOT NULL,
	`configuration_version` integer NOT NULL,
	`model` text NOT NULL,
	`phase` text NOT NULL,
	`source` text,
	`output` text DEFAULT '' NOT NULL,
	`error` text,
	`page_changed` integer DEFAULT false NOT NULL,
	`dispatched` integer DEFAULT false NOT NULL,
	`reserved_tokens` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`configuration_version`) REFERENCES `model_settings`(`version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `model_settings` (
	`version` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`hash` text NOT NULL,
	`endpoint` text NOT NULL,
	`model` text NOT NULL,
	`ciphertext` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_settings_request_id_unique` ON `model_settings` (`request_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `model_call_id` text;