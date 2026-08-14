import { createTabularWorkbook, type CellValue } from "./review-export.ts";

type SnapshotRecord = Record<string, unknown>;

function printable(value: unknown): CellValue {
  if (value == null || typeof value === "string" || typeof value === "number") return value as CellValue;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return JSON.stringify(value);
}

function flatten(record: SnapshotRecord, prefix = ""): SnapshotRecord {
  const output: SnapshotRecord = {};
  for (const [key, value] of Object.entries(record)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) Object.assign(output, flatten(value as SnapshotRecord, name));
    else output[name] = value;
  }
  return output;
}

function table(records: unknown[]): CellValue[][] {
  const flattened = records.filter((record): record is SnapshotRecord => Boolean(record) && typeof record === "object" && !Array.isArray(record)).map((record) => flatten(record));
  if (!flattened.length) return [["No rows"]];
  const headers = [...new Set(flattened.flatMap((record) => Object.keys(record)))];
  return [headers, ...flattened.map((record) => headers.map((header) => printable(record[header])))];
}

function keyValues(record: unknown): CellValue[][] {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [["Field", "Value"]];
  const values = flatten(record as SnapshotRecord);
  return [["Field", "Value"], ...Object.entries(values).map(([key, value]) => [key, printable(value)])];
}

export function allDataFilename(reportEnd: string) {
  return `amazon-bidding-control-all-data-${reportEnd}.xlsx`;
}

export function createAllDataWorkbook(snapshot: SnapshotRecord) {
  const reporting = snapshot.reporting as SnapshotRecord;
  const periodEnd = typeof reporting?.end === "string" ? reporting.end : new Date().toISOString().slice(0, 10);
  return createTabularWorkbook([
    { name: "Snapshot summary", rows: keyValues({ generatedAt: snapshot.generatedAt, reporting: snapshot.reporting, settings: snapshot.settings, totals: snapshot.totals }) },
    { name: "Daily performance", rows: table(snapshot.daily as unknown[] ?? []) },
    { name: "Products", rows: table(snapshot.products as unknown[] ?? []) },
    { name: "Product master", rows: table((snapshot.catalogProducts as unknown[] | undefined) ?? (snapshot.products as unknown[] | undefined) ?? []) },
    { name: "Campaigns", rows: table(snapshot.campaigns as unknown[] ?? []) },
    { name: "Placements", rows: table(snapshot.placements as unknown[] ?? []) },
    { name: "Targets", rows: table(snapshot.targetPerformance as unknown[] ?? []) },
    { name: "Promotion candidates", rows: table(snapshot.promotionCandidates as unknown[] ?? []) },
    { name: "Source files", rows: table(snapshot.imports as unknown[] ?? []) },
    { name: "Data quality", rows: keyValues(snapshot.quality) },
  ], `Amazon Bidding Control complete snapshot ${periodEnd}`, `${periodEnd}T12:00:00Z`);
}
