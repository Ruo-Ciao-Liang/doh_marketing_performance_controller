// Client-side eBay (DE) importer.
//
// eBay exports a listing catalog, an orders report, and several Promoted Listings
// reports (priority campaign / listing / keyword / search query, plus general
// listing). This module reads them in the browser and reconciles them into one
// EUR snapshot: retail from the orders report (joined by SKU), advertising from the
// priority-campaign summary plus general-listing report. SKUs (eBay "custom label" /
// order "Bestandseinheit") match the internal product-master SKUs directly.

import { parseLocaleNumber, readWorkbookFile, sheetToObjects, type WorkbookSheet } from "@/lib/workbook-reader";

export interface EbayListing {
  itemNumber: string;
  sku: string;
  title: string;
  ean: string | null;
  price: number | null;
  availableQty: number | null;
  soldQty: number | null;
  category: string | null;
}

export interface EbayOrderAgg {
  sku: string;
  title: string;
  sales: number;
  units: number;
  transactions: number;
}

export interface EbayCampaign {
  name: string;
  campaignId: string;
  type: "priority" | "general";
  status: string;
  impressions: number;
  clicks: number;
  ctr: number | null;
  spend: number;
  sales: number;
  unitsSold: number;
  roas: number | null;
  cpc: number | null;
}

export interface EbayAdListing {
  itemNumber: string;
  sku: string | null;
  title: string;
  campaign: string;
  type: "priority" | "general";
  impressions: number;
  clicks: number;
  spend: number;
  sales: number;
  unitsSold: number;
}

export interface EbayKeyword {
  campaign: string;
  adGroup: string;
  keyword: string;
  matchType: string;
  bid: number | null;
  status: string;
  impressions: number;
  clicks: number;
  spend: number;
  sales: number;
  unitsSold: number;
}

export interface EbaySource {
  key: "active_listings" | "orders" | "priority_campaign" | "priority_listing" | "general_listing" | "priority_keyword" | "search_query";
  label: string;
  fileName: string;
  rows: number;
}

export interface EbaySnapshot {
  periodStart: string | null;
  periodEnd: string | null;
  days: number | null;
  currency: "EUR";
  totals: {
    advertising: { impressions: number; clicks: number; ctr: number | null; spend: number; sales: number; unitsSold: number; cpc: number | null; acos: number | null; roas: number | null };
    retail: { sales: number; transactions: number; unitsSold: number };
    combined: { tacos: number | null; adShareOfSales: number | null };
  };
  listings: EbayListing[];
  orders: EbayOrderAgg[];
  campaigns: EbayCampaign[];
  adListings: EbayAdListing[];
  keywords: EbayKeyword[];
  sources: EbaySource[];
  warnings: string[];
}

type Row = Record<string, string>;

const DE_MONTHS: Record<string, number> = { jan: 1, feb: 2, "mär": 3, mar: 3, apr: 4, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dez: 12 };

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

function pick(row: Row, ...aliases: string[]): string {
  const lookup = new Map<string, string>();
  for (const key of Object.keys(row)) lookup.set(normalizeHeader(key), key);
  for (const alias of aliases) {
    const key = lookup.get(normalizeHeader(alias));
    if (key != null && (row[key] ?? "").trim()) return row[key].trim();
  }
  return "";
}

function num(row: Row, ...aliases: string[]): number | null {
  return parseLocaleNumber(pick(row, ...aliases));
}

