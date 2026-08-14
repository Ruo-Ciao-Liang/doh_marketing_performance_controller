import { env } from "cloudflare:workers";
import { parseCsv } from "./runtime-import.ts";
import { normalizeMarketplaceId, type MarketplaceId } from "./marketplaces.ts";

interface RuntimeBindings { DB: D1Database; IMPORTS: R2Bucket }

export interface ProductIdentifierRecord {
  marketplaceId: MarketplaceId;
  canonicalSku: string;
  identifierType: "ean" | "seller_sku" | "asin" | "offer_id" | "product_id";
  identifierValue: string;
}

export interface MarketplaceCostSettings {
  marketplaceId: MarketplaceId;
  commissionRate: number | null;
  vatRate: number;
  categoryOverrides: Record<string, number>;
  confirmed: boolean;
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

function bindings(): RuntimeBindings {
  const runtime = env as unknown as Partial<RuntimeBindings>;
  if (!runtime.DB || !runtime.IMPORTS) throw new Error("Marketplace persistence is unavailable.");
  return runtime as RuntimeBindings;
}

async function ensureSchema(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS product_identifier_versions (
      id TEXT PRIMARY KEY NOT NULL, source_file TEXT NOT NULL, source_hash TEXT NOT NULL,
      row_count INTEGER NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL
    )`),
    database.prepare("CREATE UNIQUE INDEX IF NOT EXISTS product_identifier_versions_source_hash_unique ON product_identifier_versions (source_hash)"),
    database.prepare(`CREATE TABLE IF NOT EXISTS product_identifiers (
      id TEXT PRIMARY KEY NOT NULL, version_id TEXT NOT NULL REFERENCES product_identifier_versions(id),
      marketplace_id TEXT NOT NULL, canonical_sku TEXT NOT NULL, identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL
    )`),
    database.prepare("CREATE UNIQUE INDEX IF NOT EXISTS product_identifiers_marketplace_value_unique ON product_identifiers (marketplace_id, identifier_type, identifier_value)"),
    database.prepare("CREATE INDEX IF NOT EXISTS product_identifiers_sku_idx ON product_identifiers (canonical_sku)"),
    database.prepare(`CREATE TABLE IF NOT EXISTS marketplace_settings (
      marketplace_id TEXT PRIMARY KEY NOT NULL, commission_rate REAL, vat_rate REAL NOT NULL DEFAULT 0.19,
      category_overrides_json TEXT NOT NULL DEFAULT '{}', confirmed INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
    )`),
  ]);
}

function normalizedCell(row: Record<string, string>, aliases: string[]): string {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"), value.trim()]));
  for (const alias of aliases) {
    const value = normalized.get(alias);
    if (value) return value;
  }
  return "";
}

export async function listProductIdentifiers(marketplaceId: MarketplaceId = "kaufland_de"): Promise<ProductIdentifierRecord[]> {
  const { DB } = bindings();
  await ensureSchema(DB);
  const result = await DB.prepare(`SELECT marketplace_id, canonical_sku, identifier_type, identifier_value
    FROM product_identifiers WHERE marketplace_id = ? ORDER BY canonical_sku, identifier_type`).bind(marketplaceId).all<Record<string, unknown>>();
  return result.results.map((row) => ({
    marketplaceId: normalizeMarketplaceId(String(row.marketplace_id)),
    canonicalSku: String(row.canonical_sku),
    identifierType: String(row.identifier_type) as ProductIdentifierRecord["identifierType"],
    identifierValue: String(row.identifier_value),
  }));
}

export async function saveProductIdentifierMapping(input: {
  marketplaceId: MarketplaceId;
  fileName: string;
  text: string;
  sha256: string;
  createdBy: string;
  validSkus: Set<string>;
}): Promise<{ versionId: string; rowCount: number; identifiers: ProductIdentifierRecord[] }> {
  const { DB, IMPORTS } = bindings();
  await ensureSchema(DB);
  if (input.marketplaceId !== "kaufland_de") throw new Error("The separate identifier crosswalk is currently required for Kaufland DE only.");
  const duplicate = await DB.prepare("SELECT id FROM product_identifier_versions WHERE source_hash = ?").bind(input.sha256).first<{ id: string }>();
  if (duplicate) throw new Error("This exact SKU–EAN mapping file has already been imported.");
  const parsed = parseCsv(input.text);
  const records: ProductIdentifierRecord[] = [];
  const seen = new Map<string, string>();
  for (const [index, row] of parsed.rows.entries()) {
    const canonicalSku = normalizedCell(row, ["internal_sku", "canonical_sku", "sku", "artikelnummer"]);
    const ean = normalizedCell(row, ["ean", "gtin", "ean_gtin"]); 
    if (!canonicalSku || !ean) throw new Error(`Mapping row ${index + 2} must contain internal_sku and ean.`);
    if (!input.validSkus.has(canonicalSku)) throw new Error(`Mapping row ${index + 2} references unknown internal SKU ${canonicalSku}.`);
    if (!/^\d{8,14}$/.test(ean)) throw new Error(`Mapping row ${index + 2} has invalid EAN ${ean}.`);
    const previous = seen.get(ean);
    if (previous && previous !== canonicalSku) throw new Error(`EAN ${ean} is assigned to both ${previous} and ${canonicalSku}. Resolve the conflict before importing.`);
    seen.set(ean, canonicalSku);
    records.push({ marketplaceId: input.marketplaceId, canonicalSku, identifierType: "ean", identifierValue: ean });
    const optional: Array<[ProductIdentifierRecord["identifierType"], string[]]> = [
      ["seller_sku", ["marketplace_seller_sku", "seller_sku", "kaufland_sku"]],
      ["offer_id", ["offer_id", "offerid"]],
      ["product_id", ["product_id", "productid"]],
    ];
    for (const [identifierType, aliases] of optional) {
      const identifierValue = normalizedCell(row, aliases);
      if (identifierValue) records.push({ marketplaceId: input.marketplaceId, canonicalSku, identifierType, identifierValue });
    }
  }
  if (!records.length) throw new Error("The mapping file contains no data rows.");
  const existing = await listProductIdentifiers(input.marketplaceId);
  const existingByIdentifier = new Map(existing.map((record) => [`${record.identifierType}:${record.identifierValue}`, record.canonicalSku]));
  for (const record of records) {
    const previous = existingByIdentifier.get(`${record.identifierType}:${record.identifierValue}`);
    if (previous && previous !== record.canonicalSku) throw new Error(`${record.identifierType} ${record.identifierValue} is already assigned to ${previous}. Mapping conflicts block import.`);
  }
  const versionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await IMPORTS.put(`mappings/${input.marketplaceId}/${versionId}/${input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`, input.text, {
    httpMetadata: { contentType: "text/csv; charset=utf-8" },
    customMetadata: { sha256: input.sha256, uploadedBy: input.createdBy },
  });
  await DB.batch([
    DB.prepare("INSERT INTO product_identifier_versions (id, source_file, source_hash, row_count, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(versionId, input.fileName, input.sha256, parsed.rows.length, createdAt, input.createdBy),
    ...records.map((record) => DB.prepare(`INSERT OR IGNORE INTO product_identifiers
      (id, version_id, marketplace_id, canonical_sku, identifier_type, identifier_value, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), versionId, record.marketplaceId, record.canonicalSku, record.identifierType, record.identifierValue, createdAt, input.createdBy)),
  ]);
  return { versionId, rowCount: parsed.rows.length, identifiers: await listProductIdentifiers(input.marketplaceId) };
}

