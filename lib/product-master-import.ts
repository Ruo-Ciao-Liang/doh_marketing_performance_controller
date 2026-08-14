// Client-side product master importer.
//
// The completed product master is normally a fixed, build-time source rebuilt by
// scripts/import_data.py. This module lets a user upload their own product master
// (.xlsx or .csv) entirely in the browser — no server, database or R2 needed — and
// turns it into the canonical catalog the dashboard renders. Parsing mirrors the
// Python importer's column mapping and margin policy so an uploaded file behaves the
// same as the baked-in baseline.

import { parseLocaleNumber, readWorkbookFile, sheetToObjects } from "@/lib/workbook-reader";

const VAT_RATE = 0.19;
const PROVISION_RATE = 0.15;

export interface CatalogProduct {
  sku: string;
  canonicalSku: string;
  ean: string | null;
  eanAmbiguous: boolean;
  asin: string;
  name: string;
  supplier: string | null;
  manufacturerNumber: string | null;
  manufacturer: string | null;
  price: number | null;
  margin: number | null;
  category: string | null;
  economicsDescription: string | null;
  unitCosts: {
    purchaseNet: number | null;
    deliveryNet: number | null;
    landedNet: number | null;
    provisionRate: number;
    sourceSku: string;
  } | null;
  active: boolean;
  retail: null;
  advertising: null;
  advertisingStatus: string;
}

export interface ProductMasterStats {
  fileName: string;
  format: "xlsx" | "csv";
  totalRows: number;
  products: number;
  withEan: number;
  withPrice: number;
  withMargin: number;
  withCost: number;
  ambiguousEans: number;
  duplicateSkus: number;
}

export interface ProductMasterParseResult {
  products: CatalogProduct[];
  stats: ProductMasterStats;
  warnings: string[];
}

type Row = Record<string, string>;

// Column aliases — the canonical German master headers come first, followed by
// common English equivalents so a plainer export still resolves.
const FIELD_ALIASES = {
  sku: ["Artikelnummer", "SKU", "Internal SKU", "Interne SKU", "Article number", "Item number"],
  ean: ["EAN / GTIN", "EAN", "GTIN", "EAN/GTIN", "Barcode"],
  name: ["Bezeichnung", "Name", "Product name", "Description", "Produktname", "Title"],
  price: ["price", "Price", "Available price", "VK", "VK (€)", "Verkaufspreis", "Selling price", "Retail price"],
  purchase: ["Letzter EK", "EK", "EK (€ netto)", "Einstandspreis", "Einstandspreis (€ netto)", "Purchase cost", "Purchase price", "Cost"],
  delivery: ["Logistikkosten", "Logistic Cost", "Logistic Cost (€ netto)", "Delivery cost", "Shipping cost", "Fulfilment cost"],
  landed: ["Landed Cost", "Landed cost", "Landed", "Gesamtkosten"],
  supplier: ["Firma / Lieferant", "Lieferant", "Supplier", "Vendor"],
  manufacturerNumber: ["Hersteller-Nr.", "Hersteller-Nr", "MPN", "Manufacturer number", "Herstellernummer"],
  manufacturer: ["Herstellername", "Hersteller", "Manufacturer", "Brand"],
  asin: ["Amazon ASIN", "ASIN", "asin1", "asin"],
  category: ["Kategorie", "Category", "Product category"],
  margin: ["Margin (%)", "Margin", "Marge", "Marge (%)", "Contribution margin"],
} as const;

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
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

function cellText(row: Row, header: string | null): string {
  if (!header) return "";
  return (row[header] ?? "").trim();
}

function round(value: number | null, digits = 4): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// A margin cell may be a ratio (0.25) or a percentage (25 / 25.09). Values whose
// magnitude clearly exceeds 1 are read as percentages.
function normalizeMargin(value: number | null): number | null {
  if (value == null) return null;
  const ratio = Math.abs(value) > 1.5 ? value / 100 : value;
  return round(ratio);
}

function emptyCounts(): Omit<ProductMasterStats, "fileName" | "format" | "totalRows"> {
  return { products: 0, withEan: 0, withPrice: 0, withMargin: 0, withCost: 0, ambiguousEans: 0, duplicateSkus: 0 };
}

