CREATE TABLE `data_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`period_days` integer NOT NULL,
	`status` text NOT NULL,
	`warning_count` integer DEFAULT 0 NOT NULL,
	`source_set_hash` text NOT NULL,
	`snapshot_object_key` text NOT NULL,
	`file_count` integer NOT NULL,
	`advertising_sales` real NOT NULL,
	`advertising_spend` real NOT NULL,
	`advertising_purchases` real NOT NULL,
	`impressions` real NOT NULL,
	`clicks` real NOT NULL,
	`acos` real,
	`retail_sales` real NOT NULL,
	`retail_units` real NOT NULL,
	`retail_sessions` real NOT NULL,
	`tcos` real,
	`net_contribution` real,
	`net_contribution_margin` real,
	`retail_coverage_products` integer NOT NULL,
	`active_products` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `data_snapshots_source_set_hash_unique` ON `data_snapshots` (`source_set_hash`);--> statement-breakpoint
CREATE INDEX `data_snapshots_period_end_idx` ON `data_snapshots` (`period_end`);--> statement-breakpoint
CREATE INDEX `data_snapshots_created_at_idx` ON `data_snapshots` (`created_at`);--> statement-breakpoint
CREATE TABLE `import_files` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`role` text NOT NULL,
	`file_name` text NOT NULL,
	`object_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`row_count` integer NOT NULL,
	`sha256` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `data_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_files_snapshot_role_unique` ON `import_files` (`snapshot_id`,`role`);--> statement-breakpoint
CREATE INDEX `import_files_snapshot_idx` ON `import_files` (`snapshot_id`);