CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`task_id` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`goal` text NOT NULL,
	`created` integer NOT NULL,
	`url` text NOT NULL,
	`draft` text NOT NULL,
	`hidden` integer NOT NULL,
	`minimized` integer NOT NULL,
	`phase` text NOT NULL,
	`error` text NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` integer PRIMARY KEY NOT NULL,
	`active` text,
	`revision` integer NOT NULL,
	`schema_version` integer NOT NULL,
	FOREIGN KEY (`active`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
