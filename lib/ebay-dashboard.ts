// Adapts an eBay snapshot into the standard dashboard snapshot shape so eBay flows
// through every shared page (dashboard, products, ranking, comparison, rules, history)
// like Amazon, Kaufland and Allegro. eBay is EUR, so no currency conversion is needed.
//
// Contribution margin is derived by joining each SKU (eBay "custom label" / order
// "Bestandseinheit") to the uploaded product master. eBay SKUs match the internal
// SKUs directly, with a trailing variant suffix (_1, _S, …) stripped as a fallback.

import type { EbaySnapshot } from "@/lib/ebay-import";
import type { CatalogProduct } from "@/lib/product-master-import";

const VAT_DE = 0.19;

export interface EbayDashboardResult {
  snapshot: Record<string, unknown>;
  marginCoverage: { matchedSkus: number; totalSkus: number; coveredSales: number; totalSales: number };
}

function round(value: number | null, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function indexCatalog(catalog: CatalogProduct[]) {
  const bySku = new Map<string, CatalogProduct>();
  for (const product of catalog) {
    if (product.sku) bySku.set(normalizeKey(product.sku), product);
    if (product.canonicalSku) bySku.set(normalizeKey(product.canonicalSku), product);
  }
  return bySku;
}

// eBay SKUs equal the internal SKU, sometimes with a variant suffix (CAB401_1, 420004_S).
function matchSku(sku: string, bySku: Map<string, CatalogProduct>): CatalogProduct | null {
  const key = normalizeKey(sku);
  const direct = bySku.get(key);
  if (direct) return direct;
  const stripped = key.replace(/[_-](?:fba|fab|psi|psw|s|[0-9]+)$/i, "");
  if (stripped !== key) {
    const variant = bySku.get(stripped);
    if (variant) return variant;
  }
  return null;
}

export function buildEbayDashboardData(
  ebay: EbaySnapshot | null,
  productMaster: CatalogProduct[] | null,
  _unused?: number,
): EbayDashboardResult {
  const adv = ebay?.totals.advertising;
  const retail = ebay?.totals.retail;
  const catalog = productMaster ?? [];
  const bySku = indexCatalog(catalog);

  const listings = ebay?.listings ?? [];
  const orderBySku = new Map((ebay?.orders ?? []).map((order) => [order.sku, order]));

  // Aggregate advertising by SKU from the per-listing ad rows.
  const adBySku = new Map<string, { impressions: number; clicks: number; spend: number; sales: number; units: number }>();
  for (const ad of ebay?.adListings ?? []) {
    if (!ad.sku) continue;
    const current = adBySku.get(ad.sku) ?? { impressions: 0, clicks: 0, spend: 0, sales: 0, units: 0 };
    current.impressions += ad.impressions;
    current.clicks += ad.clicks;
    current.spend += ad.spend;
    current.sales += ad.sales;
    current.units += ad.unitsSold;
    adBySku.set(ad.sku, current);
  }

  // Product rows come from the active-listing catalog, enriched with retail + advertising.
  const products = listings.map((listing) => {
    const match = catalog.length ? matchSku(listing.sku, bySku) : null;
    const order = orderBySku.get(listing.sku);
    const ad = adBySku.get(listing.sku);
    return {
      sku: listing.sku || listing.itemNumber,
      canonicalSku: match?.canonicalSku ?? match?.sku ?? listing.sku,
      sourceMatch: match ? "product_master" : "unmatched",
      ean: listing.ean ?? match?.ean ?? null,
      eanAmbiguous: match?.eanAmbiguous ?? false,
      asin: "",
      name: listing.title || listing.sku,
      price: listing.price ?? match?.price ?? null,
      active: true,
      margin: match?.margin ?? null,
      category: listing.category ?? match?.category ?? null,
      economicsDescription: match?.economicsDescription ?? null,
      unitCosts: match?.unitCosts ?? null,
      retail: order
        ? { sessions: null, pageViews: null, units: order.units, sales: order.sales, conversion: null, buyBox: null }
        : null,
      advertising: ad
        ? { impressions: ad.impressions, clicks: ad.clicks, spend: round(ad.spend) ?? 0, purchases: ad.units, sales: round(ad.sales) ?? 0, acos: ad.sales > 0 ? round(ad.spend / ad.sales, 4) : null, roas: ad.spend > 0 ? round(ad.sales / ad.spend, 2) : null }
        : null,
      advertisingStatus: ad && ad.spend > 0 ? "Observed activity" : "No ad activity observed",
    };
  });

  // Contribution margin from the orders joined to the master.
  let matchedSkus = 0;
  let coveredGross = 0;
  let coveredNet = 0;
  let grossContribution = 0;
  for (const order of ebay?.orders ?? []) {
    const match = catalog.length ? matchSku(order.sku, bySku) : null;
    if (match && match.margin != null && order.sales > 0) {
      matchedSkus++;
      const net = order.sales / (1 + VAT_DE);
      coveredGross += order.sales;
      coveredNet += net;
      grossContribution += net * match.margin;
    }
  }

  const adSpend = adv?.spend ?? 0;
  const retailSales = retail?.sales ?? 0;
  const hasMargin = matchedSkus > 0;
  const netContribution = hasMargin ? round(grossContribution - adSpend) : null;
  const netContributionMargin = hasMargin && coveredNet > 0 ? round(netContribution! / coveredNet, 4) : null;
  const retailSalesCoverage = retailSales > 0 && hasMargin ? round(coveredGross / retailSales, 4) : null;
  const tcos = retailSales > 0 ? round(adSpend / retailSales, 4) : null;

  const capabilities = {
    retail: true,
    retailSessions: false,
    advertising: true,
    placements: false,
    currentBids: false,
    exactBidSuggestions: false,
    keywordOwnership: false,
    harvest: false,
    exactConflictDetection: false,
    dailyAdvertising: false,
    profitability: hasMargin,
  };

  const today = new Date().toISOString().slice(0, 10);
  const snapshot: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    reporting: {
      start: ebay?.periodStart || today,
      end: ebay?.periodEnd || today,
      days: ebay?.days || 1,
      currency: "EUR",
      nativeCurrency: "EUR",
      fxRateToEur: 1,
      marketplaceId: "ebay_de",
      marketplace: "eBay DE",
      timezone: "Europe/Berlin",
      capabilities,
    },
    settings: { aggressivenessFactor: 0.7, maxBidChange: 0.5, minimumClicks: 10, manualApproval: true, evaluationCadence: "weekly", evidenceWindowDays: 30 },
    totals: {
      advertising: {
        impressions: adv?.impressions ?? 0,
        clicks: adv?.clicks ?? 0,
        spend: adSpend,
        purchases: adv?.unitsSold ?? 0,
        sales: adv?.sales ?? 0,
        units: adv?.unitsSold ?? 0,
        ctr: adv?.ctr ?? 0,
        cvr: adv && adv.clicks > 0 ? round(adv.unitsSold / adv.clicks, 4)! : 0,
        acos: adv?.acos ?? 0,
        roas: adv?.roas ?? 0,
        cpc: adv?.cpc ?? 0,
        cpa: adv && adv.unitsSold > 0 ? round(adSpend / adv.unitsSold)! : 0,
        aov: adv && adv.unitsSold > 0 ? round(adv.sales / adv.unitsSold)! : 0,
      },
      retail: {
        sales: retailSales,
        sessions: null,
        units: retail?.unitsSold ?? 0,
        conversion: null,
      },
      profitability: {
        tcos,
        netContribution,
        netContributionMargin,
        coveredGrossSales: round(coveredGross) ?? 0,
        coveredNetSales: round(coveredNet) ?? 0,
        retailSalesCoverage,
        purchaseCost: null,
        deliveryCost: null,
        provisionCost: null,
        advertisingCost: adSpend,
        totalCost: null,
        vatRate: VAT_DE,
        provisionRate: null,
        missingCostProducts: [],
        unavailableReason: hasMargin ? null : "Upload a product master whose SKUs match the eBay custom labels to compute contribution margin.",
      },
    },
    daily: [],
    placements: [],
    campaigns: (ebay?.campaigns ?? []).map((campaign) => ({ name: campaign.name, spend: campaign.spend, sales: campaign.sales })),
    products,
    catalogProducts: catalog.length ? catalog : undefined,
    targetPerformance: [],
    promotionCandidates: [],
    imports: (ebay?.sources ?? []).map((source) => ({ key: source.key, file: source.fileName, path: source.fileName, report: source.label, role: source.key, rows: source.rows, status: "Ready", sha256: "" })),
    quality: {
      activeProducts: products.length,
      retailCoverageProducts: products.filter((product) => product.retail != null).length,
      economicsCoverageProducts: matchedSkus,
      netContributionCoverageProducts: matchedSkus,
      masterCatalogProducts: catalog.length,
      targets: 0,
      targetsMatchedToActiveProduct: 0,
      ambiguousTargetProductJoins: 0,
      excludedNonEuroAdvertisedRows: 0,
      duplicateProtection: ebay ? "eBay reports are reconciled in the browser; re-importing replaces the working snapshot." : "No eBay reports imported yet.",
    },
  };

  return {
    snapshot,
    marginCoverage: { matchedSkus, totalSkus: (ebay?.orders ?? []).length, coveredSales: round(coveredGross) ?? 0, totalSales: retailSales },
  };
}
