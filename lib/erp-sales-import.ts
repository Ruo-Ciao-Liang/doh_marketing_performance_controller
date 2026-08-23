// Client-side ERP sales-summary importer. One file per marketplace, holding retail
// sales by SKU (units + revenue) exported from the ERP. Parsed in the browser and
// stored locally; it does not yet drive the dashboard totals (that wiring is a
// follow-up) but is a required part of the import package and is matched to the
// product master by SKU.

import { parseLocaleNumber, readWorkbookFile, sheetToObjects } from "@/lib/workbook-reader";

export interface ErpSalesRow {
  sku: string;
  units: number | null;
  netRevenue: number | null;
  grossRevenue: number | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface ErpSalesStats {
  fileName: string;
  format: "xlsx" | "csv";
  totalRows: number;
  rows: number;
  withSku: number;
  withRevenue: number;
}

export interface ErpSalesParseResult {
  rows: ErpSalesRow[];
  stats: ErpSalesStats;
  warnings: string[];
}

type Row = Record<string, string>;

const FIELD_ALIASES = {
  sku: ["SKU", "Artikelnummer", "Internal SKU", "Interne SKU", "Item number", "Article number"],
  units: ["Units sold", "Units", "Quantity", "Quantity sold", "Menge", "Stückzahl", "Verkaufte Stückzahl", "Absatz"],
  net: ["Net revenue", "Net sales", "Nettoumsatz", "Umsatz netto", "Revenue net", "Umsatz (netto)"],
  gross: ["Gross revenue", "Gross sales", "Bruttoumsatz", "Umsatz brutto", "Revenue", "Umsatz", "Sales", "Umsatz (brutto)"],
  periodStart: ["Period start", "Start date", "Von", "Zeitraum von", "Startdatum"],
  periodEnd: ["Period end", "End date", "Bis", "Zeitraum bis", "Enddatum"],
} as const;

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

function buildFieldIndex(headers: string[]): Record<keyof typeof FIELD_ALIASES, string | null> {
  const lookup = new Map<string, string>();
  for (const header of headers) lookup.set(normalizeHeader(header), header);
  const resolved = {} as Record<keyof typeof FIELD_ALIASES, string | null>;
  for (const field of Object.keys(FIELD_ALIASES) as (keyof typeof FIELD_ALIASES)[]) {
    resolved[field] = null;
    for (const alias of FIELD_ALIASES[field]) {
      const match = lookup.get(normalizeHeader(alias));
      if (match) { resolved[field] = match; break; }
    }
  }
  return resolved;
}

function cell(row: Row, header: string | null): string {
  if (!header) return "";
  return (row[header] ?? "").trim();
}

function round(value: number | null, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export async function parseErpSalesFile(file: File): Promise<ErpSalesParseResult> {
  const lower = file.name.toLowerCase();
  const isXlsx = lower.endsWith(".xlsx");
  const isCsv = lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt");
  if (!isXlsx && !isCsv) throw new Error("Unsupported file type. Upload the ERP sales summary as .xlsx or .csv.");

  const sheets = await readWorkbookFile(file);
  const objectRows = sheetToObjects(sheets[0]?.rows ?? []);
  const warnings: string[] = [];
  if (!objectRows.length) return { rows: [], stats: { fileName: file.name, format: isXlsx ? "xlsx" : "csv", totalRows: 0, rows: 0, withSku: 0, withRevenue: 0 }, warnings: ["The file has no data rows."] };

  const fields = buildFieldIndex(Object.keys(objectRows[0]));
  if (!fields.sku) warnings.push("No SKU column was found. Expected a column such as \"SKU\" or \"Artikelnummer\".");
  if (!fields.gross && !fields.net) warnings.push("No revenue column was found. Expected \"Net revenue\" or \"Gross revenue\".");

  const rows: ErpSalesRow[] = [];
  for (const row of objectRows) {
    const sku = cell(row, fields.sku);
    if (!sku) continue;
    rows.push({
      sku,
      units: parseLocaleNumber(cell(row, fields.units)),
      netRevenue: round(parseLocaleNumber(cell(row, fields.net))),
      grossRevenue: round(parseLocaleNumber(cell(row, fields.gross))),
      periodStart: cell(row, fields.periodStart) || null,
      periodEnd: cell(row, fields.periodEnd) || null,
    });
  }

  return {
    rows,
    stats: {
      fileName: file.name,
      format: isXlsx ? "xlsx" : "csv",
      totalRows: objectRows.length,
      rows: rows.length,
      withSku: rows.length,
      withRevenue: rows.filter((r) => r.netRevenue != null || r.grossRevenue != null).length,
    },
    warnings,
  };
}
