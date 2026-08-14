import { env } from "cloudflare:workers";
import { comparisonRow, shiftedRange } from "./marketplace-comparison.ts";
import { marketplaceIds, marketplaceRegistry } from "./marketplaces.ts";

interface Bindings { DB: D1Database; IMPORTS: R2Bucket }
interface SnapshotRow { id: string; marketplace_id: string; period_start: string; period_end: string; file_count: number; snapshot_object_key: string }

function bindings(): Bindings {
  const runtime = env as unknown as Partial<Bindings>;
  if (!runtime.DB || !runtime.IMPORTS) throw new Error("Marketplace comparison storage is unavailable.");
  return runtime as Bindings;
}

async function load(key: string): Promise<Record<string, unknown>> {
  const object = await bindings().IMPORTS.get(key);
  if (!object) throw new Error("A retained normalized snapshot file is unavailable.");
  return JSON.parse(await object.text()) as Record<string, unknown>;
}

export async function getAlignedComparisonRows(start: string, end: string) {
  const { DB } = bindings();
  const rows = [];
  for (const marketplaceId of marketplaceIds) {
    const current = await DB.prepare(`SELECT id, marketplace_id, period_start, period_end, file_count, snapshot_object_key
      FROM data_snapshots WHERE marketplace_id = ? AND period_start = ? AND period_end = ?
      ORDER BY created_at DESC LIMIT 1`).bind(marketplaceId, start, end).first<SnapshotRow>();
    if (!current) {
      rows.push({ marketplaceId, marketplace: marketplaceRegistry[marketplaceId].name, periodStart: start, periodEnd: end, currency: "EUR", fxRateToEur: 1, sourceStatus: "missing", sourceCount: 0, coverageNote: `No retained ${marketplaceRegistry[marketplaceId].name} snapshot exactly matches this date range.`, metrics: {}, mom: {}, yoy: {} });
      continue;
    }
    const month = shiftedRange(start, end, "mom"); const year = shiftedRange(start, end, "yoy");
    const prior = async (range: { start: string; end: string }) => DB.prepare(`SELECT id, marketplace_id, period_start, period_end, file_count, snapshot_object_key
      FROM data_snapshots WHERE marketplace_id = ? AND period_start = ? AND period_end = ?
      ORDER BY created_at DESC LIMIT 1`).bind(marketplaceId, range.start, range.end).first<SnapshotRow>();
    const monthRow = await prior(month); const yearRow = await prior(year);
    rows.push(comparisonRow({ marketplaceId, snapshot: await load(current.snapshot_object_key), previousMonth: monthRow ? await load(monthRow.snapshot_object_key) : null, previousYear: yearRow ? await load(yearRow.snapshot_object_key) : null, sourceCount: current.file_count }));
  }
  return rows;
}

