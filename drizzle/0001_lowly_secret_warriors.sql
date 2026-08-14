CREATE TABLE `change_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`changed_by` text NOT NULL,
	`changed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `change_audit_changed_at_idx` ON `change_audit` (`changed_at`);--> statement-breakpoint
CREATE INDEX `change_audit_entity_idx` ON `change_audit` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `organization_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`aggressiveness_factor` real NOT NULL,
	`max_bid_change` real NOT NULL,
	`minimum_clicks` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_decisions` (
	`snapshot_id` text NOT NULL,
	`suggestion_id` text NOT NULL,
	`decision` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`snapshot_id`, `suggestion_id`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `data_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_decisions_snapshot_idx` ON `review_decisions` (`snapshot_id`);--> statement-breakpoint
CREATE INDEX `review_decisions_updated_by_idx` ON `review_decisions` (`updated_by`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_email` text PRIMARY KEY NOT NULL,
	`preferences_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
