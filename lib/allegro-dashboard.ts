// Adapts an Allegro snapshot into the standard dashboard snapshot shape so Allegro
// flows through every shared page (dashboard, products, ranking, comparison, rules,
// history) exactly like Amazon and Kaufland. All money stays PLN-native; the app's
// currency-aware formatter renders złoty with the EUR equivalent.
//
// Contribution margin is derived by joining each Allegro offer to the uploaded product
// master (cost/margin) — primarily via the Allegro Ads campaign name, which mirrors the
// internal SKU, with offer-name fallbacks. Offers that cannot be matched stay outside
// the margin calculation (never coerced to zero).

import type { AllegroSnapshot } from "@/lib/allegro-import";
import type { CatalogProduct } from "@/lib/product-master-import";

const VAT_PL = 0.23;

export interface AllegroDashboardResult {
  snapshot: Record<string, unknown>;
  marginCoverage: { matchedOffers: number; totalOffers: number; coveredSales: number; totalSales: number };
}

function round(value: number | null, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

// Build lookups from the product master so an offer can resolve to a margin.
function indexCatalog(catalog: CatalogProduct[]) {
  const bySku = new Map<string, CatalogProduct>();
  const byName = new Map<string, CatalogProduct>();
  for (const product of catalog) {
    if (product.sku) bySku.set(normalizeKey(product.sku), product);
    if (product.canonicalSku) bySku.set(normalizeKey(product.canonicalSku), product);
    if (product.name) byName.set(normalizeKey(product.name), product);
    if (product.economicsDescription) byName.set(normalizeKey(product.economicsDescription), product);
  }
  return { bySku, byName };
}

function matchOffer(
  offer: { campaign: string | null; name: string; productId: string | null },
  index: { bySku: Map<string, CatalogProduct>; byName: Map<string, CatalogProduct> },
): CatalogProduct | null {
  // 1) Allegro Ads campaign name mirrors the internal SKU.
  if (offer.campaign) {
    const bySku = index.bySku.get(normalizeKey(offer.campaign));
    if (bySku) return bySku;
  }
  // 2) A known SKU appears as a whole-word token inside the offer title.
  const title = normalizeKey(offer.name);
  if (title) {
    const exactName = index.byName.get(title);
    if (exactName) return exactName;
    for (const [sku, product] of index.bySku) {
      if (sku.length >= 3 && new RegExp(`(^|[^a-z0-9])${escapeRegExp(sku)}([^a-z0-9]|$)`).test(title)) return product;
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildAllegroDashboardData(
  allegro: AllegroSnapshot | null,
  productMaster: CatalogProduct[] | null,
  fxRateToEur: number,
): AllegroDashboardResult {
  const adv = allegro?.totals.advertising;
  const retail = allegro?.totals.retail;
  const offers = allegro?.offers ?? [];
  const catalog = productMaster ?? [];
  const index = indexCatalog(catalog);

  // Join offers to the master and compute contribution.
  let matchedOffers = 0;
  let coveredGross = 0;
  let coveredNet = 0;
  let grossContribution = 0;
  const products = offers.map((offer) => {
    const match = catalog.length ? matchOffer(offer, index) : null;
    const margin = match?.margin ?? null;
    if (match && margin != null && offer.sales > 0) {
      matchedOffers++;
      const net = offer.sales / (1 + VAT_PL);
      coveredGross += offer.sales;
      coveredNet += net;
      grossContribution += net * margin;
    }
    return {
      sku: offer.offerId || offer.name,
      canonicalSku: match?.canonicalSku ?? match?.sku ?? offer.campaign ?? offer.offerId,
      sourceMatch: match ? "product_master" : "unmatched",
      ean: match?.ean ?? null,
      eanAmbiguous: match?.eanAmbiguous ?? false,
      asin: "",
      name: offer.name || offer.offerId,
      price: offer.avgPrice,
      active: true,
      margin,
      category: match?.category ?? null,
      economicsDescription: match?.economicsDescription ?? null,
      unitCosts: match?.unitCosts ?? null,
      retail: {
        sessions: null,
        pageViews: offer.views || null,
        units: offer.unitsSold,
        sales: offer.sales,
        conversion: offer.conversion,
        buyBox: null,
      },
      advertising: offer.adSales
        ? { impressions: 0, clicks: 0, spend: 0, purchases: offer.adUnits, sales: offer.adSales, acos: null, roas: null }
        : null,
      advertisingStatus: offer.adSales ? "Observed activity" : "No ad activity observed",
    };
  });

  const adSpendNet = adv?.spendNet ?? 0;
  const retailSales = retail?.sales ?? 0;
  const advertisingCost = adSpendNet;
  const hasMargin = matchedOffers > 0;
  const netContribution = hasMargin ? round(grossContribution - advertisingCost) : null;
  const netContributionMargin = hasMargin && coveredNet > 0 ? round(netContribution! / coveredNet, 4) : null;
  const retailSalesCoverage = retailSales > 0 && hasMargin ? round(coveredGross / retailSales, 4) : null;
  const tcos = retailSales > 0 ? round(adSpendNet / retailSales, 4) : null;

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
      start: allegro?.periodStart || today,
      end: allegro?.periodEnd || today,
      days: allegro?.days || 1,
      currency: "PLN",
      nativeCurrency: "PLN",
      fxRateToEur,
      marketplaceId: "allegro_pl",
      marketplace: "Allegro PL",
      timezone: "Europe/Warsaw",
      capabilities,
    },
    settings: { aggressivenessFactor: 0.7, maxBidChange: 0.5, minimumClicks: 10, manualApproval: true, evaluationCadence: "weekly", evidenceWindowDays: 30 },
    totals: {
      advertising: {
        impressions: adv?.impressions ?? 0,
        clicks: adv?.clicks ?? 0,
        spend: adSpendNet,
        purchases: adv?.unitsSold ?? 0,
        sales: adv?.sales ?? 0,
        units: adv?.unitsSold ?? 0,
        ctr: adv?.ctr ?? 0,
        cvr: adv && adv.clicks > 0 ? round(adv.unitsSold / adv.clicks, 4)! : 0,
        acos: adv?.acos ?? 0,
        roas: adv?.roas ?? 0,
        cpc: adv?.cpcNet ?? 0,
        cpa: adv && adv.unitsSold > 0 ? round(adSpendNet / adv.unitsSold)! : 0,
        aov: adv && adv.unitsSold > 0 ? round(adv.sales / adv.unitsSold)! : 0,
      },
      retail: {
        sales: retailSales,
        sessions: retail?.views ?? null,
        units: retail?.unitsSold ?? 0,
        conversion: retail?.conversion ?? null,
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
        advertisingCost,
        totalCost: null,
        vatRate: VAT_PL,
        provisionRate: null,
        missingCostProducts: [],
        unavailableReason: hasMargin ? null : "Upload a product master whose SKUs match the Allegro campaign names to compute contribution margin.",
      },
    },
    daily: [],
    placements: [],
    campaigns: (allegro?.campaigns ?? []).map((campaign) => ({ name: campaign.name, spend: campaign.spendNet, sales: campaign.sales })),
    products,
    catalogProducts: catalog.length ? catalog : undefined,
    targetPerformance: [],
    promotionCandidates: [],
    imports: (allegro?.sources ?? []).map((source) => ({ key: source.key, file: source.fileName, path: source.fileName, report: source.label, role: source.key, rows: source.rows, status: "Ready", sha256: "" })),
    quality: {
      activeProducts: offers.length,
      retailCoverageProducts: offers.filter((offer) => offer.sales > 0).length,
      economicsCoverageProducts: matchedOffers,
      netContributionCoverageProducts: matchedOffers,
      masterCatalogProducts: catalog.length,
      targets: 0,
      targetsMatchedToActiveProduct: 0,
      ambiguousTargetProductJoins: 0,
      excludedNonEuroAdvertisedRows: 0,
      duplicateProtection: allegro ? "Allegro reports are reconciled in the browser; re-importing replaces the working snapshot." : "No Allegro reports imported yet.",
    },
  };

  return {
    snapshot,
    marginCoverage: { matchedOffers, totalOffers: offers.length, coveredSales: round(coveredGross) ?? 0, totalSales: retailSales },
  };
}
