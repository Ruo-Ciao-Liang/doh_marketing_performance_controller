ALTER TABLE `data_snapshots` ADD `marketplace_id` text DEFAULT 'amazon_de' NOT NULL;
--> statement-breakpoint
ALTER TABLE `data_snapshots` ADD `currency` text DEFAULT 'EUR' NOT NULL;
--> statement-breakpoint
ALTER TABLE `data_snapshots` ADD `fx_rate_to_eur` real DEFAULT 1 NOT NULL;
--> statement-breakpoint
DROP INDEX `data_snapshots_source_set_hash_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `data_snapshots_marketplace_source_hash_unique` ON `data_snapshots` (`marketplace_id`,`source_set_hash`);
--> statement-breakpoint
CREATE INDEX `data_snapshots_marketplace_period_idx` ON `data_snapshots` (`marketplace_id`,`period_end`);
--> statement-breakpoint
CREATE TABLE `product_identifier_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_file` text NOT NULL,
	`source_hash` text NOT NULL,
	`row_count` integer NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_identifier_versions_source_hash_unique` ON `product_identifier_versions` (`source_hash`);
--> statement-breakpoint
CREATE TABLE `product_identifiers` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`marketplace_id` text NOT NULL,
	`canonical_sku` text NOT NULL,
	`identifier_type` text NOT NULL,
	`identifier_value` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `product_identifier_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_identifiers_marketplace_value_unique` ON `product_identifiers` (`marketplace_id`,`identifier_type`,`identifier_value`);
--> statement-breakpoint
CREATE INDEX `product_identifiers_sku_idx` ON `product_identifiers` (`canonical_sku`);
--> statement-breakpoint
CREATE TABLE `marketplace_settings` (
	`marketplace_id` text PRIMARY KEY NOT NULL,
	`commission_rate` real,
	`vat_rate` real DEFAULT 0.19 NOT NULL,
	`category_overrides_json` text DEFAULT '{}' NOT NULL,
	`confirmed` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL
);
