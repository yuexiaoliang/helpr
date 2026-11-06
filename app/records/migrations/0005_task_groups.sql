ALTER TABLE `tasks` ADD `group_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `group_goal` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `archived` integer DEFAULT false NOT NULL;