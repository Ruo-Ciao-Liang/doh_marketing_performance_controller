import { env } from "cloudflare:workers";
import baseSnapshotJson from "../data/generated/normalized.json";
import { mergeAdvertisingRange, type AdvertisingDay, type AdvertisingRangeSource, type MergedAdvertisingRange } from "./advertising-range.ts";
import { collectImportChunksSequentially } from "./import-reassembly.ts";
import type { ClassifiedUpload, UploadFileInput } from "./runtime-import.ts";
import { normalizeMarketplaceId, snapshotMarketplaceId, type MarketplaceId } from "./marketplaces.ts";

export interface SnapshotSummary {
  id: string;
  marketplaceId: MarketplaceId;
  currency: string;
  fxRateToEur: number;
  createdAt: string;
  createdBy: string;
  periodStart: string;
  periodEnd: string;
  periodDays: number;
  status: string;
  warningCount: number;
  fileCount: number;
  advertisingSales: number;
  advertisingSpend: number;
  advertisingPurchases: number;
  impressions: number;
  clicks: number;
  acos: number | null;
  retailSales: number;
  retailUnits: number;
  retailSessions: number;
  tcos: number | null;
  netContribution: number | null;
  netContributionMargin: number | null;
  retailCoverageProducts: number;
  activeProducts: number;
}

export interface StoredImportFile {
  id: string;
  snapshotId: string;
  role: string;
  fileName: string;
  objectKey: string;
  sizeBytes: number;
  rowCount: number;
  sha256: string;
  status: string;
  createdAt: string;
}

export interface StagedImportReference {
  uploadId: string;
  fileId: string;
}

interface RuntimeBindings {
  DB: D1Database;
  IMPORTS: R2Bucket;
}

const baseSnapshot = baseSnapshotJson as unknown as Record<string, unknown>;
const BASELINE_ID = "baseline-2026-07-20-product-master-2026-08-11";
const BASELINE_OBJECT_KEY = `snapshots/${BASELINE_ID}/normalized.json`;
const STAGING_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bindings(): RuntimeBindings {
  const runtime = env as unknown as Partial<RuntimeBindings>;
  if (!runtime.DB || !runtime.IMPORTS) {
    throw new Error("Persistent import storage is not available in this environment.");
  }
  return runtime as RuntimeBindings;
}

function stagingObjectKey(reference: StagedImportReference): string {
  if (!STAGING_ID_PATTERN.test(reference.uploadId) || !STAGING_ID_PATTERN.test(reference.fileId)) {
    throw new Error("The upload session is invalid. Please select the files again.");
  }
  return `staging/${reference.uploadId}/${reference.fileId}`;
}

function stagedChunkKey(reference: StagedImportReference, chunkIndex: number): string {
  return `${stagingObjectKey(reference)}/chunks/${String(chunkIndex).padStart(4, "0")}`;
}

function stagedManifestKey(reference: StagedImportReference): string {
  return `${stagingObjectKey(reference)}/manifest.json`;
}

export async function stageImportChunk(input: StagedImportReference & {
  chunk: ArrayBuffer;
  chunkIndex: number;
  chunkCount: number;
  createdBy: string;
  fileName: string;
  fileSize: number;
}): Promise<void> {
  if (!Number.isInteger(input.chunkIndex) || !Number.isInteger(input.chunkCount) ||
      input.chunkCount < 1 || input.chunkCount > 128 ||
      input.chunkIndex < 0 || input.chunkIndex >= input.chunkCount) {
    throw new Error("The file chunk sequence is invalid. Please retry the import.");
  }
  const { IMPORTS } = bindings();
  await IMPORTS.put(stagedChunkKey(input, input.chunkIndex), input.chunk, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: {
      createdBy: input.createdBy,
      chunkIndex: String(input.chunkIndex),
      chunkCount: String(input.chunkCount),
    },
  });
  if (input.chunkIndex === input.chunkCount - 1) {
    await IMPORTS.put(stagedManifestKey(input), JSON.stringify({
      fileName: input.fileName,
      fileSize: input.fileSize,
      chunkCount: input.chunkCount,
    }), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { createdBy: input.createdBy },
    });
  }
}

