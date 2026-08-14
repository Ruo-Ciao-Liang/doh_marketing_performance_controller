// Client-side Allegro (PL) importer.
//
// Allegro exports three workbooks — campaign statistics + ad-attributed sales, an
// offer/product retail summary, and a traffic report. This module reads them in the
// browser (no server) and reconciles them into one PLN-native snapshot. Every money
// figure is stored in PLN; EUR is derived at render time with an editable FX rate so
// both currencies are always available.

import { excelSerialToISO, parseLocaleNumber, readWorkbookFile, sheetToObjects, type WorkbookSheet } from "@/lib/workbook-reader";

export interface AllegroCampaign {
  name: string;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpcNet: number | null;
  cpcGross: number | null;
  spendNet: number;
  spendGross: number;
  sales: number;
  unitsSold: number;
  roas: number | null;
}

export interface AllegroOffer {
  offerId: string;
  name: string;
  productId: string | null;
  campaign: string | null;
  sales: number;
  avgPrice: number | null;
  price: number | null;
  omnibusPrice: number | null;
  transactions: number;
  unitsSold: number;
  conversion: number | null;
  views: number;
  addedToCart: number;
  favorited: number;
  adSales: number;
  adUnits: number;
}

export interface AllegroProduct {
  productId: string;
  name: string;
  sales: number;
  avgPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  transactions: number;
  unitsSold: number;
  conversion: number | null;
  views: number;
  numberOfOffers: number | null;
}

export interface AllegroSource {
  key: "campaign_statistics" | "campaign_sales" | "offers" | "products" | "traffic" | "metadata";
  label: string;
  fileName: string;
  rows: number;
}

export interface AllegroSnapshot {
  account: string | null;
  market: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  days: number | null;
  currency: "PLN";
  totals: {
    advertising: { impressions: number; clicks: number; ctr: number | null; spendNet: number; spendGross: number; sales: number; unitsSold: number; cpcNet: number | null; acos: number | null; roas: number | null };
    retail: { sales: number; transactions: number; unitsSold: number; views: number; conversion: number | null; addedToCart: number };
    combined: { tacos: number | null };
  };
  campaigns: AllegroCampaign[];
  offers: AllegroOffer[];
  products: AllegroProduct[];
  sources: AllegroSource[];
  warnings: string[];
}

type Row = Record<string, string>;

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

// Case/space-insensitive column reader that tolerates the "(PLN)" suffixes and
// small header variations across Allegro exports.
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

function hasHeaders(rows: string[][], ...required: string[]): boolean {
  const headerRow = rows.find((row) => row && row.filter((cell) => (cell ?? "").trim()).length > 1) ?? [];
  const present = new Set(headerRow.map((cell) => normalizeHeader(cell ?? "")));
  return required.every((header) => present.has(normalizeHeader(header)));
}

function periodFromSheetName(name: string): { start: string; end: string } | null {
  const match = /(\d{4})(\d{2})(\d{2})[_-](\d{4})(\d{2})(\d{2})/.exec(name);
  if (!match) return null;
  return { start: `${match[1]}-${match[2]}-${match[3]}`, end: `${match[4]}-${match[5]}-${match[6]}` };
}

