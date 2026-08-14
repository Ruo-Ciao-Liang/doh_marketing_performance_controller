export type MarketplaceId = "amazon_de" | "kaufland_de";
export type MarketplaceSelection = MarketplaceId | "all";

export interface MarketplaceCapabilities {
  retail: boolean;
  retailSessions: boolean;
  advertising: boolean;
  placements: boolean;
  currentBids: boolean;
  exactBidSuggestions: boolean;
  keywordOwnership: boolean;
  harvest: boolean;
  exactConflictDetection: boolean;
  dailyAdvertising: boolean;
  profitability: boolean;
}

export interface MarketplaceImportRequirement {
  role: string;
  title: string;
  cadence: "daily" | "summary" | "reference";
  description: string;
  optional?: boolean;
}

export interface MarketplaceDefinition {
  id: MarketplaceId;
  name: string;
  shortName: string;
  platform: string;
  country: string;
  currency: "EUR";
  timezone: "Europe/Berlin";
  capabilities: MarketplaceCapabilities;
  importRequirements: MarketplaceImportRequirement[];
}

export const marketplaceRegistry: Record<MarketplaceId, MarketplaceDefinition> = {
  amazon_de: {
    id: "amazon_de",
    name: "Amazon DE",
    shortName: "Amazon",
    platform: "Amazon",
    country: "Germany",
    currency: "EUR",
    timezone: "Europe/Berlin",
    capabilities: {
      retail: true,
      retailSessions: true,
      advertising: true,
      placements: true,
      currentBids: true,
      exactBidSuggestions: true,
      keywordOwnership: true,
      harvest: true,
      exactConflictDetection: true,
      dailyAdvertising: true,
      profitability: true,
    },
    importRequirements: [
      { role: "advertised_product", title: "Advertised Product", cadence: "daily", description: "Product advertising totals and daily trend." },
      { role: "campaign", title: "Campaign", cadence: "summary", description: "Campaign settings and reconciliation." },
      { role: "placement", title: "Placement", cadence: "daily", description: "Performance by placement." },
      { role: "targeting", title: "Targeting", cadence: "daily", description: "Targets, verified bids and recommendation evidence." },
      { role: "business_report", title: "Business Report", cadence: "summary", description: "Retail revenue, units, sessions and conversion." },
      { role: "search_term_summary", title: "Search Term", cadence: "summary", description: "Optional reconciliation; never added to totals.", optional: true },
    ],
  },
  kaufland_de: {
    id: "kaufland_de",
    name: "Kaufland DE",
    shortName: "Kaufland",
    platform: "Kaufland",
    country: "Germany",
    currency: "EUR",
    timezone: "Europe/Berlin",
    capabilities: {
      retail: true,
      retailSessions: false,
      advertising: true,
      placements: false,
      currentBids: false,
      exactBidSuggestions: false,
      keywordOwnership: false,
      harvest: false,
      exactConflictDetection: false,
      dailyAdvertising: true,
      profitability: true,
    },
    importRequirements: [
      { role: "kaufland_sales", title: "Sales GMU", cadence: "daily", description: "Order-unit revenue, EAN, seller offer ID, cancellations and returns." },
      { role: "kaufland_offers", title: "Account listing feed", cadence: "reference", description: "Seller offer ID ↔ EAN identity, price, stock and availability." },
      { role: "kaufland_spa_daily_campaign", title: "SPA daily campaign performance", cadence: "daily", description: "Authoritative daily advertising trend and reporting dates." },
      { role: "kaufland_spa_campaign", title: "SPA campaign performance", cadence: "summary", description: "Campaign inventory and period-total reconciliation." },
      { role: "kaufland_spa_ean", title: "SPA EAN performance", cadence: "summary", description: "Product-level advertising performance joined by EAN." },
      { role: "kaufland_spa_daily_cost", title: "SPA daily cost", cadence: "daily", description: "Account-level daily spend control total." },
      { role: "kaufland_spa_daily_cost_campaign", title: "SPA daily cost by campaign", cadence: "daily", description: "Campaign-level daily spend reconciliation; never added twice." },
    ],
  },
};

export const marketplaceIds = Object.keys(marketplaceRegistry) as MarketplaceId[];

export function normalizeMarketplaceId(value: string | null | undefined): MarketplaceId {
  return value === "kaufland_de" ? "kaufland_de" : "amazon_de";
}

export function getMarketplaceDefinition(value: string | null | undefined): MarketplaceDefinition {
  return marketplaceRegistry[normalizeMarketplaceId(value)];
}

export function snapshotMarketplaceId(snapshot: Record<string, unknown>): MarketplaceId {
  const reporting = snapshot.reporting && typeof snapshot.reporting === "object" ? snapshot.reporting as Record<string, unknown> : {};
  return normalizeMarketplaceId(typeof reporting.marketplaceId === "string" ? reporting.marketplaceId : undefined);
}