function buildProducts(rows: Row[]): { products: CatalogProduct[]; warnings: string[]; counts: Omit<ProductMasterStats, "fileName" | "format" | "totalRows"> } {
  const warnings: string[] = [];
  if (!rows.length) return { products: [], warnings: ["The file has no data rows."], counts: emptyCounts() };
  const fields = buildFieldIndex(Object.keys(rows[0]));
  if (!fields.sku) {
    warnings.push("No SKU column was found. Expected a column such as \"Artikelnummer\", \"SKU\" or \"Internal SKU\".");
    return { products: [], warnings, counts: emptyCounts() };
  }

  const eanCounts = new Map<string, number>();
  for (const row of rows) {
    const ean = cellText(row, fields.ean);
    if (ean) eanCounts.set(ean, (eanCounts.get(ean) ?? 0) + 1);
  }

  const seen = new Set<string>();
  let duplicateSkus = 0;
  const products: CatalogProduct[] = [];
  for (const row of rows) {
    const sku = cellText(row, fields.sku);
    if (!sku) continue;
    if (seen.has(sku)) { duplicateSkus++; continue; }
    seen.add(sku);

    const ean = cellText(row, fields.ean) || null;
    const price = round(parseLocaleNumber(cellText(row, fields.price)), 2);
    const purchase = round(parseLocaleNumber(cellText(row, fields.purchase)), 2);
    const delivery = round(parseLocaleNumber(cellText(row, fields.delivery)), 2);
    const landed = round(parseLocaleNumber(cellText(row, fields.landed)), 2);

    let margin = normalizeMargin(parseLocaleNumber(cellText(row, fields.margin)));
    if (margin == null && price && purchase != null && delivery != null) {
      const netPrice = price / (1 + VAT_RATE);
      if (netPrice > 0) margin = round((netPrice - purchase - delivery) / netPrice);
    }
    if (margin == null && price && landed != null) {
      const netPrice = price / (1 + VAT_RATE);
      if (netPrice > 0) margin = round((netPrice - landed) / netPrice);
    }

    const hasCost = purchase != null || delivery != null || landed != null;
    const name = cellText(row, fields.name) || `Product ${sku}`;
    products.push({
      sku,
      canonicalSku: sku,
      ean,
      eanAmbiguous: Boolean(ean && (eanCounts.get(ean) ?? 0) > 1),
      asin: cellText(row, fields.asin),
      name,
      supplier: cellText(row, fields.supplier) || null,
      manufacturerNumber: cellText(row, fields.manufacturerNumber) || null,
      manufacturer: cellText(row, fields.manufacturer) || null,
      price,
      margin,
      category: cellText(row, fields.category) || null,
      economicsDescription: cellText(row, fields.name) || null,
      unitCosts: hasCost ? { purchaseNet: purchase, deliveryNet: delivery, landedNet: landed, provisionRate: PROVISION_RATE, sourceSku: sku } : null,
      active: true,
      retail: null,
      advertising: null,
      advertisingStatus: "Uploaded from product master",
    });
  }

  const counts = {
    products: products.length,
    withEan: products.filter((product) => product.ean).length,
    withPrice: products.filter((product) => product.price != null).length,
    withMargin: products.filter((product) => product.margin != null).length,
    withCost: products.filter((product) => product.unitCosts != null).length,
    ambiguousEans: products.filter((product) => product.eanAmbiguous).length,
    duplicateSkus,
  };
  if (!fields.price) warnings.push("No price column was found, so contribution margin cannot be derived from price and cost.");
  if (!fields.ean) warnings.push("No EAN column was found. Products were imported by SKU only.");
  if (duplicateSkus > 0) warnings.push(`${duplicateSkus} duplicate SKU row${duplicateSkus === 1 ? "" : "s"} were ignored (first occurrence kept).`);
  return { products, warnings, counts };
}

export async function parseProductMasterFile(file: File): Promise<ProductMasterParseResult> {
  const lower = file.name.toLowerCase();
  const isXlsx = lower.endsWith(".xlsx");
  const isCsv = lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt");
  if (!isXlsx && !isCsv) {
    throw new Error("Unsupported file type. Upload a product master as .xlsx or .csv.");
  }
  const sheets = await readWorkbookFile(file);
  const rows = sheetToObjects(sheets[0]?.rows ?? []);
  const { products, warnings, counts } = buildProducts(rows);
  return {
    products,
    warnings,
    stats: { fileName: file.name, format: isXlsx ? "xlsx" : "csv", totalRows: rows.length, ...counts },
  };
}
