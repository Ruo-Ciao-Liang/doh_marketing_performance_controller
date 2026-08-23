"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import snapshot from "@/data/generated/normalized.json";
import {
  buildSuggestions,
  DEFAULT_RULE_POLICY,
  manualReviewReason,
  resolveRulePolicy,
  type RecommendationType,
  type RulePolicy,
  type RuleSettings,
  type Suggestion,
  type TargetPerformance,
} from "@/lib/rules-engine";
import { createReviewedSuggestionsWorkbook, reviewedSuggestionsFilename } from "@/lib/review-export";
import { allDataFilename, createAllDataWorkbook } from "@/lib/all-data-export";
import { applySuggestionView, type ConfidenceFilter, type ReviewFilter, type SuggestionSort } from "@/lib/suggestion-view";
import { productGrossContribution, productRankingValue, sortRankedProducts, summarizeUnmatchedRetail, type ProductRankingDirection, type ProductRankingMetric, type UnmatchedRetailRow } from "@/lib/product-ranking";
import { buildProductComparison, type ProductComparisonMetric, type ProductComparisonRow } from "@/lib/product-comparison";
import { buildProductContributionBreakdown, type ProductContributionBreakdown } from "@/lib/product-contribution";
import { importChunkRanges, parseImportApiPayload } from "@/lib/import-client";
import { comparableSnapshot, comparisonTargetDate, percentageChange } from "@/lib/kpi-comparison";
import { comparableMetrics, rankComparisonRows, type ComparableMetricKey, type MarketplaceComparisonRow } from "@/lib/marketplace-comparison";
import { marketplaceRegistry, type MarketplaceId, type MarketplaceSelection } from "@/lib/marketplaces";
import { parseProductMasterFile, type CatalogProduct, type ProductMasterStats } from "@/lib/product-master-import";
import { parseErpSalesFile, type ErpSalesRow, type ErpSalesStats } from "@/lib/erp-sales-import";
import { parseAllegroFiles, type AllegroSnapshot } from "@/lib/allegro-import";
import { buildAllegroDashboardData } from "@/lib/allegro-dashboard";
import { parseEbayFiles, type EbaySnapshot } from "@/lib/ebay-import";
import { buildEbayDashboardData } from "@/lib/ebay-dashboard";
import { createTabularWorkbook } from "@/lib/review-export";
import type { MergedAdvertisingRange } from "@/lib/advertising-range";
import {
  advertisingRangeRequestPath,
  matchingSnapshot,
  presetDateRange,
  snapshotRequestPath,
  type DateRangePreset,
  type ReportingDateRange,
} from "@/lib/snapshot-selection";
import {
  answerDataQuestion,
  type AssistantAnswerStatus,
  type AssistantEntityRef,
  type AssistantMetric,
  type AssistantResultItem,
  type AssistantSnapshot,
} from "@/lib/data-assistant";

type PageKey = "dashboard" | "marketplace_performance" | "comparisons" | "suggestions" | "products" | "ranking" | "imports" | "rules" | "knowledge" | "history";
type MetricKey = "adSales" | "adSpend" | "acos" | "tcos" | "retailSales" | "netMargin" | "impressions" | "clicks" | "retailSessions" | "retailCoverage";

interface MetricDetail {
  title: string;
  value: string;
  explanation: string;
  formula: string;
  source: string;
  sourcePaths: string[];
  stats: { label: string; value: string }[];
  caveat?: string;
}

const navItems: { key: PageKey; label: string; icon: string }[] = [
  { key: "dashboard", label: "Dashboard", icon: "▦" },
  { key: "comparisons", label: "Time intelligent KPI comparison", icon: "↔" },
  { key: "suggestions", label: "Bidding suggestions", icon: "↗" },
  { key: "products", label: "Products", icon: "□" },
  { key: "ranking", label: "Product ranking", icon: "≋" },
  { key: "imports", label: "Data imports", icon: "⇣" },
  { key: "rules", label: "Rules & settings", icon: "⚙" },
  { key: "knowledge", label: "Methodology & AI", icon: "✦" },
  { key: "history", label: "Run history", icon: "↺" },
];

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const pct = (value: number | null | undefined, digits = 1) => value == null ? "—" : `${(value * 100).toFixed(digits)}%`;
const zloty = new Intl.NumberFormat("en-GB", { style: "currency", currency: "PLN", maximumFractionDigits: 0 });
const zloty2 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "PLN", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pln = (value: number | null | undefined, cents = false) => value == null ? "—" : cents ? zloty2.format(value) : zloty.format(value);
// The active marketplace's native currency and its EUR rate. Set once per render from
// data.reporting so every shared page formats money in the marketplace's own currency
// (EUR for Amazon/Kaufland, PLN for Allegro) without touching each call site.
let activeCurrency: "EUR" | "PLN" = "EUR";
let activeFxToEur = 1;
// Native-currency money (the pervasive formatter). Historically euro-only; now switches
// to złoty when the active marketplace is PLN.
const euro = (value: number | null | undefined, cents = false) => value == null ? "—" : activeCurrency === "PLN" ? (cents ? zloty2 : zloty).format(value) : (cents ? money2 : money).format(value);
// The EUR equivalent of a native-currency amount (identity for EUR marketplaces). Used to
// show the euro figure alongside złoty on Allegro.
const eurFrom = (nativeValue: number | null | undefined, cents = true) => nativeValue == null ? "—" : (cents ? money2 : money).format(activeCurrency === "PLN" ? nativeValue * activeFxToEur : nativeValue);
const displayDate = (value: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00Z`));

type DashboardData = {
  generatedAt: string;
  reporting: { start: string; end: string; days: number; currency: string; nativeCurrency?: string; fxRateToEur?: number; marketplaceId?: MarketplaceId; marketplace: string; timezone: string; capabilities?: Record<string, boolean> };
  settings: { aggressivenessFactor: number; maxBidChange: number; minimumClicks: number; manualApproval: boolean; evaluationCadence: string; evidenceWindowDays: number };
  totals: {
    advertising: { impressions: number; clicks: number; spend: number; purchases: number; sales: number; units: number; ctr: number; cvr: number; acos: number; roas: number; cpc: number; cpa: number; aov: number };
    retail: { sales: number; sessions: number | null; units: number; conversion: number | null };
    profitability: { tcos: number | null; netContribution: number | null; netContributionMargin: number | null; coveredGrossSales: number; coveredNetSales: number; retailSalesCoverage: number | null; purchaseCost: number | null; deliveryCost: number | null; provisionCost: number | null; advertisingCost: number | null; totalCost: number | null; vatRate: number; provisionRate: number | null; missingCostProducts: { sku: string; grossSales: number }[]; unavailableReason?: string | null };
  };
  daily: { date: string; impressions: number; clicks: number; spend: number; purchases: number; sales: number; acos: number | null }[];
  placements: { name: string; impressions: number; clicks: number; spend: number; purchases: number; sales: number; acos: number | null; roas: number | null }[];
  campaigns: Campaign[];
  products: Product[];
  catalogProducts?: Product[];
  targetPerformance: TargetPerformance[];
  promotionCandidates: PromotionCandidate[];
  imports: ImportRecord[];
  quality: Record<string, unknown>;
};

const initialData = snapshot as unknown as DashboardData;
let data = initialData;
let marketplaceSelectionGlobal: MarketplaceSelection = "amazon_de";
let changeMarketplaceGlobal: (selection: MarketplaceSelection) => void = () => undefined;
let openImportsGlobal: () => void = () => undefined;
let marketplaceAvailableGlobal = true;

interface SnapshotHistorySummary {
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

interface Product {
  sku: string;
  canonicalSku?: string | null;
  ean?: string | null;
  asin: string;
  name: string;
  price: number | null;
  margin: number | null;
  category: string | null;
  advertisingStatus: string;
  retail: { sessions: number | null; pageViews: number | null; units: number; sales: number; conversion: number | null; buyBox: number | null } | null;
  advertising: { impressions: number; clicks: number; spend: number; purchases: number; sales: number; acos: number | null; roas: number | null } | null;
}

interface Campaign {
  name: string;
  spend: number;
  sales: number;
}

interface PromotionCandidate {
  sku: string;
  asin: string;
  name: string;
  price: number | null;
  margin: number | null;
  category: string | null;
  level: string;
  score: number;
  reason: string;
}

interface ImportRecord {
  key: string;
  file: string;
  path: string;
  report: string;
  role: string;
  rows: number;
  status: string;
  sha256: string;
}

type SaveStatus = "loading" | "idle" | "saving" | "saved" | "conflict" | "error";

interface ReviewRecord {
  decision: "approved" | "rejected";
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

interface AuditRecord {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  changedBy: string;
  changedAt: string;
}

interface SuggestionPreferences {
  filter: "all" | RecommendationType | "promotion";
  sort: SuggestionSort;
  confidence: ConfidenceFilter;
  review: ReviewFilter;
}

interface RankingPreferences {
  category: string;
  sortBy: ProductRankingMetric;
  sortDirection: ProductRankingDirection;
}

interface UserPreferences {
  suggestions?: SuggestionPreferences;
  ranking?: RankingPreferences;
  products?: { status: string };
  layout?: { sidebarPosition: "left" | "right" };
  marketplaceId?: MarketplaceSelection;
}

const MAX_IMPORT_FILE_BYTES = 8 * 1024 * 1024;

const fileSize = (bytes: number) => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function SaveIndicator({ status, label, detail }: { status: SaveStatus; label: string; detail?: string }) {
  const text = status === "loading" ? "Loading saved state…" :
    status === "saving" ? "Saving…" :
    status === "saved" ? label :
    status === "conflict" ? "Updated by another user" :
    status === "error" ? "Could not save" : label;
  return <>{label === "All changes saved" && <label className="marketplace-switcher"><span>Marketplace</span><select aria-label="Choose marketplace" value={marketplaceSelectionGlobal} onChange={(event) => changeMarketplaceGlobal(event.target.value as MarketplaceSelection)}><option value="amazon_de">Amazon DE</option><option value="kaufland_de">Kaufland DE</option><option value="allegro_pl">Allegro PL</option><option value="ebay_de">eBay DE</option><option value="all">All marketplaces</option></select></label>}<span className={`save-indicator ${status}`} title={detail}><i />{text}</span></>;
}

const summaryFromData = (currentData: DashboardData, id = "baseline-2026-07-20"): SnapshotHistorySummary => ({
  id,
  marketplaceId: currentData.reporting.marketplaceId ?? "amazon_de",
  currency: currentData.reporting.nativeCurrency ?? currentData.reporting.currency,
  fxRateToEur: currentData.reporting.fxRateToEur ?? 1,
  createdAt: currentData.generatedAt,
  createdBy: "Initial immutable source files",
  periodStart: currentData.reporting.start,
  periodEnd: currentData.reporting.end,
  periodDays: currentData.reporting.days,
  status: "ready",
  warningCount: 0,
  fileCount: currentData.imports.length,
  advertisingSales: currentData.totals.advertising.sales,
  advertisingSpend: currentData.totals.advertising.spend,
  advertisingPurchases: currentData.totals.advertising.purchases,
  impressions: currentData.totals.advertising.impressions,
  clicks: currentData.totals.advertising.clicks,
  acos: currentData.totals.advertising.acos,
  retailSales: currentData.totals.retail.sales,
  retailUnits: currentData.totals.retail.units,
  retailSessions: currentData.totals.retail.sessions,
  tcos: currentData.totals.profitability.tcos,
  netContribution: currentData.totals.profitability.netContribution,
  netContributionMargin: currentData.totals.profitability.netContributionMargin,
  retailCoverageProducts: Number(currentData.quality.retailCoverageProducts),
  activeProducts: Number(currentData.quality.activeProducts),
});

function emptyMarketplaceData(marketplaceId: MarketplaceId): DashboardData {
  const definition = marketplaceRegistry[marketplaceId];
  return {
    ...initialData,
    generatedAt: new Date().toISOString(),
    reporting: { ...initialData.reporting, marketplaceId, marketplace: definition.name, currency: "EUR", nativeCurrency: "EUR", fxRateToEur: 1, capabilities: definition.capabilities },
    totals: {
      advertising: { impressions: 0, clicks: 0, spend: 0, purchases: 0, sales: 0, units: 0, ctr: 0, cvr: 0, acos: 0, roas: 0, cpc: 0, cpa: 0, aov: 0 },
      retail: { sales: 0, sessions: null, units: 0, conversion: null },
      profitability: { tcos: null, netContribution: null, netContributionMargin: null, coveredGrossSales: 0, coveredNetSales: 0, retailSalesCoverage: null, purchaseCost: null, deliveryCost: null, provisionCost: null, advertisingCost: 0, totalCost: null, vatRate: 0.19, provisionRate: null, missingCostProducts: [], unavailableReason: "Import a complete marketplace snapshot." },
    },
    daily: [], placements: [], campaigns: [], targetPerformance: [], promotionCandidates: [],
    products: (initialData.catalogProducts ?? initialData.products).map((product) => ({ ...product, retail: null, advertising: null, advertisingStatus: "Unavailable until this marketplace is imported" })),
    catalogProducts: initialData.catalogProducts,
    imports: initialData.imports.filter((item) => ["product_master", "amazon_listing", "economics"].includes(item.key)),
    quality: { activeProducts: initialData.products.length, retailCoverageProducts: 0, economicsCoverageProducts: initialData.quality.economicsCoverageProducts, netContributionCoverageProducts: 0, targets: 0, targetsMatchedToActiveProduct: 0, ambiguousTargetProductJoins: 0, excludedNonEuroAdvertisedRows: 0, duplicateProtection: "No reporting snapshot has been imported for this marketplace." },
  };
}

// A user-uploaded product master is persisted client-side (no D1/R2 needed) so it
// survives a reload and drives the catalog everywhere the dashboard renders products.
const PRODUCT_MASTER_STORAGE_KEY = "mpc:product-master:v1";

function loadStoredProductMaster(): { products: CatalogProduct[]; stats: ProductMasterStats } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PRODUCT_MASTER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { products?: CatalogProduct[]; stats?: ProductMasterStats };
    if (!parsed.products?.length || !parsed.stats) return null;
    return { products: parsed.products, stats: parsed.stats };
  } catch {
    return null;
  }
}

function saveStoredProductMaster(products: CatalogProduct[], stats: ProductMasterStats) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(PRODUCT_MASTER_STORAGE_KEY, JSON.stringify({ products, stats })); } catch { /* quota or private mode */ }
}

function clearStoredProductMaster() {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(PRODUCT_MASTER_STORAGE_KEY); } catch { /* ignore */ }
}

// Replace the active catalog with an uploaded product master. Any retail/advertising
// already present for a SKU is preserved; missing metrics stay null (never zeroed).
function applyCatalogToData(base: DashboardData, catalog: CatalogProduct[]): DashboardData {
  const bySku = new Map(base.products.map((product) => [product.sku, product]));
  const products = catalog.map((entry) => {
    const existing = bySku.get(entry.sku);
    return {
      ...entry,
      retail: existing?.retail ?? null,
      advertising: existing?.advertising ?? null,
      advertisingStatus: existing?.advertising ? existing.advertisingStatus : entry.advertisingStatus,
    } as unknown as Product;
  });
  return {
    ...base,
    catalogProducts: catalog as unknown as Product[],
    products,
    quality: {
      ...base.quality,
      activeProducts: products.length,
      masterCatalogProducts: catalog.length,
      masterCatalogEanProducts: catalog.filter((entry) => entry.ean).length,
      economicsCoverageProducts: catalog.filter((entry) => entry.margin != null).length,
      retailCoverageProducts: products.filter((product) => product.retail != null).length,
      productMasterSource: "Uploaded product master",
    },
  };
}

function comparisonLabel(label: "MoM" | "YoY", current: number | null | undefined, previous: number | null | undefined, inverse = false): { label: string; value: string; tone: string } {
  const change = percentageChange(current, previous);
  if (change == null) return { label, value: "Awaiting period", tone: "neutral" };
  const signed = `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
  const positive = inverse ? change <= 0 : change >= 0;
  return { label, value: signed, tone: positive ? "positive" : "negative" };
}

const typeLabel: Record<RecommendationType, string> = {
  increase: "Increase",
  reduce: "Reduce",
  hold: "Hold",
  pause_review: "Pause / review",
  harvest: "Harvest",
  harvest_review: "Exact conflict review",
  manual_review: "Manual review",
};

const isHarvestType = (type: RecommendationType) => type === "harvest" || type === "harvest_review";

type KnowledgeGroup = "Advertising" | "Retail" | "Profitability" | "Bidding" | "Coverage" | "Data model";

interface KnowledgeTopic {
  id: string;
  group: KnowledgeGroup;
  title: string;
  summary: string;
  formula?: string;
  sources: string[];
  aliases: string[];
}

interface AssistantMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
  headline?: string;
  status?: AssistantAnswerStatus;
  sources?: string[];
  facts?: AssistantMetric[];
  items?: AssistantResultItem[];
  entities?: AssistantEntityRef[];
  followUps?: string[];
}

const sourcePath = (key: string) => data.imports.find((item) => item.key === key)?.path ?? "Source path unavailable";

type SuggestionMetricKey = "targetCost" | "campaignCost" | "productCost" | "acos" | "targetAcos" | "breakEven" | "cpc";

interface SuggestionMetricDetail {
  key: SuggestionMetricKey;
  title: string;
  value: string;
  summary: string;
  formula: string;
  inputs: { label: string; value: string }[];
  sources: string[];
  caveat?: string;
}

function buildSuggestionMetricDetails(
  suggestion: Suggestion,
  settings: RuleSettings,
  campaignCost: number | null,
  productCost: number | null,
): SuggestionMetricDetail[] {
  const isHarvest = isHarvestType(suggestion.type);
  const targetLabel = isHarvest ? "Search term cost" : "Target cost";
  const averageOrderValue = suggestion.purchases > 0 ? suggestion.sales / suggestion.purchases : null;
  const conversionRate = suggestion.clicks > 0 ? suggestion.purchases / suggestion.clicks : null;
  const isKaufland = data.reporting.marketplaceId === "kaufland_de";
  const targetingSource = sourcePath(isKaufland ? "kaufland_spa_ean" : "targeting");
  const campaignSource = sourcePath(isKaufland ? "kaufland_spa_campaign" : "campaign");
  const advertisedProductSource = sourcePath(isKaufland ? "kaufland_spa_daily_campaign" : "advertised_product");
  const economicsSource = sourcePath("economics");

  return [
    {
      key: "targetCost",
      title: targetLabel,
      value: euro(suggestion.spend, true),
      summary: `Advertising cost attributed to this ${isHarvest ? "search term" : "target"} during the current 30-day evidence window.`,
      formula: `Σ advertising cost for the matching campaign, ad group and ${isHarvest ? "search term" : "target"}`,
      inputs: [
        { label: "Campaign", value: suggestion.campaignName },
        { label: isHarvest ? "Search term" : "Target", value: suggestion.harvestTerm || suggestion.target },
        { label: "30-day result", value: euro(suggestion.spend, true) },
      ],
      sources: [targetingSource],
    },
    {
      key: "campaignCost",
      title: "Campaign ad cost",
      value: euro(campaignCost, true),
      summary: "Total advertising cost for the selected campaign over the reporting period. This is wider than the individual target or search term.",
      formula: "Σ advertising cost for all rows in the selected campaign",
      inputs: [
        { label: "Campaign", value: suggestion.campaignName },
        { label: "30-day result", value: euro(campaignCost, true) },
      ],
      sources: [campaignSource],
      caveat: campaignCost == null ? "No matching campaign-cost row is available, so the value remains unavailable rather than being treated as zero." : undefined,
    },
    {
      key: "productCost",
      title: "Product ad cost",
      value: euro(productCost, true),
      summary: "Total advertising cost attributed to this product across all of its campaigns and targets during the reporting period.",
      formula: "Σ advertising cost for rows matching the product SKU or ASIN",
      inputs: [
        { label: "SKU", value: suggestion.sku || "Unavailable" },
        { label: "ASIN", value: suggestion.asin || "Unavailable" },
        { label: "30-day result", value: euro(productCost, true) },
      ],
      sources: [advertisedProductSource],
      caveat: productCost == null ? "The product could not be matched to an Advertised Product row, so the value remains unavailable." : undefined,
    },
    {
      key: "acos",
      title: "30-day ACoS",
      value: pct(suggestion.acos),
      summary: `The share of attributed ${isHarvest ? "search-term" : "target"} sales consumed by advertising cost. Lower is more efficient.`,
      formula: `${targetLabel} ÷ attributed advertising sales`,
      inputs: [
        { label: targetLabel, value: euro(suggestion.spend, true) },
        { label: "Attributed sales", value: euro(suggestion.sales, true) },
        { label: "30-day ACoS", value: pct(suggestion.acos) },
      ],
      sources: [targetingSource],
      caveat: suggestion.sales <= 0 ? "ACoS is unavailable when attributed sales are zero; the rules engine evaluates zero-order spend against target cost instead." : undefined,
    },
    {
      key: "targetAcos",
      title: "Target ACoS",
      value: pct(suggestion.targetAcos),
      summary: "The strategic efficiency threshold used by the rules engine. It preserves a safety share of the product contribution margin.",
      formula: "Product contribution margin × aggressiveness factor",
      inputs: [
        { label: "Contribution margin", value: pct(suggestion.breakEvenAcos) },
        { label: "Aggressiveness factor", value: pct(settings.aggressivenessFactor, 0) },
        { label: "Target ACoS", value: pct(suggestion.targetAcos) },
      ],
      sources: [economicsSource, targetingSource],
      caveat: suggestion.targetAcos == null ? "A missing product contribution margin prevents calculation and forces manual review." : undefined,
    },
    {
      key: "breakEven",
      title: "Break-even ACoS",
      value: pct(suggestion.breakEvenAcos),
      summary: "The product contribution margin before advertising. If ACoS exceeds this percentage, advertising has consumed the available product contribution.",
      formula: "Imported Margin (%) or (net selling price − landed cost) ÷ net selling price",
      inputs: [
        { label: "Product", value: suggestion.sku || suggestion.asin || suggestion.productName },
        { label: "Break-even ACoS", value: pct(suggestion.breakEvenAcos) },
      ],
      sources: [economicsSource],
      caveat: "This is a product-level contribution-margin guardrail from the calculation workbook, not the dashboard’s net contribution margin after provision and advertising.",
    },
    {
      key: "cpc",
      title: isHarvest ? "Observed CPC" : "Maximum CPC",
      value: euro(isHarvest ? suggestion.observedCpc : suggestion.maxCpc, true),
      summary: isHarvest
        ? "The average amount paid for each click on this search term in the evidence window."
        : "The profit-safe click ceiling derived from observed order value, conversion rate and Target ACoS.",
      formula: isHarvest ? `${targetLabel} ÷ clicks` : "Average order value × conversion rate × Target ACoS",
      inputs: isHarvest ? [
        { label: targetLabel, value: euro(suggestion.spend, true) },
        { label: "Clicks", value: integer.format(suggestion.clicks) },
        { label: "Observed CPC", value: euro(suggestion.observedCpc, true) },
      ] : [
        { label: "Average order value", value: euro(averageOrderValue, true) },
        { label: "Conversion rate", value: pct(conversionRate) },
        { label: "Target ACoS", value: pct(suggestion.targetAcos) },
        { label: "Maximum CPC", value: euro(suggestion.maxCpc, true) },
      ],
      sources: [targetingSource, economicsSource],
      caveat: (isHarvest ? suggestion.observedCpc : suggestion.maxCpc) == null ? "The required evidence is unavailable, so the rules engine does not estimate a value." : undefined,
    },
  ];
}

function buildKnowledgeTopics(settings: RuleSettings): KnowledgeTopic[] {
  const policy = resolveRulePolicy(settings);
  const isKaufland = data.reporting.marketplaceId === "kaufland_de";
  const advertisedProduct = sourcePath(isKaufland ? "kaufland_spa_daily_campaign" : "advertised_product");
  const targeting = sourcePath(isKaufland ? "kaufland_spa_ean" : "targeting");
  const campaign = sourcePath(isKaufland ? "kaufland_spa_campaign" : "campaign");
  const businessReport = sourcePath(isKaufland ? "kaufland_sales" : "business_report");
  const productList = sourcePath("product_master");
  const economics = sourcePath("economics");
  return [
    { id: "ad-sales", group: "Advertising", title: "Advertising sales", summary: isKaufland ? "Attributed sales summed from SPA daily campaign performance. Campaign summary and EAN performance must reconcile to it and are never added again." : "Attributed sales from the 30-day Advertised Product export. It is the only source used for the dashboard advertising-sales total.", formula: "Σ attributed advertising sales", sources: [advertisedProduct], aliases: ["ad sales", "advertising revenue", "attributed sales"] },
    { id: "ad-spend", group: "Advertising", title: "Advertising spend", summary: isKaufland ? "Cost summed from SPA daily campaign performance. Campaign summary, EAN performance, daily account cost and daily campaign cost are validation/allocation views of the same spend." : "Advertising cost summed from Advertised Product rows after marketplace and EUR validation. Campaign cost shown in suggestion details comes separately from the Campaign export.", formula: "Σ advertising cost", sources: [advertisedProduct, campaign], aliases: ["ad cost", "advertising cost", "spend"] },
    { id: "acos", group: "Advertising", title: "ACoS", summary: "Advertising Cost of Sales measures how much advertising cost was required for each euro of attributed advertising sales.", formula: "Advertising spend ÷ advertising sales", sources: [advertisedProduct, targeting], aliases: ["acos", "advertising cost of sales"] },
    { id: "roas", group: "Advertising", title: "ROAS", summary: "Return on Ad Spend is the inverse of ACoS and shows attributed advertising sales per euro of spend.", formula: "Advertising sales ÷ advertising spend", sources: [advertisedProduct, targeting], aliases: ["roas", "return on ad spend"] },
    { id: "ctr", group: "Advertising", title: "CTR", summary: "Click-through rate measures the share of advertising impressions that produced a click.", formula: "Clicks ÷ impressions", sources: [advertisedProduct, targeting], aliases: ["ctr", "click through", "click-through"] },
    { id: "cvr", group: "Advertising", title: "Advertising CVR", summary: "Advertising conversion rate measures the share of advertising clicks that produced an attributed purchase.", formula: "Attributed purchases ÷ clicks", sources: [advertisedProduct, targeting], aliases: ["cvr", "ad conversion", "advertising conversion"] },
    { id: "cpc", group: "Advertising", title: "Average CPC", summary: "Average cost per click is calculated after aggregation so row-level rounding does not distort the result.", formula: "Advertising spend ÷ clicks", sources: [advertisedProduct, targeting], aliases: ["cpc", "cost per click"] },
    { id: "cpa", group: "Advertising", title: "CPA", summary: "Advertising cost per attributed purchase. This is an observed efficiency metric, not the rules engine's target cost per order.", formula: "Advertising spend ÷ attributed purchases", sources: [advertisedProduct, targeting], aliases: ["cpa", "cost per acquisition", "cost per order"] },
    { id: "aov", group: "Advertising", title: "Average order value", summary: "Average attributed advertising sales per advertising purchase.", formula: "Advertising sales ÷ attributed purchases", sources: [advertisedProduct, targeting], aliases: ["aov", "average order value", "order value"] },
    { id: "retail-sales", group: "Retail", title: "Reported retail sales", summary: isKaufland ? "Price from unique Sales GMU order units after cancelled and returned units are excluded. Shipping charges are excluded for Amazon comparability; unmatched products stay in totals and the quality queue." : "Ordered Product Sales from the supplied Business Report. Missing products remain unavailable rather than zero.", formula: isKaufland ? "Σ(price ÷ 100) for valid unique order units" : "Σ Ordered Product Sales", sources: [businessReport], aliases: ["retail sales", "business report sales", "total sales"] },
    { id: "retail-conversion", group: "Retail", title: "Retail conversion", summary: isKaufland ? "Unavailable because the supplied Sales GMU report has no retail-session field. It is never displayed as zero." : "Unit Session Percentage for the products present in the supplied Business Report.", formula: isKaufland ? "Unavailable from this source" : "Retail units ordered ÷ retail sessions", sources: [businessReport], aliases: ["retail conversion", "unit session", "sessions conversion"] },
    { id: "product-ranking", group: "Retail", title: "Product ranking", summary: isKaufland ? "Matched products are ranked by valid Sales GMU revenue and sold order units. Unmatched Kaufland products remain in marketplace totals and the quality queue, not at zero." : "Products with a Business Report row are ranked by reported Ordered Product Sales by default. Sold units come from the same report. The displayed product contribution margin is gross before provision and advertising, sourced from the calculation workbook.", formula: "Rank = descending reported product revenue; weighted gross margin = Σ(revenue × product margin) ÷ revenue with margin", sources: [businessReport, economics, productList], aliases: ["product ranking", "revenue ranking", "sold units", "gross product margin"] },
    { id: "tcos", group: "Profitability", title: "TCOS", summary: "Total Advertising Cost of Sales compares all dashboard advertising spend with the reported retail sales available in the Business Report.", formula: "Advertising spend ÷ reported retail sales", sources: [advertisedProduct, businessReport], aliases: ["tcos", "total acos", "total advertising cost"] },
    { id: "net-contribution", group: "Profitability", title: "Net contribution", summary: "Covered net retail sales less purchase cost, delivery cost, provision, and all advertising cost. Gross retail sales are converted to net using the current 19% VAT assumption; provision is currently 15% of covered net sales.", formula: "Covered net sales − purchase cost − delivery cost − provision − advertising cost", sources: [businessReport, economics, advertisedProduct], aliases: ["net contribution", "profit", "total cost"] },
    { id: "net-margin", group: "Profitability", title: "Net contribution margin", summary: "The share of covered net retail sales remaining after purchase, delivery, provision, and advertising costs. It is explicitly a net contribution margin, not gross margin.", formula: "Net contribution ÷ covered net sales", sources: [businessReport, economics, advertisedProduct], aliases: ["contribution margin", "net margin", "margin"] },
    { id: "target-acos", group: "Bidding", title: "Target ACoS", summary: `The profitability guardrail for a product. The current aggressiveness factor is ${pct(settings.aggressivenessFactor, 0)}; a missing contribution margin forces manual review.`, formula: "Product contribution margin × aggressiveness factor", sources: [economics, targeting], aliases: ["target acos", "acos target", "aggressiveness"] },
    { id: "maximum-cpc", group: "Bidding", title: "Maximum CPC", summary: "The profit-safe click ceiling based on the target's observed order value and conversion rate. Bid increases and harvest bids are capped here.", formula: "Average order value × conversion rate × target ACoS", sources: [targeting, economics], aliases: ["maximum cpc", "max cpc", "safe bid", "bid ceiling"] },
    { id: "suggested-bid", group: "Bidding", title: "Suggested bid", summary: isKaufland ? "The supplied seven Kaufland files contain no verified current bid. The engine shows product-level increase, decrease or hold direction but intentionally leaves the exact bid blank instead of estimating it from CPC." : `The rule change is applied to the current bid, limited to ${pct(settings.maxBidChange, 0)} per review cycle, floored at €0.02, and any increase is capped at maximum CPC.`, formula: isKaufland ? "Direction from ACoS rule; exact bid unavailable" : "Current bid × (1 + rule change), constrained by safety caps", sources: [targeting, economics], aliases: ["suggested bid", "bid suggestion", "new bid"] },
    { id: "harvest", group: "Bidding", title: "Keyword harvest", summary: isKaufland ? "Unavailable from the supplied package because no search-term ownership or exact-keyword target report is present. No conflict-free harvest is inferred." : `A profitable search term with at least ${policy.harvestMinimumPurchases} purchases can be created as an exact keyword only when it is absent from the same product's exact targets. Existing exact use by another product becomes a conflict review.`, formula: isKaufland ? "Unavailable from this source" : `Starting bid = source bid, or observed CPC × ${policy.harvestBidBuffer.toFixed(2)}; capped at maximum CPC`, sources: [targeting, economics], aliases: ["harvest", "harvesting", "exact keyword", "search term"] },
    { id: "evidence", group: "Bidding", title: "Evidence and confidence", summary: `Targets below ${settings.minimumClicks} clicks are held. Confidence is high from at least 5 purchases or 40 clicks, medium from at least 2 purchases or 15 clicks, and otherwise low. Every action still requires human approval.`, sources: [targeting], aliases: ["confidence", "evidence", "minimum clicks", "approval"] },
    { id: "retail-coverage", group: "Coverage", title: "Retail product coverage", summary: isKaufland ? "Marketplace offers matched to the fixed completed product master that also have valid Sales GMU activity. Unmatched products stay in the data-quality queue and missing rows are never converted to zero." : "Active Amazon listing SKUs that have a row in the supplied Business Report. Missing rows remain unavailable and are never converted to zero sales.", formula: isKaufland ? "Matched products with Sales GMU activity ÷ marketplace products matched to completed product master" : "Business Report SKUs ÷ active Amazon listing SKUs", sources: [productList, businessReport], aliases: ["retail coverage", "46", "missing sku", "absent sku"] },
    { id: "cost-coverage", group: "Coverage", title: "Cost coverage", summary: "The share of reported gross retail sales for which both per-unit purchase and delivery costs are available. It is not full-catalog Business Report coverage.", formula: "Reported gross sales with purchase and delivery inputs ÷ reported retail sales", sources: [businessReport, economics], aliases: ["cost coverage", "cost inputs", "economics coverage"] },
    { id: "period-comparisons", group: "Data model", title: "MoM and YoY comparisons", summary: "Each valid upload is stored as an immutable snapshot. The dashboard compares the current snapshot with a similarly sized period whose end date is closest to one month or one year earlier. Until a matching period exists, the card says Awaiting period.", formula: "(Current KPI − comparison KPI) ÷ absolute comparison KPI", sources: ["Persistent snapshot database (period metrics)", "Persistent source archive (raw uploaded CSV files)"], aliases: ["mom", "yoy", "month over month", "year over year", "history", "snapshot"] },
    { id: "flexible-advertising-range", group: "Data model", title: "Flexible advertising range", summary: "Daily advertising facts are merged across retained snapshots by date. When uploads overlap, the newest retained snapshot supplies that date. Missing dates remain visibly missing. Retail, margin, product and bidding data stay on the complete snapshot until daily retail and product facts are available.", formula: "Σ newest retained daily advertising facts within From–To", sources: ["Persistent snapshot database (date coverage)", "Persistent normalized snapshot archive (daily Advertised Product facts)"], aliases: ["custom date", "advertising only", "flexible range", "overlap", "deduplicate", "missing days"] },
    { id: "duplicate-protection", group: "Data model", title: "Duplicate protection", summary: isKaufland ? "SPA daily campaign performance controls advertising totals. Campaign summary, EAN performance, daily account cost and daily campaign cost must reconcile but are never added to that total." : "Dashboard totals use Advertised Product only. Targeting drives recommendations and already contains daily search-term evidence. The optional Search Term summary validates the model and is never added to totals.", sources: isKaufland ? [advertisedProduct, campaign, targeting, sourcePath("kaufland_spa_daily_cost"), sourcePath("kaufland_spa_daily_cost_campaign")] : [advertisedProduct, targeting, sourcePath("search_term_summary")], aliases: ["duplicate", "double counting", "data model", "normalization"] },
  ];
}