export async function readStagedImportFiles(
  uploadId: string,
  fileIds: string[],
  createdBy: string,
): Promise<UploadFileInput[]> {
  const { IMPORTS } = bindings();
  const files: UploadFileInput[] = [];
  for (const fileId of fileIds) {
    const reference = { uploadId, fileId };
    const manifestObject = await IMPORTS.get(stagedManifestKey(reference));
    if (!manifestObject) throw new Error("One staged file is incomplete. Please retry the import.");
    if (manifestObject.customMetadata?.createdBy !== createdBy) {
      throw new Error("This staged upload belongs to another user.");
    }
    const manifest = JSON.parse(await manifestObject.text()) as {
      fileName?: string;
      fileSize?: number;
      chunkCount?: number;
    };
    const fileSize = Number(manifest.fileSize);
    const chunkCount = Number(manifest.chunkCount);
    if (!manifest.fileName || !Number.isInteger(fileSize) ||
        !Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 128) {
      throw new Error("One staged file is missing its validation metadata.");
    }
    const chunkBuffers = await collectImportChunksSequentially(chunkCount, async (chunkIndex) => {
      const chunkObject = await IMPORTS.get(stagedChunkKey(reference, chunkIndex));
      if (!chunkObject) {
        throw new Error(`${manifest.fileName} did not upload completely. Please retry the import.`);
      }
      return chunkObject.arrayBuffer();
    });
    const totalBytes = chunkBuffers.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (totalBytes !== fileSize) {
      throw new Error(`${manifest.fileName} did not upload completely. Please retry the import.`);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunkBuffers) {
      bytes.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    files.push({
      name: manifest.fileName,
      size: totalBytes,
      text: new TextDecoder().decode(bytes),
      sha256,
    });
  }
  return files;
}

export async function deleteStagedImportFiles(
  uploadId: string,
  fileIds: string[],
  createdBy: string,
): Promise<void> {
  const { IMPORTS } = bindings();
  const keys: string[] = [];
  for (const fileId of fileIds) {
    const prefix = `${stagingObjectKey({ uploadId, fileId })}/`;
    const listed = await IMPORTS.list({ prefix, limit: 1000 });
    if (!listed.objects.length) continue;
    const first = await IMPORTS.head(listed.objects[0].key);
    if (first?.customMetadata?.createdBy === createdBy) {
      keys.push(...listed.objects.map((object) => object.key));
    }
  }
  if (keys.length) await IMPORTS.delete(keys);
}

async function ensureSchema(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS data_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      period_days INTEGER NOT NULL,
      status TEXT NOT NULL,
      warning_count INTEGER NOT NULL DEFAULT 0,
      source_set_hash TEXT NOT NULL,
      snapshot_object_key TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      advertising_sales REAL NOT NULL,
      advertising_spend REAL NOT NULL,
      advertising_purchases REAL NOT NULL,
      impressions REAL NOT NULL,
      clicks REAL NOT NULL,
      acos REAL,
      retail_sales REAL NOT NULL,
      retail_units REAL NOT NULL,
      retail_sessions REAL NOT NULL,
      tcos REAL,
      net_contribution REAL,
      net_contribution_margin REAL,
      retail_coverage_products INTEGER NOT NULL,
      active_products INTEGER NOT NULL
    )`),
    database.prepare("CREATE INDEX IF NOT EXISTS data_snapshots_created_at_idx ON data_snapshots (created_at)"),
    database.prepare(`CREATE TABLE IF NOT EXISTS import_files (
      id TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES data_snapshots(id),
      role TEXT NOT NULL,
      file_name TEXT NOT NULL,
      object_key TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    database.prepare("CREATE UNIQUE INDEX IF NOT EXISTS import_files_snapshot_role_unique ON import_files (snapshot_id, role)"),
    database.prepare("CREATE INDEX IF NOT EXISTS import_files_snapshot_idx ON import_files (snapshot_id)"),
  ]);
  const columns = await database.prepare("PRAGMA table_info(data_snapshots)").all<{ name: string }>();
  const names = new Set(columns.results.map((column) => column.name));
  const additions: D1PreparedStatement[] = [];
  if (!names.has("marketplace_id")) additions.push(database.prepare("ALTER TABLE data_snapshots ADD COLUMN marketplace_id TEXT NOT NULL DEFAULT 'amazon_de'"));
  if (!names.has("currency")) additions.push(database.prepare("ALTER TABLE data_snapshots ADD COLUMN currency TEXT NOT NULL DEFAULT 'EUR'"));
  if (!names.has("fx_rate_to_eur")) additions.push(database.prepare("ALTER TABLE data_snapshots ADD COLUMN fx_rate_to_eur REAL NOT NULL DEFAULT 1"));
  if (additions.length) await database.batch(additions);
  await database.batch([
    database.prepare("DROP INDEX IF EXISTS data_snapshots_source_set_hash_unique"),
    database.prepare("CREATE UNIQUE INDEX IF NOT EXISTS data_snapshots_marketplace_source_hash_unique ON data_snapshots (marketplace_id, source_set_hash)"),
    database.prepare("CREATE INDEX IF NOT EXISTS data_snapshots_marketplace_period_idx ON data_snapshots (marketplace_id, period_end)"),
  ]);
}