function dayCount(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

export async function parseAllegroFiles(files: File[]): Promise<AllegroSnapshot> {
  const warnings: string[] = [];
  const sources: AllegroSource[] = [];
  const campaigns: AllegroCampaign[] = [];
  const adSalesByOffer = new Map<string, { sales: number; units: number; campaign: string | null }>();
  let offers: AllegroOffer[] = [];
  let products: AllegroProduct[] = [];
  const trafficByOffer = new Map<string, { views: number; addedToCart: number; favorited: number; transactions: number }>();
  let account: string | null = null;
  let market: string | null = null;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;

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

      // Campaign statistics (advertising cost / impressions / clicks)
      if (hasHeaders(rows, "Campaign name", "Impressions") && (hasHeaders(rows, "Net cost (PLN)") || hasHeaders(rows, "Gross cost (PLN)"))) {
        const objects = sheetToObjects(rows);
        for (const row of objects) {
          const name = pick(row, "Campaign name");
          if (!name) continue;
          const spendNet = round(num(row, "Net cost (PLN)", "Net cost")) ?? 0;
          const spendGross = round(num(row, "Gross cost (PLN)", "Gross cost")) ?? 0;
          const sales = round(num(row, "Sales value (PLN)", "Sales value")) ?? 0;
          const impressions = num(row, "Impressions") ?? 0;
          const clicks = num(row, "Clicks") ?? 0;
          campaigns.push({
            name,
            impressions,
            clicks,
            ctr: num(row, "CTR"),
            cpcNet: num(row, "Net CPC (PLN)", "Net CPC"),
            cpcGross: num(row, "Gross CPC (PLN)", "Gross CPC"),
            spendNet,
            spendGross,
            sales,
            unitsSold: num(row, "Quantity sold") ?? 0,
            roas: spendNet > 0 ? round(sales / spendNet, 2) : null,
          });
        }
        sources.push({ key: "campaign_statistics", label: "Campaign statistics", fileName: file.name, rows: objects.length });
        const parsed = periodFromSheetName(sheet.name);
        if (parsed) { periodStart = periodStart ?? parsed.start; periodEnd = periodEnd ?? parsed.end; }
        continue;
      }

      // Ad-attributed sales by offer
      if (hasHeaders(rows, "Campaign name", "Sold offer ID")) {
        const objects = sheetToObjects(rows);
        for (const row of objects) {
          const offerId = pick(row, "Sold offer ID");
          if (!offerId) continue;
          const sales = num(row, "Sales value (PLN)", "Sales value") ?? 0;
          const units = num(row, "Quantity sold") ?? 0;
          const campaign = pick(row, "Campaign name") || null;
          const current = adSalesByOffer.get(offerId) ?? { sales: 0, units: 0, campaign: null };
          adSalesByOffer.set(offerId, { sales: current.sales + sales, units: current.units + units, campaign: current.campaign ?? campaign });
        }
        sources.push({ key: "campaign_sales", label: "Ad-attributed sales", fileName: file.name, rows: objects.length });
        continue;
      }

      // Metadata (market, account, reporting range)
      if (hasHeaders(rows, "Market", "Allegro Account")) {
        const [meta] = sheetToObjects(rows);
        if (meta) {
          market = market ?? (pick(meta, "Market") || null);
          account = account ?? (pick(meta, "Allegro Account") || null);
          periodStart = excelSerialToISO(pick(meta, "Start date")) ?? periodStart;
          periodEnd = excelSerialToISO(pick(meta, "End date")) ?? periodEnd;
        }
        sources.push({ key: "metadata", label: "Report metadata", fileName: file.name, rows: rows.length });
        continue;
      }

      // Retail offers
      if (hasHeaders(rows, "Offer ID", "Sales value") && hasHeaders(rows, "Average price")) {
        const objects = sheetToObjects(rows);
        offers = objects.map((row) => ({
          offerId: pick(row, "Offer ID"),
          name: pick(row, "Offer name"),
          productId: pick(row, "Product ID") || null,
          campaign: null as string | null,
          sales: round(num(row, "Sales value")) ?? 0,
          avgPrice: round(num(row, "Average price")),
          price: round(num(row, "Price")),
          omnibusPrice: round(num(row, "Omnibus price")),
          transactions: num(row, "Transactions") ?? 0,
          unitsSold: num(row, "Quantity sold") ?? 0,
          conversion: num(row, "Conversion"),
          views: num(row, "Views") ?? 0,
          addedToCart: num(row, "Added to cart") ?? 0,
          favorited: num(row, "Favorited") ?? 0,
          adSales: 0,
          adUnits: 0,
        })).filter((offer) => offer.offerId || offer.name);
        sources.push({ key: "offers", label: "Offer performance", fileName: file.name, rows: objects.length });
        continue;
      }

      // Retail products
      if (hasHeaders(rows, "Product ID", "Number of offers")) {
        const objects = sheetToObjects(rows);
        products = objects.map((row) => ({
          productId: pick(row, "Product ID"),
          name: pick(row, "Product"),
          sales: round(num(row, "Sales value")) ?? 0,
          avgPrice: round(num(row, "Average price")),
          minPrice: round(num(row, "Min. price", "Min price")),
          maxPrice: round(num(row, "Max. price", "Max price")),
          transactions: num(row, "Transactions") ?? 0,
          unitsSold: num(row, "Quantity sold") ?? 0,
          conversion: num(row, "Conversion"),
          views: num(row, "Views") ?? 0,
          numberOfOffers: num(row, "Number of offers"),
        })).filter((product) => product.productId || product.name);
        sources.push({ key: "products", label: "Product performance", fileName: file.name, rows: objects.length });
        continue;
      }

      // Traffic report (views, likes, transactions by offer)
      if (hasHeaders(rows, "Number of views") && (hasHeaders(rows, "Likes") || hasHeaders(rows, "Offer ID (link)") || hasHeaders(rows, "Offer ID"))) {
        const objects = sheetToObjects(rows);
        for (const row of objects) {
          const offerId = pick(row, "Offer ID (link)", "Offer ID");
          if (!offerId) continue;
          trafficByOffer.set(offerId, {
            views: num(row, "Number of views") ?? 0,
            addedToCart: num(row, "Added to cart") ?? 0,
            favorited: num(row, "Likes") ?? 0,
            transactions: num(row, "Transactions") ?? 0,
          });
        }
        sources.push({ key: "traffic", label: "Traffic report", fileName: file.name, rows: objects.length });
        continue;
      }
    }
  }

  // Merge ad-attributed sales and traffic enrichment onto offers.
  for (const offer of offers) {
    const ad = adSalesByOffer.get(offer.offerId);
    if (ad) { offer.adSales = round(ad.sales) ?? 0; offer.adUnits = ad.units; offer.campaign = offer.campaign ?? ad.campaign; }
    if (!offer.views) {
      const traffic = trafficByOffer.get(offer.offerId);
      if (traffic) { offer.views = traffic.views; offer.addedToCart = offer.addedToCart || traffic.addedToCart; offer.favorited = offer.favorited || traffic.favorited; }
    }
  }

  // Reporting period fallbacks.
  if (!periodStart || !periodEnd) {
    for (const file of files) {
      const parsed = periodFromSheetName(file.name);
      if (parsed) { periodStart = periodStart ?? parsed.start; periodEnd = periodEnd ?? parsed.end; break; }
    }
  }

  const adSpendNet = round(campaigns.reduce((sum, campaign) => sum + campaign.spendNet, 0)) ?? 0;
  const adSpendGross = round(campaigns.reduce((sum, campaign) => sum + campaign.spendGross, 0)) ?? 0;
  const adImpressions = campaigns.reduce((sum, campaign) => sum + campaign.impressions, 0);
  const adClicks = campaigns.reduce((sum, campaign) => sum + campaign.clicks, 0);
  // Ad sales prefer the attributed Sales sheet; fall back to campaign statistics.
  const attributedSales = round([...adSalesByOffer.values()].reduce((sum, entry) => sum + entry.sales, 0)) ?? 0;
  const attributedUnits = [...adSalesByOffer.values()].reduce((sum, entry) => sum + entry.units, 0);
  const campaignSales = round(campaigns.reduce((sum, campaign) => sum + campaign.sales, 0)) ?? 0;
  const adSales = attributedSales || campaignSales;
  const adUnits = attributedUnits || campaigns.reduce((sum, campaign) => sum + campaign.unitsSold, 0);

  const retailSales = round(offers.reduce((sum, offer) => sum + offer.sales, 0)) ?? 0;
  const retailTransactions = offers.reduce((sum, offer) => sum + offer.transactions, 0);
  const retailUnits = offers.reduce((sum, offer) => sum + offer.unitsSold, 0);
  const retailViews = offers.reduce((sum, offer) => sum + offer.views, 0);
  const retailAddedToCart = offers.reduce((sum, offer) => sum + offer.addedToCart, 0);

  if (!campaigns.length) warnings.push("No campaign statistics file was recognized — advertising KPIs are unavailable.");
  if (!offers.length) warnings.push("No offer summary file was recognized — retail KPIs are unavailable.");

  return {
    account,
    market,
    periodStart,
    periodEnd,
    days: dayCount(periodStart, periodEnd),
    currency: "PLN",
    totals: {
      advertising: {
        impressions: adImpressions,
        clicks: adClicks,
        ctr: adImpressions > 0 ? round(adClicks / adImpressions, 4) : null,
        spendNet: adSpendNet,
        spendGross: adSpendGross,
        sales: adSales,
        unitsSold: adUnits,
        cpcNet: adClicks > 0 ? round(adSpendNet / adClicks, 2) : null,
        acos: adSales > 0 ? round(adSpendNet / adSales, 4) : null,
        roas: adSpendNet > 0 ? round(adSales / adSpendNet, 2) : null,
      },
      retail: {
        sales: retailSales,
        transactions: retailTransactions,
        unitsSold: retailUnits,
        views: retailViews,
        conversion: retailViews > 0 ? round(retailTransactions / retailViews, 4) : null,
        addedToCart: retailAddedToCart,
      },
      combined: { tacos: retailSales > 0 ? round(adSpendNet / retailSales, 4) : null },
    },
    campaigns: campaigns.sort((a, b) => b.spendNet - a.spendNet),
    offers: offers.sort((a, b) => b.sales - a.sales),
    products: products.sort((a, b) => b.sales - a.sales),
    sources,
    warnings,
  };
}