function KpiCard({ label, value, subValue, detail, tone = "blue", tooltip, comparisons, onSelect }: { label: string; value: string; subValue?: string; detail: string; tone?: string; tooltip?: string; comparisons?: { label: string; value: string; tone: string; detail?: string }[]; onSelect?: () => void }) {
  const clickable = Boolean(onSelect);
  const interaction = clickable ? { role: "button", tabIndex: 0, onClick: onSelect, onKeyDown: (event: ReactKeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect?.(); } }, "aria-label": `Open details for ${label}` } : {};
  return (
    <article className={`kpi-card tone-${tone} ${clickable ? "clickable-kpi" : ""}`} title={tooltip} {...interaction}>
      <div className="kpi-top"><span>{label}</span>{tooltip ? <span className="kpi-info" aria-label={tooltip}>i</span> : <span className="kpi-dot" />}</div>
      <strong>{value}</strong>
      {subValue && <span className="kpi-subvalue">{subValue}</span>}
      <small>{detail}</small>
      {comparisons && <div className="kpi-comparisons">{comparisons.map((comparison) => <span className={comparison.tone} key={comparison.label} title={comparison.detail}><b>{comparison.label}</b>{comparison.value}</span>)}</div>}
      {clickable && <span className="kpi-action">Explore details <b>→</b></span>}
    </article>
  );
}

const contributionPalette = ["#2468e8", "#7555d9", "#139b65", "#d88719", "#dd6f9e", "#8c99aa"];

function ProductContributionDonut({ breakdown }: { breakdown: ProductContributionBreakdown }) {
  const circumference = 2 * Math.PI * 42;
  let cumulativeShare = 0;
  const formatValue = (value: number) => breakdown.valueKind === "currency" ? euro(value, true) : integer.format(value);
  return (
    <section className="product-contribution" aria-labelledby="product-contribution-title">
      <div className="product-contribution-heading">
        <div><span>Product contribution</span><h3 id="product-contribution-title">{breakdown.title}</h3><p>{breakdown.subtitle}</p></div>
        <span className="product-contribution-count">{breakdown.slices.length} chart segments</span>
      </div>
      {breakdown.total > 0 && breakdown.slices.length > 0 ? (
        <div className="product-contribution-layout">
          <div className="product-donut-wrap">
            <svg className="product-donut" viewBox="0 0 120 120" role="img" aria-label={`${breakdown.title}. ${formatValue(breakdown.total)} total.`}>
              <circle className="product-donut-track" cx="60" cy="60" r="42" />
              {breakdown.slices.map((slice, index) => {
                const dashLength = Math.max(0, slice.share * circumference - 1.4);
                const dashOffset = -(cumulativeShare * circumference);
                cumulativeShare += slice.share;
                return <circle key={slice.id} className="product-donut-segment" cx="60" cy="60" r="42" stroke={contributionPalette[index % contributionPalette.length]} strokeDasharray={`${dashLength} ${circumference - dashLength}`} strokeDashoffset={dashOffset} transform="rotate(-90 60 60)"><title>{slice.label}: {formatValue(slice.value)} ({pct(slice.share)})</title></circle>;
              })}
            </svg>
            <div className="product-donut-center"><strong>{formatValue(breakdown.total)}</strong><span>{breakdown.centerLabel}</span></div>
          </div>
          <div className="product-contribution-legend">
            {breakdown.slices.map((slice, index) => <div className="product-contribution-row" key={slice.id}>
              <i style={{ backgroundColor: contributionPalette[index % contributionPalette.length] }} />
              <div title={slice.label}><b>{slice.label}</b><small>{slice.secondary}</small></div>
              <dl><dt>{pct(slice.share)}</dt><dd>{formatValue(slice.value)}</dd></dl>
            </div>)}
          </div>
        </div>
      ) : <div className="product-contribution-empty"><b>No positive product contribution is available</b><span>The selected metric has no product-level value in the current snapshot.</span></div>}
      {breakdown.note && <p className="product-contribution-note"><span>i</span>{breakdown.note}</p>}
    </section>
  );
}