function nestedNumber(source: Record<string, unknown>, path: string[]): number | null {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function nestedString(source: Record<string, unknown>, path: string[]): string {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return "";
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : "";
}

function summaryValues(
  id: string,
  snapshot: Record<string, unknown>,
  metadata: { createdAt: string; createdBy: string; status: string; warningCount: number; fileCount: number },
): SnapshotSummary {
  return {
    id,
    marketplaceId: snapshotMarketplaceId(snapshot),
    currency: nestedString(snapshot, ["reporting", "nativeCurrency"]) || nestedString(snapshot, ["reporting", "currency"]) || "EUR",
    fxRateToEur: nestedNumber(snapshot, ["reporting", "fxRateToEur"]) ?? 1,
    createdAt: metadata.createdAt,
    createdBy: metadata.createdBy,
    periodStart: nestedString(snapshot, ["reporting", "start"]),
    periodEnd: nestedString(snapshot, ["reporting", "end"]),
    periodDays: nestedNumber(snapshot, ["reporting", "days"]) ?? 0,
    status: metadata.status,
    warningCount: metadata.warningCount,
    fileCount: metadata.fileCount,
    advertisingSales: nestedNumber(snapshot, ["totals", "advertising", "sales"]) ?? 0,
    advertisingSpend: nestedNumber(snapshot, ["totals", "advertising", "spend"]) ?? 0,
    advertisingPurchases: nestedNumber(snapshot, ["totals", "advertising", "purchases"]) ?? 0,
    impressions: nestedNumber(snapshot, ["totals", "advertising", "impressions"]) ?? 0,
    clicks: nestedNumber(snapshot, ["totals", "advertising", "clicks"]) ?? 0,
    acos: nestedNumber(snapshot, ["totals", "advertising", "acos"]),
    retailSales: nestedNumber(snapshot, ["totals", "retail", "sales"]) ?? 0,
    retailUnits: nestedNumber(snapshot, ["totals", "retail", "units"]) ?? 0,
    retailSessions: nestedNumber(snapshot, ["totals", "retail", "sessions"]) ?? 0,
    tcos: nestedNumber(snapshot, ["totals", "profitability", "tcos"]),
    netContribution: nestedNumber(snapshot, ["totals", "profitability", "netContribution"]),
    netContributionMargin: nestedNumber(snapshot, ["totals", "profitability", "netContributionMargin"]),
    retailCoverageProducts: nestedNumber(snapshot, ["quality", "retailCoverageProducts"]) ?? 0,
    activeProducts: nestedNumber(snapshot, ["quality", "activeProducts"]) ?? 0,
  };
}

function snapshotInsert(database: D1Database, summary: SnapshotSummary, sourceSetHash: string, objectKey: string): D1PreparedStatement {
  return database.prepare(`INSERT OR IGNORE INTO data_snapshots (
    id, marketplace_id, currency, fx_rate_to_eur, created_at, created_by, period_start, period_end, period_days, status, warning_count,
    source_set_hash, snapshot_object_key, file_count, advertising_sales, advertising_spend,
    advertising_purchases, impressions, clicks, acos, retail_sales, retail_units, retail_sessions,
    tcos, net_contribution, net_contribution_margin, retail_coverage_products, active_products
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    summary.id,
    summary.marketplaceId,
    summary.currency,
    summary.fxRateToEur,
    summary.createdAt,
    summary.createdBy,
    summary.periodStart,
    summary.periodEnd,
    summary.periodDays,
    summary.status,
    summary.warningCount,
    sourceSetHash,
    objectKey,
    summary.fileCount,
    summary.advertisingSales,
    summary.advertisingSpend,
    summary.advertisingPurchases,
    summary.impressions,
    summary.clicks,
    summary.acos,
    summary.retailSales,
    summary.retailUnits,
    summary.retailSessions,
    summary.tcos,
    summary.netContribution,
    summary.netContributionMargin,
    summary.retailCoverageProducts,
    summary.activeProducts,
  );
}

async function ensureBaseline(): Promise<void> {
  const { DB, IMPORTS } = bindings();
  await ensureSchema(DB);
  const existing = await DB.prepare("SELECT id FROM data_snapshots WHERE id = ?").bind(BASELINE_ID).first<{ id: string }>();
  if (existing) return;
  const generatedAt = nestedString(baseSnapshot, ["generatedAt"]) || new Date().toISOString();
  const summary = summaryValues(BASELINE_ID, baseSnapshot, {
    createdAt: generatedAt,
    createdBy: "Initial immutable source files",
    status: "ready",
    warningCount: 0,
    fileCount: Array.isArray(baseSnapshot.imports) ? baseSnapshot.imports.length : 9,
  });
  await IMPORTS.put(BASELINE_OBJECT_KEY, JSON.stringify(baseSnapshot), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { periodEnd: summary.periodEnd, source: "baseline" },
  });
  await DB.batch([
    snapshotInsert(DB, summary, `baseline:${summary.periodStart}:${summary.periodEnd}`, BASELINE_OBJECT_KEY),
  ]);
}

function rowToSummary(row: Record<string, unknown>): SnapshotSummary {
  return {
    id: String(row.id),
    marketplaceId: normalizeMarketplaceId(String(row.marketplace_id ?? "amazon_de")),
    currency: String(row.currency ?? "EUR"),
    fxRateToEur: Number(row.fx_rate_to_eur ?? 1),
    createdAt: String(row.created_at),
    createdBy: String(row.created_by),
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    periodDays: Number(row.period_days),
    status: String(row.status),
    warningCount: Number(row.warning_count),
    fileCount: Number(row.file_count),
    advertisingSales: Number(row.advertising_sales),
    advertisingSpend: Number(row.advertising_spend),
    advertisingPurchases: Number(row.advertising_purchases),
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    acos: row.acos == null ? null : Number(row.acos),
    retailSales: Number(row.retail_sales),
    retailUnits: Number(row.retail_units),
    retailSessions: Number(row.retail_sessions),
    tcos: row.tcos == null ? null : Number(row.tcos),
    netContribution: row.net_contribution == null ? null : Number(row.net_contribution),
    netContributionMargin: row.net_contribution_margin == null ? null : Number(row.net_contribution_margin),
    retailCoverageProducts: Number(row.retail_coverage_products),
    activeProducts: Number(row.active_products),
  };
}

export async function listSnapshots(marketplaceId: MarketplaceId = "amazon_de"): Promise<SnapshotSummary[]> {
  await ensureBaseline();
  const { DB } = bindings();
  const result = await DB.prepare("SELECT * FROM data_snapshots WHERE marketplace_id = ? ORDER BY period_end DESC, created_at DESC").bind(marketplaceId).all<Record<string, unknown>>();
  return result.results.map(rowToSummary);
}

export async function listAllSnapshots(): Promise<SnapshotSummary[]> {
  await ensureBaseline();
  const { DB } = bindings();
  const result = await DB.prepare("SELECT * FROM data_snapshots ORDER BY period_end DESC, created_at DESC").all<Record<string, unknown>>();
  return result.results.map(rowToSummary);
}

async function loadSnapshotObject(snapshotId: string): Promise<Record<string, unknown>> {
  const { DB, IMPORTS } = bindings();
  const row = await DB.prepare("SELECT snapshot_object_key FROM data_snapshots WHERE id = ?").bind(snapshotId).first<{ snapshot_object_key: string }>();
  if (!row) throw new Error("The requested historical snapshot metadata is unavailable.");
  const object = await IMPORTS.get(row.snapshot_object_key);
  if (!object) throw new Error("The requested historical snapshot file is unavailable.");
  return JSON.parse(await object.text()) as Record<string, unknown>;
}

export async function getSnapshot(snapshotId?: string, marketplaceId: MarketplaceId = "amazon_de"): Promise<{ snapshot: Record<string, unknown>; summary: SnapshotSummary; history: SnapshotSummary[] }> {
  const history = await listSnapshots(marketplaceId);
  const selected = snapshotId ? history.find((item) => item.id === snapshotId) : history[0];
  if (!selected) throw new Error("The requested historical snapshot does not exist.");
  const snapshot = await loadSnapshotObject(selected.id);
  return { snapshot, summary: selected, history };
}

export async function readSnapshotImportFiles(snapshotId: string, marketplaceId: MarketplaceId): Promise<UploadFileInput[]> {
  await ensureBaseline();
  const { DB, IMPORTS } = bindings();
  const snapshot = await DB.prepare("SELECT id FROM data_snapshots WHERE id = ? AND marketplace_id = ?")
    .bind(snapshotId, marketplaceId)
    .first<{ id: string }>();
  if (!snapshot) throw new Error("The retained snapshot does not exist for this marketplace.");
  const result = await DB.prepare("SELECT * FROM import_files WHERE snapshot_id = ? ORDER BY created_at, role")
    .bind(snapshotId)
    .all<Record<string, unknown>>();
  if (!result.results.length) throw new Error("The retained snapshot has no preserved raw files to reprocess.");
  const files: UploadFileInput[] = [];
  for (const row of result.results) {
    const object = await IMPORTS.get(String(row.object_key));
    if (!object) throw new Error(`The preserved source file ${String(row.file_name)} is unavailable.`);
    const text = await object.text();
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (sha256 !== String(row.sha256)) throw new Error(`The preserved source file ${String(row.file_name)} failed its integrity check.`);
    files.push({ name: String(row.file_name), size: bytes.byteLength, text, sha256 });
  }
  return files;
}

export async function getAdvertisingRange(start: string, end: string, marketplaceId: MarketplaceId = "amazon_de"): Promise<MergedAdvertisingRange> {
  const history = await listSnapshots(marketplaceId);
  const overlapping = history.filter((item) => item.periodStart <= end && item.periodEnd >= start);
  const sources: AdvertisingRangeSource[] = [];
  for (const summary of overlapping) {
    const snapshot = await loadSnapshotObject(summary.id);
    const daily = Array.isArray(snapshot.daily) ? snapshot.daily as AdvertisingDay[] : [];
    sources.push({
      id: summary.id,
      createdAt: summary.createdAt,
      periodStart: summary.periodStart,
      periodEnd: summary.periodEnd,
      daily,
    });
  }
  return mergeAdvertisingRange(sources, start, end);
}

export async function sourceSetHash(files: { role: string; sha256: string }[]): Promise<string> {
  const source = files.map((file) => `${file.role}:${file.sha256}`).sort().join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function findSnapshotBySourceHash(hash: string, marketplaceId: MarketplaceId = "amazon_de"): Promise<SnapshotSummary | null> {
  await ensureBaseline();
  const { DB } = bindings();
  const row = await DB.prepare("SELECT * FROM data_snapshots WHERE marketplace_id = ? AND source_set_hash = ?").bind(marketplaceId, hash).first<Record<string, unknown>>();
  return row ? rowToSummary(row) : null;
}

export async function saveSnapshot(input: {
  id: string;
  createdBy: string;
  snapshot: Record<string, unknown>;
  status: string;
  warnings: string[];
  sourceHash: string;
  rawFiles: UploadFileInput[];
  classifiedFiles: ClassifiedUpload[];
}): Promise<{ summary: SnapshotSummary; history: SnapshotSummary[] }> {
  await ensureBaseline();
  const { DB, IMPORTS } = bindings();
  const createdAt = new Date().toISOString();
  const marketplaceId = snapshotMarketplaceId(input.snapshot);
  const snapshotKey = `snapshots/${marketplaceId}/${input.id}/normalized.json`;
  const summary = summaryValues(input.id, input.snapshot, {
    createdAt,
    createdBy: input.createdBy,
    status: input.status,
    warningCount: input.warnings.length,
    fileCount: input.classifiedFiles.length,
  });
  await IMPORTS.put(snapshotKey, JSON.stringify(input.snapshot), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { periodStart: summary.periodStart, periodEnd: summary.periodEnd, uploadedBy: input.createdBy },
  });

  const fileStatements: D1PreparedStatement[] = [];
  for (const classified of input.classifiedFiles) {
    const raw = input.rawFiles.find((file) => file.name === classified.name)!;
    const safeName = classified.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectKey = `snapshots/${marketplaceId}/${input.id}/sources/${classified.role}-${safeName}`;
    await IMPORTS.put(objectKey, raw.text, {
      httpMetadata: { contentType: "text/csv; charset=utf-8" },
      customMetadata: { role: classified.role, originalFilename: classified.name, sha256: classified.sha256 },
    });
    fileStatements.push(DB.prepare(`INSERT INTO import_files (
      id, snapshot_id, role, file_name, object_key, size_bytes, row_count, sha256, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      crypto.randomUUID(),
      input.id,
      classified.role,
      classified.name,
      objectKey,
      classified.size,
      classified.rows.length,
      classified.sha256,
      "ready",
      createdAt,
    ));
  }
  await DB.batch([snapshotInsert(DB, summary, input.sourceHash, snapshotKey), ...fileStatements]);
  return { summary, history: await listSnapshots(marketplaceId) };
}
