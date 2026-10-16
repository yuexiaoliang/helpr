CREATE TABLE `execution_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`task_id` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_executions` (
	`task_id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
