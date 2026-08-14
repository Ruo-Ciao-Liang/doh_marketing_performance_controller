import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const dataSnapshots = sqliteTable("data_snapshots", {
  id: text("id").primaryKey(),
  marketplaceId: text("marketplace_id").notNull().default("amazon_de"),
  currency: text("currency").notNull().default("EUR"),
  fxRateToEur: real("fx_rate_to_eur").notNull().default(1),
  createdAt: text("created_at").notNull(),
  createdBy: text("created_by").notNull(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  periodDays: integer("period_days").notNull(),
  status: text("status").notNull(),
  warningCount: integer("warning_count").notNull().default(0),
  sourceSetHash: text("source_set_hash").notNull(),
  snapshotObjectKey: text("snapshot_object_key").notNull(),
  fileCount: integer("file_count").notNull(),
  advertisingSales: real("advertising_sales").notNull(),
  advertisingSpend: real("advertising_spend").notNull(),
  advertisingPurchases: real("advertising_purchases").notNull(),
  impressions: real("impressions").notNull(),
  clicks: real("clicks").notNull(),
  acos: real("acos"),
  retailSales: real("retail_sales").notNull(),
  retailUnits: real("retail_units").notNull(),
  retailSessions: real("retail_sessions").notNull(),
  tcos: real("tcos"),
  netContribution: real("net_contribution"),
  netContributionMargin: real("net_contribution_margin"),
  retailCoverageProducts: integer("retail_coverage_products").notNull(),
  activeProducts: integer("active_products").notNull(),
}, (table) => [
  uniqueIndex("data_snapshots_marketplace_source_hash_unique").on(table.marketplaceId, table.sourceSetHash),
  index("data_snapshots_marketplace_period_idx").on(table.marketplaceId, table.periodEnd),
  index("data_snapshots_created_at_idx").on(table.createdAt),
]);

export const importFiles = sqliteTable("import_files", {
  id: text("id").primaryKey(),
  snapshotId: text("snapshot_id").notNull().references(() => dataSnapshots.id),
  role: text("role").notNull(),
  fileName: text("file_name").notNull(),
  objectKey: text("object_key").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  rowCount: integer("row_count").notNull(),
  sha256: text("sha256").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("import_files_snapshot_role_unique").on(table.snapshotId, table.role),
  index("import_files_snapshot_idx").on(table.snapshotId),
]);

export const organizationSettings = sqliteTable("organization_settings", {
  id: text("id").primaryKey(),
  aggressivenessFactor: real("aggressiveness_factor").notNull(),
  maxBidChange: real("max_bid_change").notNull(),
  minimumClicks: integer("minimum_clicks").notNull(),
  policyJson: text("policy_json").notNull().default("{}"),
  revision: integer("revision").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
});

export const reviewDecisions = sqliteTable("review_decisions", {
  snapshotId: text("snapshot_id").notNull().references(() => dataSnapshots.id),
  suggestionId: text("suggestion_id").notNull(),
  decision: text("decision").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
}, (table) => [
  primaryKey({ columns: [table.snapshotId, table.suggestionId] }),
  index("review_decisions_snapshot_idx").on(table.snapshotId),
  index("review_decisions_updated_by_idx").on(table.updatedBy),
]);

export const userPreferences = sqliteTable("user_preferences", {
  userEmail: text("user_email").primaryKey(),
  preferencesJson: text("preferences_json").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});

export const changeAudit = sqliteTable("change_audit", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  changedBy: text("changed_by").notNull(),
  changedAt: text("changed_at").notNull(),
}, (table) => [
  index("change_audit_changed_at_idx").on(table.changedAt),
  index("change_audit_entity_idx").on(table.entityType, table.entityId),
]);

export const productIdentifierVersions = sqliteTable("product_identifier_versions", {
  id: text("id").primaryKey(),
  sourceFile: text("source_file").notNull(),
  sourceHash: text("source_hash").notNull(),
  rowCount: integer("row_count").notNull(),
  createdAt: text("created_at").notNull(),
  createdBy: text("created_by").notNull(),
}, (table) => [
  uniqueIndex("product_identifier_versions_source_hash_unique").on(table.sourceHash),
]);

export const productIdentifiers = sqliteTable("product_identifiers", {
  id: text("id").primaryKey(),
  versionId: text("version_id").notNull().references(() => productIdentifierVersions.id),
  marketplaceId: text("marketplace_id").notNull(),
  canonicalSku: text("canonical_sku").notNull(),
  identifierType: text("identifier_type").notNull(),
  identifierValue: text("identifier_value").notNull(),
  createdAt: text("created_at").notNull(),
  createdBy: text("created_by").notNull(),
}, (table) => [
  uniqueIndex("product_identifiers_marketplace_value_unique").on(table.marketplaceId, table.identifierType, table.identifierValue),
  index("product_identifiers_sku_idx").on(table.canonicalSku),
]);

export const marketplaceSettings = sqliteTable("marketplace_settings", {
  marketplaceId: text("marketplace_id").primaryKey(),
  commissionRate: real("commission_rate"),
  vatRate: real("vat_rate").notNull().default(0.19),
  categoryOverridesJson: text("category_overrides_json").notNull().default("{}"),
  confirmed: integer("confirmed", { mode: "boolean" }).notNull().default(false),
  revision: integer("revision").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
});
