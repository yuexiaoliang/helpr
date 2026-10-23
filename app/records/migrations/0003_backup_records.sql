CREATE TABLE `archived_model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`hash` text NOT NULL,
	`body` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `backup_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`file` text NOT NULL,
	`archive` text NOT NULL
);