export async function getMarketplaceSettings(marketplaceId: MarketplaceId): Promise<MarketplaceCostSettings> {
  const { DB } = bindings();
  await ensureSchema(DB);
  const row = await DB.prepare("SELECT * FROM marketplace_settings WHERE marketplace_id = ?").bind(marketplaceId).first<Record<string, unknown>>();
  if (!row) return { marketplaceId, commissionRate: marketplaceId === "amazon_de" ? 0.15 : null, vatRate: 0.19, categoryOverrides: {}, confirmed: marketplaceId === "amazon_de", revision: 0, updatedAt: "", updatedBy: "" };
  return {
    marketplaceId,
    commissionRate: row.commission_rate == null ? null : Number(row.commission_rate),
    vatRate: Number(row.vat_rate),
    categoryOverrides: JSON.parse(String(row.category_overrides_json || "{}")) as Record<string, number>,
    confirmed: Boolean(row.confirmed),
    revision: Number(row.revision),
    updatedAt: String(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

export async function saveMarketplaceSettings(input: MarketplaceCostSettings, expectedRevision: number, updatedBy: string): Promise<MarketplaceCostSettings> {
  const { DB } = bindings();
  await ensureSchema(DB);
  if (input.commissionRate != null && (input.commissionRate < 0 || input.commissionRate > 0.5)) throw new Error("Commission must be between 0% and 50%.");
  if (input.vatRate < 0 || input.vatRate > 0.3) throw new Error("VAT must be between 0% and 30%.");
  const current = await getMarketplaceSettings(input.marketplaceId);
  if (current.revision !== expectedRevision) throw Object.assign(new Error("Marketplace cost settings changed in another session."), { current });
  const updatedAt = new Date().toISOString();
  const revision = current.revision + 1;
  await DB.prepare(`INSERT INTO marketplace_settings
    (marketplace_id, commission_rate, vat_rate, category_overrides_json, confirmed, revision, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(marketplace_id) DO UPDATE SET commission_rate=excluded.commission_rate, vat_rate=excluded.vat_rate,
      category_overrides_json=excluded.category_overrides_json, confirmed=excluded.confirmed, revision=excluded.revision,
      updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .bind(input.marketplaceId, input.commissionRate, input.vatRate, JSON.stringify(input.categoryOverrides), input.confirmed ? 1 : 0, revision, updatedAt, updatedBy).run();
  return getMarketplaceSettings(input.marketplaceId);
}