function round(value: number | null, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// "01. Jul 2026" / "01 Jul 2026" → ISO. eBay Promoted reports use German month names.
function parseGermanDate(raw: string): string | null {
  const match = /(\d{1,2})\.?\s+([A-Za-zä]+)\.?\s+(\d{4})/.exec(raw.trim());
  if (!match) return null;
  const key = match[2].toLowerCase();
  const month = DE_MONTHS[key.slice(0, 3)] ?? DE_MONTHS[key];
  if (!month) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function headerRowOf(rows: string[][]): string[] {
  return rows.find((row) => row && row.filter((cell) => (cell ?? "").trim()).length > 1) ?? [];
}

function hasHeaders(rows: string[][], ...required: string[]): boolean {
  const present = new Set(headerRowOf(rows).map((cell) => normalizeHeader(cell ?? "")));
  return required.every((header) => present.has(normalizeHeader(header)));
}

function dayCount(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

export async function parseEbayFiles(files: File[]): Promise<EbaySnapshot> {
  const warnings: string[] = [];
  const sources: EbaySource[] = [];
  let listings: EbayListing[] = [];
  const orderAgg = new Map<string, EbayOrderAgg>();
  const campaigns: EbayCampaign[] = [];
  const adListings: EbayAdListing[] = [];
  const keywords: EbayKeyword[] = [];
  let periodStart: string | null = null;
  let periodEnd: string | null = null;

  const notePeriod = (row: Row) => {
    const start = parseGermanDate(pick(row, "Startdatum"));
    const end = parseGermanDate(pick(row, "Enddatum"));
    if (start) periodStart = periodStart ?? start;
    if (end) periodEnd = periodEnd ?? end;
  };

  for (const file of files) {
    let sheets: WorkbookSheet[];
    try {
      sheets = await readWorkbookFile(file);
    } catch (error) {
      warnings.push(`${file.name}: ${error instanceof Error ? error.message : "could not be read"}.`);
      continue;
    }
    for (const sheet of sheets) {
      const rows = sheet.rows;
      if (!rows.length) continue;

      // Active listings catalog
      if (hasHeaders(rows, "Item number", "Custom label (SKU)")) {
        const objects = sheetToObjects(rows);
        listings = objects.map((row) => ({
          itemNumber: pick(row, "Item number"),
          sku: pick(row, "Custom label (SKU)"),
          title: pick(row, "Title"),
          ean: pick(row, "P:EAN", "EAN") || null,
          price: round(num(row, "Current price", "Start price")),
          availableQty: num(row, "Available quantity"),
          soldQty: num(row, "Sold quantity"),
          category: pick(row, "eBay category 1 name") || null,
        })).filter((listing) => listing.itemNumber || listing.sku);
        sources.push({ key: "active_listings", label: "Active listings", fileName: file.name, rows: objects.length });
        continue;
      }

      // Orders report (retail) — aggregate by SKU
      if (hasHeaders(rows, "Bestandseinheit", "Angebotstitel")) {
        const objects = sheetToObjects(rows);
        let count = 0;
        for (const row of objects) {
          const sku = pick(row, "Bestandseinheit");
          if (!sku) continue;
          count++;
          const units = num(row, "Anzahl") ?? 0;
          const lineTotal = num(row, "Gesamtbetrag") ?? ((num(row, "Verkauft für") ?? 0) * units);
          const current = orderAgg.get(sku) ?? { sku, title: pick(row, "Angebotstitel"), sales: 0, units: 0, transactions: 0 };
          current.sales += lineTotal;
          current.units += units;
          current.transactions += 1;
          if (!current.title) current.title = pick(row, "Angebotstitel");
          orderAgg.set(sku, current);
        }
        sources.push({ key: "orders", label: "Orders report", fileName: file.name, rows: count });
        continue;
      }

      // Priority search-query report
      if (hasHeaders(rows, "Suchanfrage", "Keyword des Verkäufers")) {
        const objects = sheetToObjects(rows);
        sources.push({ key: "search_query", label: "Search query", fileName: file.name, rows: objects.length });
        continue;
      }

      // Priority keyword report
      if (hasHeaders(rows, "Keyword des Verkäufers", "Gebot")) {
        const objects = sheetToObjects(rows);
        for (const row of objects) {
          const keyword = pick(row, "Keyword des Verkäufers");
          if (!keyword) continue;
          notePeriod(row);
          keywords.push({
            campaign: pick(row, "Name der Kampagne"),
            adGroup: pick(row, "Name der Anzeigengruppe"),
            keyword,
            matchType: pick(row, "Keyword-Übereinstimmungstyp"),
            bid: num(row, "Gebot", "Keyword-Gebot"),
            status: pick(row, "Status"),
            impressions: num(row, "Impressions") ?? 0,
            clicks: num(row, "Klicks") ?? 0,
            spend: round(num(row, "Anzeigengebühren (in Rechnungswährung)", "Anzeigengebühren")) ?? 0,
            sales: round(num(row, "Umsatz (in Rechnungswährung)", "Umsatz")) ?? 0,
            unitsSold: num(row, "Verkaufte Stückzahl") ?? 0,
          });
        }
        sources.push({ key: "priority_keyword", label: "Promoted keyword", fileName: file.name, rows: objects.length });
        continue;
      }

      // General (off-site) listing report
      if (hasHeaders(rows, "Artikelnr.") && (hasHeaders(rows, "Anzeigen-Impressions (über Platzierungen bei eBay)") || hasHeaders(rows, "Gesamtumsatz mit Anzeigen (in Rechnungswährung)"))) {
        const objects = sheetToObjects(rows);
        for (const row of objects) {
          const itemNumber = pick(row, "Artikelnr.");
          if (!itemNumber) continue;
          notePeriod(row);
          adListings.push({
            itemNumber,
            sku: null,
            title: pick(row, "Titel"),
            campaign: pick(row, "Name der Kampagne"),
            type: "general",
            impressions: num(row, "Anzeigen-Impressions (über Platzierungen bei eBay)", "Anzeigen-Impressions") ?? 0,
            clicks: num(row, "Anzeigen-Klicks insgesamt", "Anzeigen-Klicks (über Platzierungen bei eBay)") ?? 0,
            spend: round(num(row, "Anzeigengebühren (in Rechnungswährung)", "Anzeigengebühren")) ?? 0,
            sales: round(num(row, "Gesamtumsatz mit Anzeigen (in Rechnungswährung)", "Anzeigen-Umsatz (über Platzierungen bei eBay)")) ?? 0,
            unitsSold: num(row, "Verkauft mit Anzeigen - Gesamtstückzahl") ?? 0,
          });
        }
        sources.push({ key: "general_listing", label: "General listing", fileName: file.name, rows: objects.length });
        continue;
      }

      // Priority campaign summary
      if (hasHeaders(rows, "Name der Kampagne", "Kampagnen-ID") && hasHeaders(rows, "Tagesbudget")) {
        const objects = sheetToObjects(rows);
        for (const row of objects) {
          const name = pick(row, "Name der Kampagne");
          if (!name) continue;
          notePeriod(row);
          const spend = round(num(row, "Anzeigengebühren (in Rechnungswährung)", "Anzeigengebühren")) ?? 0;
          const sales = round(num(row, "Umsatz (in Rechnungswährung)", "Umsatz")) ?? 0;
          const clicks = num(row, "Klicks") ?? 0;
          campaigns.push({
            name,
            campaignId: pick(row, "Kampagnen-ID"),
            type: "priority",
            status: pick(row, "Status"),
            impressions: num(row, "Impressions") ?? 0,
            clicks,
            ctr: num(row, "CTR (Klickrate)"),
            spend,
            sales,
            unitsSold: num(row, "Verkaufte Stückzahl") ?? 0,
            roas: spend > 0 ? round(sales / spend, 2) : null,
            cpc: clicks > 0 ? round(spend / clicks, 2) : null,
          });
        }
        sources.push({ key: "priority_campaign", label: "Priority campaign", fileName: file.name, rows: objects.length });
        continue;
      }

      // Priority listing report (per-item breakdown of priority campaigns)
      if (hasHeaders(rows, "Artikelnr.", "Impressions")) {
        const objects = sheetToObjects(rows);
        for (const row of objects) {
          const itemNumber = pick(row, "Artikelnr.");
          if (!itemNumber) continue;
          notePeriod(row);
          adListings.push({
            itemNumber,
            sku: null,
            title: pick(row, "Titel"),
            campaign: pick(row, "Name der Kampagne"),
            type: "priority",
            impressions: num(row, "Impressions") ?? 0,
            clicks: num(row, "Klicks") ?? 0,
            spend: round(num(row, "Anzeigengebühren (in Rechnungswährung)", "Anzeigengebühren")) ?? 0,
            sales: round(num(row, "Umsatz (in Rechnungswährung)", "Umsatz")) ?? 0,
            unitsSold: num(row, "Verkaufte Stückzahl") ?? 0,
          });
        }
        sources.push({ key: "priority_listing", label: "Priority listing", fileName: file.name, rows: objects.length });
        continue;
      }
    }
  }

  // Map ad listings to SKUs via the catalog (item number → SKU).
  const skuByItem = new Map<string, string>();
  for (const listing of listings) if (listing.itemNumber && listing.sku) skuByItem.set(listing.itemNumber, listing.sku);
  for (const ad of adListings) ad.sku = skuByItem.get(ad.itemNumber) ?? null;

  // Advertising totals: priority campaign summary + general-listing report (distinct
  // programmes, so they add up without double counting the priority listing breakdown).
  const priorityImpr = campaigns.reduce((sum, c) => sum + c.impressions, 0);
  const priorityClicks = campaigns.reduce((sum, c) => sum + c.clicks, 0);
  const prioritySpend = campaigns.reduce((sum, c) => sum + c.spend, 0);
  const prioritySales = campaigns.reduce((sum, c) => sum + c.sales, 0);
  const priorityUnits = campaigns.reduce((sum, c) => sum + c.unitsSold, 0);
  const generalAds = adListings.filter((ad) => ad.type === "general");
  const generalImpr = generalAds.reduce((sum, a) => sum + a.impressions, 0);
  const generalClicks = generalAds.reduce((sum, a) => sum + a.clicks, 0);
  const generalSpend = generalAds.reduce((sum, a) => sum + a.spend, 0);
  const generalSales = generalAds.reduce((sum, a) => sum + a.sales, 0);
  const generalUnits = generalAds.reduce((sum, a) => sum + a.unitsSold, 0);

  const adImpr = priorityImpr + generalImpr;
  const adClicks = priorityClicks + generalClicks;
  const adSpend = round(prioritySpend + generalSpend) ?? 0;
  const adSales = round(prioritySales + generalSales) ?? 0;
  const adUnits = priorityUnits + generalUnits;

  const orders = [...orderAgg.values()].map((order) => ({ ...order, sales: round(order.sales) ?? 0 })).sort((a, b) => b.sales - a.sales);
  const retailSales = round(orders.reduce((sum, order) => sum + order.sales, 0)) ?? 0;
  const retailUnits = orders.reduce((sum, order) => sum + order.units, 0);
  const retailTransactions = orders.reduce((sum, order) => sum + order.transactions, 0);

  if (!campaigns.length && !generalAds.length) warnings.push("No Promoted Listings report was recognized — advertising KPIs are unavailable.");
  if (!orders.length) warnings.push("No orders report was recognized — retail sales are unavailable.");
  if (!listings.length) warnings.push("No active-listings report was recognized — product titles and EANs may be missing.");

  return {
    periodStart,
    periodEnd,
    days: dayCount(periodStart, periodEnd),
    currency: "EUR",
    totals: {
      advertising: {
        impressions: adImpr,
        clicks: adClicks,
        ctr: adImpr > 0 ? round(adClicks / adImpr, 4) : null,
        spend: adSpend,
        sales: adSales,
        unitsSold: adUnits,
        cpc: adClicks > 0 ? round(adSpend / adClicks, 2) : null,
        acos: adSales > 0 ? round(adSpend / adSales, 4) : null,
        roas: adSpend > 0 ? round(adSales / adSpend, 2) : null,
      },
      retail: { sales: retailSales, transactions: retailTransactions, unitsSold: retailUnits },
      combined: {
        tacos: retailSales > 0 ? round(adSpend / retailSales, 4) : null,
        adShareOfSales: retailSales > 0 ? round(adSales / retailSales, 4) : null,
      },
    },
    listings,
    orders,
    campaigns: campaigns.sort((a, b) => b.spend - a.spend),
    adListings: adListings.sort((a, b) => b.spend - a.spend),
    keywords: keywords.sort((a, b) => b.spend - a.spend),
    sources,
    warnings,
  };
}