function StatusPill({ children, tone }: { children: React.ReactNode; tone: string }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function Dashboard({ onNavigate, history, currentSummary, advertisingRange }: { onNavigate: (page: PageKey) => void; history: SnapshotHistorySummary[]; currentSummary: SnapshotHistorySummary; advertisingRange: MergedAdvertisingRange | null }) {
  if (marketplaceSelectionGlobal === "all") return <MarketplacePerformance currentSummary={currentSummary} onOpenImports={openImportsGlobal} onOpenMarketplace={(marketplaceId) => changeMarketplaceGlobal(marketplaceId)} />;
  if (!marketplaceAvailableGlobal) return <EmptyMarketplace marketplaceId={marketplaceSelectionGlobal} onOpenImports={openImportsGlobal} />;
  const ad = advertisingRange?.totals ?? data.totals.advertising;
  const daily = advertisingRange?.daily ?? data.daily;
  const advertisingOnly = Boolean(advertisingRange);
  const retail = data.totals.retail;
  const profitability = data.totals.profitability;
  const momSnapshot = comparableSnapshot(history, currentSummary, "mom");
  const yoySnapshot = comparableSnapshot(history, currentSummary, "yoy");
  const comparisonDetail = (label: "MoM" | "YoY", snapshot: SnapshotHistorySummary | null, period: "mom" | "yoy") => snapshot
    ? `${label} compares with ${displayDate(snapshot.periodStart)} – ${displayDate(snapshot.periodEnd)}.`
    : `${label} needs a similar ${currentSummary.periodDays}-day snapshot ending near ${displayDate(comparisonTargetDate(currentSummary, period).toISOString().slice(0, 10))}.`;
  const comparisons = (currentValue: number | null | undefined, selector: (item: SnapshotHistorySummary) => number | null | undefined, inverse = false) => [
    { ...comparisonLabel("MoM", currentValue, momSnapshot ? selector(momSnapshot) : null, inverse), detail: comparisonDetail("MoM", momSnapshot, "mom") },
    { ...comparisonLabel("YoY", currentValue, yoySnapshot ? selector(yoySnapshot) : null, inverse), detail: comparisonDetail("YoY", yoySnapshot, "yoy") },
  ];
  const advertisingComparisons = (currentValue: number | null | undefined, selector: (item: SnapshotHistorySummary) => number | null | undefined, inverse = false) => advertisingOnly
    ? [{ label: "MoM", value: "Full snapshots only", tone: "neutral", detail: "MoM and YoY comparisons remain tied to complete reporting snapshots." }, { label: "YoY", value: "Full snapshots only", tone: "neutral", detail: "MoM and YoY comparisons remain tied to complete reporting snapshots." }]
    : comparisons(currentValue, selector, inverse);
  const [activeMetric, setActiveMetric] = useState<MetricKey | null>(null);
  const [coverageSearch, setCoverageSearch] = useState("");
  const maxSales = Math.max(...daily.map((day) => day.sales), 1);
  const maxPlacementSpend = Math.max(...data.placements.map((placement) => placement.spend), 1);
  const [productSearch, setProductSearch] = useState("");
  const products = data.products.filter((product) => `${product.name} ${product.sku} ${product.asin}`.toLowerCase().includes(productSearch.toLowerCase())).slice(0, 12);
  const missingRetailProducts = useMemo(() => data.products.filter((product) => product.retail == null).sort((left, right) => (right.advertising?.spend ?? 0) - (left.advertising?.spend ?? 0)), []);
  const filteredMissingRetailProducts = missingRetailProducts.filter((product) => `${product.name} ${product.sku} ${product.asin} ${product.category}`.toLowerCase().includes(coverageSearch.toLowerCase()));
  const missingWithAdImpressions = missingRetailProducts.filter((product) => (product.advertising?.impressions ?? 0) > 0).length;
  const missingWithAdClicks = missingRetailProducts.filter((product) => (product.advertising?.clicks ?? 0) > 0).length;
  const missingWithAdPurchases = missingRetailProducts.filter((product) => (product.advertising?.purchases ?? 0) > 0).length;
  const campaignReportSpend = data.campaigns.reduce((sum, campaign) => sum + campaign.spend, 0);
  const importPath = (key: string) => data.imports.find((item) => item.key === key)?.path ?? "Source path unavailable";
  const isKaufland = data.reporting.marketplaceId === "kaufland_de";
  const advertisingSourceName = isKaufland ? "SPA daily campaign performance" : "Advertised Product";
  const retailSourceName = isKaufland ? "Sales GMU" : "Business Report";
  const advertisedProductPath = advertisingRange
    ? `Merged daily ${advertisingSourceName} facts from ${advertisingRange.coverage.sourceSnapshots.length} retained snapshot${advertisingRange.coverage.sourceSnapshots.length === 1 ? "" : "s"}; newest upload wins for overlapping dates.`
    : importPath(isKaufland ? "kaufland_spa_daily_campaign" : "advertised_product");
  const campaignPath = importPath(isKaufland ? "kaufland_spa_campaign" : "campaign");
  const businessReportPath = importPath(isKaufland ? "kaufland_sales" : "business_report");
  const productListPath = importPath("product_master");
  const economicsPath = importPath("economics");
  const metricDetails: Record<MetricKey, MetricDetail> = {
    adSales: {
      title: "Advertising sales",
      value: euro(ad.sales, true),
      explanation: advertisingRange ? `${data.reporting.marketplace} attributed ${euro(ad.sales)} in sales during the selected ${advertisingRange.reporting.days}-day advertising range. Daily facts were merged across retained uploads.` : `${data.reporting.marketplace} attributed ${euro(ad.sales)} in sales to advertising during this ${data.reporting.days}-day window. This is attributed advertising revenue, not total retail revenue.`,
      formula: advertisingRange ? "Sum of daily attributed advertising sales after date filtering and overlap deduplication." : `Sum of Sales in the ${data.reporting.days}-day ${advertisingSourceName} export.`,
      source: `${advertisingSourceName} report`,
      sourcePaths: [advertisedProductPath],
      stats: [{ label: "Attributed purchases", value: integer.format(ad.purchases) }, { label: "Average order value", value: euro(ad.aov, true) }, { label: "ROAS", value: ad.roas == null ? "—" : `${decimal.format(ad.roas)}×` }],
      caveat: advertisingRange ? "Product contribution is not shown because product-level daily facts are not retained yet." : undefined,
    },
    adSpend: {
      title: "Advertising spend",
      value: euro(ad.spend, true),
      explanation: advertisingRange ? `Daily advertising facts accumulated ${euro(ad.spend)} of cost in the selected range. Overlapping dates use the newest retained upload.` : isKaufland ? `The authoritative daily campaign export reports ${euro(ad.spend)} of advertising cost. Campaign summary, EAN performance and both cost reports were reconciled to this amount and are not added again.` : `Products accumulated ${euro(ad.spend)} of advertising cost. The Campaign export reports ${euro(campaignReportSpend)}, so the ${euro(Math.abs(ad.spend - campaignReportSpend), true)} source difference remains visible.`,
      formula: advertisingRange ? "Sum of daily Total cost after date filtering and overlap deduplication." : isKaufland ? "Sum of Cost (€) in SPA daily campaign performance; four overlapping reports are validation/allocation sources only." : "Sum of Total cost in Advertised Product; campaign cost is shown separately from the Campaign export.",
      source: `${advertisingSourceName} and campaign reports`,
      sourcePaths: [advertisedProductPath, campaignPath],
      stats: [{ label: "Average CPC", value: euro(ad.cpc, true) }, { label: advertisingRange ? "Merged daily cost" : "Product-report cost", value: euro(ad.spend, true) }, { label: "Campaign-report cost", value: advertisingRange ? "Full snapshot only" : euro(campaignReportSpend, true) }],
      caveat: advertisingRange ? "Campaign and product cost breakdowns remain on the complete snapshot until their daily facts are retained." : isKaufland ? "If the five overlapping advertising totals differ beyond tolerance, import is blocked and all seven reports must be re-exported for the same range." : "The dashboard total uses Advertised Product because it also supports the product-level drill-down. The Campaign export is not forced to match it.",
    },
    acos: {
      title: "Advertising cost of sales (ACoS)",
      value: pct(ad.acos, 2),
      explanation: `For every €1.00 of advertising-attributed sales, ${euro(ad.acos, true)} was spent on ads${advertisingRange ? " in the selected advertising range" : ""}. Lower is more efficient, but it must be compared with each product’s break-even margin.`,
      formula: `${euro(ad.spend, true)} advertising spend ÷ ${euro(ad.sales, true)} advertising-attributed sales.`,
      source: `${advertisingSourceName} report`,
      sourcePaths: [advertisedProductPath],
      stats: [{ label: "Ad spend", value: euro(ad.spend, true) }, { label: "Ad sales", value: euro(ad.sales, true) }, { label: "ROAS", value: ad.roas == null ? "—" : `${decimal.format(ad.roas)}×` }],
      caveat: advertisingRange ? "ACoS is complete only for the covered advertising days shown in the range banner." : undefined,
    },
    tcos: {
      title: "Total advertising cost of sales (TCOS)",
      value: advertisingRange ? "—" : pct(profitability.tcos, 2),
      explanation: advertisingRange ? "TCOS is unavailable for a flexible advertising-only range because retail sales do not yet have daily dates. Combining custom-range spend with full-snapshot retail sales would be misleading." : `Advertising consumed ${pct(profitability.tcos, 2)} of the retail sales reported for the period. Unlike ACoS, TCOS uses all reported retail sales as the denominator.`,
      formula: advertisingRange ? "Requires advertising spend and reported retail sales for exactly the same dates." : `${euro(ad.spend, true)} advertising spend ÷ ${euro(retail.sales, true)} reported retail sales.`,
      source: `${advertisingSourceName} and ${retailSourceName} reports`,
      sourcePaths: [advertisedProductPath, businessReportPath],
      stats: [{ label: "Ad spend", value: euro(ad.spend, true) }, { label: "Reported retail sales", value: advertisingRange ? "Different date scope" : euro(retail.sales, true) }, { label: `${retailSourceName} matched SKUs`, value: integer.format(Number(data.quality.retailCoverageProducts)) }],
      caveat: advertisingRange ? `Import daily retail facts later to enable custom-range TCOS.` : isKaufland ? "TCOS includes every valid non-cancelled Sales GMU order unit, including products that have not yet been mapped to the internal source of truth." : "If the Business Report omitted retail sales from missing SKUs, the true TCOS denominator is larger and the displayed TCOS is overstated.",
    },
    retailSales: {
      title: "Reported retail sales",
      value: euro(retail.sales, true),
      explanation: isKaufland ? `${euro(retail.sales)} is the sum of price for all valid, non-cancelled and non-returned Kaufland order units in the Sales GMU report. ${integer.format(Number(data.quality.retailCoverageProducts))} matched products contribute to product-level analysis; unmatched revenue remains in the marketplace total.` : `${euro(retail.sales)} is the total ordered-product sales contained in the supplied Business Report. It covers ${data.quality.retailCoverageProducts} catalog SKUs, not the full ${data.quality.activeProducts}-SKU catalog.`,
      formula: isKaufland ? "Σ(price in cents ÷ 100) for unique order units where cancel_status = not_cancelled and return_status = not_returned." : "Sum of Ordered Product Sales for all rows present in the Business Report.",
      source: `${retailSourceName} report`,
      sourcePaths: [businessReportPath],
      stats: [{ label: "Units", value: integer.format(retail.units) }, { label: "SKUs represented", value: `${data.quality.retailCoverageProducts}/${data.quality.activeProducts}` }, { label: "Average sales per unit", value: euro(retail.sales / retail.units, true) }],
      caveat: isKaufland ? "Shipping charges are excluded for comparability with Amazon ordered-product sales. Unmatched products stay in the data-quality queue and are never assigned zero margin." : "Products absent from the file remain unavailable, never zero. A fuller Business Report may increase this total.",
    },
    netMargin: {
      title: "Net contribution margin",
      value: pct(profitability.netContributionMargin, 2),
      explanation: `The provisional net contribution is ${euro(profitability.netContribution)} after purchase, delivery, provision and all advertising costs. It is labelled net because gross retail sales are converted to net sales before costs are deducted.`,
      formula: `(${euro(profitability.coveredNetSales, true)} covered net sales − ${euro(profitability.totalCost, true)} total costs) ÷ covered net sales.`,
      source: `${retailSourceName}, calculation workbook and ${advertisingSourceName} report`,
      sourcePaths: [businessReportPath, economicsPath, advertisedProductPath],
      stats: [{ label: "Purchase cost", value: euro(profitability.purchaseCost, true) }, { label: "Delivery cost", value: euro(profitability.deliveryCost, true) }, { label: "Provision", value: euro(profitability.provisionCost, true) }, { label: "Advertising", value: euro(profitability.advertisingCost, true) }],
      caveat: `${pct(profitability.retailSalesCoverage, 2)} cost coverage refers only to sales mapped to products with purchase and delivery inputs. Unmatched marketplace products are not treated as zero. VAT is ${pct(profitability.vatRate, 0)} and provision is currently ${pct(profitability.provisionRate, 0)}.`,
    },
    impressions: {
      title: "Advertising impressions",
      value: integer.format(ad.impressions),
      explanation: `Ads were rendered ${integer.format(ad.impressions)} times during the 30-day reporting window. Impressions measure exposure, not unique shoppers.`,
      formula: `Sum of Impressions in ${advertisingSourceName} after marketplace and EUR validation.`,
      source: `${advertisingSourceName} report`,
      sourcePaths: [advertisedProductPath],
      stats: [{ label: "Clicks", value: integer.format(ad.clicks) }, { label: "Click-through rate", value: pct(ad.ctr, 2) }, { label: "Spend", value: euro(ad.spend, true) }],
    },
    clicks: {
      title: "Advertising clicks",
      value: integer.format(ad.clicks),
      explanation: `${integer.format(ad.clicks)} advertising clicks produced ${integer.format(ad.purchases)} attributed purchases during the window.`,
      formula: `Sum of Clicks in ${advertisingSourceName}; conversion = attributed purchases ÷ clicks.`,
      source: `${advertisingSourceName} report`,
      sourcePaths: [advertisedProductPath],
      stats: [{ label: "Conversion rate", value: pct(ad.cvr, 2) }, { label: "Average CPC", value: euro(ad.cpc, true) }, { label: "Attributed purchases", value: integer.format(ad.purchases) }],
    },
    retailSessions: {
      title: "Reported retail sessions",
      value: retail.sessions == null ? "Unavailable" : integer.format(retail.sessions),
      explanation: retail.sessions == null ? `${data.reporting.marketplace}'s supplied retail report has no session field, so sessions are unavailable rather than zero.` : `The Business Report recorded ${integer.format(retail.sessions)} sessions across the ${data.quality.retailCoverageProducts} SKUs included in that export. It is not a full-catalog session count.`,
      formula: retail.sessions == null ? "Unavailable from the supplied marketplace source." : "Sum of Sessions – Total for rows present in the Business Report.",
      source: `${retailSourceName} report`,
      sourcePaths: [businessReportPath],
      stats: [{ label: "Units", value: integer.format(retail.units) }, { label: "Retail conversion", value: pct(retail.conversion, 2) }, { label: "SKUs represented", value: `${data.quality.retailCoverageProducts}/${data.quality.activeProducts}` }],
      caveat: retail.sessions == null ? "No substitute or inferred session value is used." : `${missingRetailProducts.length} absent SKUs contribute no sessions because their retail values are unavailable, not because they are assumed to be zero.`,
    },
    retailCoverage: {
      title: "Retail data coverage",
      value: `${data.quality.retailCoverageProducts}/${data.quality.activeProducts}`,
      explanation: `Only ${data.quality.retailCoverageProducts} of ${data.quality.activeProducts} marketplace products matched to the source of truth have retail performance in this period. The remaining ${missingRetailProducts.length} matched products are absent from the retail report for this range.`,
      formula: `Marketplace products with a ${retailSourceName} observation ÷ marketplace products matched to the completed product master.`,
      source: isKaufland ? "Kaufland Account listing feed joined by internal SKU/EAN to the completed product master" : "Amazon listing export joined to the completed product master, then to Business Report by seller SKU or ASIN",
      sourcePaths: [productListPath, businessReportPath],
      stats: [{ label: "Missing SKUs", value: integer.format(missingRetailProducts.length) }, { label: "Missing but had ad impressions", value: integer.format(missingWithAdImpressions) }, { label: "Missing but had ad clicks", value: integer.format(missingWithAdClicks) }, { label: "Missing but had ad purchases", value: integer.format(missingWithAdPurchases) }],
      caveat: `The file alone cannot tell us whether each absence means zero retail activity, an export filter, or an omitted listing. Because ${missingWithAdPurchases} absent SKUs still have advertising-attributed purchases, the Business Report should be treated as incomplete rather than assuming all missing products had zero sales.`,
    },
  };
  const selectedMetricDetail = activeMetric ? metricDetails[activeMetric] : null;
  const customAdvertisingMetric = activeMetric != null && ["adSales", "adSpend", "acos", "tcos", "impressions", "clicks"].includes(activeMetric);
  const selectedProductContribution = activeMetric && !(advertisingRange && customAdvertisingMetric) ? buildProductContributionBreakdown(activeMetric, data.products) : null;

  useEffect(() => {
    if (!activeMetric) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setActiveMetric(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [activeMetric]);
  return (
    <>
      <div className="page-heading">
        <div><span className="eyebrow">{advertisingOnly ? "Flexible advertising range" : `${data.reporting.days}-day performance`}</span><h1>{data.reporting.marketplace} control room</h1><p>One reconciled view of retail demand, advertising efficiency, and product profitability.</p></div>
        <button className="primary-button" onClick={() => onNavigate("suggestions")}>Review suggestions <span>→</span></button>
      </div>

      {advertisingRange && <section className={`advertising-range-banner ${advertisingRange.coverage.missingDates.length ? "partial" : "complete"}`}>
        <div><span>Advertising-only range</span><b>{displayDate(advertisingRange.reporting.start)} – {displayDate(advertisingRange.reporting.end)}</b><p>Advertising cards, trend and funnel use merged daily data. Retail, margin, products, placements and bidding recommendations remain on the complete {displayDate(currentSummary.periodStart)} – {displayDate(currentSummary.periodEnd)} snapshot.</p></div>
        <dl><div><dt>Coverage</dt><dd>{advertisingRange.coverage.availableDays}/{advertisingRange.coverage.requestedDays} days</dd></div><div><dt>Sources</dt><dd>{advertisingRange.coverage.sourceSnapshots.length} snapshot{advertisingRange.coverage.sourceSnapshots.length === 1 ? "" : "s"}</dd></div><div><dt>Overlaps removed</dt><dd>{advertisingRange.coverage.overlappingDates}</dd></div></dl>
        {advertisingRange.coverage.missingDates.length > 0 && <small>Missing advertising dates: {advertisingRange.coverage.missingDates.slice(0, 5).map(displayDate).join(", ")}{advertisingRange.coverage.missingDates.length > 5 ? ` and ${advertisingRange.coverage.missingDates.length - 5} more` : ""}.</small>}
      </section>}

      <section className="comparison-overview" aria-label="Month-over-month and year-over-year comparison status">
        <div className="comparison-overview-copy"><span className="eyebrow">Movement</span><h2>MoM and YoY change</h2><p>The percentage changes are shown on every KPI card below. Hover a comparison badge to see its exact comparison period.</p></div>
        <div className={`comparison-period ${momSnapshot ? "ready" : "missing"}`}><span>MoM</span><b>{momSnapshot ? `${displayDate(momSnapshot.periodStart)} – ${displayDate(momSnapshot.periodEnd)}` : "Comparison period missing"}</b><small>{momSnapshot ? `${momSnapshot.periodDays}-day snapshot selected` : `Upload a period ending near ${displayDate(comparisonTargetDate(currentSummary, "mom").toISOString().slice(0, 10))}`}</small></div>
        <div className={`comparison-period ${yoySnapshot ? "ready" : "missing"}`}><span>YoY</span><b>{yoySnapshot ? `${displayDate(yoySnapshot.periodStart)} – ${displayDate(yoySnapshot.periodEnd)}` : "Comparison period missing"}</b><small>{yoySnapshot ? `${yoySnapshot.periodDays}-day snapshot selected` : `Upload a period ending near ${displayDate(comparisonTargetDate(currentSummary, "yoy").toISOString().slice(0, 10))}`}</small></div>
        <button type="button" className="comparison-import-button" onClick={() => onNavigate("comparisons")}>Open Time intelligent KPI comparison <span>→</span></button>
      </section>

      <section className="kpi-grid">
        <KpiCard label="Advertising sales" value={euro(ad.sales)} subValue={activeCurrency === "PLN" ? eurFrom(ad.sales) : undefined} detail={`${integer.format(ad.purchases)} attributed purchases${advertisingOnly ? " · custom range" : ""}`} comparisons={advertisingComparisons(ad.sales, (item) => item.advertisingSales)} onSelect={() => setActiveMetric("adSales")} />
        <KpiCard label="Advertising spend" value={euro(ad.spend)} subValue={activeCurrency === "PLN" ? eurFrom(ad.spend) : undefined} detail={`${euro(ad.cpc, true)} average CPC${advertisingOnly ? " · custom range" : ""}`} comparisons={advertisingComparisons(ad.spend, (item) => item.advertisingSpend, true)} tone="violet" onSelect={() => setActiveMetric("adSpend")} />
        <KpiCard label="ACoS" value={pct(ad.acos)} detail={`${ad.roas == null ? "—" : decimal.format(ad.roas)}× ROAS${advertisingOnly ? " · custom range" : ""}`} comparisons={advertisingComparisons(ad.acos, (item) => item.acos, true)} tone="amber" onSelect={() => setActiveMetric("acos")} />
        <KpiCard label="TCOS" value={advertisingOnly ? "—" : pct(profitability.tcos, 2)} detail={advertisingOnly ? "Unavailable: retail sales are not daily yet" : `${euro(ad.spend)} ad spend ÷ ${euro(retail.sales)} reported sales`} comparisons={advertisingOnly ? undefined : comparisons(profitability.tcos, (item) => item.tcos, true)} tone="amber" tooltip="TCOS needs advertising spend and retail sales for the same date range." onSelect={() => setActiveMetric("tcos")} />
        <KpiCard label="Retail sales" value={euro(retail.sales)} subValue={activeCurrency === "PLN" ? eurFrom(retail.sales) : undefined} detail={advertisingOnly ? `Full ${currentSummary.periodDays}-day snapshot · ${integer.format(retail.units)} units` : `${integer.format(retail.units)} units across ${data.quality.retailCoverageProducts} reported SKUs`} comparisons={comparisons(retail.sales, (item) => item.retailSales)} tone="green" onSelect={() => setActiveMetric("retailSales")} />
        <KpiCard label="Net contribution margin" value={pct(profitability.netContributionMargin, 2)} detail={advertisingOnly ? `Full ${currentSummary.periodDays}-day snapshot · not custom-range` : `${euro(profitability.netContribution)} net · ${pct(profitability.retailSalesCoverage, 2)} of reported sales cost-covered`} comparisons={comparisons(profitability.netContributionMargin, (item) => item.netContributionMargin)} tone="green" tooltip={`Net sales minus purchase, delivery, ${pct(profitability.provisionRate, 0)} provision and mapped advertising costs. Unmatched products remain outside the margin calculation.`} onSelect={() => setActiveMetric("netMargin")} />
        <KpiCard label="Impressions" value={integer.format(ad.impressions)} detail={`${pct(ad.ctr, 2)} click-through rate${advertisingOnly ? " · custom range" : ""}`} comparisons={advertisingComparisons(ad.impressions, (item) => item.impressions)} onSelect={() => setActiveMetric("impressions")} />
        <KpiCard label="Clicks" value={integer.format(ad.clicks)} detail={`${pct(ad.cvr, 2)} advertising conversion${advertisingOnly ? " · custom range" : ""}`} comparisons={advertisingComparisons(ad.clicks, (item) => item.clicks)} tone="violet" onSelect={() => setActiveMetric("clicks")} />
        <KpiCard label="Retail sessions" value={retail.sessions == null ? "Unavailable" : integer.format(retail.sessions)} detail={retail.sessions == null ? `Not included in ${data.reporting.marketplace} retail source` : advertisingOnly ? `Full ${currentSummary.periodDays}-day snapshot · not custom-range` : `${pct(retail.conversion, 2)} conversion across reported SKUs`} comparisons={retail.sessions == null ? undefined : comparisons(retail.sessions, (item) => item.retailSessions)} tone="green" onSelect={() => setActiveMetric("retailSessions")} />
        <KpiCard label="Retail coverage" value={`${data.quality.retailCoverageProducts}/${data.quality.activeProducts}`} detail={`${missingRetailProducts.length} matched marketplace SKUs lack retail activity`} comparisons={comparisons(Number(data.quality.retailCoverageProducts) / Number(data.quality.activeProducts), (item) => item.retailCoverageProducts / item.activeProducts)} tone="slate" tooltip={`Catalog coverage: marketplace products matched to the fixed Product List with a retail observation in ${retailSourceName}.`} onSelect={() => setActiveMetric("retailCoverage")} />
      </section>

      {selectedMetricDetail && activeMetric && (
        <div className="metric-dialog-backdrop" onClick={() => setActiveMetric(null)}>
          <section className="metric-dialog" role="dialog" aria-modal="true" aria-labelledby="metric-dialog-title" onClick={(event) => event.stopPropagation()}>
            <button className="metric-dialog-close" onClick={() => setActiveMetric(null)} aria-label="Close metric details">×</button>
            <span className="metric-dialog-kicker">30-day metric conversation</span>
            <h2 id="metric-dialog-title">{selectedMetricDetail.title}</h2>
            <strong className="metric-dialog-value">{selectedMetricDetail.value}</strong>
            <div className="metric-chat"><span className="metric-avatar">BC</span><div className="metric-bubble"><b>What this metric means</b><p>{selectedMetricDetail.explanation}</p></div></div>
            <div className="metric-detail-stats">{selectedMetricDetail.stats.map((stat) => <div key={stat.label}><span>{stat.label}</span><strong>{stat.value}</strong></div>)}</div>
            {selectedProductContribution && <ProductContributionDonut breakdown={selectedProductContribution} />}
            <div className="metric-definition-grid"><div><span>Calculation</span><p>{selectedMetricDetail.formula}</p></div><div><span>Source</span><p>{selectedMetricDetail.source}</p></div></div>
            <div className="metric-source-paths"><span>Source file {selectedMetricDetail.sourcePaths.length > 1 ? "paths" : "path"}</span>{selectedMetricDetail.sourcePaths.map((path) => <code key={path}>{path}</code>)}</div>
            {selectedMetricDetail.caveat && <div className="metric-caveat"><b>Important context</b><p>{selectedMetricDetail.caveat}</p></div>}
            {activeMetric === "retailCoverage" && <div className="coverage-detail">
              <div className="coverage-detail-heading"><div><span>Missing-product detail</span><h3>{filteredMissingRetailProducts.length} of {missingRetailProducts.length} absent SKUs</h3></div><label className="search-box"><span>⌕</span><input value={coverageSearch} onChange={(event) => setCoverageSearch(event.target.value)} placeholder="Search missing SKU, ASIN or product" /></label></div>
              <div className="missing-products-wrap"><table><thead><tr><th>Missing product</th><th>Category</th><th>Ad cost</th><th>Ad sales</th><th>Ad purchases</th></tr></thead><tbody>{filteredMissingRetailProducts.map((product) => <tr key={product.sku}><td><b>{product.name}</b><small>{product.sku} · {product.asin}</small></td><td>{product.category || "—"}</td><td>{euro(product.advertising?.spend, true)}</td><td>{euro(product.advertising?.sales, true)}</td><td>{product.advertising ? integer.format(product.advertising.purchases) : "—"}</td></tr>)}</tbody></table></div>
              <div className="metric-dialog-actions"><span>Missing retail values are never treated as zero.</span><button className="secondary-button" onClick={() => { setActiveMetric(null); onNavigate("products"); }}>Open product catalog</button></div>
            </div>}
          </section>
        </div>
      )}

      <section className="dashboard-grid wide-left">
        <article className="panel trend-panel">
          <div className="panel-heading"><div><span className="eyebrow">Daily trend</span><h2>Sales and spend</h2></div><div className="legend"><span><i className="legend-sales" /> Sales</span><span><i className="legend-spend" /> Spend</span></div></div>
          <div className="trend-chart" aria-label="Daily advertising sales and spend chart">
            {daily.map((day, index) => {
              const showDate = index === 0 || index === daily.length - 1 || index % Math.max(1, Math.ceil(daily.length / 7)) === 0;
              const dateLabel = new Date(`${day.date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
              const dayLabel = `${displayDate(day.date)}: ${euro(day.sales)} sales, ${euro(day.spend)} spend`;
              return <div className="trend-day" key={day.date} title={dayLabel} aria-label={dayLabel}>
                <div className="bar-stack"><span className="sales-bar" style={{ height: `${Math.max(3, day.sales / maxSales * 100)}%` }} /><span className="spend-bar" style={{ height: `${Math.max(2, day.spend / maxSales * 100)}%` }} /></div>
                {showDate && <small className={index === 0 ? "first" : index === daily.length - 1 ? "last" : ""}>{dateLabel}</small>}
              </div>;
            })}
          </div>
        </article>

        <article className="panel health-panel">
          <div className="panel-heading"><div><span className="eyebrow">Source confidence</span><h2>Data health</h2></div><StatusPill tone="ready">Protected</StatusPill></div>
          <div className="health-score"><strong>{Math.round(Number(data.quality.targetsMatchedToActiveProduct) / Number(data.quality.targets) * 100)}%</strong><span>target-to-product coverage</span></div>
          <ul className="health-list">
            <li><span className="check">✓</span><div><b>{data.imports.length} immutable inputs</b><small>Checksummed at import</small></div></li>
            <li><span className="check">✓</span><div><b>No metric double counting</b><small>Targeting contains daily search-term evidence; the optional summary is validation-only</small></div></li>
            <li><span className="warn">!</span><div><b>{data.quality.ambiguousTargetProductJoins} ambiguous target joins</b><small>Forced to manual review</small></div></li>
          </ul>
          <button className="text-button" onClick={() => onNavigate("imports")}>Open import audit →</button>
        </article>
      </section>

      <section className="dashboard-grid equal">
        <article className="panel funnel-panel">
          <div className="panel-heading"><div><span className="eyebrow">Advertising funnel</span><h2>Impressions to purchases</h2></div></div>
          <div className="funnel" aria-label="Advertising conversion funnel">
            <div className="funnel-step first"><div className="funnel-step-top"><span>01</span><small>Reach</small></div><span>Impressions</span><strong>{integer.format(ad.impressions)}</strong><small>Advertising views</small></div>
            <div className="funnel-arrow"><span>→</span><div><strong>{pct(ad.ctr, 2)}</strong><small>click-through rate</small></div></div>
            <div className="funnel-step second"><div className="funnel-step-top"><span>02</span><small>Engage</small></div><span>Clicks</span><strong>{integer.format(ad.clicks)}</strong><small>{euro(ad.cpc, true)} average CPC</small></div>
            <div className="funnel-arrow"><span>→</span><div><strong>{pct(ad.cvr, 2)}</strong><small>purchase conversion</small></div></div>
            <div className="funnel-step third"><div className="funnel-step-top"><span>03</span><small>Convert</small></div><span>Purchases</span><strong>{integer.format(ad.purchases)}</strong><small>{euro(ad.cpa, true)} cost per purchase</small></div>
          </div>
          <div className="funnel-summary"><div><span>Impression → click</span><strong>1 in {integer.format(ad.clicks ? ad.impressions / ad.clicks : 0)}</strong><small>impressions becomes a click</small></div><div><span>Click → purchase</span><strong>1 in {integer.format(ad.purchases ? ad.clicks / ad.purchases : 0)}</strong><small>clicks becomes a purchase</small></div><div><span>Overall conversion</span><strong>{pct(ad.impressions ? ad.purchases / ad.impressions : null, 3)}</strong><small>impressions become purchases</small></div></div>
          <p className="panel-note funnel-note"><span>i</span>Retail sessions are intentionally excluded because this view follows the advertising journey only.</p>
        </article>

        <article className="panel placements-panel">
          <div className="panel-heading"><div><span className="eyebrow">Placement mix</span><h2>Spend by placement</h2></div></div>
          <div className="placement-list">
            {data.placements.slice(0, 5).map((placement, index) => (
              <div className="placement-row" key={placement.name}>
                <div><span>{placement.name.replace(" on-Amazon", "")}</span><b>{euro(placement.spend)}</b></div>
                <div className="progress"><span style={{ width: `${placement.spend / maxPlacementSpend * 100}%`, opacity: 1 - index * 0.11 }} /></div>
                <small>{pct(placement.acos)} ACoS · {integer.format(placement.purchases)} purchases</small>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="panel table-panel">
        <div className="panel-heading table-heading"><div><span className="eyebrow">Product view</span><h2>All active products</h2></div><label className="search-box"><span>⌕</span><input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="Search SKU, ASIN or product" /></label></div>
        <div className="table-wrap"><table><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Margin</th><th>Retail sales</th><th>Ad spend</th><th>Ad sales</th><th>ACoS</th><th>Status</th></tr></thead>
          <tbody>{products.map((product) => <tr key={product.sku}><td><div className="product-cell"><span className="product-avatar">{product.name.slice(0, 1)}</span><div><b>{product.name}</b><small>{product.sku} · {product.asin}</small></div></div></td><td>{product.category || "—"}</td><td>{euro(product.price, true)}</td><td>{pct(product.margin)}</td><td>{euro(product.retail?.sales)}</td><td>{euro(product.advertising?.spend)}</td><td>{euro(product.advertising?.sales)}</td><td>{pct(product.advertising?.acos)}</td><td><StatusPill tone={product.advertising ? "active" : "quiet"}>{product.advertisingStatus}</StatusPill></td></tr>)}</tbody>
        </table></div>
        <div className="table-footer"><span>Showing {products.length} of {data.products.length} active products</span><button className="text-button" onClick={() => onNavigate("products")}>View product catalog →</button></div>
      </section>
    </>
  );
}

type ComparisonMetricId = "retailSales" | "adSales" | "adSpend" | "acos" | "tcos" | "margin" | "units" | "sessions" | "impressions" | "clicks";

interface ComparisonMetricDefinition {
  id: ComparisonMetricId;
  label: string;
  shortLabel: string;
  format: "currency" | "percent" | "integer";
  inverse?: boolean;
  value: (snapshot: SnapshotHistorySummary) => number | null;
  formula: string;
  source: string;
}

const comparisonMetrics: ComparisonMetricDefinition[] = [
  { id: "retailSales", label: "Reported retail sales", shortLabel: "Retail sales", format: "currency", value: (item) => item.retailSales, formula: "Sum of ordered-product sales in the Business Report.", source: "Business Report" },
  { id: "adSales", label: "Advertising-attributed sales", shortLabel: "Ad sales", format: "currency", value: (item) => item.advertisingSales, formula: "Sum of attributed sales in Advertised Product.", source: "Advertised Product" },
  { id: "adSpend", label: "Advertising spend", shortLabel: "Ad spend", format: "currency", value: (item) => item.advertisingSpend, formula: "Sum of advertising cost in Advertised Product.", source: "Advertised Product" },
  { id: "acos", label: "Advertising cost of sales", shortLabel: "ACoS", format: "percent", inverse: true, value: (item) => item.acos, formula: "Advertising spend ÷ advertising-attributed sales.", source: "Advertised Product" },
  { id: "tcos", label: "Total advertising cost of sales", shortLabel: "TCOS", format: "percent", inverse: true, value: (item) => item.tcos, formula: "Advertising spend ÷ reported retail sales.", source: "Advertised Product + Business Report" },
  { id: "margin", label: "Net contribution margin", shortLabel: "Net margin", format: "percent", value: (item) => item.netContributionMargin, formula: "Net contribution ÷ cost-covered net sales.", source: "Business Report + product economics + Advertised Product" },
  { id: "units", label: "Reported sold units", shortLabel: "Sold units", format: "integer", value: (item) => item.retailUnits, formula: "Sum of units ordered for SKUs present in the Business Report.", source: "Business Report" },
  { id: "sessions", label: "Reported retail sessions", shortLabel: "Sessions", format: "integer", value: (item) => item.retailSessions, formula: "Sum of sessions for SKUs present in the Business Report.", source: "Business Report" },
  { id: "impressions", label: "Advertising impressions", shortLabel: "Impressions", format: "integer", value: (item) => item.impressions, formula: "Sum of advertising impressions after marketplace and currency validation.", source: "Advertised Product" },
  { id: "clicks", label: "Advertising clicks", shortLabel: "Clicks", format: "integer", value: (item) => item.clicks, formula: "Sum of advertising clicks after marketplace and currency validation.", source: "Advertised Product" },
];

function comparisonMetricValue(metric: ComparisonMetricDefinition, value: number | null | undefined): string {
  if (value == null) return "—";
  if (metric.format === "currency") return euro(value);
  if (metric.format === "percent") return pct(value, 2);
  return integer.format(value);
}

function comparisonMovement(change: number | null, inverse = false): { label: string; tone: "positive" | "negative" | "neutral" } {
  if (change == null) return { label: "Awaiting period", tone: "neutral" };
  const label = `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
  if (change === 0) return { label, tone: "neutral" };
  return { label, tone: (inverse ? change < 0 : change > 0) ? "positive" : "negative" };
}

const productComparisonMetrics: { id: ProductComparisonMetric; label: string; shortLabel: string; format: "currency" | "integer"; source: string }[] = [
  { id: "revenue", label: "Reported product revenue", shortLabel: "Revenue", format: "currency", source: "Business Report" },
  { id: "units", label: "Reported sold units", shortLabel: "Units", format: "integer", source: "Business Report" },
  { id: "contribution", label: "Gross product contribution", shortLabel: "Gross contribution", format: "currency", source: "Business Report + product economics" },
];

function productComparisonValue(metric: ProductComparisonMetric, value: number | null | undefined): string {
  if (value == null) return "—";
  return metric === "units" ? integer.format(value) : euro(value);
}

function productCoverageLabel(row: ProductComparisonRow): string {
  if (row.coverage === "matched") return "Both periods";
  return row.coverage === "current-only" ? "Current only" : "Comparison only";
}

function KpiComparisons({ history, currentSummary, onNavigate }: {
  history: SnapshotHistorySummary[];
  currentSummary: SnapshotHistorySummary;
  onNavigate: (page: PageKey) => void;
}) {
  const [selectedMetricId, setSelectedMetricId] = useState<ComparisonMetricId>("retailSales");
  const [productPeriod, setProductPeriod] = useState<"mom" | "yoy">("mom");
  const [productMetric, setProductMetric] = useState<ProductComparisonMetric>("revenue");
  const [productMovement, setProductMovement] = useState<"all" | "increase" | "decrease">("all");
  const [productQuery, setProductQuery] = useState("");
  const [productSnapshots, setProductSnapshots] = useState<{ mom: DashboardData | null; yoy: DashboardData | null }>({ mom: null, yoy: null });
  const [productComparisonLoading, setProductComparisonLoading] = useState(false);
  const [productComparisonError, setProductComparisonError] = useState("");
  const selectedMetric = comparisonMetrics.find((metric) => metric.id === selectedMetricId) ?? comparisonMetrics[0];
  const momSnapshot = comparableSnapshot(history, currentSummary, "mom");
  const yoySnapshot = comparableSnapshot(history, currentSummary, "yoy");
  useEffect(() => {
    let active = true;
    const targets = ([{ period: "mom" as const, snapshot: momSnapshot }, { period: "yoy" as const, snapshot: yoySnapshot }])
      .filter((item): item is { period: "mom" | "yoy"; snapshot: SnapshotHistorySummary } => Boolean(item.snapshot));
    setProductSnapshots({ mom: null, yoy: null });
    setProductComparisonError("");
    if (targets.length === 0) {
      setProductComparisonLoading(false);
      return () => { active = false; };
    }
    setProductComparisonLoading(true);
    Promise.all(targets.map(async (item) => {
      const response = await fetch(snapshotRequestPath(item.snapshot.id), { cache: "no-store" });
      const payload = await response.json() as { error?: string; snapshot?: DashboardData };
      if (!response.ok || !payload.snapshot) throw new Error(payload.error || "The retained product comparison could not be loaded.");
      return { period: item.period, snapshot: payload.snapshot };
    }))
      .then((loaded) => {
        if (!active) return;
        const next: { mom: DashboardData | null; yoy: DashboardData | null } = { mom: null, yoy: null };
        loaded.forEach((item) => { next[item.period] = item.snapshot; });
        setProductSnapshots(next);
      })
      .catch((error: unknown) => { if (active) setProductComparisonError(error instanceof Error ? error.message : "The retained product comparison could not be loaded."); })
      .finally(() => { if (active) setProductComparisonLoading(false); });
    return () => { active = false; };
  }, [currentSummary.id, momSnapshot?.id, yoySnapshot?.id]);
  const currentValue = selectedMetric.value(currentSummary);
  const momValue = momSnapshot ? selectedMetric.value(momSnapshot) : null;
  const yoyValue = yoySnapshot ? selectedMetric.value(yoySnapshot) : null;
  const momChange = percentageChange(currentValue, momValue);
  const yoyChange = percentageChange(currentValue, yoyValue);
  const periodBars = [
    { key: "yoy", label: "YoY period", snapshot: yoySnapshot, value: yoyValue, color: "yoy" },
    { key: "mom", label: "MoM period", snapshot: momSnapshot, value: momValue, color: "mom" },
    { key: "current", label: "Current", snapshot: currentSummary, value: currentValue, color: "current" },
  ];
  const maxBarValue = Math.max(...periodBars.map((item) => Math.abs(item.value ?? 0)), 1);
  const trend = [...history]
    .sort((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    .map((snapshot) => ({ snapshot, value: selectedMetric.value(snapshot) }))
    .filter((item) => item.value != null)
    .slice(-12);
  const maxTrendValue = Math.max(...trend.map((item) => Math.abs(item.value ?? 0)), 1);
  const productReferenceSummary = productPeriod === "mom" ? momSnapshot : yoySnapshot;
  const productReferenceData = productSnapshots[productPeriod];
  const selectedProductMetric = productComparisonMetrics.find((metric) => metric.id === productMetric) ?? productComparisonMetrics[0];
  const productRows = useMemo(
    () => productReferenceData ? buildProductComparison(data.products, productReferenceData.products, productMetric) : [],
    [currentSummary.id, productMetric, productReferenceData],
  );
  const searchedProductRows = productRows.filter((row) => `${row.name} ${row.sku} ${row.asin} ${row.category ?? ""}`.toLowerCase().includes(productQuery.toLowerCase()));
  const visibleProductRows = searchedProductRows
    .filter((row) => productMovement === "all" || (productMovement === "increase" ? (row.absoluteChange ?? 0) > 0 : (row.absoluteChange ?? 0) < 0))
    .sort((left, right) => {
      const leftChange = left.percentageChange;
      const rightChange = right.percentageChange;
      if (leftChange == null && rightChange == null) return left.name.localeCompare(right.name);
      if (leftChange == null) return 1;
      if (rightChange == null) return -1;
      if (productMovement === "increase") return rightChange - leftChange || (right.currentValue ?? 0) - (left.currentValue ?? 0);
      if (productMovement === "decrease") return leftChange - rightChange || (left.currentValue ?? 0) - (right.currentValue ?? 0);
      return Math.abs(rightChange) - Math.abs(leftChange) || (right.currentValue ?? 0) - (left.currentValue ?? 0);
    });
  const matchedProducts = searchedProductRows.filter((row) => row.coverage === "matched");
  const increasingProducts = matchedProducts.filter((row) => (row.absoluteChange ?? 0) > 0).length;
  const decreasingProducts = matchedProducts.filter((row) => (row.absoluteChange ?? 0) < 0).length;
  const currentOnlyProducts = searchedProductRows.filter((row) => row.coverage === "current-only").length;
  const referenceOnlyProducts = searchedProductRows.filter((row) => row.coverage === "reference-only").length;
  const currentProductTotal = matchedProducts.reduce((sum, row) => sum + (row.currentValue ?? 0), 0);
  const referenceProductTotal = matchedProducts.reduce((sum, row) => sum + (row.referenceValue ?? 0), 0);
  const aggregateProductChange = percentageChange(currentProductTotal, referenceProductTotal);
  const topProductMovers = [...matchedProducts]
    .filter((row) => row.percentageChange != null)
    .sort((left, right) => Math.abs(right.percentageChange!) - Math.abs(left.percentageChange!))
    .slice(0, 8);
  const maxProductMovement = Math.max(...topProductMovers.map((row) => Math.abs(row.percentageChange ?? 0)), 0.01);

  return <>
    <div className="page-heading comparison-page-heading"><div><span className="eyebrow">Retained snapshot analysis</span><h1>Time intelligent KPI comparison</h1><p>Compare the active reporting period with the closest similarly sized snapshot one month and one year earlier.</p></div><button type="button" className="secondary-button" onClick={() => onNavigate("imports")}>Manage comparison data</button></div>

    <section className="comparison-readiness panel">
      <div><span className="eyebrow">Current period</span><b>{displayDate(currentSummary.periodStart)} – {displayDate(currentSummary.periodEnd)}</b><small>{currentSummary.periodDays} days · selected in the header</small></div>
      <div className={momSnapshot ? "ready" : "missing"}><span>MoM comparison</span><b>{momSnapshot ? `${displayDate(momSnapshot.periodStart)} – ${displayDate(momSnapshot.periodEnd)}` : "Period not imported"}</b><small>{momSnapshot ? `${momSnapshot.periodDays}-day snapshot` : `Needed near ${displayDate(comparisonTargetDate(currentSummary, "mom").toISOString().slice(0, 10))}`}</small></div>
      <div className={yoySnapshot ? "ready" : "missing"}><span>YoY comparison</span><b>{yoySnapshot ? `${displayDate(yoySnapshot.periodStart)} – ${displayDate(yoySnapshot.periodEnd)}` : "Period not imported"}</b><small>{yoySnapshot ? `${yoySnapshot.periodDays}-day snapshot` : `Needed near ${displayDate(comparisonTargetDate(currentSummary, "yoy").toISOString().slice(0, 10))}`}</small></div>
    </section>

    <section className="comparison-kpi-grid" aria-label="Select a KPI to visualize">
      {comparisonMetrics.map((metric) => {
        const value = metric.value(currentSummary);
        const mom = percentageChange(value, momSnapshot ? metric.value(momSnapshot) : null);
        const yoy = percentageChange(value, yoySnapshot ? metric.value(yoySnapshot) : null);
        const momMovement = comparisonMovement(mom, metric.inverse);
        const yoyMovement = comparisonMovement(yoy, metric.inverse);
        return <button type="button" className={`comparison-kpi-card ${selectedMetric.id === metric.id ? "active" : ""}`} aria-pressed={selectedMetric.id === metric.id} key={metric.id} onClick={() => setSelectedMetricId(metric.id)}>
          <span>{metric.shortLabel}</span><strong>{comparisonMetricValue(metric, value)}</strong>
          <div><small className={momMovement.tone}><b>MoM</b>{momMovement.label}</small><small className={yoyMovement.tone}><b>YoY</b>{yoyMovement.label}</small></div>
        </button>;
      })}
    </section>

    <section className="comparison-visual-grid">
      <article className="panel comparison-period-chart">
        <header><div><span className="eyebrow">Absolute values</span><h2>{selectedMetric.label}</h2><p>Current value against the selected MoM and YoY reference periods.</p></div><span className="comparison-source">{selectedMetric.source}</span></header>
        <div className="comparison-bars">{periodBars.map((item) => <div className={`comparison-bar-row ${item.color}`} key={item.key}>
          <div><b>{item.label}</b><small>{item.snapshot ? `${displayDate(item.snapshot.periodStart)} – ${displayDate(item.snapshot.periodEnd)}` : "No matching snapshot"}</small></div>
          <div className="comparison-bar-track"><i style={{ width: item.value == null ? "0%" : `${Math.max(4, Math.abs(item.value) / maxBarValue * 100)}%` }} /></div>
          <strong>{comparisonMetricValue(selectedMetric, item.value)}</strong>
        </div>)}</div>
        <footer><span>Calculation</span><p>{selectedMetric.formula}</p></footer>
      </article>

      <article className="panel comparison-movement-panel">
        <header><span className="eyebrow">Movement</span><h2>Change versus comparison periods</h2></header>
        {[{ label: "Month over month", snapshot: momSnapshot, change: momChange, period: "mom" as const }, { label: "Year over year", snapshot: yoySnapshot, change: yoyChange, period: "yoy" as const }].map((item) => {
          const movement = comparisonMovement(item.change, selectedMetric.inverse);
          return <div className={`comparison-movement ${movement.tone}`} key={item.period}><div><span>{item.label}</span><strong>{movement.label}</strong></div><p>{item.snapshot ? `${comparisonMetricValue(selectedMetric, currentValue)} current versus ${comparisonMetricValue(selectedMetric, selectedMetric.value(item.snapshot))} in ${displayDate(item.snapshot.periodStart)} – ${displayDate(item.snapshot.periodEnd)}.` : `Upload a similarly sized period ending near ${displayDate(comparisonTargetDate(currentSummary, item.period).toISOString().slice(0, 10))}.`}</p></div>;
        })}
        {(!momSnapshot || !yoySnapshot) && <button type="button" className="comparison-empty-action" onClick={() => onNavigate("imports")}>Import missing comparison period →</button>}
      </article>
    </section>

    <section className="panel comparison-trend-panel">
      <header><div><span className="eyebrow">Historical movement</span><h2>{selectedMetric.shortLabel} across retained snapshots</h2><p>Up to the twelve most recent imports, ordered by period end date.</p></div><StatusPill tone="quiet">{trend.length} period{trend.length === 1 ? "" : "s"}</StatusPill></header>
      {trend.length > 1 ? <div className="comparison-history-chart">{trend.map((item) => <div className={item.snapshot.id === currentSummary.id ? "current" : ""} key={item.snapshot.id} title={`${displayDate(item.snapshot.periodStart)} – ${displayDate(item.snapshot.periodEnd)}: ${comparisonMetricValue(selectedMetric, item.value)}`}><strong>{comparisonMetricValue(selectedMetric, item.value)}</strong><i style={{ height: `${Math.max(7, Math.abs(item.value ?? 0) / maxTrendValue * 100)}%` }} /><small>{displayDate(item.snapshot.periodEnd)}</small></div>)}</div> : <div className="comparison-trend-empty"><b>One retained period is available</b><p>Import another similarly sized reporting period to reveal the trend.</p></div>}
    </section>

    <section className="panel comparison-table-panel">
      <header><div><span className="eyebrow">KPI reconciliation</span><h2>Current, MoM and YoY values</h2></div><small>Positive and negative colors indicate desirable direction; lower ACoS and TCOS are treated as positive.</small></header>
      <div className="comparison-table-wrap"><table><thead><tr><th>KPI</th><th>Current</th><th>MoM period</th><th>MoM change</th><th>YoY period</th><th>YoY change</th><th>Source</th></tr></thead><tbody>{comparisonMetrics.map((metric) => {
        const current = metric.value(currentSummary);
        const mom = momSnapshot ? metric.value(momSnapshot) : null;
        const yoy = yoySnapshot ? metric.value(yoySnapshot) : null;
        const momMovement = comparisonMovement(percentageChange(current, mom), metric.inverse);
        const yoyMovement = comparisonMovement(percentageChange(current, yoy), metric.inverse);
        return <tr key={metric.id}><td><button type="button" onClick={() => setSelectedMetricId(metric.id)}>{metric.label}</button></td><td>{comparisonMetricValue(metric, current)}</td><td>{comparisonMetricValue(metric, mom)}</td><td><span className={momMovement.tone}>{momMovement.label}</span></td><td>{comparisonMetricValue(metric, yoy)}</td><td><span className={yoyMovement.tone}>{yoyMovement.label}</span></td><td>{metric.source}</td></tr>;
      })}</tbody></table></div>
    </section>

    <section className="panel product-comparison-panel">
      <header className="product-comparison-heading"><div><span className="eyebrow">Product-level movement</span><h2>Which products changed?</h2><p>Compare SKU-level revenue, sold units, or gross contribution without treating absent marketplace retail observations as zero.</p></div><span className="comparison-source">{data.reporting.marketplaceId === "kaufland_de" ? selectedProductMetric.source.replace("Business Report", "Sales GMU") : selectedProductMetric.source}</span></header>
      <div className="product-comparison-toolbar">
        <div className="product-period-toggle" role="group" aria-label="Choose product comparison period"><button type="button" aria-pressed={productPeriod === "mom"} onClick={() => setProductPeriod("mom")}>Month over month</button><button type="button" aria-pressed={productPeriod === "yoy"} onClick={() => setProductPeriod("yoy")}>Year over year</button></div>
        <div className="product-metric-toggle" role="group" aria-label="Choose product comparison metric">{productComparisonMetrics.map((metric) => <button type="button" aria-pressed={productMetric === metric.id} key={metric.id} onClick={() => setProductMetric(metric.id)}>{metric.shortLabel}</button>)}</div>
        <label className="search-box wide"><span>⌕</span><input value={productQuery} onChange={(event) => setProductQuery(event.target.value)} placeholder="Search product, SKU, ASIN or category" /></label>
      </div>
      {productQuery && <div className="product-selection-return" role="status"><span>Showing products matching <b>{productQuery}</b></span><button type="button" onClick={() => setProductQuery("")} aria-label="Clear selected product and return to all products">← Back to all products</button></div>}

      {!productReferenceSummary ? <div className="product-comparison-empty"><b>{productPeriod === "mom" ? "MoM" : "YoY"} product comparison is waiting for a retained period</b><p>Import a similarly sized marketplace reporting package so products can be matched at SKU level.</p><button type="button" onClick={() => onNavigate("imports")}>Import comparison data →</button></div>
      : productComparisonLoading ? <div className="product-comparison-empty"><b>Loading retained product data</b><p>Matching SKUs across the two reporting periods.</p></div>
      : productComparisonError ? <div className="product-comparison-empty error"><b>Product comparison could not be loaded</b><p>{productComparisonError}</p></div>
      : productReferenceData ? <>
        <div className="product-comparison-context"><span>Current: <b>{displayDate(currentSummary.periodStart)} – {displayDate(currentSummary.periodEnd)}</b></span><span>{productPeriod === "mom" ? "MoM" : "YoY"}: <b>{displayDate(productReferenceSummary.periodStart)} – {displayDate(productReferenceSummary.periodEnd)}</b></span></div>
        <div className="product-comparison-summary">
          <article><span>Current matched {selectedProductMetric.shortLabel.toLowerCase()}</span><strong>{productComparisonValue(productMetric, currentProductTotal)}</strong><small>{matchedProducts.length} products in both periods</small></article>
          <article><span>Comparison matched {selectedProductMetric.shortLabel.toLowerCase()}</span><strong>{productComparisonValue(productMetric, referenceProductTotal)}</strong><small>{productPeriod === "mom" ? "MoM" : "YoY"} reference · same SKUs</small></article>
          <article><span>Overall movement</span><strong className={aggregateProductChange == null ? "neutral" : aggregateProductChange >= 0 ? "positive" : "negative"}>{comparisonMovement(aggregateProductChange).label}</strong><small>Matched scope totals</small></article>
          <article><span>Matched products</span><strong>{matchedProducts.length}</strong><small>{currentOnlyProducts} current-only · {referenceOnlyProducts} comparison-only</small></article>
        </div>

        {topProductMovers.length > 0 && <div className="product-mover-section"><div className="product-mover-heading"><div><span className="eyebrow">Largest relative movements</span><h3>{selectedProductMetric.label}</h3></div><small>Percentage change is unavailable when the comparison value is zero.</small></div><div className="product-mover-list">{topProductMovers.map((row) => <button type="button" key={row.sku} onClick={() => setProductQuery(row.sku)} title={`Filter the table to ${row.sku}`}><div><b>{row.name}</b><small>{row.sku} · {productComparisonValue(productMetric, row.referenceValue)} → {productComparisonValue(productMetric, row.currentValue)}</small></div><span className={row.percentageChange! >= 0 ? "positive" : "negative"}>{comparisonMovement(row.percentageChange).label}</span><i className={row.percentageChange! >= 0 ? "positive" : "negative"} style={{ width: `${Math.max(6, Math.abs(row.percentageChange!) / maxProductMovement * 100)}%` }} /></button>)}</div></div>}

        <div className="product-comparison-filter"><div role="group" aria-label="Filter products by movement"><button type="button" aria-pressed={productMovement === "all"} onClick={() => setProductMovement("all")}>All observed</button><button type="button" aria-pressed={productMovement === "increase"} onClick={() => setProductMovement("increase")}>Increases <span>{increasingProducts}</span></button><button type="button" aria-pressed={productMovement === "decrease"} onClick={() => setProductMovement("decrease")}>Decreases <span>{decreasingProducts}</span></button></div><small>{visibleProductRows.length} product{visibleProductRows.length === 1 ? "" : "s"} shown · largest relative movement first</small></div>
        <div className="product-comparison-table-wrap"><table><thead><tr><th>Product</th><th>Current {selectedProductMetric.shortLabel}</th><th>{productPeriod === "mom" ? "MoM" : "YoY"} {selectedProductMetric.shortLabel}</th><th>Absolute change</th><th>Change</th><th>Current gross margin</th><th>Comparison gross margin</th><th>Coverage</th></tr></thead><tbody>{visibleProductRows.map((row) => {
          const movement = comparisonMovement(row.percentageChange);
          return <tr key={row.sku}><td><div className="product-cell"><span className="product-avatar">{row.name.slice(0, 1)}</span><div><b>{row.name}</b><small>{row.sku} · {row.asin} · {row.category || "Uncategorized"}</small></div></div></td><td><b>{productComparisonValue(productMetric, row.currentValue)}</b></td><td>{productComparisonValue(productMetric, row.referenceValue)}</td><td>{row.absoluteChange == null ? "—" : `${row.absoluteChange > 0 ? "+" : ""}${productComparisonValue(productMetric, row.absoluteChange)}`}</td><td><span className={movement.tone}>{movement.label}</span></td><td>{pct(row.currentMargin)}</td><td>{pct(row.referenceMargin)}</td><td><StatusPill tone={row.coverage === "matched" ? "ready" : "partial"}>{productCoverageLabel(row)}</StatusPill></td></tr>;
        })}</tbody></table></div>
        <footer><span><b>Coverage rule:</b> only products with a retail observation in a period receive a value. Missing observations remain unavailable.</span><span>Sources: <code>{sourcePath(data.reporting.marketplaceId === "kaufland_de" ? "kaufland_sales" : "business_report")}</code> · <code>{sourcePath("economics")}</code></span></footer>
      </> : null}
    </section>
  </>;
}

function Suggestions({ settings, reviews, reviewSaveStatus, onDecision, preferences, onPreferencesChange }: {
  settings: RuleSettings;
  reviews: Record<string, ReviewRecord>;
  reviewSaveStatus: SaveStatus;
  onDecision: (suggestionId: string, decision: "approved" | "rejected" | null) => void;
  preferences?: SuggestionPreferences;
  onPreferencesChange: (value: SuggestionPreferences) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [exportNotice, setExportNotice] = useState<{ tone: "info" | "success"; text: string } | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedMetricKey, setSelectedMetricKey] = useState<SuggestionMetricKey | null>(null);
  const lastMetricTrigger = useRef<HTMLButtonElement | null>(null);
  const filter = preferences?.filter ?? "all";
  const sort = preferences?.sort ?? "priority";
  const confidenceFilter = preferences?.confidence ?? "all";
  const reviewFilter = preferences?.review ?? "all";
  const decisions = useMemo(() => Object.fromEntries(Object.entries(reviews).map(([id, record]) => [id, record.decision])), [reviews]);
  const suggestions = useMemo(() => buildSuggestions(data.targetPerformance, settings), [settings]);
  const campaignSpendByName = useMemo(() => new Map(data.campaigns.map((campaign) => [campaign.name, campaign.spend])), []);
  const productSpendBySku = useMemo(() => new Map(data.products.map((product) => [product.sku, product.advertising?.spend ?? null])), []);
  const productSpendByAsin = useMemo(() => new Map(data.products.map((product) => [product.asin, product.advertising?.spend ?? null])), []);
  const campaignAdCost = (suggestion: Suggestion) => campaignSpendByName.get(suggestion.campaignName) ?? null;
  const productAdCost = (suggestion: Suggestion) => (suggestion.sku ? productSpendBySku.get(suggestion.sku) : undefined) ?? (suggestion.asin ? productSpendByAsin.get(suggestion.asin) : undefined) ?? null;
  const rulePolicy = resolveRulePolicy(settings);
  const metricDetails = selected ? buildSuggestionMetricDetails(selected, settings, campaignAdCost(selected), productAdCost(selected)) : [];
  const selectedMetric = metricDetails.find((metric) => metric.key === selectedMetricKey) ?? null;
  const counts = useMemo(() => suggestions.reduce<Record<string, number>>((acc, suggestion) => ({ ...acc, [suggestion.type]: (acc[suggestion.type] || 0) + 1 }), {}), [suggestions]);
  const matchedSuggestions = suggestions.filter((suggestion) => {
    const matchesFilter = filter === "all" || filter === suggestion.type;
    const haystack = `${suggestion.productName} ${suggestion.sku} ${suggestion.asin} ${suggestion.campaignName} ${suggestion.target} ${suggestion.destinationCampaign} ${suggestion.ruleId} ${suggestion.reason} ${suggestion.exactConflicts.map((conflict) => conflict.campaignName).join(" ")}`.toLowerCase();
    return matchesFilter && haystack.includes(query.toLowerCase());
  });
  const arrangedSuggestions = applySuggestionView(matchedSuggestions, { sort, confidence: confidenceFilter, review: reviewFilter, decisions });
  const visible = arrangedSuggestions.slice(0, 100);

  const tabs: { key: typeof filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: suggestions.length },
    { key: "increase", label: "Increase", count: counts.increase || 0 },
    { key: "reduce", label: "Reduce", count: counts.reduce || 0 },
    { key: "hold", label: "Hold", count: counts.hold || 0 },
    { key: "pause_review", label: "Pause / review", count: counts.pause_review || 0 },
    { key: "harvest", label: "Harvest", count: counts.harvest || 0 },
    { key: "harvest_review", label: "Exact conflicts", count: counts.harvest_review || 0 },
    { key: "manual_review", label: "Manual review", count: counts.manual_review || 0 },
  ];
  const summaryCards: { key: RecommendationType; label: string; count: number }[] = [
    { key: "increase", label: "growth opportunities", count: counts.increase || 0 },
    { key: "reduce", label: "bid reductions", count: counts.reduce || 0 },
    { key: "pause_review", label: "pause / review", count: counts.pause_review || 0 },
    { key: "manual_review", label: "data reviews", count: counts.manual_review || 0 },
    { key: "harvest", label: "clean harvests", count: counts.harvest || 0 },
    { key: "harvest_review", label: "exact conflicts", count: counts.harvest_review || 0 },
  ];
  const sortOptions: { key: SuggestionSort; label: string }[] = [
    { key: "priority", label: "Highest priority" },
    { key: "acos", label: "Highest ACoS" },
    { key: "spend", label: "Highest spend" },
    { key: "change", label: "Largest bid change" },
    { key: "product", label: "Product A–Z" },
  ];
  const sortLabel = sortOptions.find((option) => option.key === sort)?.label ?? "Highest priority";
  const activeAdvancedFilters = Number(confidenceFilter !== "all") + Number(reviewFilter !== "all");
  const saveView = (next: Partial<SuggestionPreferences>) => onPreferencesChange({
    filter,
    sort,
    confidence: confidenceFilter,
    review: reviewFilter,
    ...next,
  });
  const updateFilter = (next: typeof filter) => saveView({ filter: next });
  const updateSort = (next: SuggestionSort) => saveView({ sort: next });
  const updateConfidence = (next: ConfidenceFilter) => saveView({ confidence: next });
  const updateReviewFilter = (next: ReviewFilter) => saveView({ review: next });
  const toggleSummaryFilter = (nextFilter: RecommendationType) => {
    updateFilter(filter === nextFilter ? "all" : nextFilter);
    setSelected(null);
    setSelectedMetricKey(null);
  };
  const openMetric = (metricKey: SuggestionMetricKey, trigger: HTMLButtonElement) => {
    lastMetricTrigger.current = trigger;
    setSelectedMetricKey(metricKey);
  };
  const closeMetric = () => {
    setSelectedMetricKey(null);
    window.requestAnimationFrame(() => lastMetricTrigger.current?.focus());
  };
  useEffect(() => {
    if (!selectedMetricKey) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMetric();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedMetricKey]);
  const reviewedCount = Object.keys(decisions).length;
  const exportReviewed = () => {
    if (reviewedCount === 0) {
      setExportNotice({ tone: "info", text: "Review at least one suggestion first: open a row, then approve or reject it." });
      return;
    }
    const workbook = createReviewedSuggestionsWorkbook(suggestions, decisions, data.reporting.end);
    const blob = new Blob([workbook], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = reviewedSuggestionsFilename(data.reporting.end);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExportNotice({ tone: "success", text: `${reviewedCount} reviewed suggestion${reviewedCount === 1 ? "" : "s"} exported to Excel.` });
  };
  return (
    <>
      <div className="page-heading"><div><span className="eyebrow">Explainable decisions</span><h1>Bidding suggestions</h1><p>Every action is traceable to one rule, its evidence, and the product’s actual contribution margin.</p></div><div className="heading-action-stack"><div className="heading-actions"><SaveIndicator status={reviewSaveStatus} label="Reviews saved for everyone" /><button type="button" className="primary-button" onClick={exportReviewed} aria-describedby={exportNotice ? "review-export-notice" : undefined}>Export reviewed{reviewedCount > 0 ? ` (${reviewedCount})` : ""}</button></div>{exportNotice && <div id="review-export-notice" className={`export-feedback ${exportNotice.tone}`} role="status">{exportNotice.text}</div>}</div></div>
      {data.reporting.capabilities?.exactBidSuggestions === false && <div className="advertising-scope-reminder"><span><b>{data.reporting.marketplace} source limitation:</b> the uploaded package has product-level EAN performance but no verified current bids or keyword ownership. Increase/decrease/hold directions are available; exact bid amounts, harvest and conflict checks remain unavailable rather than being estimated.</span></div>}
      <section className="suggestion-summary">
        {summaryCards.map((card) => <button key={card.key} type="button" className={filter === card.key ? "active" : ""} aria-pressed={filter === card.key} aria-label={`Filter suggestions by ${card.label}`} onClick={() => toggleSummaryFilter(card.key)}><strong>{card.count}</strong><span>{card.label}</span><i aria-hidden="true">→</i></button>)}
      </section>
      <section className="panel suggestion-panel">
        <div className="tabs" role="tablist">{tabs.map((tab) => <button key={tab.key} className={filter === tab.key ? "active" : ""} onClick={() => updateFilter(tab.key)}>{tab.label}<span>{tab.count}</span></button>)}</div>
        <div className="toolbar">
          <label className="search-box wide"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search product, SKU, campaign or target" /></label>
          <div className="toolbar-menu-wrap">
            <button type="button" className={`secondary-button toolbar-control ${sortOpen ? "active" : ""}`} aria-expanded={sortOpen} aria-controls="suggestion-sort-menu" onClick={() => { setSortOpen((current) => !current); setFilterOpen(false); }}>≡ Sort <small>{sortLabel}</small></button>
            {sortOpen && <div className="toolbar-popover sort-menu" id="suggestion-sort-menu" role="menu" aria-label="Sort bidding suggestions"><span className="popover-title">Sort suggestions</span>{sortOptions.map((option) => <button type="button" role="menuitemradio" aria-checked={sort === option.key} key={option.key} onClick={() => { updateSort(option.key); setSortOpen(false); }}><span>{option.label}</span>{sort === option.key && <b aria-hidden="true">✓</b>}</button>)}</div>}
          </div>
          <div className="toolbar-menu-wrap">
            <button type="button" className={`secondary-button toolbar-control ${filterOpen || activeAdvancedFilters > 0 ? "active" : ""}`} aria-expanded={filterOpen} aria-controls="suggestion-filter-menu" onClick={() => { setFilterOpen((current) => !current); setSortOpen(false); }}>▽ Filter{activeAdvancedFilters > 0 && <i>{activeAdvancedFilters}</i>}</button>
            {filterOpen && <div className="toolbar-popover filter-menu" id="suggestion-filter-menu" aria-label="Filter bidding suggestions"><span className="popover-title">Filter suggestions</span><label><span>Confidence</span><select aria-label="Filter by confidence" value={confidenceFilter} onChange={(event) => updateConfidence(event.target.value as ConfidenceFilter)}><option value="all">All confidence levels</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label><label><span>Review status</span><select aria-label="Filter by review status" value={reviewFilter} onChange={(event) => updateReviewFilter(event.target.value as ReviewFilter)}><option value="all">All review states</option><option value="unreviewed">Unreviewed</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label><div className="filter-menu-footer"><span>{arrangedSuggestions.length} matching suggestions</span><button type="button" disabled={activeAdvancedFilters === 0} onClick={() => saveView({ confidence: "all", review: "all" })}>Clear filters</button></div></div>}
          </div>
        </div>
        <div className="table-wrap"><table className="suggestions-table"><thead><tr><th>Priority</th><th>Product</th><th>Campaign / target</th><th>Campaign ad cost</th><th>Product ad cost</th><th>Current bid</th><th>Suggested</th><th>Change</th><th>30-day ACoS</th><th>Target</th><th>Orders</th><th>Recommendation / reason</th><th>Confidence</th><th /></tr></thead>
          <tbody>{visible.map((suggestion) => {
            const reviewReason = manualReviewReason(suggestion);
            return <tr key={suggestion.id} onClick={() => { setSelected(suggestion); setSelectedMetricKey(null); }} className="clickable-row"><td><span className="priority-score">{suggestion.priority}</span></td><td><div className="product-cell compact"><span className="product-avatar">{suggestion.productName.slice(0, 1)}</span><div><b>{suggestion.productName}</b><small>{suggestion.sku || "Unmatched"} · {suggestion.asin || "—"}</small></div></div></td><td><div className="campaign-cell"><b>{suggestion.campaignName}</b><small>{suggestion.target} · {suggestion.matchType || "—"}</small></div></td><td>{euro(campaignAdCost(suggestion), true)}</td><td>{euro(productAdCost(suggestion), true)}</td><td>{isHarvestType(suggestion.type) ? <span className="bid-context">Source {euro(suggestion.currentBid, true)}</span> : euro(suggestion.currentBid, true)}</td><td><b>{euro(suggestion.suggestedBid, true)}</b>{isHarvestType(suggestion.type) && <small className="exact-bid-label">new exact</small>}</td><td className={suggestion.change > 0 ? "positive" : suggestion.change < 0 ? "negative" : "muted"}>{suggestion.type === "harvest_review" ? "Review conflict" : suggestion.type === "harvest" ? "New target" : suggestion.change === 0 ? "—" : `${suggestion.change > 0 ? "+" : ""}${pct(suggestion.change, 0)}`}</td><td>{pct(suggestion.acos)}</td><td>{pct(suggestion.targetAcos)}</td><td>{integer.format(suggestion.purchases)}</td><td><div className="recommendation-cell"><StatusPill tone={suggestion.type}>{typeLabel[suggestion.type]}</StatusPill>{reviewReason && <small className="manual-review-reason" title={suggestion.reason}><b>{suggestion.ruleId}</b>{reviewReason}</small>}</div></td><td><span className={`confidence ${suggestion.confidence}`}>{suggestion.confidence}</span></td><td>{decisions[suggestion.id] ? <span className={`decision-dot ${decisions[suggestion.id]}`}>●</span> : "›"}</td></tr>;
          })}{visible.length === 0 && <tr><td colSpan={14}><div className="empty-suggestions"><strong>No suggestions match these filters</strong><span>Change the search or clear the advanced filters.</span></div></td></tr>}</tbody>
        </table></div>
        <div className="table-footer"><span aria-live="polite">Showing {visible.length} of {arrangedSuggestions.length} matching suggestions{arrangedSuggestions.length !== suggestions.length ? ` · ${suggestions.length} total` : ""} · sorted by {sortLabel.toLowerCase()}</span><span>Manual approval required</span></div>
      </section>
      {selected && (
        <div className="drawer-backdrop" onClick={() => { setSelected(null); setSelectedMetricKey(null); }}>
          <aside className="detail-drawer" onClick={(event) => event.stopPropagation()}>
            <button className="drawer-close" onClick={() => { setSelected(null); setSelectedMetricKey(null); }}>×</button>
            <div className="drawer-kicker">Rule {selected.ruleId}</div>
            <h2>{selected.type === "manual_review" ? "Manual review required" : selected.type === "harvest_review" ? "Review exact keyword conflict" : selected.type === "harvest" ? "Harvest search term" : `${typeLabel[selected.type]} bid`}</h2>
            <p className="drawer-product">{selected.productName}<small>{selected.sku || "Unmatched"} · {selected.campaignName}</small></p>
            {isHarvestType(selected.type) && <>
              <div className="harvest-map">
                <div className="harvest-node harvest-source"><span>From discovery target</span><strong>{selected.sourceTarget || "Unnamed discovery target"}</strong><small>{selected.sourceMatchType || "—"} · {selected.adGroupName}</small></div>
                <div className="harvest-arrow"><span>→</span><small>Create as exact</small></div>
                <div className="harvest-node harvest-destination"><span>Harvest this search term</span><strong>{selected.harvestTerm || selected.target}</strong><small>EXACT target</small></div>
              </div>
              <div className="destination-campaign-card"><div><span>Intended exact campaign</span><strong>{selected.destinationCampaign || "Destination unavailable"}</strong></div><StatusPill tone={selected.destinationCampaignIsNew ? "validation" : "ready"}>{selected.destinationCampaignIsNew ? "Create new campaign" : "Existing campaign"}</StatusPill></div>
              {selected.exactConflicts.length > 0 && <div className="exact-conflict-box"><span>Exact keyword already used by other products</span><p>Review product ownership before approving another exact target.</p><ul>{selected.exactConflicts.map((conflict) => <li key={`${conflict.campaignName}:${conflict.adGroupName}:${conflict.asin}`}><div><b>{conflict.campaignName}</b><small>{conflict.productName}</small></div><div><b>{euro(conflict.bid, true)}</b><small>{conflict.sku || "—"} · {conflict.asin || "—"} · {conflict.status}</small></div></li>)}</ul></div>}
              <div className="harvest-bid-card"><div><span>Recommended starting bid</span><strong>{euro(selected.suggestedBid, true)}</strong><small>Enter this bid for the new exact keyword</small></div><dl><div><dt>{selected.currentBid == null ? `Observed CPC × ${rulePolicy.harvestBidBuffer.toFixed(2)}` : "Discovery target bid"}</dt><dd>{euro(selected.currentBid ?? (selected.observedCpc == null ? null : selected.observedCpc * rulePolicy.harvestBidBuffer), true)}</dd></div><div><dt>Safe maximum CPC</dt><dd>{euro(selected.maxCpc, true)}</dd></div></dl><p>{selected.currentBid == null ? `Uses observed CPC plus a ${Math.round((rulePolicy.harvestBidBuffer - 1) * 100)}% auction buffer` : "Uses the discovery bid as the starting point"} and caps it at the keyword’s profit-safe maximum CPC.</p></div>
            </>}
            {!isHarvestType(selected.type) && <div className="bid-change"><div><span>Current bid</span><strong>{euro(selected.currentBid, true)}</strong></div><span className="change-arrow">→</span><div><span>Suggested bid</span><strong>{euro(selected.suggestedBid, true)}</strong></div></div>}
            {!isHarvestType(selected.type) && selected.currentBid == null && <div className="reason-box"><span>Direction only · no invented bid</span><p>{selected.bidUnavailableReason || "This source does not contain a verified current bid. The rule can recommend increase, decrease or hold, but it intentionally leaves the exact bid blank."}</p></div>}
            <div className="reason-box"><span>Why this suggestion</span><p>{selected.reason}</p></div>
            <h3>30-day advertising cost context <small className="metric-section-hint">Click any card to see its calculation</small></h3>
            <div className="cost-context">{metricDetails.slice(0, 3).map((metric) => <button type="button" className="explain-metric-card" key={metric.key} aria-haspopup="dialog" onClick={(event) => openMetric(metric.key, event.currentTarget)}><span>{metric.title}</span><strong>{metric.value}</strong><small>View calculation</small></button>)}</div>
            <div className="drawer-metrics">{metricDetails.slice(3).map((metric) => <button type="button" className="explain-metric-card" key={metric.key} aria-haspopup="dialog" onClick={(event) => openMetric(metric.key, event.currentTarget)}><span>{metric.title}</span><strong>{metric.value}</strong><small>View calculation</small></button>)}</div>
            <h3>Evidence used</h3><ul className="evidence-list">{selected.evidence.map((item) => <li key={item}><span>✓</span>{item}</li>)}</ul>
            <h3>Risk & limitation</h3><p className="risk-copy">{selected.risk}</p>
            {reviews[selected.id] && <p className="review-attribution">{reviews[selected.id].decision === "approved" ? "Approved" : "Rejected"} by {reviews[selected.id].updatedBy} · {new Date(reviews[selected.id].updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</p>}
            <div className="drawer-actions"><button className="secondary-button reject" onClick={() => onDecision(selected.id, "rejected")}>Reject</button>{reviews[selected.id] && <button className="secondary-button" onClick={() => onDecision(selected.id, null)}>Clear review</button>}<button className="primary-button" onClick={() => onDecision(selected.id, "approved")}>{selected.type === "harvest_review" ? "Approve after review" : "Approve suggestion"}</button></div>
          </aside>
          {selectedMetric && <div className="suggestion-metric-backdrop" onClick={(event) => { event.stopPropagation(); closeMetric(); }}><section className="suggestion-metric-dialog" role="dialog" aria-modal="true" aria-labelledby="suggestion-metric-title" onClick={(event) => event.stopPropagation()}><button type="button" className="suggestion-metric-close" aria-label="Close calculation detail" onClick={closeMetric} autoFocus>×</button><div className="suggestion-metric-heading"><span>How this is calculated</span><h2 id="suggestion-metric-title">{selectedMetric.title}</h2><strong>{selectedMetric.value}</strong><p>{selectedMetric.summary}</p></div><div className="suggestion-metric-formula"><span>Formula</span><code>{selectedMetric.formula}</code></div><div className="suggestion-metric-inputs"><span>Values used for this suggestion</span><div>{selectedMetric.inputs.map((input) => <article key={input.label}><small>{input.label}</small><b>{input.value}</b></article>)}</div></div><div className="suggestion-metric-sources"><div><span>Verified source{selectedMetric.sources.length === 1 ? "" : "s"}</span><b>{selectedMetric.sources.length}</b></div>{selectedMetric.sources.map((source) => <code key={source}>{source}</code>)}</div>{selectedMetric.caveat && <p className="suggestion-metric-caveat"><span>i</span>{selectedMetric.caveat}</p>}</section></div>}
        </div>
      )}
    </>
  );
}

function ProductRanking({ preferences, onPreferencesChange }: {
  preferences?: RankingPreferences;
  onPreferencesChange: (value: RankingPreferences) => void;
}) {
  const [query, setQuery] = useState("");
  const [detailMetric, setDetailMetric] = useState<ProductRankingMetric | "products" | "unmatched" | null>(null);
  const category = preferences?.category ?? "all";
  const sortBy = preferences?.sortBy ?? "revenue";
  const sortDirection = preferences?.sortDirection ?? "desc";
  const isKaufland = data.reporting.marketplaceId === "kaufland_de";
  const retailSourceLabel = isKaufland ? "Sales GMU" : "Business Report";
  const retailSourcePath = sourcePath(isKaufland ? "kaufland_sales" : "business_report");
  const saveView = (next: Partial<RankingPreferences>) => onPreferencesChange({
    category,
    sortBy,
    sortDirection,
    ...next,
  });
  const updateCategory = (next: string) => saveView({ category: next });
  const updateSortBy = (next: ProductRankingMetric) => saveView({ sortBy: next });
  const updateSortDirection = (next: ProductRankingDirection) => saveView({ sortDirection: next });
  const reportedProducts = useMemo(() => data.products.filter((product) => product.retail != null), []);
  const unmatchedRetail = useMemo(() => summarizeUnmatchedRetail(Array.isArray(data.quality.unmatchedProductRows) ? data.quality.unmatchedProductRows as UnmatchedRetailRow[] : []), []);
  const mappedRevenue = useMemo(() => reportedProducts.reduce((sum, product) => sum + (product.retail?.sales ?? 0), 0), [reportedProducts]);
  const categories = useMemo(() => Array.from(new Set(reportedProducts.map((product) => product.category).filter((value): value is string => Boolean(value)))).sort(), [reportedProducts]);
  const filteredProducts = reportedProducts.filter((product) => {
    const matchesText = `${product.name} ${product.sku} ${product.asin}`.toLowerCase().includes(query.toLowerCase());
    return matchesText && (category === "all" || product.category === category);
  });
  const rankedProducts = sortRankedProducts(filteredProducts, sortBy, sortDirection);
  const visibleRevenue = rankedProducts.reduce((sum, product) => sum + (product.retail?.sales ?? 0), 0);
  const visibleUnits = rankedProducts.reduce((sum, product) => sum + (product.retail?.units ?? 0), 0);
  const marginRevenue = rankedProducts.reduce((sum, product) => sum + (product.margin == null ? 0 : product.retail?.sales ?? 0), 0);
  const totalGrossContribution = rankedProducts.reduce((sum, product) => sum + (productGrossContribution(product) ?? 0), 0);
  const weightedMargin = marginRevenue > 0 ? totalGrossContribution / marginRevenue : null;
  const marginCoverage = rankedProducts.filter((product) => product.margin != null).length;
  const leaders = rankedProducts.slice(0, 8);
  const rankingValue = (product: Product) => productRankingValue(product, sortBy) ?? 0;
  const maxRankingValue = Math.max(...leaders.map(rankingValue), 1);
  const rankingLabel = sortBy === "units" ? "sold units" : sortBy === "margin" ? "gross contribution margin" : "reported revenue";
  const displayRank = (index: number) => sortDirection === "desc" ? index + 1 : rankedProducts.length - index;
  const openRankingDetail = (metric: ProductRankingMetric | "products" | "unmatched") => {
    setDetailMetric(metric);
    if (metric !== "products" && metric !== "unmatched") {
      saveView({ sortBy: metric, sortDirection: "desc" });
    }
  };
  const detailProducts = [...filteredProducts].sort((left, right) => {
    if (detailMetric === "units") return (right.retail?.units ?? 0) - (left.retail?.units ?? 0) || (right.retail?.sales ?? 0) - (left.retail?.sales ?? 0);
    if (detailMetric === "margin") {
      const leftContribution = productGrossContribution(left);
      const rightContribution = productGrossContribution(right);
      if (leftContribution == null && rightContribution == null) return left.name.localeCompare(right.name);
      if (leftContribution == null) return 1;
      if (rightContribution == null) return -1;
      return rightContribution - leftContribution || (right.margin ?? 0) - (left.margin ?? 0);
    }
    return (right.retail?.sales ?? 0) - (left.retail?.sales ?? 0);
  });
  const detailTitle = detailMetric === "unmatched" ? "Unmatched Kaufland revenue" : detailMetric === "units" ? "Sold-unit contributors" : detailMetric === "margin" ? "Gross-margin contributors" : detailMetric === "products" ? "Ranked-product coverage" : "Revenue contributors";
  const detailValue = detailMetric === "unmatched" ? euro(unmatchedRetail.revenue) : detailMetric === "units" ? integer.format(visibleUnits) : detailMetric === "margin" ? pct(weightedMargin) : detailMetric === "products" ? integer.format(filteredProducts.length) : euro(visibleRevenue);
  const detailExplanation = detailMetric === "units"
    ? "Products are ordered by Units Ordered. Each row shows its share of the filtered unit total, together with the revenue and gross contribution it generated."
    : detailMetric === "margin"
      ? "Gross contribution amount equals reported product revenue × gross product contribution margin. The headline is the revenue-weighted margin across products with margin data."
      : detailMetric === "unmatched"
        ? "These valid Sales GMU order units are included in dashboard revenue but cannot be assigned a product rank because their seller SKU and EAN do not resolve safely to a canonical SKU in the completed product master or saved crosswalk."
      : detailMetric === "products"
        ? `These products receive a rank because they have a matching product-level observation in the supplied ${retailSourceLabel}. Products absent from that report are not treated as zero.`
        : `Products are ordered by reported ${isKaufland ? "valid order-unit revenue" : "Ordered Product Sales"}. Each row shows how much it contributed to the filtered revenue total, plus units and gross contribution.`;
  return <>
    <div className="page-heading"><div><span className="eyebrow">Retail performance · {data.reporting.days} days · {data.reporting.marketplace}</span><h1>Product ranking</h1><p>Products ranked by reported revenue, with sold units and gross product contribution margin shown together.</p></div><StatusPill tone="partial">{data.quality.retailCoverageProducts}/{data.quality.activeProducts} retail-covered</StatusPill></div>
    <section className={`ranking-kpis ${isKaufland ? "has-unmatched" : ""}`}>
      <button type="button" onClick={() => openRankingDetail("revenue")} aria-label="Explain reported revenue contributors"><span>Reported revenue</span><strong>{euro(visibleRevenue)}</strong><small>{retailSourceLabel} · mapped products · current filter</small><i>See contributing products →</i></button>
      <button type="button" onClick={() => openRankingDetail("units")} aria-label="Explain sold-unit contributors"><span>Sold units</span><strong>{integer.format(visibleUnits)}</strong><small>Units Ordered · current filter</small><i>See unit contribution →</i></button>
      <button type="button" onClick={() => openRankingDetail("products")} aria-label="Explain which products are ranked"><span>Ranked products</span><strong>{rankedProducts.length}</strong><small>of {reportedProducts.length} retail-covered SKUs</small><i>See all ranked products →</i></button>
      <button type="button" onClick={() => openRankingDetail("margin")} aria-label="Explain weighted gross-margin contributors"><span>Weighted gross margin</span><strong>{pct(weightedMargin)}</strong><small>{marginCoverage}/{rankedProducts.length} ranked SKUs with margin</small><i>See product margin contribution →</i></button>
      {isKaufland && <button type="button" className="unmatched" onClick={() => openRankingDetail("unmatched")} aria-label="Explain unmatched Kaufland revenue"><span>Unmatched revenue</span><strong>{euro(unmatchedRetail.revenue)}</strong><small>{integer.format(unmatchedRetail.units)} units · {unmatchedRetail.identifiers} identifier groups</small><i>See what could not be matched →</i></button>}
    </section>
    <section className="ranking-grid">
      <article className="panel leaderboard-panel">
        <div className="panel-heading leaderboard-heading"><div><span className="eyebrow">Top performers</span><h2>{sortDirection === "desc" ? "Leaders" : "Lowest performers"} by {rankingLabel}</h2><span className="ranking-window">{displayDate(data.reporting.start)} – {displayDate(data.reporting.end)}</span></div><div className="leaderboard-controls"><div className="ranking-metric-toggle" role="group" aria-label="Rank top performers by"><button type="button" aria-pressed={sortBy === "revenue"} onClick={() => updateSortBy("revenue")}>Revenue</button><button type="button" aria-pressed={sortBy === "units"} onClick={() => updateSortBy("units")}>Units</button><button type="button" aria-pressed={sortBy === "margin"} onClick={() => updateSortBy("margin")}>Gross margin</button></div><button type="button" className="ranking-direction" aria-label={sortDirection === "desc" ? "Show lowest performers first" : "Show highest performers first"} onClick={() => updateSortDirection(sortDirection === "desc" ? "asc" : "desc")}>{sortDirection === "desc" ? "↓ Highest first" : "↑ Lowest first"}</button></div></div>
        <div className="leaderboard-list">{leaders.map((product, index) => <div className="leaderboard-row" key={product.sku}><span className="leader-rank">{displayRank(index)}</span><div className="leader-product"><b>{product.name}</b><small>{product.sku} · {product.asin}</small><div className="leader-track"><i style={{ width: `${Math.max(4, Math.max(0, rankingValue(product)) / maxRankingValue * 100)}%` }} /></div></div><dl><div><dt>Revenue</dt><dd>{euro(product.retail?.sales)}</dd></div><div><dt>Units</dt><dd>{integer.format(product.retail?.units ?? 0)}</dd></div><div><dt>Gross margin</dt><dd>{pct(product.margin)}</dd></div><div><dt>Gross contribution</dt><dd>{euro(productGrossContribution(product))}</dd></div></dl></div>)}</div>
      </article>
      <article className="panel ranking-note"><span className="ranking-note-icon">i</span><div><span className="eyebrow">How to read this</span><h2>Coverage and margin scope</h2><p>Only the {data.quality.retailCoverageProducts} marketplace products with a matched {retailSourceLabel} observation receive a revenue rank. The other {Math.max(0, Number(data.quality.activeProducts) - Number(data.quality.retailCoverageProducts))} matched products remain unranked because missing retail values are unavailable, not zero.{isKaufland ? " Unmatched Kaufland order units remain in marketplace totals and the import quality queue." : ""}</p><p><b>Gross product contribution margin</b> comes from the calculation workbook and is measured before provision and advertising cost. It is different from the dashboard’s net contribution margin.</p><div><span>Revenue and units</span><code>{retailSourcePath}</code><span>Product margin</span><code>{sourcePath("economics")}</code></div></div></article>
    </section>
    <section className="panel ranking-table-panel"><div className="ranking-toolbar"><div><span className="eyebrow">Complete ranking</span><h2>{rankedProducts.length} products</h2></div><label className="search-box wide"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search product, SKU or ASIN" /></label><select value={category} onChange={(event) => updateCategory(event.target.value)} aria-label="Filter ranking by category"><option value="all">All categories</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select><select value={sortBy} onChange={(event) => updateSortBy(event.target.value as ProductRankingMetric)} aria-label="Rank products by"><option value="revenue">Rank by revenue</option><option value="units">Rank by sold units</option><option value="margin">Rank by gross margin</option></select><select value={sortDirection} onChange={(event) => updateSortDirection(event.target.value as ProductRankingDirection)} aria-label="Rank direction"><option value="desc">Highest first</option><option value="asc">Lowest first</option></select></div><div className="table-wrap"><table className="ranking-table"><thead><tr><th>Rank</th><th>Product</th><th>Category</th><th>Reported revenue</th><th>Revenue share</th><th>Sold units</th><th>Gross contribution margin</th><th>Gross contribution</th><th>Retail conversion</th></tr></thead><tbody>{rankedProducts.map((product, index) => { const rank = displayRank(index); return <tr key={product.sku}><td><span className={`rank-badge ${rank <= 3 ? "top" : ""}`}>{rank}</span></td><td><div className="product-cell"><span className="product-avatar">{product.name.slice(0, 1)}</span><div><b>{product.name}</b><small>{product.sku} · {product.asin}</small></div></div></td><td>{product.category || "—"}</td><td><b>{euro(product.retail?.sales)}</b></td><td>{pct(visibleRevenue > 0 ? (product.retail?.sales ?? 0) / visibleRevenue : null)}</td><td>{integer.format(product.retail?.units ?? 0)}</td><td><span className={`margin-value ${product.margin != null && product.margin >= 0.3 ? "strong" : ""}`}>{pct(product.margin)}</span></td><td>{euro(productGrossContribution(product))}</td><td>{pct(product.retail?.conversion)}</td></tr>; })}</tbody></table></div><div className="table-footer"><span>Ranking uses the current search, category, metric, and direction.</span><span>Source: {retailSourceLabel} + Calculation workbook</span></div></section>
    {detailMetric && <div className="ranking-detail-backdrop" onClick={() => setDetailMetric(null)}><section className={`ranking-detail-dialog ${detailMetric === "unmatched" ? "unmatched-detail" : ""}`} role="dialog" aria-modal="true" aria-labelledby="ranking-detail-title" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="ranking-detail-close" aria-label="Close ranking detail" onClick={() => setDetailMetric(null)}>×</button>
      <div className="ranking-detail-heading"><div><span className="eyebrow">{detailMetric === "unmatched" ? "Full marketplace period" : "Current product filter"} · {data.reporting.days} days</span><h2 id="ranking-detail-title">{detailTitle}</h2><p>{detailExplanation}</p></div><strong>{detailValue}</strong></div>
      {detailMetric === "unmatched" ? <>
        <div className="ranking-detail-summary"><div><span>Dashboard revenue</span><b>{euro(data.totals.retail.sales)}</b></div><div><span>Mapped ranking revenue</span><b>{euro(mappedRevenue)}</b></div><div><span>Unmatched units</span><b>{integer.format(unmatchedRetail.units)}</b></div><div><span>Identifier groups</span><b>{integer.format(unmatchedRetail.identifiers)}</b></div></div>
        <div className="unmatched-ranking-note"><span>Why they cannot match</span><p>The seller SKU/EAN pair either has no canonical match or conflicts with the completed product master. The revenue remains in dashboard totals, but margin and rank stay unavailable until the identity is resolved.</p></div>
        <div className="unmatched-ranking-table"><table><thead><tr><th>#</th><th>Seller SKU</th><th>EAN</th><th>Order units</th><th>Revenue</th><th>Match status</th></tr></thead><tbody>{unmatchedRetail.rows.map((row, index) => <tr key={`${row.sellerSku}-${row.ean}-${index}`}><td>{index + 1}</td><td><b>{row.sellerSku || "—"}</b></td><td>{row.ean || "—"}</td><td>{integer.format(row.rows ?? 0)}</td><td><b>{euro(row.revenue, true)}</b></td><td><StatusPill tone="partial">No canonical SKU mapping</StatusPill></td></tr>)}</tbody></table></div>
        <div className="ranking-detail-source"><div><span>Revenue and identifiers</span><code>{retailSourcePath}</code></div><div><span>Required resolution</span><code>Data imports · Internal SKU ↔ EAN / seller SKU crosswalk</code></div></div>
      </> : <>
        <div className="ranking-detail-summary"><div><span>Reported revenue</span><b>{euro(visibleRevenue)}</b></div><div><span>Sold units</span><b>{integer.format(visibleUnits)}</b></div><div><span>Ranked products</span><b>{filteredProducts.length}</b></div><div><span>Gross contribution</span><b>{euro(totalGrossContribution)}</b></div></div>
        <div className="ranking-detail-columns"><span>#</span><span>Product</span><span>Revenue contribution</span><span>Unit contribution</span><span>Gross contribution</span></div>
        <div className="ranking-detail-list">{detailProducts.map((product, index) => { const revenue = product.retail?.sales ?? 0; const units = product.retail?.units ?? 0; const contribution = productGrossContribution(product); return <div className="ranking-detail-row" key={product.sku}><span>{index + 1}</span><div><b>{product.name}</b><small>{product.sku} · {product.asin} · {product.category || "Uncategorized"}</small></div><div><b>{euro(revenue)}</b><small>{pct(visibleRevenue > 0 ? revenue / visibleRevenue : null)} of revenue</small></div><div><b>{integer.format(units)}</b><small>{pct(visibleUnits > 0 ? units / visibleUnits : null)} of units</small></div><div><b>{euro(contribution)}</b><small>{pct(product.margin)} gross margin</small></div></div>; })}</div>
        <div className="ranking-detail-source"><div><span>Revenue and units</span><code>{retailSourcePath}</code></div><div><span>Gross product margin</span><code>{sourcePath("economics")}</code></div></div>
      </>}
    </section></div>}
  </>;
}

function Products({ preferences, onPreferencesChange }: {
  preferences?: { status: string };
  onPreferencesChange: (value: { status: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const status = preferences?.status ?? "all";
  const products = data.products.filter((product) => {
    const matchesText = `${product.name} ${product.sku} ${product.canonicalSku ?? ""} ${product.ean ?? ""} ${product.asin}`.toLowerCase().includes(query.toLowerCase());
    return matchesText && (status === "all" || (status === "advertised" ? !!product.advertising : !product.advertising));
  });
  return <><div className="page-heading"><div><span className="eyebrow">Catalog source of truth · {data.reporting.marketplace}</span><h1>Products</h1><p>{data.products.length} marketplace products joined to the immutable completed product master, performance data, and available contribution economics.</p></div></div><section className="panel table-panel"><div className="toolbar"><label className="search-box wide"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search product, internal SKU, EAN or ASIN" /></label><select value={status} onChange={(event) => onPreferencesChange({ status: event.target.value })}><option value="all">All activity states</option><option value="advertised">Observed ad activity</option><option value="not-advertised">No ad activity observed</option></select></div><div className="table-wrap tall"><table><thead><tr><th>Product</th><th>Internal identity</th><th>Category</th><th>Price</th><th>Contribution margin</th><th>Retail sessions</th><th>Retail sales</th><th>Ad spend</th><th>Ad sales</th><th>Orders</th><th>ACoS</th><th>Advertising status</th></tr></thead><tbody>{products.map((product) => <tr key={product.sku}><td><div className="product-cell"><span className="product-avatar">{product.name.slice(0, 1)}</span><div><b>{product.name}</b><small>{product.sku} · {product.asin || "No ASIN"}</small></div></div></td><td><b>{product.canonicalSku || product.sku}</b><small className="identity-ean">{product.ean ? `EAN ${product.ean}` : "EAN unavailable"}</small></td><td>{product.category || "—"}</td><td>{euro(product.price, true)}</td><td>{pct(product.margin)}</td><td>{product.retail?.sessions == null ? "—" : integer.format(product.retail.sessions)}</td><td>{euro(product.retail?.sales)}</td><td>{euro(product.advertising?.spend)}</td><td>{euro(product.advertising?.sales)}</td><td>{product.advertising ? integer.format(product.advertising.purchases) : "—"}</td><td>{pct(product.advertising?.acos)}</td><td><StatusPill tone={product.advertising ? "active" : "quiet"}>{product.advertisingStatus}</StatusPill></td></tr>)}</tbody></table></div><div className="table-footer"><span>{products.length} marketplace products</span><span>Source of truth: completed product master + current {data.reporting.marketplace} reports</span></div></section></>;
}

function MarketplacePerformance({ currentSummary, onOpenImports, onOpenMarketplace }: {
  currentSummary: SnapshotHistorySummary;
  onOpenImports: () => void;
  onOpenMarketplace: (marketplaceId: MarketplaceId) => void;
}) {
  const [start, setStart] = useState(currentSummary.periodStart);
  const [end, setEnd] = useState(currentSummary.periodEnd);
  const [metric, setMetric] = useState<ComparableMetricKey>("retailSales");
  const [rows, setRows] = useState<MarketplaceComparisonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = () => {
    setLoading(true); setError("");
    fetch(`/api/marketplace-comparison?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, { cache: "no-store" })
      .then(async (response) => { const payload = await response.json() as { error?: string; rows?: MarketplaceComparisonRow[] }; if (!response.ok || !payload.rows) throw new Error(payload.error || "Comparison data is unavailable."); return payload.rows; })
      .then(setRows).catch((reason) => setError(reason instanceof Error ? reason.message : "Comparison data is unavailable.")).finally(() => setLoading(false));
  };
  useEffect(load, [start, end]);
  const alignedRows = rows.filter((row) => row.sourceStatus === "aligned");
  const ranked = rankComparisonRows(alignedRows, metric);
  const definition = comparableMetrics.find((item) => item.key === metric)!;
  const max = Math.max(...ranked.map((row) => Math.abs(Number(row.metrics[metric] ?? 0))), 1);
  const format = (value: number | null | undefined, mode = definition.format) => value == null ? "Unavailable" : mode === "currency" ? euro(value, true) : mode === "percent" ? pct(value) : decimal.format(value);
  const movement = (value: number | null | undefined) => value == null ? "Awaiting period" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
  const exportComparison = () => {
    const workbookRows: Array<Array<string | number | null>> = [["Marketplace", "Period start", "Period end", "KPI", "Native currency", "Native value", "EUR value", "FX rate to EUR", "MoM", "YoY", "Coverage"]];
    for (const row of rows) for (const item of comparableMetrics) {
      const native = row.metrics[item.key] ?? null;
      workbookRows.push([row.marketplace, row.periodStart, row.periodEnd, item.label, row.currency, native, native == null ? null : native * row.fxRateToEur, row.fxRateToEur, row.mom[item.key] ?? null, row.yoy[item.key] ?? null, row.coverageNote]);
    }
    const workbook = createTabularWorkbook([{ name: "Marketplace comparison", rows: workbookRows }], `Marketplace Performance ${start} to ${end}`, `${end}T12:00:00Z`);
    const url = URL.createObjectURL(new Blob([workbook], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a"); link.href = url; link.download = `marketplace-performance-${start}-${end}.xlsx`; link.click(); URL.revokeObjectURL(url);
  };
  return <>
    <div className="page-heading marketplace-heading"><div><span className="eyebrow">Aligned portfolio view</span><h1>Marketplace performance</h1><p>Compare Amazon DE and Kaufland DE only when the exact same reporting dates are retained. Missing coverage stays visible and is never replaced with latest data.</p></div><button type="button" className="primary-button" onClick={exportComparison} disabled={!rows.length}>Export comparison</button></div>
    <section className="panel marketplace-range"><div><label><span>Date from</span><input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label><label><span>Date to</span><input type="date" value={end} onChange={(event) => setEnd(event.target.value)} /></label><button type="button" className="secondary-button" onClick={load} disabled={loading}>Refresh aligned range</button></div><p>Rankings use one selected KPI. Lower is better for ACoS, CPA and TCOS; higher is better for revenue, units, ROAS and margin.</p></section>
    {error && <div className="import-feedback error">{error}</div>}
    <section className="marketplace-status-grid">{rows.map((row) => <article key={row.marketplaceId} className={`panel marketplace-status ${row.sourceStatus}`}><div><span className="eyebrow">{row.marketplace}</span><StatusPill tone={row.sourceStatus === "aligned" ? "ready" : "partial"}>{row.sourceStatus === "aligned" ? "Exact range" : "Coverage gap"}</StatusPill></div><h2>{row.sourceStatus === "aligned" ? `${displayDate(row.periodStart)} – ${displayDate(row.periodEnd)}` : "Period unavailable"}</h2><p>{row.coverageNote}</p>{row.sourceStatus === "aligned" ? <button type="button" onClick={() => onOpenMarketplace(row.marketplaceId)}>Open marketplace →</button> : <button type="button" onClick={onOpenImports}>Import this period →</button>}</article>)}</section>
    <section className="panel marketplace-ranking-panel"><div className="panel-heading"><div><span className="eyebrow">Selected KPI ranking</span><h2>{definition.label}</h2><p>{loading ? "Loading aligned snapshots…" : `${ranked.length} marketplace${ranked.length === 1 ? "" : "s"} with comparable data`}</p></div><select value={metric} onChange={(event) => setMetric(event.target.value as ComparableMetricKey)} aria-label="Rank marketplaces by KPI">{comparableMetrics.map((item) => <option key={item.key} value={item.key}>{item.label}{item.lowerIsBetter ? " · lower is better" : ""}</option>)}</select></div><div className="marketplace-bars">{ranked.map((row) => <button type="button" key={row.marketplaceId} onClick={() => onOpenMarketplace(row.marketplaceId)}><span className="marketplace-rank">#{row.rank}</span><div><b>{row.marketplace}</b><small>{row.sourceCount} retained source files · {row.currency} × {row.fxRateToEur} EUR</small><i><span style={{ width: `${Math.max(6, Math.abs(Number(row.metrics[metric])) / max * 100)}%` }} /></i></div><strong>{format(row.metrics[metric])}</strong><dl><div><dt>MoM</dt><dd>{movement(row.mom[metric])}</dd></div><div><dt>YoY</dt><dd>{movement(row.yoy[metric])}</dd></div></dl></button>)}</div>{!loading && !ranked.length && <div className="empty-marketplace"><h3>No aligned marketplace data</h3><p>Import snapshots with exactly {displayDate(start)} – {displayDate(end)} to create a fair ranking.</p><button type="button" className="primary-button" onClick={onOpenImports}>Open data imports</button></div>}</section>
    <section className="panel marketplace-table-panel"><div className="panel-heading"><div><span className="eyebrow">Full reconciliation</span><h2>Comparable KPI table</h2></div><StatusPill tone="quiet">Native + EUR</StatusPill></div><div className="table-wrap"><table><thead><tr><th>Marketplace</th>{comparableMetrics.map((item) => <th key={item.key}>{item.label}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.marketplaceId}><td><b>{row.marketplace}</b><small>{row.sourceStatus === "aligned" ? "Aligned" : "Missing exact period"}</small></td>{comparableMetrics.map((item) => <td key={item.key}>{row.sourceStatus === "aligned" ? format(row.metrics[item.key], item.format) : "—"}</td>)}</tr>)}</tbody></table></div></section>
  </>;
}

function EmptyMarketplace({ marketplaceId, onOpenImports }: { marketplaceId: MarketplaceId; onOpenImports: () => void }) {
  const definition = marketplaceRegistry[marketplaceId];
  return <section className="panel empty-marketplace marketplace-onboarding"><span className="eyebrow">{definition.name}</span><h1>No retained snapshot yet</h1><p>Import one complete {definition.shortName} reporting package. Missing metrics will remain explicitly unavailable; no Amazon values or zeros are substituted.</p><div><button type="button" className="primary-button" onClick={onOpenImports}>Open {definition.shortName} imports</button><a href="https://www.kauflandglobalmarketplace.com/en/seller-university/your-performance/reports/" target="_blank" rel="noreferrer">View Kaufland report guidance →</a></div></section>;
}

// Shared product-master upload panel — the same catalog drives every marketplace, so
// this is rendered on the Amazon/Kaufland, Allegro and eBay import pages alike.
function ProductMasterUpload({ productMasterStats, onProductMaster, onClearProductMaster }: {
  productMasterStats: ProductMasterStats | null;
  onProductMaster: (products: CatalogProduct[], stats: ProductMasterStats) => void;
  onClearProductMaster: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const downloadTemplate = () => {
    const rows: (string | number)[][] = [["SKU", "EAN / GTIN", "Purchase price", "Logistic cost", "Other cost", "Price"]];
    const workbook = createTabularWorkbook([{ name: "Product master", rows }], "Product master template", new Date().toISOString(), "FF000000");
    const url = URL.createObjectURL(new Blob([workbook], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a"); link.href = url; link.download = "product-master-template.xlsx"; link.click(); URL.revokeObjectURL(url);
  };
  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setFeedback({ tone: "warning", text: `Reading ${file.name}…` });
    try {
      const result = await parseProductMasterFile(file);
      if (!result.products.length) { setFeedback({ tone: "error", text: result.warnings[0] ?? "No products could be read from this file." }); return; }
      onProductMaster(result.products, result.stats);
      const warningText = result.warnings.length ? ` ${result.warnings.join(" ")}` : "";
      setFeedback({ tone: result.warnings.length ? "warning" : "success", text: `${integer.format(result.stats.products)} products loaded from ${file.name}. ${integer.format(result.stats.withMargin)} have a contribution margin and ${integer.format(result.stats.withEan)} carry an EAN.${warningText}` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "The product master could not be read." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel mapping-upload product-master-upload">
      <div><span className="eyebrow">Bring your own catalog</span><h2>Product master upload</h2><p>Download the template, fill it in and upload it back to drive the whole catalog. The six columns are <code>SKU</code>, <code>EAN / GTIN</code>, <code>Purchase price</code>, <code>Logistic cost</code>, <code>Other cost</code> and <code>Price</code>. Contribution margin is derived automatically as <em>(net price − purchase − logistic − other) ÷ net price</em>. One product master is shared across every marketplace and is parsed and kept in your browser only.</p><button type="button" className="secondary-button template-button" onClick={downloadTemplate}><span aria-hidden="true">⇩</span> Download template (.xlsx)</button></div>
      <label className={`drop-zone compact ${dragging ? "dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { event.preventDefault(); setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files?.[0]); }}>
        <input type="file" accept=".xlsx,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" disabled={busy} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
        <span className="drop-icon">⇧</span><strong>{busy ? "Reading your product master…" : "Drop a product master (.xlsx or .csv)"}</strong><small>or click to choose a file · parsed and kept in your browser</small>
      </label>
      <div className="product-master-status"><StatusPill tone={productMasterStats ? "ready" : "quiet"}>{productMasterStats ? `${integer.format(productMasterStats.products)} products retained` : "Using the built-in demo catalog"}</StatusPill>{productMasterStats && <button type="button" className="text-button" onClick={onClearProductMaster}>Remove uploaded master</button>}</div>
      {feedback && <div className={`import-feedback ${feedback.tone}`} role="status">{feedback.text}</div>}
      {productMasterStats && <p className="mapping-feedback">Source: {productMasterStats.fileName} · {productMasterStats.format.toUpperCase()} · {integer.format(productMasterStats.withMargin)} with margin · {integer.format(productMasterStats.withCost)} with cost · {integer.format(productMasterStats.withEan)} with EAN{productMasterStats.duplicateSkus ? ` · ${integer.format(productMasterStats.duplicateSkus)} duplicate SKUs ignored` : ""}</p>}
    </section>
  );
}

// Required ERP sales summary — one file per marketplace (retail sales by SKU from the
// ERP). Parsed and kept in the browser per marketplace; matched to the product master
// by SKU. Does not yet drive dashboard totals (follow-up), but is part of the package.
function loadStoredErpSales(marketplaceId: MarketplaceId): { rows: ErpSalesRow[]; stats: ErpSalesStats } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`mpc:erp-sales:${marketplaceId}:v1`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { rows?: ErpSalesRow[]; stats?: ErpSalesStats };
    if (!parsed.rows || !parsed.stats) return null;
    return { rows: parsed.rows, stats: parsed.stats };
  } catch { return null; }
}

function ErpSalesUpload({ marketplaceId }: { marketplaceId: MarketplaceId }) {
  const stored = useMemo(() => loadStoredErpSales(marketplaceId), [marketplaceId]);
  const catalogSkus = useMemo(() => new Set((loadStoredProductMaster()?.products ?? []).map((product) => (product.canonicalSku ?? product.sku))), []);
  const [rows, setRows] = useState<ErpSalesRow[]>(stored?.rows ?? []);
  const [stats, setStats] = useState<ErpSalesStats | null>(stored?.stats ?? null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const matched = rows.filter((row) => catalogSkus.has(row.sku)).length;

  const downloadTemplate = () => {
    const templateRows: (string | number)[][] = [["SKU", "Period start", "Period end", "Units sold", "Net revenue", "Gross revenue"]];
    const workbook = createTabularWorkbook([{ name: "ERP sales summary", rows: templateRows }], "ERP sales summary template", new Date().toISOString(), "FF000000");
    const url = URL.createObjectURL(new Blob([workbook], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a"); link.href = url; link.download = `erp-sales-summary-template-${marketplaceId}.xlsx`; link.click(); URL.revokeObjectURL(url);
  };
  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setFeedback({ tone: "warning", text: `Reading ${file.name}…` });
    try {
      const result = await parseErpSalesFile(file);
      if (!result.rows.length) { setFeedback({ tone: "error", text: result.warnings[0] ?? "No sales rows could be read from this file." }); return; }
      setRows(result.rows); setStats(result.stats);
      try { window.localStorage.setItem(`mpc:erp-sales:${marketplaceId}:v1`, JSON.stringify({ rows: result.rows, stats: result.stats })); } catch { /* quota */ }
      const warningText = result.warnings.length ? ` ${result.warnings.join(" ")}` : "";
      setFeedback({ tone: result.warnings.length ? "warning" : "success", text: `${integer.format(result.stats.rows)} sales rows loaded from ${file.name}. ${integer.format(result.stats.withRevenue)} carry revenue.${warningText}` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "The ERP sales summary could not be read." });
    } finally { setBusy(false); }
  };
  const clear = () => { setRows([]); setStats(null); try { window.localStorage.removeItem(`mpc:erp-sales:${marketplaceId}:v1`); } catch { /* ignore */ } };

  return (
    <section className="panel mapping-upload product-master-upload">
      <div><span className="eyebrow">Required · from your ERP</span><h2>ERP sales summary</h2><p>Upload your ERP sales summary for {marketplaceRegistry[marketplaceId].name} — one file per marketplace, replacing the marketplace's own sales report. Download the template and fill it in. The columns are <code>SKU</code>, <code>Period start</code>, <code>Period end</code>, <code>Units sold</code>, <code>Net revenue</code> and <code>Gross revenue</code>. Parsed and kept in your browser only.</p><button type="button" className="secondary-button template-button" onClick={downloadTemplate}><span aria-hidden="true">⇩</span> Download template (.xlsx)</button></div>
      <label className={`drop-zone compact ${dragging ? "dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { event.preventDefault(); setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files?.[0]); }}>
        <input type="file" accept=".xlsx,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" disabled={busy} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
        <span className="drop-icon">⇧</span><strong>{busy ? "Reading your ERP sales summary…" : "Drop the ERP sales summary (.xlsx or .csv)"}</strong><small>or click to choose a file · parsed and kept in your browser</small>
      </label>
      <div className="product-master-status"><StatusPill tone={stats ? "ready" : "quiet"}>{stats ? `${integer.format(stats.rows)} sales rows retained` : "Required — not uploaded yet"}</StatusPill>{stats && <button type="button" className="text-button" onClick={clear}>Remove ERP sales summary</button>}</div>
      {feedback && <div className={`import-feedback ${feedback.tone}`} role="status">{feedback.text}</div>}
      {stats && <p className="mapping-feedback">Source: {stats.fileName} · {stats.format.toUpperCase()} · {integer.format(stats.withRevenue)} with revenue · {catalogSkus.size ? `${integer.format(matched)} of ${integer.format(stats.rows)} SKUs matched to the product master` : "upload a product master to see SKU matches"}</p>}
    </section>
  );
}

function Imports({ history, currentSummary, marketplaceId = marketplaceSelectionGlobal === "all" ? "kaufland_de" : marketplaceSelectionGlobal, onImported, productMasterStats, onProductMaster, onClearProductMaster }: {
  history: SnapshotHistorySummary[];
  currentSummary: SnapshotHistorySummary;
  marketplaceId?: MarketplaceId;
  onImported: (snapshot: DashboardData, summary: SnapshotHistorySummary, history: SnapshotHistorySummary[]) => void;
  productMasterStats: ProductMasterStats | null;
  onProductMaster: (products: CatalogProduct[], stats: ProductMasterStats) => void;
  onClearProductMaster: () => void;
}) {
  const marketplace = marketplaceRegistry[marketplaceId];
  const requiredRequirements = marketplace.importRequirements.filter((item) => !item.optional);
  const optionalRequirements = marketplace.importRequirements.filter((item) => item.optional);
  const requiredFileCount = requiredRequirements.length;
  const maximumFileCount = marketplace.importRequirements.length;
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const validFileCount = selectedFiles.length >= requiredFileCount && selectedFiles.length <= maximumFileCount;
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reprocessingId, setReprocessingId] = useState("");
  const [feedback, setFeedback] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [mappingCount, setMappingCount] = useState(0);
  const [mappingFeedback, setMappingFeedback] = useState("");
  const [commissionRate, setCommissionRate] = useState("");
  const [feeRevision, setFeeRevision] = useState(0);
  const [feeConfirmed, setFeeConfirmed] = useState(false);
  const [feeFeedback, setFeeFeedback] = useState("");
  useEffect(() => {
    if (marketplaceId !== "kaufland_de") return;
    fetch(`/api/marketplace-config?marketplaceId=${marketplaceId}`, { cache: "no-store" }).then((response) => response.json()).then((payload: { identifiers?: unknown[]; settings?: { commissionRate: number | null; revision: number; confirmed: boolean } }) => { setMappingCount(payload.identifiers?.length ?? 0); setCommissionRate(payload.settings?.commissionRate == null ? "" : String(payload.settings.commissionRate * 100)); setFeeRevision(payload.settings?.revision ?? 0); setFeeConfirmed(payload.settings?.confirmed ?? false); }).catch(() => undefined);
  }, [marketplaceId]);
  const uploadMapping = async (file: File | undefined) => {
    if (!file) return;
    const form = new FormData(); form.append("marketplaceId", marketplaceId); form.append("mapping", file);
    const response = await fetch("/api/marketplace-config", { method: "POST", body: form });
    const payload = await response.json() as { error?: string; identifiers?: unknown[] };
    if (!response.ok) { setMappingFeedback(payload.error || "Mapping import failed."); return; }
    setMappingCount(payload.identifiers?.length ?? 0); setMappingFeedback("The versioned SKU–EAN crosswalk was validated and retained.");
  };
  const saveFees = async () => {
    const rate = Number(commissionRate) / 100;
    if (!Number.isFinite(rate)) { setFeeFeedback("Enter a valid commission percentage."); return; }
    const response = await fetch("/api/marketplace-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ marketplaceId, commissionRate: rate, vatRate: 0.19, confirmed: true, expectedRevision: feeRevision, categoryOverrides: {} }) });
    const payload = await response.json() as { error?: string; revision?: number; confirmed?: boolean };
    if (!response.ok) { setFeeFeedback(payload.error || "The marketplace fees could not be saved."); return; }
    setFeeRevision(payload.revision ?? feeRevision + 1); setFeeConfirmed(Boolean(payload.confirmed)); setFeeFeedback("Kaufland fees were saved for every authorized user. Re-import a period to recalculate margin with this rate.");
  };
  const addFiles = (incoming: File[]) => {
    const nonCsvFiles = incoming.filter((file) => !file.name.toLowerCase().endsWith(".csv"));
    const oversizedFiles = incoming.filter((file) => file.size > MAX_IMPORT_FILE_BYTES);
    const csvFiles = incoming.filter((file) => file.name.toLowerCase().endsWith(".csv") && file.size <= MAX_IMPORT_FILE_BYTES);
    setSelectedFiles((current) => {
      const merged = [...current];
      for (const file of csvFiles) {
        const existing = merged.findIndex((item) => item.name === file.name && item.size === file.size);
        if (existing >= 0) merged[existing] = file;
        else merged.push(file);
      }
      return merged.slice(0, maximumFileCount);
    });
    setFeedback(oversizedFiles.length ? {
      tone: "error",
      text: `${oversizedFiles.map((file) => file.name).join(", ")} exceeds the supported 8 MB per-file limit.`,
    } : nonCsvFiles.length ? {
      tone: "warning",
      text: "Only CSV files are accepted. The completed product master and its fixed supporting workbooks must not be uploaded here.",
    } : null);
  };
  const upload = async () => {
    if (!validFileCount) {
      setFeedback({ tone: "error", text: `Choose the ${requiredFileCount} required ${marketplace.shortName} CSV files${optionalRequirements.length ? `, with up to ${optionalRequirements.length} optional file${optionalRequirements.length === 1 ? "" : "s"}` : ""}. ${selectedFiles.length} files are currently selected.` });
      return;
    }
    setUploading(true);
    setFeedback(null);
    const uploadId = crypto.randomUUID();
    const fileIds: string[] = [];
    const totalUploadBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0);
    let uploadedBytes = 0;
    try {
      for (const [index, file] of selectedFiles.entries()) {
        const fileId = crypto.randomUUID();
        fileIds.push(fileId);
        for (const range of importChunkRanges(file.size)) {
          const chunk = file.slice(range.start, range.end);
          const form = new FormData();
          form.append("uploadId", uploadId);
          form.append("fileId", fileId);
          form.append("fileName", file.name);
          form.append("fileSize", String(file.size));
          form.append("chunkIndex", String(range.index));
          form.append("chunkCount", String(range.count));
          form.append("chunk", chunk, `${file.name}.part-${range.index + 1}`);
          const fileResponse = await fetch("/api/snapshots/uploads", { method: "POST", body: form });
          const filePayload = parseImportApiPayload(await fileResponse.text(), fileResponse.status);
          if (!fileResponse.ok) throw new Error(filePayload.error || `Could not upload ${file.name}.`);
          uploadedBytes += chunk.size;
          const progress = Math.min(100, Math.round((uploadedBytes / totalUploadBytes) * 100));
          setFeedback({ tone: "warning", text: `Uploading ${progress}% · file ${index + 1} of ${selectedFiles.length}: ${file.name}` });
        }
      }
      setFeedback({ tone: "warning", text: "All files uploaded. Validating and storing the snapshot…" });
      const response = await fetch("/api/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId, fileIds, marketplaceId }),
      });
      const payload = parseImportApiPayload(await response.text(), response.status) as {
        error?: string;
        snapshot?: DashboardData;
        summary?: SnapshotHistorySummary;
        history?: SnapshotHistorySummary[];
        importedSummary?: SnapshotHistorySummary;
        validation?: { warnings?: string[] };
      };
      if (!response.ok || !payload.snapshot || !payload.summary || !payload.history) throw new Error(payload.error || "The import could not be completed.");
      onImported(payload.snapshot, payload.summary, payload.history);
      setSelectedFiles([]);
      const imported = payload.importedSummary ?? payload.summary;
      const warningText = payload.validation?.warnings?.length ? ` ${payload.validation.warnings.join(" ")}` : "";
      setFeedback({ tone: payload.validation?.warnings?.length ? "warning" : "success", text: `Snapshot ${displayDate(imported.periodStart)} – ${displayDate(imported.periodEnd)} was validated and stored permanently.${warningText}` });
    } catch (error) {
      await fetch("/api/snapshots/uploads", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId, fileIds }),
      }).catch(() => undefined);
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "The import could not be completed." });
    } finally {
      setUploading(false);
    }
  };
  const reprocess = async (snapshotId: string) => {
    if (!snapshotId || reprocessingId) return;
    setReprocessingId(snapshotId);
    setFeedback({ tone: "warning", text: "Rebuilding the retained snapshot from its preserved raw files and the current product master…" });
    try {
      const response = await fetch("/api/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketplaceId, reprocessSnapshotId: snapshotId }),
      });
      const payload = parseImportApiPayload(await response.text(), response.status) as {
        error?: string;
        snapshot?: DashboardData;
        summary?: SnapshotHistorySummary;
        history?: SnapshotHistorySummary[];
        importedSummary?: SnapshotHistorySummary;
        validation?: { warnings?: string[] };
      };
      if (!response.ok || !payload.snapshot || !payload.summary || !payload.history) throw new Error(payload.error || "The retained snapshot could not be reprocessed.");
      onImported(payload.snapshot, payload.summary, payload.history);
      const rebuilt = payload.importedSummary ?? payload.summary;
      const warningText = payload.validation?.warnings?.length ? ` ${payload.validation.warnings.join(" ")}` : "";
      setFeedback({ tone: payload.validation?.warnings?.length ? "warning" : "success", text: `A new snapshot for ${displayDate(rebuilt.periodStart)} – ${displayDate(rebuilt.periodEnd)} was created with the current product master. The original snapshot remains retained.${warningText}` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "The retained snapshot could not be reprocessed." });
    } finally {
      setReprocessingId("");
    }
  };
  const unmatchedProductRows = Array.isArray(data.quality.unmatchedProductRows)
    ? data.quality.unmatchedProductRows as Array<{ ean?: string; sellerSku?: string; source?: string; rows?: number; revenue?: number; spend?: number }>
    : [];
  const reconciliation = data.quality.advertisingReconciliation && typeof data.quality.advertisingReconciliation === "object"
    ? data.quality.advertisingReconciliation as { authoritativeSource?: string; reconciledSources?: number; spend?: number; sales?: number }
    : null;
  return <>
    <div className="page-heading"><div><span className="eyebrow">Persistent source history · {marketplace.name}</span><h1>Data imports</h1><p>{marketplaceId === "kaufland_de" ? "Upload the same seven-report package for July, a single day, or month-to-date. Every refresh is retained; newer overlapping daily evidence is used for flexible ranges without deleting the older snapshot." : `Upload one complete ${marketplace.shortName} reporting period. Every valid snapshot and its raw files are retained for MoM, YoY and marketplace comparisons.`}</p></div><StatusPill tone="ready">{history.length} retained snapshot{history.length === 1 ? "" : "s"}</StatusPill></div>
    <ProductMasterUpload productMasterStats={productMasterStats} onProductMaster={onProductMaster} onClearProductMaster={onClearProductMaster} />
    <ErpSalesUpload key={marketplaceId} marketplaceId={marketplaceId} />
    {marketplaceId === "kaufland_de" && <section className="panel mapping-upload"><div><span className="eyebrow">Optional identity enrichment</span><h2>Internal SKU ↔ EAN crosswalk</h2><p>The Account listing feed automatically joins <code>id_offer</code> to matching internal SKUs. Upload a crosswalk only for the remaining unmatched Kaufland offers. Required columns: <code>internal_sku</code> and <code>ean</code>; conflicts still block import.</p></div><label className="secondary-button">Choose optional mapping CSV<input type="file" accept=".csv,text/csv" onChange={(event) => void uploadMapping(event.target.files?.[0])} /></label><StatusPill tone={mappingCount ? "ready" : "quiet"}>{mappingCount ? `${mappingCount} identifiers retained` : "Auto-match enabled"}</StatusPill>{mappingFeedback && <p className="mapping-feedback">{mappingFeedback}</p>}</section>}
    {marketplaceId === "kaufland_de" && <section className="panel marketplace-fees"><div><span className="eyebrow">Marketplace cost settings</span><h2>Kaufland commission / provision</h2><p>Purchase and delivery costs remain sourced from the locked economics workbook. Profitability stays unavailable until this marketplace rate is confirmed.</p></div><label><span>Commission rate</span><div><input type="number" min="0" max="50" step="0.1" value={commissionRate} onChange={(event) => setCommissionRate(event.target.value)} /><b>%</b></div></label><button type="button" className="primary-button" onClick={() => void saveFees()}>Save marketplace fee</button><StatusPill tone={feeConfirmed ? "ready" : "partial"}>{feeConfirmed ? "Confirmed" : "Not confirmed"}</StatusPill>{feeFeedback && <p>{feeFeedback}</p>}</section>}
    <section className="import-upload-layout">
      <article className="panel upload-panel">
        <div className="panel-heading"><div><span className="eyebrow">New reporting period</span><h2>Upload {requiredFileCount} required {marketplace.shortName} CSV exports</h2></div><StatusPill tone={validFileCount ? "ready" : "quiet"}>{validFileCount ? `${selectedFiles.length} files ready` : `${selectedFiles.length}/${requiredFileCount} required`}</StatusPill></div>
        <label className={`drop-zone ${dragging ? "dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { event.preventDefault(); setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}>
          <input type="file" accept=".csv,text/csv" multiple onChange={(event) => addFiles(Array.from(event.target.files ?? []))} />
          <span className="drop-icon">⇧</span><strong>Drop the {requiredFileCount} required CSV files here</strong><small>or click to choose them from a folder · original filenames and headers · maximum 8 MB per file</small>
        </label>
        {selectedFiles.length > 0 && <div className="selected-files">{selectedFiles.map((file) => <div key={`${file.name}-${file.size}`}><span>CSV</span><div><b>{file.name}</b><small>{fileSize(file.size)}</small></div><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setSelectedFiles((current) => current.filter((item) => item !== file))}>×</button></div>)}</div>}
        {feedback && <div className={`import-feedback ${feedback.tone}`} role="status">{feedback.text}</div>}
        <div className="upload-actions"><button type="button" className="secondary-button" disabled={selectedFiles.length === 0 || uploading} onClick={() => { setSelectedFiles([]); setFeedback(null); }}>Clear selection</button><button type="button" className="primary-button" disabled={!validFileCount || uploading} onClick={upload}>{uploading ? "Validating and storing…" : "Validate & import snapshot"}</button></div>
        <p className="retention-note"><span>✓</span><b>Append-only history:</b> a new upload never overwrites an older period. Exact duplicate file sets are rejected for the current fixed product-source version; after the product master changes, the same reports can be imported again as a new normalized snapshot.</p>
      </article>
      <aside className="panel upload-guide">
        <div className="panel-heading"><div><span className="eyebrow">Required package</span><h2>Files to export from {marketplace.shortName}</h2></div></div>
        <div className="upload-requirements">{requiredRequirements.map((item, index) => <div className="upload-requirement" key={item.role}><span>{index + 1}</span><div><b>{item.title} <em>{item.cadence}</em></b><small>{item.description}</small></div></div>)}</div>
        {optionalRequirements.length > 0 && <><div className="optional-upload-heading"><span className="eyebrow">Optional validation</span></div><div className="upload-requirements">{optionalRequirements.map((item) => <div className="upload-requirement optional" key={item.role}><span>+</span><div><b>{item.title} <em>Optional</em></b><small>{item.description}</small></div></div>)}</div></>}
        <div className="fixed-source-note"><span>LOCKED</span><div><b>Product source of truth stays fixed</b><p>product-master.xlsx supplies canonical internal SKUs, EANs, costs and available prices. amazon-product-list.xlsx remains marketplace-listing enrichment, and calculation-workbook.xlsx supplies available category and margin detail. Do not upload or replace them here.</p></div></div>
      </aside>
    </section>
    <section className="panel snapshot-history">
      <div className="panel-heading"><div><span className="eyebrow">Comparison foundation</span><h2>Retained reporting periods</h2><p>The latest period drives the dashboard. Same-length snapshots closest to one month and one year earlier power the MoM and YoY labels.</p></div><StatusPill tone="ready">No automatic deletion</StatusPill></div>
      <div className="snapshot-history-list">{history.map((item) => <article className={item.id === currentSummary.id ? "current" : ""} key={item.id}><div><span className="snapshot-period">{displayDate(item.periodStart)} – {displayDate(item.periodEnd)}</span>{item.id === currentSummary.id && <StatusPill tone="ready">Dashboard</StatusPill>}<small>Imported {new Date(item.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · {item.createdBy}</small></div><dl><div><dt>Retail sales</dt><dd>{euro(item.retailSales)}</dd></div><div><dt>Ad spend</dt><dd>{euro(item.advertisingSpend)}</dd></div><div><dt>TCOS</dt><dd>{pct(item.tcos, 2)}</dd></div><div><dt>Files</dt><dd>{item.fileCount}</dd></div></dl>{!item.id.startsWith("baseline-") && <button type="button" className="snapshot-reprocess-button" disabled={Boolean(reprocessingId)} onClick={() => void reprocess(item.id)}>{reprocessingId === item.id ? "Reprocessing…" : "Reprocess with current product master"}</button>}</article>)}</div>
    </section>
    <section className="panel current-source-panel"><div className="panel-heading"><div><span className="eyebrow">Current snapshot audit</span><h2>Recognized source files</h2></div><StatusPill tone="ready">{data.imports.length} sources</StatusPill></div><div className="import-grid">{data.imports.map((item) => <article className="import-card" key={item.key}><div className="file-icon">{item.file.endsWith(".csv") ? "CSV" : "XLSX"}</div><div className="import-main"><div><h3>{item.report}</h3><StatusPill tone={item.status === "Ready" ? "ready" : item.status === "Partial" ? "partial" : "validation"}>{item.status}</StatusPill></div><p title={item.path}>{item.path}</p><dl><div><dt>Rows</dt><dd>{integer.format(item.rows)}</dd></div><div><dt>System role</dt><dd>{item.role}</dd></div><div><dt>SHA-256</dt><dd>{item.sha256.slice(0, 12)}…</dd></div></dl></div></article>)}</div></section>
    <section className="panel quality-panel"><div className="panel-heading"><div><span className="eyebrow">Join coverage</span><h2>Normalization report</h2></div>{reconciliation && <StatusPill tone="ready">{reconciliation.reconciledSources} ad sources reconciled</StatusPill>}</div><div className="quality-grid"><div><strong>{data.quality.activeProducts}</strong><span>marketplace products matched</span></div><div><strong>{data.quality.economicsCoverageProducts}</strong><span>with contribution margin</span></div><div><strong>{data.quality.retailCoverageProducts}</strong><span>with retail performance</span></div><div><strong>{data.quality.targetsMatchedToActiveProduct}/{data.quality.targets}</strong><span>ad entities matched to product</span></div><div><strong>{String(data.quality.cancelledSalesRows ?? 0)}</strong><span>cancelled order units excluded</span></div><div><strong>{unmatchedProductRows.length}</strong><span>unmatched identifiers</span></div></div>{reconciliation && <div className="protection-note"><span>✓</span><div><b>Advertising reports reconcile</b><p>{reconciliation.authoritativeSource} controls the totals: {euro(reconciliation.spend, true)} spend and {euro(reconciliation.sales, true)} sales. The other reports validate or allocate these values and are not added again.</p></div></div>}<div className="protection-note"><span>✓</span><div><b>Duplicate protection is active</b><p>{String(data.quality.duplicateProtection)}</p></div></div>{unmatchedProductRows.length > 0 && <div className="unmatched-quality"><div className="panel-heading"><div><span className="eyebrow">Data-quality queue</span><h3>Unmatched Kaufland products</h3><p>These values remain in marketplace totals but are excluded from product margin calculations until an internal SKU is mapped.</p></div><StatusPill tone="partial">{unmatchedProductRows.length} identifiers</StatusPill></div><div className="table-wrap"><table><thead><tr><th>EAN</th><th>Seller SKU</th><th>Source</th><th>Rows</th><th>Revenue</th><th>Ad spend</th></tr></thead><tbody>{unmatchedProductRows.slice(0, 100).map((item, index) => <tr key={`${item.source}-${item.ean}-${item.sellerSku}-${index}`}><td>{item.ean || "—"}</td><td>{item.sellerSku || "—"}</td><td>{item.source || "—"}</td><td>{integer.format(item.rows ?? 0)}</td><td>{euro(item.revenue, true)}</td><td>{euro(item.spend, true)}</td></tr>)}</tbody></table></div>{unmatchedProductRows.length > 100 && <p className="table-note">Showing the first 100 identifiers. Export all data for the complete queue.</p>}</div>}</section>
  </>;
}

type RuleDemoKind = "missing-data" | "multi-product" | "clicks" | "zero-orders" | "acos-band" | "break-even" | "harvest" | "conflict";
type RuleSettingKey = keyof RulePolicy | "minimumClicks" | "maxBidChange";

interface RuleEditorField {
  key: RuleSettingKey;
  label: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  format: "percent" | "integer" | "buffer";
  help: string;
}

interface RuleBookItem {
  id: string;
  condition: string;
  action: string;
  explanation: string;
  example: string;
  demo: RuleDemoKind;
  fields: RuleEditorField[];
  lockedReason?: string;
}

function RuleExercise({ rule, settings }: { rule: RuleBookItem; settings: RuleSettings }) {
  const policy = resolveRulePolicy(settings);
  const [completeData, setCompleteData] = useState(false);
  const [productCount, setProductCount] = useState(2);
  const [clicks, setClicks] = useState(Math.max(0, settings.minimumClicks - 1));
  const [orders, setOrders] = useState(rule.demo === "zero-orders" ? 0 : 3);
  const [ratio, setRatio] = useState(
    rule.id.startsWith("ZERO") ? 1 :
    rule.id === "ACOS-065" ? policy.strongScaleThreshold :
    rule.id === "ACOS-080" ? policy.moderateScaleThreshold :
    rule.id === "ACOS-110" ? policy.holdThreshold :
    rule.id === "ACOS-130" ? policy.lightReductionThreshold :
    rule.id === "ACOS-160" ? policy.mediumReductionThreshold : 1.8,
  );
  const [margin, setMargin] = useState(0.25);
  const [actualAcos, setActualAcos] = useState(0.30);
  const [termPurchases, setTermPurchases] = useState(policy.harvestMinimumPurchases);
  const [termAcosRatio, setTermAcosRatio] = useState(0.8);
  const [exactConflict, setExactConflict] = useState(rule.demo === "conflict");

  let matches = false;
  if (rule.id === "DATA-001") matches = !completeData;
  else if (rule.id === "DATA-002") matches = productCount > 1;
  else if (rule.id === "EVIDENCE-001") matches = clicks < settings.minimumClicks;
  else if (rule.id === "ZERO-075") matches = orders === 0 && ratio >= policy.zeroEarlyThreshold && ratio < policy.zeroTargetThreshold;
  else if (rule.id === "ZERO-100") matches = orders === 0 && ratio >= policy.zeroTargetThreshold && ratio < policy.zeroPauseThreshold;
  else if (rule.id === "ZERO-150") matches = orders === 0 && ratio >= policy.zeroPauseThreshold;
  else if (rule.id === "ACOS-065") matches = orders >= policy.strongScaleMinimumPurchases && ratio <= policy.strongScaleThreshold;
  else if (rule.id === "ACOS-080") matches = orders >= policy.moderateScaleMinimumPurchases && ratio <= policy.moderateScaleThreshold &&
    !(orders >= policy.strongScaleMinimumPurchases && ratio <= policy.strongScaleThreshold);
  else if (rule.id === "ACOS-110") matches = ratio <= policy.holdThreshold &&
    !(orders >= policy.strongScaleMinimumPurchases && ratio <= policy.strongScaleThreshold) &&
    !(orders >= policy.moderateScaleMinimumPurchases && ratio <= policy.moderateScaleThreshold);
  else if (rule.id === "ACOS-130") matches = ratio > policy.holdThreshold && ratio <= policy.lightReductionThreshold;
  else if (rule.id === "ACOS-160") matches = ratio > policy.lightReductionThreshold && ratio <= policy.mediumReductionThreshold;
  else if (rule.id === "ACOS-OVER160") matches = ratio > policy.mediumReductionThreshold;
  else if (rule.id === "ACOS-BE") matches = actualAcos > margin;
  else if (rule.id === "HARVEST-001") matches = termPurchases >= policy.harvestMinimumPurchases && termAcosRatio <= 1 && !exactConflict;
  else if (rule.id === "HARVEST-002") matches = exactConflict;

  return <section className="rule-exercise"><div className="rule-exercise-heading"><div><span>Interactive exercise</span><h3>Would this example trigger the rule?</h3></div><b className={matches ? "matches" : "continues"}>{matches ? `Yes · ${rule.action}` : "No · continue evaluating"}</b></div>
    {rule.demo === "missing-data" && <label className="rule-demo-toggle"><input type="checkbox" checked={completeData} onChange={(event) => setCompleteData(event.target.checked)} /><span>Product, contribution margin and current bid are all available</span></label>}
    {rule.demo === "multi-product" && <label><span>Products found in the ad group <b>{productCount}</b></span><input type="range" min="1" max="5" step="1" value={productCount} onChange={(event) => setProductCount(Number(event.target.value))} /></label>}
    {rule.demo === "clicks" && <label><span>Observed clicks <b>{clicks}</b></span><input type="range" min="0" max="30" step="1" value={clicks} onChange={(event) => setClicks(Number(event.target.value))} /></label>}
    {rule.demo === "zero-orders" && <><label><span>Attributed purchases <b>{orders}</b></span><input type="range" min="0" max="3" step="1" value={orders} onChange={(event) => setOrders(Number(event.target.value))} /></label><label><span>Spend as share of target cost/order <b>{pct(ratio, 0)}</b></span><input type="range" min="0" max="2.5" step="0.05" value={ratio} onChange={(event) => setRatio(Number(event.target.value))} /></label></>}
    {rule.demo === "acos-band" && <><label><span>Attributed purchases <b>{orders}</b></span><input type="range" min="1" max="10" step="1" value={orders} onChange={(event) => setOrders(Number(event.target.value))} /></label><label><span>ACoS as share of Target ACoS <b>{pct(ratio, 0)}</b></span><input type="range" min="0.2" max="2.5" step="0.05" value={ratio} onChange={(event) => setRatio(Number(event.target.value))} /></label></>}
    {rule.demo === "break-even" && <><label><span>Product contribution margin <b>{pct(margin, 0)}</b></span><input type="range" min="0.05" max="0.6" step="0.01" value={margin} onChange={(event) => setMargin(Number(event.target.value))} /></label><label><span>Observed ACoS <b>{pct(actualAcos, 0)}</b></span><input type="range" min="0.05" max="0.8" step="0.01" value={actualAcos} onChange={(event) => setActualAcos(Number(event.target.value))} /></label></>}
    {rule.demo === "harvest" && <><label><span>Search-term purchases <b>{termPurchases}</b></span><input type="range" min="0" max="10" step="1" value={termPurchases} onChange={(event) => setTermPurchases(Number(event.target.value))} /></label><label><span>Search-term ACoS as share of target <b>{pct(termAcosRatio, 0)}</b></span><input type="range" min="0.2" max="1.8" step="0.05" value={termAcosRatio} onChange={(event) => setTermAcosRatio(Number(event.target.value))} /></label><label className="rule-demo-toggle"><input type="checkbox" checked={exactConflict} onChange={(event) => setExactConflict(event.target.checked)} /><span>The exact keyword already exists</span></label></>}
    {rule.demo === "conflict" && <label className="rule-demo-toggle"><input type="checkbox" checked={exactConflict} onChange={(event) => setExactConflict(event.target.checked)} /><span>The same exact keyword already advertises another product</span></label>}
    <p>Move the controls to test the rule. This exercise never changes saved data or Amazon bids.</p>
  </section>;
}

function Rules({ settings, onSettingsChange, saveStatus, updatedAt, updatedBy }: {
  settings: RuleSettings;
  onSettingsChange: (value: RuleSettings) => void;
  saveStatus: SaveStatus;
  updatedAt: string;
  updatedBy: string;
}) {
  const policy = resolveRulePolicy(settings);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const lastRuleTrigger = useRef<HTMLElement | null>(null);
  const percentField = (key: keyof RulePolicy, label: string, min: number, max: number, help: string): RuleEditorField => ({
    key, label, value: Number(policy[key]), defaultValue: Number(DEFAULT_RULE_POLICY[key]), min, max, step: 0.01, format: "percent", help,
  });
  const integerField = (key: keyof RulePolicy | "minimumClicks", label: string, min: number, max: number, help: string): RuleEditorField => ({
    key,
    label,
    value: key === "minimumClicks" ? settings.minimumClicks : Number(policy[key]),
    defaultValue: key === "minimumClicks" ? 5 : Number(DEFAULT_RULE_POLICY[key as keyof RulePolicy]),
    min, max, step: 1, format: "integer", help,
  });
  const rules: RuleBookItem[] = [
    { id: "DATA-001", condition: "Missing product or margin", action: "Manual review", explanation: "Profit-safe bidding requires a product match and contribution margin. A missing current bid does not block a directional increase/decrease/hold recommendation, but the engine deliberately omits an exact bid amount.", example: "A target has €42 spend but no product margin can be joined. It is sent to manual review; a Kaufland product with margin but no bid can still receive a direction-only recommendation.", demo: "missing-data", fields: [], lockedReason: "This data-quality safeguard cannot be weakened." },
    { id: "DATA-002", condition: "Multi-product ad-group join", action: "Manual review", explanation: "One target cannot safely inherit a single product margin when its ad group advertises multiple products.", example: "An ad group contains three ASINs with margins of 18%, 27% and 34%. The target remains under manual review.", demo: "multi-product", fields: [], lockedReason: "This product-ownership safeguard cannot be weakened." },
    { id: "EVIDENCE-001", condition: `Fewer than ${settings.minimumClicks} clicks`, action: "Hold", explanation: "Low click volume is too volatile for a reliable bid change, so the engine waits until the evidence floor is reached.", example: `${Math.max(0, settings.minimumClicks - 1)} clicks triggers Hold; ${settings.minimumClicks} clicks allows the later profitability rules to evaluate.`, demo: "clicks", fields: [integerField("minimumClicks", "Minimum clicks", 3, 20, "Evidence required before profitability rules may change a bid.")] },
    { id: "ZERO-075", condition: `No orders; spend ≥${pct(policy.zeroEarlyThreshold, 0)} target cost/order`, action: `Reduce ${pct(policy.zeroEarlyReduction, 0)}`, explanation: "With no purchases, spend is compared with the product’s target acquisition cost. This first band makes a cautious reduction.", example: `At ${pct(policy.zeroEarlyThreshold, 0)} of target cost with zero orders, a €1.00 bid becomes about ${euro(1 - policy.zeroEarlyReduction, true)} before safety caps.`, demo: "zero-orders", fields: [percentField("zeroEarlyThreshold", "Trigger threshold", 0.25, policy.zeroTargetThreshold - 0.05, "Share of target cost/order that starts the early warning band."), percentField("zeroEarlyReduction", "Bid reduction", 0.01, 0.30, "Requested bid reduction when this rule wins.")] },
    { id: "ZERO-100", condition: `No orders; spend ≥${pct(policy.zeroTargetThreshold, 0)} target cost/order`, action: `Reduce ${pct(policy.zeroTargetReduction, 0)}`, explanation: "Once spend reaches the full target acquisition cost without an order, the correction becomes stronger.", example: `A €1.00 bid is reduced to about ${euro(1 - policy.zeroTargetReduction, true)} when this band wins.`, demo: "zero-orders", fields: [percentField("zeroTargetThreshold", "Trigger threshold", policy.zeroEarlyThreshold + 0.05, policy.zeroPauseThreshold - 0.05, "Share of target cost/order that starts the target-cost band."), percentField("zeroTargetReduction", "Bid reduction", 0.01, 0.30, "Requested bid reduction when this rule wins.")] },
    { id: "ZERO-150", condition: `No orders; spend ≥${pct(policy.zeroPauseThreshold, 0)} target cost/order`, action: "Pause / review", explanation: "Severe zero-order overspend is escalated for review. The engine applies the maximum permitted reduction but never pauses Amazon automatically.", example: `At ${pct(policy.zeroPauseThreshold, 0)} of target cost without an order, the recommendation becomes Pause / review and the bid change is capped at ${pct(settings.maxBidChange, 0)}.`, demo: "zero-orders", fields: [percentField("zeroPauseThreshold", "Escalation threshold", policy.zeroTargetThreshold + 0.05, 3, "Share of target cost/order that escalates the target to review.")] },
    { id: "ACOS-065", condition: `≥${policy.strongScaleMinimumPurchases} orders; ACoS ≤${pct(policy.strongScaleThreshold, 0)} of target`, action: `Increase up to ${pct(policy.strongScaleIncrease, 0)}`, explanation: "Strong, repeated profitability supports controlled scaling. Maximum CPC and the global bid-change cap still apply.", example: `With ${policy.strongScaleMinimumPurchases} purchases at ${pct(policy.strongScaleThreshold, 0)} of Target ACoS, a €1.00 bid requests ${euro(1 + policy.strongScaleIncrease, true)}.`, demo: "acos-band", fields: [integerField("strongScaleMinimumPurchases", "Minimum purchases", 1, 10, "Orders required for the strongest scale signal."), percentField("strongScaleThreshold", "Maximum ACoS / target", 0.20, policy.moderateScaleThreshold - 0.05, "Highest share of Target ACoS allowed in this band."), percentField("strongScaleIncrease", "Bid increase", 0.01, 0.30, "Requested increase before maximum-CPC and global caps.")] },
    { id: "ACOS-080", condition: `≥${policy.moderateScaleMinimumPurchases} orders; ACoS ≤${pct(policy.moderateScaleThreshold, 0)} of target`, action: `Increase up to ${pct(policy.moderateScaleIncrease, 0)}`, explanation: "Moderately profitable evidence supports a smaller increase when the stronger scale rule did not win first.", example: `With ${policy.moderateScaleMinimumPurchases} purchases at ${pct(policy.moderateScaleThreshold, 0)} of Target ACoS, a €1.00 bid requests ${euro(1 + policy.moderateScaleIncrease, true)}.`, demo: "acos-band", fields: [integerField("moderateScaleMinimumPurchases", "Minimum purchases", 1, 10, "Orders required for the moderate scale signal."), percentField("moderateScaleThreshold", "Maximum ACoS / target", policy.strongScaleThreshold + 0.05, policy.holdThreshold - 0.05, "Highest share of Target ACoS allowed in this band."), percentField("moderateScaleIncrease", "Bid increase", 0.01, 0.30, "Requested increase before maximum-CPC and global caps.")] },
    { id: "ACOS-110", condition: `ACoS ≤${pct(policy.holdThreshold, 0)} of target`, action: "Hold", explanation: "Performance inside the operating band is close enough to target that no bid change is justified.", example: `An ACoS at ${pct(policy.holdThreshold, 0)} of Target ACoS holds when neither scale rule has enough evidence.`, demo: "acos-band", fields: [percentField("holdThreshold", "Hold-band ceiling", policy.moderateScaleThreshold + 0.05, policy.lightReductionThreshold - 0.05, "Highest share of Target ACoS that remains a Hold.")] },
    { id: "ACOS-130", condition: `ACoS >${pct(policy.holdThreshold, 0)} and ≤${pct(policy.lightReductionThreshold, 0)} of target`, action: `Reduce ${pct(policy.lightReduction, 0)}`, explanation: "A small correction is used when ACoS is moderately above the operating band.", example: `A €1.00 bid requests ${euro(1 - policy.lightReduction, true)} when ACoS enters this band.`, demo: "acos-band", fields: [percentField("lightReductionThreshold", "Band ceiling", policy.holdThreshold + 0.05, policy.mediumReductionThreshold - 0.05, "Highest share of Target ACoS in the light-reduction band."), percentField("lightReduction", "Bid reduction", 0.01, 0.30, "Requested correction for this band.")] },
    { id: "ACOS-160", condition: `ACoS >${pct(policy.lightReductionThreshold, 0)} and ≤${pct(policy.mediumReductionThreshold, 0)} of target`, action: `Reduce ${pct(policy.mediumReduction, 0)}`, explanation: "A stronger correction is used when ACoS is materially above target but has not crossed the high band.", example: `A €1.00 bid requests ${euro(1 - policy.mediumReduction, true)} when this band wins.`, demo: "acos-band", fields: [percentField("mediumReductionThreshold", "Band ceiling", policy.lightReductionThreshold + 0.05, 3, "Highest share of Target ACoS in the medium-reduction band."), percentField("mediumReduction", "Bid reduction", 0.01, 0.30, "Requested correction for this band.")] },
    { id: "ACOS-OVER160", condition: `ACoS >${pct(policy.mediumReductionThreshold, 0)} of target`, action: `Reduce ${pct(policy.highReduction, 0)}`, explanation: "This is the highest non-break-even efficiency band and requests the strongest configured ordinary reduction.", example: `A €1.00 bid requests ${euro(1 - policy.highReduction, true)} above the current high-band boundary.`, demo: "acos-band", fields: [percentField("highReduction", "Bid reduction", 0.01, 0.30, "Requested correction above the final ACoS band.")] },
    { id: "ACOS-BE", condition: "ACoS above contribution margin", action: `Reduce max ${pct(settings.maxBidChange, 0)} / review`, explanation: "When advertising cost exceeds the product contribution margin, the target is beyond product-level break-even and receives a maximum reduction plus human review.", example: `A product with 25% contribution margin and 30% ACoS exceeds break-even. A €1.00 bid is reduced by at most ${pct(settings.maxBidChange, 0)}.`, demo: "break-even", fields: [{ key: "maxBidChange", label: "Maximum bid change", value: settings.maxBidChange, defaultValue: 0.20, min: 0.05, max: 0.30, step: 0.05, format: "percent", help: "Global hard cap used by this and every other bid rule." }] },
    { id: "HARVEST-001", condition: `≥${policy.harvestMinimumPurchases} profitable purchases; absent from same-product exact targets`, action: "Create exact at safe bid", explanation: "A proven search term can become its own exact keyword when it is profitable and not already exact for the same product.", example: `A term with ${policy.harvestMinimumPurchases} purchases below Target ACoS is proposed at the discovery bid or ${pct(policy.harvestBidBuffer, 0)} of observed CPC, capped at maximum CPC.`, demo: "harvest", fields: [integerField("harvestMinimumPurchases", "Minimum purchases", 1, 10, "Purchases required before a search term may be harvested."), { key: "harvestBidBuffer", label: "Observed CPC starting factor", value: policy.harvestBidBuffer, defaultValue: DEFAULT_RULE_POLICY.harvestBidBuffer, min: 1, max: 1.5, step: 0.05, format: "buffer", help: "Fallback starting bid when the discovery target bid is unavailable." }] },
    { id: "HARVEST-002", condition: "Exact term exists for another product", action: "Conflict review before creation", explanation: "An exact keyword already used by another product may cause auction overlap or unclear product ownership.", example: "The term “corner shower” already advertises ASIN A while the harvest candidate belongs to ASIN B. Creation requires conflict review.", demo: "conflict", fields: [], lockedReason: "Cross-product keyword ownership always requires human review." },
  ];
  const selectedRule = rules.find((rule) => rule.id === selectedRuleId) ?? null;
  const saveDetail = updatedAt
    ? `Last saved ${new Date(updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} by ${updatedBy}`
    : "Organization-wide settings";
  const closeRule = () => {
    setSelectedRuleId(null);
    window.requestAnimationFrame(() => lastRuleTrigger.current?.focus());
  };
  useEffect(() => {
    if (!selectedRuleId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRule();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedRuleId]);
  const updateRuleField = (field: RuleEditorField, value: number) => {
    if (field.key === "minimumClicks" || field.key === "maxBidChange") {
      onSettingsChange({ ...settings, [field.key]: value, policy });
      return;
    }
    onSettingsChange({ ...settings, policy: { ...policy, [field.key]: value } });
  };
  const resetSelectedRule = () => {
    if (!selectedRule?.fields.length) return;
    let next: RuleSettings = { ...settings, policy: { ...policy } };
    for (const field of selectedRule.fields) {
      const safeDefault = Math.min(field.max, Math.max(field.min, field.defaultValue));
      if (field.key === "minimumClicks" || field.key === "maxBidChange") next = { ...next, [field.key]: safeDefault };
      else next = { ...next, policy: { ...resolveRulePolicy(next), [field.key]: safeDefault } };
    }
    onSettingsChange(next);
  };
  const displayField = (field: RuleEditorField) => field.format === "integer" ? integer.format(field.value) :
    field.format === "buffer" ? `${Math.round(field.value * 100)}% of CPC` : pct(field.value, 0);

  return <><div className="page-heading"><div><span className="eyebrow">Version 1.1 · configurable and deterministic</span><h1>Rules & settings</h1><p>Change the shared policy and every suggestion recalculates immediately—no black box.</p></div><SaveIndicator status={saveStatus} label="Saved for the organization" detail={saveDetail} /></div><section className="settings-grid"><article className="panel settings-panel"><div className="panel-heading"><div><span className="eyebrow">Profitability policy</span><h2>Core settings</h2><p className="shared-setting-note">These settings are shared with every authorized user and save automatically.</p></div></div><label><span>Aggressiveness factor</span><b>{pct(settings.aggressivenessFactor, 0)}</b><input type="range" min="0.5" max="1" step="0.05" value={settings.aggressivenessFactor} onChange={(event) => onSettingsChange({ ...settings, aggressivenessFactor: Number(event.target.value), policy })} /><small>Target ACoS = Contribution margin × aggressiveness factor</small></label><label><span>Maximum bid change</span><b>{pct(settings.maxBidChange, 0)}</b><input type="range" min="0.05" max="0.3" step="0.05" value={settings.maxBidChange} onChange={(event) => onSettingsChange({ ...settings, maxBidChange: Number(event.target.value), policy })} /><small>Hard cap in one weekly review cycle</small></label><label><span>Minimum click evidence</span><b>{settings.minimumClicks}</b><input type="range" min="3" max="20" step="1" value={settings.minimumClicks} onChange={(event) => onSettingsChange({ ...settings, minimumClicks: Number(event.target.value), policy })} /><small>Targets below this threshold are held</small></label><div className="setting-badges"><StatusPill tone="ready">30-day evidence</StatusPill><StatusPill tone="quiet">Weekly review</StatusPill><StatusPill tone="quiet">Manual approval</StatusPill></div>{updatedAt && <p className="settings-attribution">Last changed by <b>{updatedBy}</b> on {new Date(updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</p>}</article><article className="panel formula-panel"><span className="eyebrow">Worked example</span><h2>How the safe bid is calculated</h2><div className="formula"><span>30.0%</span><i>×</i><span>{pct(settings.aggressivenessFactor, 0)}</span><i>=</i><strong>{pct(0.3 * settings.aggressivenessFactor)}</strong></div><div className="formula-labels"><span>Contribution margin</span><span>Strategy factor</span><span>Target ACoS</span></div><hr /><p><b>Maximum CPC</b> = Average order value × conversion rate × target ACoS.</p><p className="panel-note">An increase is always capped at maximum CPC. An unavailable margin causes manual review, never an estimate.</p></article></section><section className="panel rules-table interactive-rules"><div className="panel-heading"><div><span className="eyebrow">Evaluation order</span><h2>Transparent rule book</h2><p>Click any rule to understand it, adjust permitted values, and try a live exercise.</p></div><StatusPill tone="ready">{rules.length} active rules</StatusPill></div><div className="table-wrap"><table><thead><tr><th>Rule</th><th>Condition</th><th>Action</th><th>Control</th></tr></thead><tbody>{rules.map((rule) => <tr key={rule.id} tabIndex={0} role="button" aria-haspopup="dialog" aria-label={`Open ${rule.id} rule details`} onClick={(event) => { lastRuleTrigger.current = event.currentTarget; setSelectedRuleId(rule.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); lastRuleTrigger.current = event.currentTarget; setSelectedRuleId(rule.id); } }}><td><code>{rule.id}</code></td><td>{rule.condition}</td><td><b>{rule.action}</b></td><td><span className={rule.fields.length ? "rule-editable" : "rule-locked"}>{rule.fields.length ? `${rule.fields.length} editable` : "Safety locked"}</span><i aria-hidden="true">→</i></td></tr>)}</tbody></table></div></section>
    {selectedRule && <div className="rule-dialog-backdrop" onClick={closeRule}><section className="rule-dialog" role="dialog" aria-modal="true" aria-labelledby="rule-dialog-title" onClick={(event) => event.stopPropagation()}><button type="button" className="rule-dialog-close" aria-label="Close rule details" onClick={closeRule} autoFocus>×</button><header className="rule-dialog-heading"><div><span>Rule {selectedRule.id}</span><h2 id="rule-dialog-title">{selectedRule.condition}</h2><p>{selectedRule.explanation}</p></div><StatusPill tone={selectedRule.fields.length ? "active" : "quiet"}>{selectedRule.fields.length ? "Configurable" : "Safety locked"}</StatusPill></header><div className="rule-example"><span>Worked example</span><p>{selectedRule.example}</p><b>Result: {selectedRule.action}</b></div><section className="rule-editor"><div className="rule-editor-heading"><div><span>Shared rule controls</span><h3>{selectedRule.fields.length ? "Adjust this rule" : "Protected condition"}</h3></div>{selectedRule.fields.length > 0 && <button type="button" onClick={resetSelectedRule}>Reset this rule</button>}</div>{selectedRule.fields.length > 0 ? <div className="rule-field-list">{selectedRule.fields.map((field) => <label key={field.key}><div><span>{field.label}</span><b>{displayField(field)}</b></div><input type="range" min={field.min} max={field.max} step={field.step} value={field.value} onChange={(event) => updateRuleField(field, Number(event.target.value))} /><small>{field.help}</small></label>)}</div> : <p className="rule-locked-copy"><span>◆</span>{selectedRule.lockedReason}</p>}<p className="rule-shared-note"><span>✓</span>Changes save for every authorized user and recalculate suggestions. Amazon is never changed automatically.</p></section><RuleExercise key={selectedRule.id} rule={selectedRule} settings={settings} /><footer className="rule-dialog-footer"><SaveIndicator status={saveStatus} label="Rule saved for the organization" detail={saveDetail} /><button type="button" className="primary-button" onClick={closeRule}>Done</button></footer></section></div>}
  </>;
}

function KnowledgeAssistant({ settings }: { settings: RuleSettings }) {
  const topics = useMemo(() => buildKnowledgeTopics(settings), [settings]);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<KnowledgeGroup | "All">("All");
  const [selectedTopic, setSelectedTopic] = useState<KnowledgeTopic | null>(null);
  const [question, setQuestion] = useState("");
  const lastTopicTrigger = useRef<HTMLElement | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([{
    id: "welcome",
    role: "assistant",
    headline: "Ask across the complete snapshot",
    status: "answered",
    text: "I can search products, SKUs, ASINs, campaigns, targets, recommendations, rankings, profitability, placements, daily performance and source files. If the requested evidence is not present, I will say so instead of estimating.",
    followUps: ["Show the current snapshot", "Show top products by gross contribution", "Which campaigns have the highest ACoS?"],
  }]);
  const groups: (KnowledgeGroup | "All")[] = ["All", "Advertising", "Retail", "Profitability", "Bidding", "Coverage", "Data model"];
  const filteredTopics = topics.filter((topic) => {
    const matchesGroup = group === "All" || topic.group === group;
    const haystack = `${topic.title} ${topic.summary} ${topic.formula || ""} ${topic.aliases.join(" ")} ${topic.sources.join(" ")}`.toLowerCase();
    return matchesGroup && haystack.includes(query.toLowerCase());
  });
  const ask = (value: string) => {
    const cleanQuestion = value.trim();
    if (!cleanQuestion) return;
    const previousEntities = [...messages].reverse().find((message) => message.role === "assistant" && message.entities?.length)?.entities;
    const answer = answerDataQuestion(cleanQuestion, {
      data: data as unknown as AssistantSnapshot,
      settings,
      topics,
      previousEntities,
    });
    setMessages((current) => {
      const messageId = `message-${current.length}`;
      return [
        ...current,
        { id: `${messageId}-user`, role: "user", text: cleanQuestion },
        {
          id: `${messageId}-assistant`,
          role: "assistant",
          headline: answer.headline,
          text: answer.text,
          status: answer.status,
          sources: answer.sources,
          facts: answer.facts,
          items: answer.items,
          entities: answer.entities,
          followUps: answer.followUps,
        },
      ];
    });
    setQuestion("");
  };
  const closeTopic = () => {
    setSelectedTopic(null);
    window.requestAnimationFrame(() => lastTopicTrigger.current?.focus());
  };
  useEffect(() => {
    if (!selectedTopic) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTopic();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedTopic]);
  const prompts = ["Show top products by revenue", "Which campaigns spend the most?", "Show clean harvests and their bids", "Tell me everything about CAB660"];
  return <>
    <div className="page-heading"><div><span className="eyebrow">Transparent methodology</span><h1>Methodology & Assistant</h1><p>Every calculation, rule, and source path in one searchable reference—with a private assistant grounded in the current snapshot.</p></div><StatusPill tone="ready">Verified knowledge</StatusPill></div>
    <section className="knowledge-layout">
      <div className="knowledge-main">
        <article className="panel glossary-panel">
          <div className="knowledge-heading"><div><span className="eyebrow">Calculation glossary</span><h2>How everything is calculated</h2><p>{filteredTopics.length} of {topics.length} definitions</p></div><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search metric, formula or source" /></label></div>
          <div className="knowledge-tabs" aria-label="Glossary categories">{groups.map((item) => <button type="button" key={item} className={group === item ? "active" : ""} onClick={() => setGroup(item)}>{item}</button>)}</div>
          <div className="glossary-list">{filteredTopics.map((topic) => <article className="glossary-card clickable" key={topic.id} role="button" tabIndex={0} aria-haspopup="dialog" aria-label={`Open methodology details for ${topic.title}`} onClick={(event) => { lastTopicTrigger.current = event.currentTarget; setSelectedTopic(topic); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); lastTopicTrigger.current = event.currentTarget; setSelectedTopic(topic); } }}><div className="glossary-title"><div><span>{topic.group}</span><h3>{topic.title}</h3></div><b aria-hidden="true">↗</b></div><p>{topic.summary}</p>{topic.formula && <div className="glossary-formula"><span>Calculation</span><code>{topic.formula}</code></div>}<div className="glossary-card-action"><span>{topic.sources.length} source {topic.sources.length === 1 ? "file" : "files"}</span><b>Open full explanation <i>→</i></b></div></article>)}</div>
          {filteredTopics.length === 0 && <div className="knowledge-empty"><span>⌕</span><h3>No matching definition</h3><p>Try another metric name, formula, or source file.</p></div>}
        </article>
        <article className="panel source-map-panel"><div className="panel-heading"><div><span className="eyebrow">Immutable inputs</span><h2>Source-file map</h2></div><StatusPill tone="ready">{data.imports.length} verified files</StatusPill></div><div className="source-map-list">{data.imports.map((item) => <div key={item.key}><span className="source-type">{item.file.endsWith(".csv") ? "CSV" : "XLSX"}</span><div><b>{item.report}</b><code>{item.path}</code><small>{item.role} · {integer.format(item.rows)} rows · {item.status}</small></div></div>)}</div></article>
      </div>
      <aside className="panel assistant-panel">
        <div className="assistant-heading"><span className="assistant-mark">AI</span><div><span className="eyebrow">Grounded help</span><h2>Bid Control Assistant</h2><p><i /> Private · current snapshot only</p></div></div>
        <div className="assistant-prompts">{prompts.map((prompt) => <button type="button" key={prompt} onClick={() => ask(prompt)}>{prompt}</button>)}</div>
        <div className="assistant-chat" aria-live="polite">{messages.map((message) => <div className={`assistant-message ${message.role}`} key={message.id}>{message.role === "assistant" && <span className="assistant-avatar">AI</span>}<div className="assistant-bubble">{message.headline && <div className="assistant-answer-heading"><h3>{message.headline}</h3>{message.status && <span className={`assistant-grounding ${message.status}`}>{message.status === "answered" ? "Verified answer" : message.status === "interpreted" ? "Interpreted question" : "Data unavailable"}</span>}</div>}<p>{message.text}</p>{message.facts && message.facts.length > 0 && <dl className="assistant-facts">{message.facts.map((fact) => <div key={`${fact.label}-${fact.value}`}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}{message.items && message.items.length > 0 && <div className="assistant-results">{message.items.map((item, index) => <article key={`${item.title}-${index}`}><div className="assistant-result-title">{item.rank && <span>{item.rank}</span>}<div><b>{item.title}</b>{item.subtitle && <small>{item.subtitle}</small>}</div></div><dl>{item.metrics.map((metric) => <div key={`${metric.label}-${metric.value}`}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl></article>)}</div>}{message.sources && message.sources.length > 0 && <details className="assistant-sources"><summary>{message.sources.length} verified source {message.sources.length === 1 ? "file" : "files"}</summary>{message.sources.map((path) => <code key={path}>{path}</code>)}</details>}{message.followUps && message.followUps.length > 0 && <div className="assistant-followups"><span>Ask next</span>{message.followUps.map((followUp) => <button type="button" key={followUp} onClick={() => ask(followUp)}>{followUp}</button>)}</div>}</div></div>)}</div>
        <form className="assistant-input" onSubmit={(event) => { event.preventDefault(); ask(question); }}><label><span className="sr-only">Ask the Bid Control Assistant</span><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask any question that can be answered from the current data…" rows={2} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); ask(question); } }} /></label><button type="submit" disabled={!question.trim()} aria-label="Send question">↑</button></form>
        <p className="assistant-note">Answers search the complete normalized snapshot and methodology locally. No company data is sent to an external AI service.</p>
      </aside>
    </section>
    {selectedTopic && <div className="knowledge-dialog-backdrop" onClick={closeTopic}>
      <section className="knowledge-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-dialog-title" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="knowledge-dialog-close" aria-label="Close methodology details" onClick={closeTopic} autoFocus>×</button>
        <div className="knowledge-dialog-heading"><span>{selectedTopic.group} methodology</span><h2 id="knowledge-dialog-title">{selectedTopic.title}</h2><p>{selectedTopic.summary}</p></div>
        {selectedTopic.formula && <div className="knowledge-dialog-formula"><span>Calculation</span><code>{selectedTopic.formula}</code></div>}
        <div className="knowledge-dialog-sources"><div><span>Verified source {selectedTopic.sources.length > 1 ? "files" : "file"}</span><b>{selectedTopic.sources.length}</b></div>{selectedTopic.sources.map((path) => <code key={path}>{path}</code>)}</div>
        <div className="knowledge-dialog-aliases"><span>Related search terms</span><div>{selectedTopic.aliases.map((alias) => <button type="button" key={alias} onClick={() => { setQuery(alias); setGroup("All"); closeTopic(); }}>{alias}</button>)}</div></div>
        <div className="knowledge-dialog-actions"><p>Need the answer in context? Ask the assistant to combine this definition with the current data.</p><button type="button" className="primary-button" onClick={() => { ask(`Explain ${selectedTopic.title} using the current snapshot`); closeTopic(); }}>Ask the assistant <span>→</span></button></div>
      </section>
    </div>}
  </>;
}

function History({ history, currentSummary, audit }: { history: SnapshotHistorySummary[]; currentSummary: SnapshotHistorySummary; audit: AuditRecord[] }) {
  const activityLabel = (item: AuditRecord) => item.entityType === "settings"
    ? "Organization rules updated"
    : item.entityType === "review"
      ? `Suggestion review ${item.action}`
      : "Personal view preferences updated";
  return <><div className="page-heading"><div><span className="eyebrow">Persistent audit trail</span><h1>Run history</h1><p>Every validated import and shared decision remains available as evidence.</p></div><StatusPill tone="ready">{history.length} retained</StatusPill></div><section className="panel history-panel">{history.map((item) => <div className={`timeline-item ${item.id === currentSummary.id ? "current" : ""}`} key={item.id}><span className="timeline-dot" /><div className="timeline-content"><div><h3>{displayDate(item.periodStart)} – {displayDate(item.periodEnd)}</h3><StatusPill tone={item.id === currentSummary.id ? "ready" : "quiet"}>{item.id === currentSummary.id ? "Current dashboard" : "Historical"}</StatusPill></div><p>{item.periodDays} days · Amazon DE · EUR · {item.fileCount} uploaded source files</p><div className="run-stats"><span><b>{euro(item.retailSales)}</b> retail sales</span><span><b>{euro(item.advertisingSpend)}</b> ad spend</span><span><b>{pct(item.tcos, 2)}</b> TCOS</span><span><b>{item.retailCoverageProducts}/{item.activeProducts}</b> retail coverage</span></div><small>Stored {new Date(item.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} by {item.createdBy}</small></div></div>)}</section><section className="panel activity-panel"><div className="panel-heading"><div><span className="eyebrow">Team activity</span><h2>Recent saved changes</h2><p>Shared rules and review decisions include the person and time. Your personal view changes are visible only to you.</p></div><StatusPill tone="quiet">{audit.length} recent</StatusPill></div>{audit.length === 0 ? <div className="activity-empty">No saved changes have been recorded yet.</div> : <div className="activity-list">{audit.map((item) => <article key={item.id}><span className={`activity-icon ${item.entityType}`}>{item.entityType === "settings" ? "⚙" : item.entityType === "review" ? "✓" : "≡"}</span><div><b>{activityLabel(item)}</b><small>{item.changedBy} · {new Date(item.changedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</small></div>{item.entityType === "review" && <code title={item.entityId}>{item.entityId.split(":").at(-1)?.slice(0, 18)}</code>}</article>)}</div>}</section></>;
}

const reportingRangeOptions: { key: DateRangePreset; label: string }[] = [
  { key: "today", label: "Latest day" },
  { key: "yesterday", label: "Previous day" },
  { key: "last-7", label: "Last 7 days" },
  { key: "last-full-7", label: "Last full 7 days" },
  { key: "last-14", label: "Last 14 days" },
  { key: "current-week", label: "Current week" },
  { key: "current-month", label: "Current month" },
  { key: "last-30", label: "Last 30 days" },
  { key: "last-full-30", label: "Last full 30 days" },
  { key: "previous-month", label: "Previous month" },
  { key: "last-90", label: "Last 90 days" },
  { key: "last-180", label: "Last 180 days" },
  { key: "last-365", label: "Last 365 days" },
];

function ReportingPeriodSelector({
  history,
  currentSummary,
  advertisingRange,
  loading,
  ready,
  error,
  onSelect,
  onSelectAdvertisingRange,
  onMissing,
  onOpenImports,
}: {
  history: SnapshotHistorySummary[];
  currentSummary: SnapshotHistorySummary;
  advertisingRange: MergedAdvertisingRange | null;
  loading: boolean;
  ready: boolean;
  error: string;
  onSelect: (snapshotId: string) => void;
  onSelectAdvertisingRange: (range: ReportingDateRange) => void;
  onMissing: (message: string) => void;
  onOpenImports: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(currentSummary.periodStart);
  const [customTo, setCustomTo] = useState(currentSummary.periodEnd);
  const selectorRef = useRef<HTMLDivElement>(null);
  const latestEnd = history[0]?.periodEnd ?? currentSummary.periodEnd;
  const earliestStart = history.reduce((earliest, item) => item.periodStart < earliest ? item.periodStart : earliest, currentSummary.periodStart);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!selectorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    setCustomFrom(advertisingRange?.reporting.start ?? currentSummary.periodStart);
    setCustomTo(advertisingRange?.reporting.end ?? currentSummary.periodEnd);
  }, [advertisingRange?.reporting.start, advertisingRange?.reporting.end, currentSummary.periodStart, currentSummary.periodEnd]);

  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);

  const chooseRange = (range: ReportingDateRange) => {
    if (range.start > range.end) {
      onMissing("The From date must be before or equal to the To date.");
      return;
    }
    const match = matchingSnapshot(history, range);
    if (!match) {
      onMissing("");
      setOpen(false);
      onSelectAdvertisingRange(range);
      return;
    }
    onMissing("");
    setOpen(false);
    onSelect(match.id);
  };

  const visibleRange = advertisingRange?.reporting ?? { start: currentSummary.periodStart, end: currentSummary.periodEnd, days: currentSummary.periodDays };
  return <div className={`period-selector ${loading ? "loading" : ""} ${open ? "open" : ""} ${advertisingRange ? "advertising-only" : ""}`} ref={selectorRef}>
    <button type="button" className="period-selector-trigger" aria-haspopup="dialog" aria-expanded={open} disabled={!ready || loading} onClick={() => setOpen((value) => !value)}>
      <span aria-hidden="true">▣</span>
      <b>{displayDate(visibleRange.start)} – {displayDate(visibleRange.end)}</b>
      <small>{loading ? "Loading…" : advertisingRange ? `${visibleRange.days} days · Ads only` : `${visibleRange.days} days`}</small>
      <i aria-hidden="true">⌄</i>
    </button>
    {open && <section className="period-selector-popover" role="dialog" aria-label="Choose reporting date range">
      <header><div><span>Reporting period</span><h2>Choose a date range</h2></div><button type="button" aria-label="Close date selector" onClick={() => setOpen(false)}>×</button></header>
      <div className="period-selector-body">
        <div className="period-presets">
          <span>Quick ranges</span>
          {reportingRangeOptions.map((option) => {
            const range = presetDateRange(option.key, latestEnd);
            const available = Boolean(matchingSnapshot(history, range));
            return <button type="button" key={option.key} onClick={() => chooseRange(range)}>
              <b>{option.label}</b>
              <small>{available ? "Full KPI snapshot" : "Advertising only"}</small>
            </button>;
          })}
        </div>
        <div className="period-custom">
          <div><span>Custom range</span><p>Any covered range can recalculate daily advertising KPIs. Retail, margin, products and bidding remain on the complete snapshot.</p></div>
          <div className="period-date-fields">
            <label><span>Date from</span><input type="date" value={customFrom} min={earliestStart} max={latestEnd} onChange={(event) => setCustomFrom(event.target.value)} /></label>
            <label><span>Date to</span><input type="date" value={customTo} min={earliestStart} max={latestEnd} onChange={(event) => setCustomTo(event.target.value)} /></label>
          </div>
          <button type="button" className="primary-button period-apply" disabled={!customFrom || !customTo} onClick={() => chooseRange({ start: customFrom, end: customTo })}>Apply custom range</button>
          <div className="available-periods"><span>Available imported periods</span>{history.map((item, index) => <button type="button" className={item.id === currentSummary.id ? "active" : ""} key={item.id} onClick={() => { onMissing(""); setOpen(false); onSelect(item.id); }}><b>{displayDate(item.periodStart)} – {displayDate(item.periodEnd)}</b><small>{item.periodDays} days{index === 0 ? " · Latest" : ""}</small></button>)}</div>
        </div>
      </div>
      {error && <footer className="period-selector-feedback" role="alert"><p>{error}</p><button type="button" onClick={() => { setOpen(false); onOpenImports(); }}>Open data imports →</button></footer>}
    </section>}
  </div>;
}

// The Allegro workspace is fully client-side: the three Allegro workbooks are parsed
// in the browser and the resulting PLN-native snapshot (plus the editable FX rate) is
// persisted to localStorage so it survives a reload without any server storage.
const ALLEGRO_STORAGE_KEY = "mpc:allegro:v1";
const DEFAULT_PLN_EUR_RATE = 0.23;

function loadStoredAllegro(): { snapshot: AllegroSnapshot; fxRate: number; fileNames: string[] } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ALLEGRO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { snapshot?: AllegroSnapshot; fxRate?: number; fileNames?: string[] };
    if (!parsed.snapshot) return null;
    return { snapshot: parsed.snapshot, fxRate: parsed.fxRate ?? DEFAULT_PLN_EUR_RATE, fileNames: parsed.fileNames ?? [] };
  } catch {
    return null;
  }
}

function saveStoredAllegro(snapshot: AllegroSnapshot, fxRate: number, fileNames: string[]) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(ALLEGRO_STORAGE_KEY, JSON.stringify({ snapshot, fxRate, fileNames })); } catch { /* quota */ }
}

function clearStoredAllegro() {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(ALLEGRO_STORAGE_KEY); } catch { /* ignore */ }
}

// eBay reports are likewise parsed and held in the browser (EUR, no FX needed).
const EBAY_STORAGE_KEY = "mpc:ebay:v1";

function loadStoredEbay(): { snapshot: EbaySnapshot; fileNames: string[] } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(EBAY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { snapshot?: EbaySnapshot; fileNames?: string[] };
    if (!parsed.snapshot) return null;
    return { snapshot: parsed.snapshot, fileNames: parsed.fileNames ?? [] };
  } catch {
    return null;
  }
}

function saveStoredEbay(snapshot: EbaySnapshot, fileNames: string[]) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(EBAY_STORAGE_KEY, JSON.stringify({ snapshot, fileNames })); } catch { /* quota */ }
}

function clearStoredEbay() {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(EBAY_STORAGE_KEY); } catch { /* ignore */ }
}

function AllegroImports({ snapshot, marginCoverage, productMasterLoaded, productMasterStats, onProductMaster, onClearProductMaster, onImported, onClear }: {
  snapshot: AllegroSnapshot | null;
  marginCoverage: { matchedOffers: number; totalOffers: number };
  productMasterLoaded: boolean;
  productMasterStats: ProductMasterStats | null;
  onProductMaster: (products: CatalogProduct[], stats: ProductMasterStats) => void;
  onClearProductMaster: () => void;
  onImported: (snapshot: AllegroSnapshot, fileNames: string[]) => void;
  onClear: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);

  const importFiles = async (incoming: File[]) => {
    const files = incoming.filter((file) => /\.(xlsx|csv)$/i.test(file.name));
    if (!files.length) { setFeedback({ tone: "error", text: "Drop the Allegro .xlsx exports (or .csv)." }); return; }
    setBusy(true);
    setFeedback({ tone: "warning", text: `Reading ${files.length} file${files.length === 1 ? "" : "s"}…` });
    try {
      const result = await parseAllegroFiles(files);
      if (!result.sources.length) { setFeedback({ tone: "error", text: "None of the files matched a known Allegro export layout." }); return; }
      const names = files.map((file) => file.name);
      onImported(result, names);
      const warningText = result.warnings.length ? ` ${result.warnings.join(" ")}` : "";
      setFeedback({ tone: result.warnings.length ? "warning" : "success", text: `Imported ${result.sources.length} Allegro report${result.sources.length === 1 ? "" : "s"} covering ${result.periodStart ? displayDate(result.periodStart) : "?"} – ${result.periodEnd ? displayDate(result.periodEnd) : "?"}. Every sidebar tool now reflects this Allegro period.${warningText}` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "The Allegro files could not be read." });
    } finally {
      setBusy(false);
    }
  };

  return <>
    <div className="page-heading"><div><span className="eyebrow">Allegro exports · PLN</span><h1>Data imports</h1><p>Drop the campaign statistics workbook, the offer/product summary, and (optionally) the traffic report. Files are parsed and kept in your browser — nothing is uploaded. Every figure is stored in PLN and shown with the euro equivalent set by the rate in the top bar.</p></div><StatusPill tone={snapshot ? "ready" : "quiet"}>{snapshot ? `${snapshot.sources.length} reports loaded` : "No Allegro data"}</StatusPill></div>
    <section className="panel allegro-import-panel">
      <label className={`drop-zone ${dragging ? "dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { event.preventDefault(); setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); void importFiles(Array.from(event.dataTransfer.files)); }}>
        <input type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" multiple disabled={busy} onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        <span className="drop-icon">⇧</span><strong>{busy ? "Reading Allegro reports…" : "Drop Allegro .xlsx files here"}</strong><small>campaign statistics · offer/product summary · traffic report · or click to choose</small>
      </label>
      {feedback && <div className={`import-feedback ${feedback.tone}`} role="status">{feedback.text}</div>}
      {snapshot && <div className="allegro-sources"><div className="allegro-sources-head"><StatusPill tone="ready">{snapshot.sources.length} report{snapshot.sources.length === 1 ? "" : "s"} loaded</StatusPill><button type="button" className="text-button" onClick={onClear}>Remove Allegro data</button></div><div className="import-grid">{snapshot.sources.map((source, index) => <article className="import-card" key={`${source.key}-${index}`}><div className="file-icon">{source.fileName.toLowerCase().endsWith(".csv") ? "CSV" : "XLSX"}</div><div className="import-main"><div><h3>{source.label}</h3><StatusPill tone="ready">{integer.format(source.rows)} rows</StatusPill></div><p title={source.fileName}>{source.fileName}</p><dl><div><dt>System role</dt><dd>{source.key}</dd></div></dl></div></article>)}</div></div>}
      <div className="allegro-required"><span className="eyebrow">Recognized files</span><div className="upload-requirements">{marketplaceRegistry.allegro_pl.importRequirements.map((item, index) => <div className={`upload-requirement${item.optional ? " optional" : ""}`} key={item.role}><span>{item.optional ? "+" : index + 1}</span><div><b>{item.title} <em>{item.optional ? "Optional" : item.cadence}</em></b><small>{item.description}</small></div></div>)}</div></div>
    </section>
    <ProductMasterUpload productMasterStats={productMasterStats} onProductMaster={onProductMaster} onClearProductMaster={onClearProductMaster} />
    <ErpSalesUpload marketplaceId="allegro_pl" />
    <section className="panel allegro-margin-note"><div className="panel-heading"><div><span className="eyebrow">Contribution margin</span><h2>Product master join</h2><p>Contribution margin is computed by matching each Allegro offer to your uploaded product master — first by the Allegro Ads campaign name (which mirrors the internal SKU), then by the SKU appearing in the offer title. Unmatched offers stay outside the margin calculation.</p></div><StatusPill tone={productMasterLoaded ? (marginCoverage.matchedOffers > 0 ? "ready" : "partial") : "quiet"}>{productMasterLoaded ? `${integer.format(marginCoverage.matchedOffers)}/${integer.format(marginCoverage.totalOffers)} offers matched` : "No product master uploaded"}</StatusPill></div>{!productMasterLoaded && <p className="allegro-note">Upload a product master above whose SKUs match the Allegro campaign names, then the Net contribution margin card populates here too.</p>}</section>
  </>;
}

function EbayImports({ snapshot, marginCoverage, productMasterLoaded, productMasterStats, onProductMaster, onClearProductMaster, onImported, onClear }: {
  snapshot: EbaySnapshot | null;
  marginCoverage: { matchedSkus: number; totalSkus: number };
  productMasterLoaded: boolean;
  productMasterStats: ProductMasterStats | null;
  onProductMaster: (products: CatalogProduct[], stats: ProductMasterStats) => void;
  onClearProductMaster: () => void;
  onImported: (snapshot: EbaySnapshot, fileNames: string[]) => void;
  onClear: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);

  const importFiles = async (incoming: File[]) => {
    const files = incoming.filter((file) => /\.(csv|xlsx)$/i.test(file.name));
    if (!files.length) { setFeedback({ tone: "error", text: "Drop the eBay .csv report exports." }); return; }
    setBusy(true);
    setFeedback({ tone: "warning", text: `Reading ${files.length} file${files.length === 1 ? "" : "s"}…` });
    try {
      const result = await parseEbayFiles(files);
      if (!result.sources.length) { setFeedback({ tone: "error", text: "None of the files matched a known eBay export layout." }); return; }
      const names = files.map((file) => file.name);
      onImported(result, names);
      const warningText = result.warnings.length ? ` ${result.warnings.join(" ")}` : "";
      setFeedback({ tone: result.warnings.length ? "warning" : "success", text: `Imported ${result.sources.length} eBay report${result.sources.length === 1 ? "" : "s"} covering ${result.periodStart ? displayDate(result.periodStart) : "?"} – ${result.periodEnd ? displayDate(result.periodEnd) : "?"}. Every sidebar tool now reflects this eBay period.${warningText}` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "The eBay files could not be read." });
    } finally {
      setBusy(false);
    }
  };

  return <>
    <div className="page-heading"><div><span className="eyebrow">eBay exports · EUR</span><h1>Data imports</h1><p>Drop the active-listings report, the orders report, and the Promoted Listings reports (priority campaign / listing / keyword / search query, plus general listing). Files are parsed and kept in your browser — nothing is uploaded.</p></div><StatusPill tone={snapshot ? "ready" : "quiet"}>{snapshot ? `${snapshot.sources.length} reports loaded` : "No eBay data"}</StatusPill></div>
    <section className="panel allegro-import-panel">
      <label className={`drop-zone ${dragging ? "dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { event.preventDefault(); setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); void importFiles(Array.from(event.dataTransfer.files)); }}>
        <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple disabled={busy} onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        <span className="drop-icon">⇧</span><strong>{busy ? "Reading eBay reports…" : "Drop eBay .csv files here"}</strong><small>active listings · orders · promoted listings reports · or click to choose</small>
      </label>
      {feedback && <div className={`import-feedback ${feedback.tone}`} role="status">{feedback.text}</div>}
      {snapshot && <div className="allegro-sources"><div className="allegro-sources-head"><StatusPill tone="ready">{snapshot.sources.length} report{snapshot.sources.length === 1 ? "" : "s"} loaded</StatusPill><button type="button" className="text-button" onClick={onClear}>Remove eBay data</button></div><div className="import-grid">{snapshot.sources.map((source, index) => <article className="import-card" key={`${source.key}-${index}`}><div className="file-icon">{source.fileName.toLowerCase().endsWith(".xlsx") ? "XLSX" : "CSV"}</div><div className="import-main"><div><h3>{source.label}</h3><StatusPill tone="ready">{integer.format(source.rows)} rows</StatusPill></div><p title={source.fileName}>{source.fileName}</p><dl><div><dt>System role</dt><dd>{source.key}</dd></div></dl></div></article>)}</div></div>}
      <div className="allegro-required"><span className="eyebrow">Recognized files</span><div className="upload-requirements">{marketplaceRegistry.ebay_de.importRequirements.map((item, index) => <div className={`upload-requirement${item.optional ? " optional" : ""}`} key={item.role}><span>{item.optional ? "+" : index + 1}</span><div><b>{item.title} <em>{item.optional ? "Optional" : item.cadence}</em></b><small>{item.description}</small></div></div>)}</div></div>
    </section>
    <ProductMasterUpload productMasterStats={productMasterStats} onProductMaster={onProductMaster} onClearProductMaster={onClearProductMaster} />
    <ErpSalesUpload marketplaceId="ebay_de" />
    <section className="panel allegro-margin-note"><div className="panel-heading"><div><span className="eyebrow">Contribution margin</span><h2>Product master join</h2><p>Contribution margin is computed by matching each ordered eBay SKU (custom label) to your uploaded product master. eBay SKUs match the internal SKU directly, with a trailing variant suffix stripped as a fallback. Unmatched SKUs stay outside the margin calculation.</p></div><StatusPill tone={productMasterLoaded ? (marginCoverage.matchedSkus > 0 ? "ready" : "partial") : "quiet"}>{productMasterLoaded ? `${integer.format(marginCoverage.matchedSkus)}/${integer.format(marginCoverage.totalSkus)} ordered SKUs matched` : "No product master uploaded"}</StatusPill></div>{!productMasterLoaded && <p className="allegro-note">Upload a product master above whose SKUs match the eBay custom labels, then the Net contribution margin card populates here too.</p>}</section>
  </>;
}

export default function Home() {
  const [page, setPage] = useState<PageKey>("dashboard");
  const [marketplaceSelection, setMarketplaceSelection] = useState<MarketplaceSelection>("amazon_de");
  const [marketplaceAvailable, setMarketplaceAvailable] = useState(true);
  const fallbackSummary = useMemo(() => summaryFromData(initialData), []);
  const [runtimeData, setRuntimeData] = useState<DashboardData>(initialData);
  const [history, setHistory] = useState<SnapshotHistorySummary[]>([fallbackSummary]);
  const [currentSummary, setCurrentSummary] = useState<SnapshotHistorySummary>(fallbackSummary);
  const [advertisingRange, setAdvertisingRange] = useState<MergedAdvertisingRange | null>(null);
  const [storageStatus, setStorageStatus] = useState<"loading" | "ready" | "offline">("loading");
  const [periodLoading, setPeriodLoading] = useState(false);
  const [periodError, setPeriodError] = useState("");
  const [settings, setSettings] = useState<RuleSettings>({ aggressivenessFactor: initialData.settings.aggressivenessFactor, maxBidChange: initialData.settings.maxBidChange, minimumClicks: initialData.settings.minimumClicks, policy: DEFAULT_RULE_POLICY });
  const settingsRevisionRef = useRef(0);
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<SaveStatus>("loading");
  const [settingsUpdatedAt, setSettingsUpdatedAt] = useState("");
  const [settingsUpdatedBy, setSettingsUpdatedBy] = useState("");
  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reviews, setReviews] = useState<Record<string, ReviewRecord>>({});
  const reviewsRef = useRef<Record<string, ReviewRecord>>({});
  const [reviewSaveStatus, setReviewSaveStatus] = useState<SaveStatus>("loading");
  const [preferences, setPreferences] = useState<UserPreferences>({});
  const preferencesRef = useRef<UserPreferences>({});
  const preferencesRevisionRef = useRef(0);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [preferencesSaveStatus, setPreferencesSaveStatus] = useState<SaveStatus>("loading");
  const preferencesSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  const [currentUser, setCurrentUser] = useState<{ email: string; displayName: string } | null>(null);
  const [collaborationReady, setCollaborationReady] = useState(false);
  const [productMasterStats, setProductMasterStats] = useState<ProductMasterStats | null>(null);
  const productMasterRef = useRef<CatalogProduct[] | null>(null);
  const [productMasterVersion, setProductMasterVersion] = useState(0);
  const [allegroSnapshot, setAllegroSnapshot] = useState<AllegroSnapshot | null>(null);
  const [allegroFx, setAllegroFx] = useState<number>(DEFAULT_PLN_EUR_RATE);
  const [allegroFileNames, setAllegroFileNames] = useState<string[]>([]);
  const [allegroMarginCoverage, setAllegroMarginCoverage] = useState<{ matchedOffers: number; totalOffers: number }>({ matchedOffers: 0, totalOffers: 0 });
  const [ebaySnapshot, setEbaySnapshot] = useState<EbaySnapshot | null>(null);
  const [ebayFileNames, setEbayFileNames] = useState<string[]>([]);
  const [ebayMarginCoverage, setEbayMarginCoverage] = useState<{ matchedSkus: number; totalSkus: number }>({ matchedSkus: 0, totalSkus: 0 });
  // This legacy module-level snapshot lets the existing analytical page functions share one active dataset.
  // eslint-disable-next-line react-hooks/globals
  data = runtimeData;
  // eslint-disable-next-line react-hooks/globals
  activeCurrency = runtimeData.reporting.currency === "PLN" ? "PLN" : "EUR";
  // eslint-disable-next-line react-hooks/globals
  activeFxToEur = runtimeData.reporting.fxRateToEur ?? 1;
  useEffect(() => {
    if (marketplaceSelection === "all" || marketplaceSelection === "allegro_pl" || marketplaceSelection === "ebay_de") return;
    // A user-uploaded product master (held in the browser) overrides the baked-in
    // catalog and drives the products everywhere, even without server storage.
    if (productMasterRef.current === null) {
      const stored = loadStoredProductMaster();
      if (stored) { productMasterRef.current = stored.products; setProductMasterStats(stored.stats); }
    }
    const withMaster = (base: DashboardData) => productMasterRef.current?.length ? applyCatalogToData(base, productMasterRef.current) : base;
    let active = true;
    setStorageStatus("loading");
    fetch(snapshotRequestPath(undefined, marketplaceSelection), { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { error?: string; snapshot?: DashboardData; summary?: SnapshotHistorySummary; history?: SnapshotHistorySummary[] };
        if (!response.ok || !payload.snapshot || !payload.summary || !payload.history) throw new Error(payload.error || "Persistent history is unavailable.");
        return payload;
      })
      .then((payload) => {
        if (!active || !payload.snapshot || !payload.summary || !payload.history) return;
        setRuntimeData(withMaster(payload.snapshot));
        setCurrentSummary(payload.summary);
        setHistory(payload.history);
        setMarketplaceAvailable(true);
        setStorageStatus("ready");
      })
      .catch(() => { if (active) { const empty = emptyMarketplaceData(marketplaceSelection); setRuntimeData(withMaster(empty)); setCurrentSummary(summaryFromData(empty, `empty-${marketplaceSelection}`)); setHistory([]); setMarketplaceAvailable(true); setStorageStatus("ready"); } });
    return () => { active = false; };
  }, [marketplaceSelection]);
  // Load any browser-persisted Allegro reports and product master once on mount.
  useEffect(() => {
    if (productMasterRef.current === null) {
      const storedMaster = loadStoredProductMaster();
      if (storedMaster) { productMasterRef.current = storedMaster.products; setProductMasterStats(storedMaster.stats); }
    }
    const storedAllegro = loadStoredAllegro();
    if (storedAllegro) { setAllegroSnapshot(storedAllegro.snapshot); setAllegroFx(storedAllegro.fxRate); setAllegroFileNames(storedAllegro.fileNames); }
    const storedEbay = loadStoredEbay();
    if (storedEbay) { setEbaySnapshot(storedEbay.snapshot); setEbayFileNames(storedEbay.fileNames); }
  }, []);
  // eBay flows through the shared pages too (EUR, so no FX): rebuild a standard snapshot
  // from the eBay reports (joined to the product master for margin) whenever eBay is active
  // or the reports change.
  useEffect(() => {
    if (marketplaceSelection !== "ebay_de") return;
    const { snapshot, marginCoverage } = buildEbayDashboardData(ebaySnapshot, productMasterRef.current);
    const built = snapshot as unknown as DashboardData;
    const summary = summaryFromData(built, ebaySnapshot ? "ebay-current" : "ebay-empty");
    setRuntimeData(built);
    setCurrentSummary(summary);
    setHistory([summary]);
    setEbayMarginCoverage({ matchedSkus: marginCoverage.matchedSkus, totalSkus: marginCoverage.totalSkus });
    setMarketplaceAvailable(true);
    setStorageStatus("ready");
  }, [marketplaceSelection, ebaySnapshot, productMasterVersion]);
  // Allegro flows through the same shared pages as Amazon/Kaufland: rebuild a standard
  // PLN-native snapshot from the Allegro reports (joined to the product master for margin)
  // whenever Allegro is active, the reports change, or the FX rate changes.
  useEffect(() => {
    if (marketplaceSelection !== "allegro_pl") return;
    const { snapshot, marginCoverage } = buildAllegroDashboardData(allegroSnapshot, productMasterRef.current, allegroFx);
    const built = snapshot as unknown as DashboardData;
    const summary = summaryFromData(built, allegroSnapshot ? "allegro-current" : "allegro-empty");
    setRuntimeData(built);
    setCurrentSummary(summary);
    setHistory([summary]);
    setAllegroMarginCoverage({ matchedOffers: marginCoverage.matchedOffers, totalOffers: marginCoverage.totalOffers });
    setMarketplaceAvailable(true);
    setStorageStatus("ready");
  }, [marketplaceSelection, allegroSnapshot, allegroFx, productMasterVersion]);
  useEffect(() => {
    if (storageStatus !== "ready" || !marketplaceAvailable || marketplaceSelection === "all" || marketplaceSelection === "allegro_pl" || marketplaceSelection === "ebay_de") return;
    let active = true;
    fetch(`/api/app-state?snapshotId=${encodeURIComponent(currentSummary.id)}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as {
          error?: string;
          user?: { email: string; displayName: string };
          settings?: { value: RuleSettings; revision: number; updatedAt: string; updatedBy: string };
          reviews?: Record<string, ReviewRecord>;
          preferences?: { value: UserPreferences; revision: number };
          audit?: AuditRecord[];
        };
        if (!response.ok || !payload.user || !payload.settings || !payload.reviews || !payload.preferences || !payload.audit) {
          throw new Error(payload.error || "Saved team state is unavailable.");
        }
        return payload;
      })
      .then((payload) => {
        if (!active || !payload.user || !payload.settings || !payload.reviews || !payload.preferences || !payload.audit) return;
        setCurrentUser(payload.user);
        setSettings({ ...payload.settings.value, policy: resolveRulePolicy(payload.settings.value) });
        settingsRevisionRef.current = payload.settings.revision;
        setSettingsUpdatedAt(payload.settings.updatedAt);
        setSettingsUpdatedBy(payload.settings.updatedBy);
        reviewsRef.current = payload.reviews;
        setReviews(payload.reviews);
        preferencesRef.current = payload.preferences.value;
        setPreferences(payload.preferences.value);
        if (payload.preferences.value.marketplaceId) {
          setMarketplaceSelection(payload.preferences.value.marketplaceId);
          if (payload.preferences.value.marketplaceId === "all") setPage("dashboard");
        }
        preferencesRevisionRef.current = payload.preferences.revision;
        setAudit(payload.audit);
        setPreferencesReady(true);
        setCollaborationReady(true);
        setSettingsSaveStatus("saved");
        setReviewSaveStatus("saved");
        setPreferencesSaveStatus("saved");
      })
      .catch(() => {
        if (!active) return;
        setSettingsSaveStatus("error");
        setReviewSaveStatus("error");
        setPreferencesSaveStatus("error");
      });
    return () => { active = false; };
  }, [storageStatus, currentSummary.id, marketplaceAvailable, marketplaceSelection]);
  useEffect(() => () => {
    if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current);
    if (preferencesSaveTimer.current) clearTimeout(preferencesSaveTimer.current);
  }, []);

  const saveState = async <T,>(body: Record<string, unknown>): Promise<T> => {
    const response = await fetch("/api/app-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as { error?: string; current?: unknown; saved?: T };
    if (!response.ok || !("saved" in payload)) {
      const error = new Error(payload.error || "The change could not be saved.") as Error & { current?: unknown };
      error.current = payload.current;
      throw error;
    }
    return payload.saved as T;
  };
  const addAudit = (entityType: string, entityId: string, action: string, changedBy: string, changedAt: string) => {
    setAudit((current) => [{
      id: `${entityType}-${entityId}-${changedAt}`,
      entityType,
      entityId,
      action,
      changedBy,
      changedAt,
    }, ...current].slice(0, 20));
  };
  const changeSettings = (next: RuleSettings) => {
    const normalized = { ...next, policy: resolveRulePolicy(next) };
    setSettings(normalized);
    if (!collaborationReady) return;
    setSettingsSaveStatus("saving");
    if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current);
    settingsSaveTimer.current = setTimeout(() => {
      const expectedRevision = settingsRevisionRef.current;
      void saveState<{ value: RuleSettings; revision: number; updatedAt: string; updatedBy: string }>({
        type: "settings",
        value: normalized,
        expectedRevision,
      }).then((saved) => {
        setSettings(saved.value);
        settingsRevisionRef.current = saved.revision;
        setSettingsUpdatedAt(saved.updatedAt);
        setSettingsUpdatedBy(saved.updatedBy);
        setSettingsSaveStatus("saved");
        addAudit("settings", "organization", "updated", saved.updatedBy, saved.updatedAt);
      }).catch((error: Error & { current?: unknown }) => {
        const current = error.current as { value: RuleSettings; revision: number; updatedAt: string; updatedBy: string } | undefined;
        if (current?.value) {
          setSettings(current.value);
          settingsRevisionRef.current = current.revision;
          setSettingsUpdatedAt(current.updatedAt);
          setSettingsUpdatedBy(current.updatedBy);
          setSettingsSaveStatus("conflict");
        } else {
          setSettingsSaveStatus("error");
        }
      });
    }, 650);
  };
  const changeReview = (suggestionId: string, decision: "approved" | "rejected" | null) => {
    if (!collaborationReady) return;
    const previous = reviewsRef.current[suggestionId];
    const optimistic = { ...reviewsRef.current };
    if (decision == null) delete optimistic[suggestionId];
    else optimistic[suggestionId] = {
      decision,
      revision: previous?.revision ?? 0,
      updatedAt: new Date().toISOString(),
      updatedBy: currentUser?.email ?? "Saving…",
    };
    reviewsRef.current = optimistic;
    setReviews(optimistic);
    setReviewSaveStatus("saving");
    void saveState<ReviewRecord | null>({
      type: "review",
      snapshotId: currentSummary.id,
      suggestionId,
      decision,
      expectedRevision: previous?.revision ?? 0,
    }).then((saved) => {
      const next = { ...reviewsRef.current };
      if (saved) next[suggestionId] = saved;
      else delete next[suggestionId];
      reviewsRef.current = next;
      setReviews(next);
      setReviewSaveStatus("saved");
      addAudit("review", `${currentSummary.id}:${suggestionId}`, saved ? (previous ? "updated" : "created") : "cleared", saved?.updatedBy ?? currentUser?.email ?? "Authorized user", saved?.updatedAt ?? new Date().toISOString());
    }).catch((error: Error & { current?: unknown }) => {
      const next = { ...reviewsRef.current };
      if (error.current && typeof error.current === "object") next[suggestionId] = error.current as ReviewRecord;
      else if (previous) next[suggestionId] = previous;
      else delete next[suggestionId];
      reviewsRef.current = next;
      setReviews(next);
      setReviewSaveStatus(error.current !== undefined ? "conflict" : "error");
    });
  };
  const persistPreferences = (next: UserPreferences) => {
    const expectedRevision = preferencesRevisionRef.current;
    void saveState<{ value: UserPreferences; revision: number; updatedAt: string; updatedBy: string }>({
      type: "preferences",
      value: next,
      expectedRevision,
    }).then((saved) => {
      preferencesRef.current = saved.value;
      setPreferences(saved.value);
      preferencesRevisionRef.current = saved.revision;
      setPreferencesSaveStatus("saved");
    }).catch((error: Error & { current?: unknown }) => {
      const current = error.current as { value: UserPreferences; revision: number } | undefined;
      if (current?.value) {
        preferencesRef.current = current.value;
        setPreferences(current.value);
        preferencesRevisionRef.current = current.revision;
        setPreferencesSaveStatus("conflict");
      } else {
        setPreferencesSaveStatus("error");
      }
    });
  };
  const changePreferences = <K extends keyof UserPreferences>(key: K, value: NonNullable<UserPreferences[K]>) => {
    const next = { ...preferencesRef.current, [key]: value };
    preferencesRef.current = next;
    setPreferences(next);
    if (!preferencesReady || !collaborationReady) return;
    setPreferencesSaveStatus("saving");
    if (preferencesSaveTimer.current) clearTimeout(preferencesSaveTimer.current);
    preferencesSaveTimer.current = setTimeout(() => persistPreferences(next), 450);
  };
  const applyImportedSnapshot = (nextSnapshot: DashboardData, nextSummary: SnapshotHistorySummary, nextHistory: SnapshotHistorySummary[]) => {
    setCollaborationReady(false);
    setPreferencesReady(false);
    setSettingsSaveStatus("loading");
    setReviewSaveStatus("loading");
    setPreferencesSaveStatus("loading");
    reviewsRef.current = {};
    setReviews({});
    setAudit([]);
    setAdvertisingRange(null);
    setRuntimeData(nextSnapshot);
    setMarketplaceAvailable(true);
    setCurrentSummary(nextSummary);
    setHistory(nextHistory);
    setStorageStatus("ready");
  };
  const clientSideMarketplace = marketplaceSelection === "allegro_pl" || marketplaceSelection === "ebay_de";
  const emptyBaseId = marketplaceSelection === "amazon_de" || marketplaceSelection === "kaufland_de" ? marketplaceSelection : "amazon_de";
  const applyProductMaster = (products: CatalogProduct[], stats: ProductMasterStats) => {
    productMasterRef.current = products;
    setProductMasterStats(stats);
    saveStoredProductMaster(products, stats);
    setProductMasterVersion((version) => version + 1);
    // Allegro/eBay rebuild from their own reports (which re-run the join) via the version
    // dependency; Amazon/Kaufland use the catalog directly as their product list.
    if (clientSideMarketplace) return;
    setRuntimeData((current) => applyCatalogToData(current, products));
    setMarketplaceAvailable(true);
  };
  const clearProductMaster = () => {
    productMasterRef.current = null;
    setProductMasterStats(null);
    clearStoredProductMaster();
    setProductMasterVersion((version) => version + 1);
    if (clientSideMarketplace) return;
    setRuntimeData((current) => ({ ...current, catalogProducts: emptyMarketplaceData(emptyBaseId).catalogProducts, products: emptyMarketplaceData(emptyBaseId).products, quality: emptyMarketplaceData(emptyBaseId).quality }));
  };
  const applyAllegro = (snap: AllegroSnapshot, names: string[]) => {
    setAllegroSnapshot(snap);
    setAllegroFileNames(names);
    saveStoredAllegro(snap, allegroFx, names);
  };
  const clearAllegro = () => {
    setAllegroSnapshot(null);
    setAllegroFileNames([]);
    clearStoredAllegro();
  };
  const changeAllegroFx = (raw: string) => {
    const value = Number(raw);
    const next = Number.isFinite(value) && value >= 0 ? value : allegroFx;
    setAllegroFx(next);
    if (allegroSnapshot) saveStoredAllegro(allegroSnapshot, next, allegroFileNames);
  };
  const applyEbay = (snap: EbaySnapshot, names: string[]) => {
    setEbaySnapshot(snap);
    setEbayFileNames(names);
    saveStoredEbay(snap, names);
  };
  const clearEbay = () => {
    setEbaySnapshot(null);
    setEbayFileNames([]);
    clearStoredEbay();
  };
  const changeMarketplace = (selection: MarketplaceSelection) => {
    setMarketplaceSelection(selection);
    setAdvertisingRange(null);
    setPeriodError("");
    setPage("dashboard");
    if (preferencesReady) changePreferences("marketplaceId", selection);
  };
  const selectReportingPeriod = async (snapshotId: string) => {
    if (!snapshotId || periodLoading) return;
    if (snapshotId === currentSummary.id) {
      setAdvertisingRange(null);
      setPeriodError("");
      return;
    }
    setPeriodLoading(true);
    setPeriodError("");
    try {
      const response = await fetch(snapshotRequestPath(snapshotId, marketplaceSelection === "all" ? "amazon_de" : marketplaceSelection), { cache: "no-store" });
      const payload = await response.json() as {
        error?: string;
        snapshot?: DashboardData;
        summary?: SnapshotHistorySummary;
        history?: SnapshotHistorySummary[];
      };
      if (!response.ok || !payload.snapshot || !payload.summary || !payload.history) {
        throw new Error(payload.error || "The selected reporting period could not be loaded.");
      }
      applyImportedSnapshot(payload.snapshot, payload.summary, payload.history);
    } catch (error) {
      setPeriodError(error instanceof Error ? error.message : "The selected reporting period could not be loaded.");
    } finally {
      setPeriodLoading(false);
    }
  };
  const selectAdvertisingRange = async (range: ReportingDateRange) => {
    if (periodLoading) return;
    setPeriodLoading(true);
    setPeriodError("");
    try {
      const response = await fetch(advertisingRangeRequestPath(range, marketplaceSelection === "all" ? "amazon_de" : marketplaceSelection), { cache: "no-store" });
      const payload = await response.json() as { error?: string; advertisingRange?: MergedAdvertisingRange };
      if (!response.ok || !payload.advertisingRange) throw new Error(payload.error || "The advertising range could not be loaded.");
      if (payload.advertisingRange.coverage.availableDays === 0) {
        throw new Error(`No daily advertising data is retained for ${displayDate(range.start)} – ${displayDate(range.end)}.`);
      }
      setAdvertisingRange(payload.advertisingRange);
      setPage("dashboard");
    } catch (error) {
      setPeriodError(error instanceof Error ? error.message : "The advertising range could not be loaded.");
    } finally {
      setPeriodLoading(false);
    }
  };
  const exportAllData = () => {
    const workbook = createAllDataWorkbook(data as unknown as Record<string, unknown>);
    const blob = new Blob([workbook], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = allDataFilename(data.reporting.end);
    link.click();
    URL.revokeObjectURL(url);
  };
  const saveStatuses = [settingsSaveStatus, reviewSaveStatus, preferencesSaveStatus];
  const overallSaveStatus: SaveStatus = saveStatuses.includes("saving") ? "saving" : saveStatuses.includes("conflict") ? "conflict" : saveStatuses.includes("error") ? "error" : saveStatuses.includes("loading") ? "loading" : "saved";
  const userInitials = currentUser?.displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "BC";
  const sidebarPosition = preferences.layout?.sidebarPosition ?? "left";
  const moveSidebar = () => changePreferences("layout", { sidebarPosition: sidebarPosition === "left" ? "right" : "left" });
  marketplaceSelectionGlobal = marketplaceSelection;
  marketplaceAvailableGlobal = marketplaceAvailable;
  changeMarketplaceGlobal = changeMarketplace;
  openImportsGlobal = () => {
    if (marketplaceSelection === "all") setMarketplaceSelection("kaufland_de");
    setPage("imports");
  };
  return <div className={`app-shell sidebar-${sidebarPosition}`}><aside className="sidebar"><div className="brand"><span className="brand-mark">BC</span><div><b>Bid Control</b><small>Amazon DE</small></div></div><nav>{navItems.map((item) => <button key={item.key} className={page === item.key ? "active" : ""} onClick={() => setPage(item.key)}><span>{item.icon}</span>{item.label}{item.key === "suggestions" && <i>{buildSuggestions(data.targetPerformance, settings).filter((suggestion) => suggestion.type !== "hold").length}</i>}</button>)}</nav><div className="sidebar-footer"><div className="readonly-card"><span>◉</span><div><b>Recommendation only</b><small>No Amazon changes are made</small></div></div><button type="button" className="sidebar-position-button" onClick={moveSidebar} aria-label={`Move sidebar to the ${sidebarPosition === "left" ? "right" : "left"}`}><span>⇆</span> Move sidebar to {sidebarPosition === "left" ? "right" : "left"}</button><button onClick={() => setPage("knowledge")}><span>?</span> Help & glossary</button></div></aside><main className="main"><header className="topbar">{marketplaceSelection === "allegro_pl" ? <div className="topbar-marketplace-label"><span className="eyebrow">Allegro PL · złoty + euro</span><b>{currentSummary.periodStart ? `${displayDate(currentSummary.periodStart)} – ${displayDate(currentSummary.periodEnd)}` : "No Allegro period imported"}</b></div> : marketplaceSelection === "ebay_de" ? <div className="topbar-marketplace-label"><span className="eyebrow">eBay DE · EUR</span><b>{ebaySnapshot?.periodStart ? `${displayDate(ebaySnapshot.periodStart)} – ${displayDate(ebaySnapshot.periodEnd!)}` : "No eBay period imported"}</b></div> : <ReportingPeriodSelector history={history} currentSummary={currentSummary} advertisingRange={advertisingRange} loading={periodLoading} ready={storageStatus === "ready"} error={periodError} onSelect={(snapshotId) => void selectReportingPeriod(snapshotId)} onSelectAdvertisingRange={(range) => void selectAdvertisingRange(range)} onMissing={setPeriodError} onOpenImports={() => setPage("imports")} />}<div className="top-actions">{marketplaceSelection === "allegro_pl" && <label className="allegro-fx topbar-fx"><span>1 PLN =</span><input type="number" min="0" step="0.001" value={allegroFx} onChange={(event) => changeAllegroFx(event.target.value)} aria-label="PLN to EUR rate" /><b>EUR</b></label>}<a className="export-all-button" href="/exports/amazon-bidding-control-all-data.xlsx" download={`amazon-bidding-control-${data.reporting.end}.xlsx`} onClick={(event) => { event.preventDefault(); exportAllData(); }} title="Download the complete active normalized snapshot as a multi-sheet Excel workbook."><span aria-hidden="true">⇩</span><span>Export all data</span></a><SaveIndicator status={overallSaveStatus} label="All changes saved" detail={currentUser ? `Signed in as ${currentUser.email}. Rules and reviews are shared; view preferences are personal.` : "Loading signed-in user"} /><span className={`refresh-status storage-${storageStatus}`} title={storageStatus === "offline" ? "Using the embedded baseline because persistent storage could not be reached." : "Historical snapshots are stored persistently."}><i /> {storageStatus === "loading" ? "Loading history" : storageStatus === "ready" ? "History retained" : "Baseline data"}</span><button className="icon-button" aria-label="Notifications">●</button><span className="avatar" title={currentUser?.displayName}>{userInitials}</span></div></header><div className="content">{advertisingRange && page !== "dashboard" && marketplaceSelection !== "allegro_pl" && <div className="advertising-scope-reminder"><div><b>Flexible range applies to advertising dashboard KPIs only</b><span>{displayDate(advertisingRange.reporting.start)} – {displayDate(advertisingRange.reporting.end)} · This page still uses the complete {displayDate(currentSummary.periodStart)} – {displayDate(currentSummary.periodEnd)} snapshot.</span></div><button type="button" onClick={() => setPage("dashboard")}>Open advertising view →</button></div>}{page === "dashboard" && <Dashboard onNavigate={setPage} history={history} currentSummary={currentSummary} advertisingRange={advertisingRange} />}{page === "comparisons" && <KpiComparisons history={history} currentSummary={currentSummary} onNavigate={setPage} />}{page === "suggestions" && <Suggestions settings={settings} reviews={reviews} reviewSaveStatus={reviewSaveStatus} onDecision={changeReview} preferences={preferences.suggestions} onPreferencesChange={(value) => changePreferences("suggestions", value)} />}{page === "products" && <Products preferences={preferences.products} onPreferencesChange={(value) => changePreferences("products", value)} />}{page === "ranking" && <ProductRanking preferences={preferences.ranking} onPreferencesChange={(value) => changePreferences("ranking", value)} />}{page === "imports" && (marketplaceSelection === "allegro_pl" ? <AllegroImports snapshot={allegroSnapshot} marginCoverage={allegroMarginCoverage} productMasterLoaded={Boolean(productMasterRef.current?.length)} productMasterStats={productMasterStats} onProductMaster={applyProductMaster} onClearProductMaster={clearProductMaster} onImported={applyAllegro} onClear={clearAllegro} /> : marketplaceSelection === "ebay_de" ? <EbayImports snapshot={ebaySnapshot} marginCoverage={ebayMarginCoverage} productMasterLoaded={Boolean(productMasterRef.current?.length)} productMasterStats={productMasterStats} onProductMaster={applyProductMaster} onClearProductMaster={clearProductMaster} onImported={applyEbay} onClear={clearEbay} /> : <Imports history={history} currentSummary={currentSummary} onImported={applyImportedSnapshot} productMasterStats={productMasterStats} onProductMaster={applyProductMaster} onClearProductMaster={clearProductMaster} />)}{page === "rules" && <Rules settings={settings} onSettingsChange={changeSettings} saveStatus={settingsSaveStatus} updatedAt={settingsUpdatedAt} updatedBy={settingsUpdatedBy} />}{page === "knowledge" && <KnowledgeAssistant settings={settings} />}{page === "history" && <History history={history} currentSummary={currentSummary} audit={audit} />}</div></main></div>;
}
