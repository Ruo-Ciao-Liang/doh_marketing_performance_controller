import { buildSuggestions, type RuleSettings, type Suggestion, type TargetPerformance } from "./rules-engine.ts";

export type AssistantAnswerStatus = "answered" | "interpreted" | "unavailable";
export type AssistantEntityType = "product" | "campaign" | "target" | "suggestion";

export interface AssistantEntityRef {
  type: AssistantEntityType;
  id: string;
  label: string;
}

export interface AssistantMetric {
  label: string;
  value: string;
}

export interface AssistantResultItem {
  rank?: number;
  title: string;
  subtitle?: string;
  metrics: AssistantMetric[];
}

export interface AssistantAnswer {
  headline: string;
  text: string;
  status: AssistantAnswerStatus;
  sources: string[];
  facts?: AssistantMetric[];
  items?: AssistantResultItem[];
  entities?: AssistantEntityRef[];
  followUps?: string[];
}

export interface AssistantTopic {
  title: string;
  summary: string;
  formula?: string;
  sources: string[];
  aliases: string[];
}

interface AssistantProduct {
  sku: string;
  asin: string;
  name: string;
  price: number | null;
  margin: number | null;
  category: string | null;
  advertisingStatus: string;
  retail: {
    sessions: number;
    pageViews: number;
    units: number;
    sales: number;
    conversion: number | null;
    buyBox: number | null;
  } | null;
  advertising: {
    impressions: number;
    clicks: number;
    spend: number;
    purchases: number;
    sales: number;
    acos: number | null;
    roas: number | null;
  } | null;
}

interface AssistantCampaign {
  name: string;
  state?: string;
  type?: string;
  targeting?: string;
  strategy?: string;
  budget?: number | null;
  topOfSearchShare?: number | null;
  topOfSearchAdjustment?: number | null;
  spend: number;
  sales: number;
  acos?: number | null;
  roas?: number | null;
}

interface AssistantImport {
  key: string;
  file: string;
  path: string;
  report: string;
  role: string;
  rows: number;
  status: string;
}

interface AssistantDaily {
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  purchases: number;
  sales: number;
  acos: number | null;
}

interface AssistantPlacement {
  name: string;
  impressions: number;
  clicks: number;
  spend: number;
  purchases: number;
  sales: number;
  acos: number | null;
  roas: number | null;
}

export interface AssistantSnapshot {
  reporting: { start: string; end: string; days: number; currency: string; marketplace: string };
  totals: {
    advertising: {
      impressions: number;
      clicks: number;
      spend: number;
      purchases: number;
      sales: number;
      units: number;
      ctr: number;
      cvr: number;
      acos: number;
      roas: number;
      cpc: number;
      cpa: number;
      aov: number;
    };
    retail: { sales: number; sessions: number; units: number; conversion: number };
    profitability: {
      tcos: number;
      netContribution: number;
      netContributionMargin: number;
      coveredGrossSales: number;
      coveredNetSales: number;
      retailSalesCoverage: number;
      purchaseCost: number;
      deliveryCost: number;
      provisionCost: number;
      advertisingCost: number;
      totalCost: number;
    };
  };
  daily: AssistantDaily[];
  placements: AssistantPlacement[];
  campaigns: AssistantCampaign[];
  products: AssistantProduct[];
  targetPerformance: TargetPerformance[];
  imports: AssistantImport[];
  quality: Record<string, number | string>;
}

export interface AssistantContext {
  data: AssistantSnapshot;
  settings: RuleSettings;
  topics: AssistantTopic[];
  previousEntities?: AssistantEntityRef[];
}

type RankingMetric =
  | "retailRevenue"
  | "units"
  | "grossMargin"
  | "grossContribution"
  | "adSpend"
  | "adSales"
  | "acos"
  | "roas"
  | "clicks"
  | "impressions"
  | "purchases"
  | "sessions"
  | "conversion";

const money0 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const number2 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const euro = (value: number | null | undefined, cents = false) => value == null ? "Unavailable" : (cents ? money2 : money0).format(value);
const percent = (value: number | null | undefined, digits = 1) => value == null ? "Unavailable" : `${(value * 100).toFixed(digits)}%`;
const ratio = (value: number | null | undefined) => value == null ? "Unavailable" : `${number2.format(value)}x`;
const dateLabel = (value: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00Z`));
const unique = <T,>(values: T[]) => [...new Set(values)];

const stopWords = new Set([
  "a", "about", "all", "an", "and", "are", "as", "at", "be", "by", "can", "could", "data", "did", "do", "does",
  "for", "from", "give", "has", "have", "how", "i", "in", "is", "it", "list", "me", "my", "of", "on", "or", "our",
  "please", "product", "products", "show", "tell", "than", "that", "the", "their", "them", "there", "these", "this",
  "to", "what", "when", "where", "which", "who", "why", "with", "would", "you",
]);

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalize(value).split(/\s+/).filter((token) => token.length >= 2 && !stopWords.has(token));
}

function sourcePath(data: AssistantSnapshot, key: string): string {
  return data.imports.find((item) => item.key === key)?.path ?? "Source path unavailable";
}

function textScore(questionTokens: string[], value: string): number {
  const haystack = new Set(tokens(value));
  return questionTokens.reduce((score, token) => score + (haystack.has(token) ? Math.max(2, token.length) : 0), 0);
}

function requestedLimit(question: string, fallback = 5): number {
  const match = normalize(question).match(/\b(?:top|bottom|first|last|best|worst)\s+(\d{1,2})\b/);
  return Math.min(20, Math.max(1, match ? Number(match[1]) : fallback));
}

function rankingDirection(question: string): "desc" | "asc" {
  const q = normalize(question);
  return /\b(bottom|lowest|worst|least|smallest|decrease|ascending)\b/.test(q) ? "asc" : "desc";
}

function requestedMetric(question: string): RankingMetric {
  const q = normalize(question);
  if (q.includes("gross contribution") || q.includes("contribution amount") || q.includes("margin amount")) return "grossContribution";
  if (q.includes("gross margin") || q.includes("contribution margin") || /\bmargin\b/.test(q)) return "grossMargin";
  if (q.includes("ad spend") || q.includes("advertising spend") || q.includes("advertising cost") || /\bspend\b/.test(q)) return "adSpend";
  if (q.includes("ad sales") || q.includes("advertising sales") || q.includes("attributed sales")) return "adSales";
  if (q.includes("acos")) return "acos";
  if (q.includes("roas")) return "roas";
  if (q.includes("conversion") || q.includes("cvr")) return "conversion";
  if (q.includes("impression")) return "impressions";
  if (q.includes("click")) return "clicks";
  if (q.includes("purchase") || q.includes("order")) return "purchases";
  if (q.includes("session")) return "sessions";
  if (q.includes("unit") || q.includes("sold")) return "units";
  return "retailRevenue";
}

const metricLabels: Record<RankingMetric, string> = {
  retailRevenue: "reported revenue",
  units: "sold units",
  grossMargin: "gross contribution margin",
  grossContribution: "gross contribution",
  adSpend: "advertising spend",
  adSales: "advertising sales",
  acos: "ACoS",
  roas: "ROAS",
  clicks: "clicks",
  impressions: "impressions",
  purchases: "purchases",
  sessions: "sessions",
  conversion: "conversion",
};

function productMetric(product: AssistantProduct, metric: RankingMetric): number | null {
  switch (metric) {
    case "retailRevenue": return product.retail?.sales ?? null;
    case "units": return product.retail?.units ?? null;
    case "grossMargin": return product.margin;
    case "grossContribution": return product.retail && product.margin != null ? product.retail.sales * product.margin : null;
    case "adSpend": return product.advertising?.spend ?? null;
    case "adSales": return product.advertising?.sales ?? null;
    case "acos": return product.advertising?.acos ?? null;
    case "roas": return product.advertising?.roas ?? null;
    case "clicks": return product.advertising?.clicks ?? null;
    case "impressions": return product.advertising?.impressions ?? null;
    case "purchases": return product.advertising?.purchases ?? null;
    case "sessions": return product.retail?.sessions ?? null;
    case "conversion": return product.retail?.conversion ?? null;
  }
}

function targetMetric(target: TargetPerformance, metric: RankingMetric): number | null {
  switch (metric) {
    case "retailRevenue":
    case "adSales": return target.sales;
    case "units": return target.units;
    case "grossMargin": return target.margin;
    case "grossContribution": return target.margin == null ? null : target.sales * target.margin;
    case "adSpend": return target.spend;
    case "acos": return target.acos;
    case "roas": return target.roas;
    case "clicks": return target.clicks;
    case "impressions": return target.impressions;
    case "purchases": return target.purchases;
    case "sessions": return null;
    case "conversion": return target.cvr;
  }
}

function campaignMetric(campaign: AssistantCampaign, metric: RankingMetric): number | null {
  switch (metric) {
    case "retailRevenue":
    case "adSales": return campaign.sales;
    case "adSpend": return campaign.spend;
    case "acos": return campaign.acos ?? (campaign.sales ? campaign.spend / campaign.sales : null);
    case "roas": return campaign.roas ?? (campaign.spend ? campaign.sales / campaign.spend : null);
    default: return null;
  }
}

function formatMetric(metric: RankingMetric, value: number | null): string {
  if (value == null) return "Unavailable";
  if (["retailRevenue", "grossContribution", "adSpend", "adSales"].includes(metric)) return euro(value);
  if (["grossMargin", "acos", "conversion"].includes(metric)) return percent(value);
  if (metric === "roas") return ratio(value);
  return whole.format(value);
}

function productSources(data: AssistantSnapshot): string[] {
  return [sourcePath(data, "product_master"), sourcePath(data, "business_report"), sourcePath(data, "advertised_product"), sourcePath(data, "economics")];
}

function findProducts(question: string, products: AssistantProduct[]): AssistantProduct[] {
  const q = normalize(question);
  const exact = products.filter((product) =>
    (product.sku && q.includes(normalize(product.sku))) ||
    (product.asin && q.includes(normalize(product.asin))),
  );
  if (exact.length) return exact;
  const queryTokens = tokens(question);
  if (!queryTokens.length) return [];
  return products
    .map((product) => ({ product, score: textScore(queryTokens, `${product.name} ${product.sku} ${product.asin}`) }))
    .filter((item) => item.score >= 8)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((item) => item.product);
}

function findCampaigns(question: string, campaigns: AssistantCampaign[]): AssistantCampaign[] {
  const q = normalize(question);
  const exact = campaigns.filter((campaign) => q.includes(normalize(campaign.name)));
  if (exact.length) return exact;
  const queryTokens = tokens(question).filter((token) => !["campaign", "campaigns"].includes(token));
  if (queryTokens.length < 2) return [];
  return campaigns
    .map((campaign) => ({ campaign, score: textScore(queryTokens, campaign.name) }))
    .filter((item) => item.score >= 10)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((item) => item.campaign);
}

function findTargets(question: string, targets: TargetPerformance[]): TargetPerformance[] {
  const q = normalize(question);
  const byId = targets.filter((target) => target.id && q.includes(normalize(target.id)));
  if (byId.length) return byId;
  const quoted = question.match(/["“](.+?)["”]/)?.[1];
  if (quoted) {
    const quotedNormalized = normalize(quoted);
    const matches = targets.filter((target) => normalize(target.target) === quotedNormalized);
    if (matches.length) return matches;
  }
  return [];
}

function resolvePreviousEntity(question: string, previous: AssistantEntityRef[] | undefined): AssistantEntityRef | null {
  if (!previous?.length) return null;
  const q = normalize(question);
  const ordinal = q.match(/\b(first|second|third|fourth|fifth|\d+)\b/)?.[1];
  const positions: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 };
  if (ordinal) {
    const index = positions[ordinal] ?? Math.max(0, Number(ordinal) - 1);
    return previous[index] ?? null;
  }
  if (/\b(it|this|that|one|same|its)\b/.test(q) || q.startsWith("what about")) return previous[0];
  return null;
}

function productDetail(product: AssistantProduct, data: AssistantSnapshot): AssistantAnswer {
  const coveredProducts = data.products.filter((item) => item.retail);
  const revenueRank = [...coveredProducts].sort((a, b) => (b.retail?.sales ?? 0) - (a.retail?.sales ?? 0)).findIndex((item) => item.sku === product.sku) + 1;
  const unitsRank = [...coveredProducts].sort((a, b) => (b.retail?.units ?? 0) - (a.retail?.units ?? 0)).findIndex((item) => item.sku === product.sku) + 1;
  const grossContribution = product.retail && product.margin != null ? product.retail.sales * product.margin : null;
  const retailSummary = product.retail
    ? `${euro(product.retail.sales)} reported revenue from ${whole.format(product.retail.units)} units and ${whole.format(product.retail.sessions)} sessions.`
    : "This product is absent from the Business Report, so retail revenue, units and sessions are unavailable rather than zero.";
  const advertisingSummary = product.advertising
    ? ` Advertising evidence shows ${euro(product.advertising.spend)} spend, ${euro(product.advertising.sales)} attributed sales and ${percent(product.advertising.acos)} ACoS.`
    : " No matching activity appears in the Advertised Product export.";
  return {
    headline: product.name,
    text: `${retailSummary}${advertisingSummary}`,
    status: "answered",
    sources: productSources(data),
    facts: [
      { label: "SKU / ASIN", value: `${product.sku} / ${product.asin}` },
      { label: "Category", value: product.category ?? "Unavailable" },
      { label: "Gross margin", value: percent(product.margin) },
      { label: "Gross contribution", value: euro(grossContribution) },
      { label: "Revenue rank", value: product.retail ? `#${revenueRank} of ${coveredProducts.length}` : "Unranked" },
      { label: "Units rank", value: product.retail ? `#${unitsRank} of ${coveredProducts.length}` : "Unranked" },
    ],
    entities: [{ type: "product", id: product.sku, label: product.name }],
    followUps: [
      `Why does ${product.sku} have its current bid recommendations?`,
      `Show targets for ${product.sku}`,
      `Compare ${product.sku} with another SKU`,
    ],
  };
}

function productComparison(products: AssistantProduct[], data: AssistantSnapshot): AssistantAnswer {
  const selected = products.slice(0, 5);
  return {
    headline: `Product comparison (${selected.length})`,
    text: "The comparison uses reported retail values where available and product-level advertising evidence. Missing retail rows remain unavailable rather than zero.",
    status: "answered",
    sources: productSources(data),
    items: selected.map((product) => ({
      title: product.name,
      subtitle: `${product.sku} · ${product.asin} · ${product.category ?? "No category"}`,
      metrics: [
        { label: "Revenue", value: euro(product.retail?.sales) },
        { label: "Units", value: product.retail ? whole.format(product.retail.units) : "Unavailable" },
        { label: "Gross margin", value: percent(product.margin) },
        { label: "Gross contribution", value: euro(product.retail && product.margin != null ? product.retail.sales * product.margin : null) },
        { label: "Ad spend", value: euro(product.advertising?.spend) },
        { label: "Ad sales", value: euro(product.advertising?.sales) },
      ],
    })),
    entities: selected.map((product) => ({ type: "product", id: product.sku, label: product.name })),
    followUps: selected.map((product) => `Tell me everything about ${product.sku}`).slice(0, 3),
  };
}

function campaignDetail(campaign: AssistantCampaign, data: AssistantSnapshot, suggestions: Suggestion[]): AssistantAnswer {
  const targets = data.targetPerformance.filter((target) => target.campaignName === campaign.name);
  const campaignSuggestions = suggestions.filter((suggestion) => suggestion.campaignName === campaign.name);
  const products = unique(targets.map((target) => target.sku).filter((value): value is string => Boolean(value)));
  return {
    headline: campaign.name,
    text: `This ${campaign.state?.toLowerCase() ?? "reported"} ${campaign.type ?? ""} campaign contains ${whole.format(targets.length)} targets linked to ${whole.format(products.length)} products. It has ${whole.format(campaignSuggestions.filter((item) => item.type !== "hold").length)} actionable recommendations under the current settings.`,
    status: "answered",
    sources: [sourcePath(data, "campaign"), sourcePath(data, "targeting"), sourcePath(data, "advertised_product")],
    facts: [
      { label: "Spend", value: euro(campaign.spend) },
      { label: "Ad sales", value: euro(campaign.sales) },
      { label: "ACoS", value: percent(campaign.acos) },
      { label: "ROAS", value: ratio(campaign.roas) },
      { label: "Daily budget", value: euro(campaign.budget, true) },
      { label: "Targeting", value: campaign.targeting ?? "Unavailable" },
    ],
    items: campaignSuggestions.filter((item) => item.type !== "hold").slice(0, 6).map((suggestion) => suggestionItem(suggestion)),
    entities: [{ type: "campaign", id: campaign.name, label: campaign.name }],
    followUps: [
      `Show the recommendations in ${campaign.name}`,
      `Which targets spend the most in ${campaign.name}?`,
      `Which products are advertised in ${campaign.name}?`,
    ],
  };
}

function targetDetail(target: TargetPerformance, data: AssistantSnapshot, suggestion: Suggestion | undefined): AssistantAnswer {
  return {
    headline: target.target || "Unnamed target",
    text: `${target.matchType} target in ${target.campaignName} / ${target.adGroupName}. ${suggestion ? `The current rule decision is ${suggestion.type.replaceAll("_", " ")}: ${suggestion.reason}` : "No rule decision was found."}`,
    status: "answered",
    sources: [sourcePath(data, "targeting"), sourcePath(data, "economics")],
    facts: [
      { label: "Product", value: target.sku ? `${target.productName} (${target.sku})` : "Product match unavailable" },
      { label: "Current bid", value: euro(target.bid, true) },
      { label: "Suggested bid", value: euro(suggestion?.suggestedBid, true) },
      { label: "Spend", value: euro(target.spend) },
      { label: "Ad sales", value: euro(target.sales) },
      { label: "Purchases", value: whole.format(target.purchases) },
      { label: "ACoS / target", value: `${percent(target.acos)} / ${percent(suggestion?.targetAcos)}` },
    ],
    entities: [{ type: "target", id: target.id, label: target.target }],
    followUps: [
      `Why is the recommendation for target ${target.id}?`,
      `Show other targets for ${target.sku ?? target.campaignName}`,
    ],
  };
}

function suggestionItem(suggestion: Suggestion): AssistantResultItem {
  const target = suggestion.harvestTerm ?? suggestion.target;
  return {
    title: `${suggestion.type === "harvest" ? "Harvest" : suggestion.type.replaceAll("_", " ")}: ${target}`,
    subtitle: `${suggestion.productName} · ${suggestion.sku ?? "SKU unavailable"} · ${suggestion.campaignName}`,
    metrics: [
      { label: "Bid", value: `${euro(suggestion.currentBid, true)} → ${euro(suggestion.suggestedBid, true)}` },
      { label: "Spend", value: euro(suggestion.spend) },
      { label: "Sales", value: euro(suggestion.sales) },
      { label: "ACoS", value: percent(suggestion.acos) },
    ],
  };
}

function answerProductRanking(question: string, data: AssistantSnapshot): AssistantAnswer {
  const metric = requestedMetric(question);
  const direction = rankingDirection(question);
  const limit = requestedLimit(question);
  const category = unique(data.products.map((product) => product.category).filter((value): value is string => Boolean(value)))
    .find((value) => normalize(question).includes(normalize(value)));
  const candidates = data.products.filter((product) => !category || product.category === category);
  const ranked = candidates
    .map((product) => ({ product, value: productMetric(product, metric) }))
    .filter((item): item is { product: AssistantProduct; value: number } => item.value != null)
    .sort((left, right) => direction === "desc" ? right.value - left.value : left.value - right.value)
    .slice(0, limit);
  const qualifier = category ? ` in ${category}` : "";
  return {
    headline: `${direction === "desc" ? "Top" : "Lowest"} products by ${metricLabels[metric]}`,
    text: `Ranked ${ranked.length} products${qualifier} using the current ${dateLabel(data.reporting.start)}–${dateLabel(data.reporting.end)} snapshot. Products without the requested metric are excluded, not treated as zero.`,
    status: "answered",
    sources: productSources(data),
    items: ranked.map(({ product, value }, index) => ({
      rank: index + 1,
      title: product.name,
      subtitle: `${product.sku} · ${product.asin} · ${product.category ?? "No category"}`,
      metrics: [
        { label: metricLabels[metric], value: formatMetric(metric, value) },
        { label: "Revenue", value: euro(product.retail?.sales) },
        { label: "Units", value: product.retail ? whole.format(product.retail.units) : "Unavailable" },
        { label: "Gross margin", value: percent(product.margin) },
      ],
    })),
    entities: ranked.map(({ product }) => ({ type: "product", id: product.sku, label: product.name })),
    followUps: ranked.slice(0, 2).map(({ product }) => `Tell me everything about ${product.sku}`),
  };
}

function answerCampaignRanking(question: string, data: AssistantSnapshot): AssistantAnswer {
  const metric = requestedMetric(question);
  const usableMetric: RankingMetric = ["retailRevenue", "adSales", "adSpend", "acos", "roas"].includes(metric) ? metric : "adSpend";
  const direction = rankingDirection(question);
  const limit = requestedLimit(question);
  const ranked = data.campaigns
    .map((campaign) => ({ campaign, value: campaignMetric(campaign, usableMetric) }))
    .filter((item): item is { campaign: AssistantCampaign; value: number } => item.value != null)
    .sort((left, right) => direction === "desc" ? right.value - left.value : left.value - right.value)
    .slice(0, limit);
  return {
    headline: `${direction === "desc" ? "Top" : "Lowest"} campaigns by ${metricLabels[usableMetric]}`,
    text: `Ranked ${ranked.length} campaigns from the Campaign export. Sales are advertising-attributed sales; campaign rows do not contain total retail revenue.`,
    status: "answered",
    sources: [sourcePath(data, "campaign")],
    items: ranked.map(({ campaign, value }, index) => ({
      rank: index + 1,
      title: campaign.name,
      subtitle: `${campaign.state ?? "State unavailable"} · ${campaign.type ?? "Type unavailable"} · ${campaign.targeting ?? "Targeting unavailable"}`,
      metrics: [
        { label: metricLabels[usableMetric], value: formatMetric(usableMetric, value) },
        { label: "Spend", value: euro(campaign.spend) },
        { label: "Ad sales", value: euro(campaign.sales) },
        { label: "ACoS", value: percent(campaign.acos) },
      ],
    })),
    entities: ranked.map(({ campaign }) => ({ type: "campaign", id: campaign.name, label: campaign.name })),
    followUps: ranked.slice(0, 2).map(({ campaign }) => `Explain campaign ${campaign.name}`),
  };
}

function answerTargetRanking(question: string, data: AssistantSnapshot): AssistantAnswer {
  const metric = requestedMetric(question);
  const usableMetric = metric === "retailRevenue" ? "adSales" : metric;
  const direction = rankingDirection(question);
  const limit = requestedLimit(question);
  const products = findProducts(question, data.products);
  const campaigns = findCampaigns(question, data.campaigns);
  const ranked = data.targetPerformance
    .filter((target) => !products.length || products.some((product) => product.sku === target.sku))
    .filter((target) => !campaigns.length || campaigns.some((campaign) => campaign.name === target.campaignName))
    .map((target) => ({ target, value: targetMetric(target, usableMetric) }))
    .filter((item): item is { target: TargetPerformance; value: number } => item.value != null)
    .sort((left, right) => direction === "desc" ? right.value - left.value : left.value - right.value)
    .slice(0, limit);
  return {
    headline: `${direction === "desc" ? "Top" : "Lowest"} targets by ${metricLabels[usableMetric]}`,
    text: `Ranked ${ranked.length} targets after applying any product or campaign named in the question.`,
    status: "answered",
    sources: [sourcePath(data, "targeting"), sourcePath(data, "economics")],
    items: ranked.map(({ target, value }, index) => ({
      rank: index + 1,
      title: target.target,
      subtitle: `${target.matchType} · ${target.sku ?? "No product match"} · ${target.campaignName}`,
      metrics: [
        { label: metricLabels[usableMetric], value: formatMetric(usableMetric, value) },
        { label: "Bid", value: euro(target.bid, true) },
        { label: "Spend", value: euro(target.spend) },
        { label: "ACoS", value: percent(target.acos) },
      ],
    })),
    entities: ranked.map(({ target }) => ({ type: "target", id: target.id, label: target.target })),
    followUps: ranked.slice(0, 2).map(({ target }) => `Explain target ${target.id}`),
  };
}

function recommendationTypes(question: string): Set<Suggestion["type"]> {
  const q = normalize(question);
  const types = new Set<Suggestion["type"]>();
  if (q.includes("increase") || q.includes("growth")) types.add("increase");
  if (q.includes("reduce") || q.includes("reduction") || q.includes("decrease")) types.add("reduce");
  if (q.includes("pause")) types.add("pause_review");
  if (q.includes("manual")) types.add("manual_review");
  if (q.includes("hold")) types.add("hold");
  if (q.includes("conflict")) types.add("harvest_review");
  if (q.includes("harvest")) {
    types.add("harvest");
    if (!q.includes("clean")) types.add("harvest_review");
  }
  return types;
}

function answerRecommendations(question: string, context: AssistantContext, suggestions: Suggestion[]): AssistantAnswer {
  const q = normalize(question);
  const requestedTypes = recommendationTypes(question);
  const products = findProducts(question, context.data.products);
  const campaigns = findCampaigns(question, context.data.campaigns);
  const confidence = (["high", "medium", "low"] as const).find((value) => q.includes(`${value} confidence`));
  const filtered = suggestions
    .filter((suggestion) => requestedTypes.size ? requestedTypes.has(suggestion.type) : suggestion.type !== "hold")
    .filter((suggestion) => !products.length || products.some((product) => product.sku === suggestion.sku))
    .filter((suggestion) => !campaigns.length || campaigns.some((campaign) => campaign.name === suggestion.campaignName))
    .filter((suggestion) => !confidence || suggestion.confidence === confidence)
    .sort((left, right) => right.priority - left.priority);
  const limit = requestedLimit(question, 8);
  const shown = filtered.slice(0, limit);
  const counts = [...new Set(filtered.map((item) => item.type))].map((type) => ({
    label: type.replaceAll("_", " "),
    value: whole.format(filtered.filter((item) => item.type === type).length),
  }));
  if (q.includes("product") && /\b(which|most|count|many|group)\b/.test(q)) {
    const grouped = [...filtered.reduce((groups, suggestion) => {
      const key = suggestion.sku ?? `unmatched:${suggestion.productName}`;
      const current = groups.get(key) ?? { productName: suggestion.productName, sku: suggestion.sku, count: 0, spend: 0, sales: 0, actions: new Set<string>() };
      current.count += 1;
      current.spend += suggestion.spend;
      current.sales += suggestion.sales;
      current.actions.add(suggestion.type.replaceAll("_", " "));
      groups.set(key, current);
      return groups;
    }, new Map<string, { productName: string; sku: string | null; count: number; spend: number; sales: number; actions: Set<string> }>()).values()]
      .sort((left, right) => right.count - left.count || right.spend - left.spend)
      .slice(0, limit);
    return {
      headline: "Products with matching recommendations",
      text: `${whole.format(filtered.length)} matching decisions affect ${whole.format(grouped.length)} products shown below, ordered by recommendation count and then advertising spend.`,
      status: "answered",
      sources: [sourcePath(context.data, "targeting"), sourcePath(context.data, "economics")],
      facts: counts,
      items: grouped.map((group, index) => ({
        rank: index + 1,
        title: group.productName,
        subtitle: group.sku ?? "SKU unavailable",
        metrics: [
          { label: "Recommendations", value: whole.format(group.count) },
          { label: "Actions", value: [...group.actions].join(", ") },
          { label: "Ad spend", value: euro(group.spend) },
          { label: "Ad sales", value: euro(group.sales) },
        ],
      })),
      entities: grouped.filter((group) => group.sku).map((group) => ({ type: "product", id: group.sku!, label: group.productName })),
      followUps: grouped.filter((group) => group.sku).slice(0, 3).map((group) => `Show recommendations for ${group.sku}`),
    };
  }
  return {
    headline: requestedTypes.size ? `${[...requestedTypes].map((type) => type.replaceAll("_", " ")).join(" / ")} recommendations` : "Actionable recommendations",
    text: `Found ${whole.format(filtered.length)} matching decisions under the current rule settings. ${shown.length < filtered.length ? `The first ${shown.length} are shown by priority.` : "All matching decisions are shown."}`,
    status: "answered",
    sources: [sourcePath(context.data, "targeting"), sourcePath(context.data, "economics")],
    facts: counts,
    items: shown.map(suggestionItem),
    entities: shown.map((suggestion) => ({ type: "suggestion", id: suggestion.id, label: suggestion.harvestTerm ?? suggestion.target })),
    followUps: [
      "Show only high-confidence recommendations",
      "Which products have the most bid reductions?",
      "Show clean harvests and their suggested bids",
    ],
  };
}

function answerMissingCoverage(question: string, data: AssistantSnapshot): AssistantAnswer {
  const missing = data.products
    .filter((product) => !product.retail)
    .sort((left, right) => (right.advertising?.spend ?? 0) - (left.advertising?.spend ?? 0));
  const withAdvertising = missing.filter((product) => (product.advertising?.impressions ?? 0) > 0);
  const limit = requestedLimit(question, 10);
  return {
    headline: "Products absent from the Business Report",
    text: `${whole.format(missing.length)} of ${whole.format(data.products.length)} active products are absent from the supplied Business Report. Their retail metrics are unavailable, not zero. ${whole.format(withAdvertising.length)} of those products still have observed advertising impressions.`,
    status: "answered",
    sources: [sourcePath(data, "product_master"), sourcePath(data, "business_report"), sourcePath(data, "advertised_product")],
    facts: [
      { label: "Retail-covered", value: whole.format(data.products.length - missing.length) },
      { label: "Absent", value: whole.format(missing.length) },
      { label: "Absent with ad activity", value: whole.format(withAdvertising.length) },
    ],
    items: missing.slice(0, limit).map((product, index) => ({
      rank: index + 1,
      title: product.name,
      subtitle: `${product.sku} · ${product.asin} · ${product.category ?? "No category"}`,
      metrics: [
        { label: "Ad spend", value: euro(product.advertising?.spend) },
        { label: "Ad sales", value: euro(product.advertising?.sales) },
        { label: "Ad purchases", value: product.advertising ? whole.format(product.advertising.purchases) : "Unavailable" },
      ],
    })),
    entities: missing.slice(0, limit).map((product) => ({ type: "product", id: product.sku, label: product.name })),
    followUps: ["Which absent products have the highest ad spend?", "Why is retail coverage incomplete?"],
  };
}

function answerPlacements(question: string, data: AssistantSnapshot): AssistantAnswer {
  const direction = rankingDirection(question);
  const metric = requestedMetric(question);
  const usableMetric: RankingMetric = ["adSpend", "adSales", "acos", "roas", "clicks", "impressions", "purchases"].includes(metric) ? metric : "adSpend";
  const ranked = data.placements
    .map((placement) => {
      const value = usableMetric === "adSpend" ? placement.spend
        : usableMetric === "adSales" ? placement.sales
          : usableMetric === "acos" ? placement.acos
            : usableMetric === "roas" ? placement.roas
              : usableMetric === "clicks" ? placement.clicks
                : usableMetric === "impressions" ? placement.impressions
                  : placement.purchases;
      return { placement, value };
    })
    .filter((item): item is { placement: AssistantPlacement; value: number } => item.value != null)
    .sort((left, right) => direction === "desc" ? right.value - left.value : left.value - right.value);
  return {
    headline: `Placement performance by ${metricLabels[usableMetric]}`,
    text: "Placement data explains where advertising activity occurred. It does not include total retail sales.",
    status: "answered",
    sources: [sourcePath(data, "placement")],
    items: ranked.map(({ placement, value }, index) => ({
      rank: index + 1,
      title: placement.name,
      metrics: [
        { label: metricLabels[usableMetric], value: formatMetric(usableMetric, value) },
        { label: "Spend", value: euro(placement.spend) },
        { label: "Ad sales", value: euro(placement.sales) },
        { label: "Purchases", value: whole.format(placement.purchases) },
      ],
    })),
  };
}

function answerDaily(question: string, data: AssistantSnapshot): AssistantAnswer {
  const metric = requestedMetric(question);
  const usableMetric: RankingMetric = ["adSpend", "adSales", "acos", "clicks", "impressions", "purchases"].includes(metric) ? metric : "adSales";
  const direction = rankingDirection(question);
  const limit = requestedLimit(question, 5);
  const ranked = data.daily
    .map((day) => {
      const value = usableMetric === "adSpend" ? day.spend
        : usableMetric === "adSales" ? day.sales
          : usableMetric === "acos" ? day.acos
            : usableMetric === "clicks" ? day.clicks
              : usableMetric === "impressions" ? day.impressions
                : day.purchases;
      return { day, value };
    })
    .filter((item): item is { day: AssistantDaily; value: number } => item.value != null)
    .sort((left, right) => direction === "desc" ? right.value - left.value : left.value - right.value)
    .slice(0, limit);
  return {
    headline: `${direction === "desc" ? "Highest" : "Lowest"} days by ${metricLabels[usableMetric]}`,
    text: `Daily evidence covers ${dateLabel(data.reporting.start)}–${dateLabel(data.reporting.end)}.`,
    status: "answered",
    sources: [sourcePath(data, "advertised_product")],
    items: ranked.map(({ day, value }, index) => ({
      rank: index + 1,
      title: dateLabel(day.date),
      metrics: [
        { label: metricLabels[usableMetric], value: formatMetric(usableMetric, value) },
        { label: "Spend", value: euro(day.spend) },
        { label: "Ad sales", value: euro(day.sales) },
        { label: "Purchases", value: whole.format(day.purchases) },
      ],
    })),
  };
}

function answerOverview(data: AssistantSnapshot): AssistantAnswer {
  const ad = data.totals.advertising;
  const retail = data.totals.retail;
  const profit = data.totals.profitability;
  return {
    headline: "Current 30-day snapshot",
    text: `${dateLabel(data.reporting.start)}–${dateLabel(data.reporting.end)} for ${data.reporting.marketplace}. Retail sales are partial because the Business Report covers ${whole.format(Number(data.quality.retailCoverageProducts))} of ${whole.format(Number(data.quality.activeProducts))} active products.`,
    status: "answered",
    sources: [sourcePath(data, "advertised_product"), sourcePath(data, "business_report"), sourcePath(data, "economics")],
    facts: [
      { label: "Retail sales", value: euro(retail.sales) },
      { label: "Sold units", value: whole.format(retail.units) },
      { label: "Ad spend", value: euro(ad.spend) },
      { label: "Ad sales", value: euro(ad.sales) },
      { label: "ACoS", value: percent(ad.acos) },
      { label: "TCOS", value: percent(profit.tcos) },
      { label: "Net contribution", value: euro(profit.netContribution) },
      { label: "Net margin", value: percent(profit.netContributionMargin) },
    ],
    followUps: ["Show the top 5 products by revenue", "Which campaigns spend the most?", "Show actionable recommendations"],
  };
}

function answerProfitability(data: AssistantSnapshot): AssistantAnswer {
  const profit = data.totals.profitability;
  return {
    headline: "Profitability and total cost",
    text: `Net contribution is covered net sales minus purchase, delivery, provision and all advertising costs. It is ${euro(profit.netContribution)}, equal to ${percent(profit.netContributionMargin)} of covered net sales.`,
    status: "answered",
    sources: [sourcePath(data, "business_report"), sourcePath(data, "economics"), sourcePath(data, "advertised_product")],
    facts: [
      { label: "Covered net sales", value: euro(profit.coveredNetSales) },
      { label: "Purchase cost", value: euro(profit.purchaseCost) },
      { label: "Delivery cost", value: euro(profit.deliveryCost) },
      { label: "Provision", value: euro(profit.provisionCost) },
      { label: "Advertising", value: euro(profit.advertisingCost) },
      { label: "Total cost", value: euro(profit.totalCost) },
      { label: "Net contribution", value: euro(profit.netContribution) },
      { label: "Net margin", value: percent(profit.netContributionMargin) },
    ],
  };
}

function answerRequestedTotal(question: string, data: AssistantSnapshot): AssistantAnswer | null {
  const q = normalize(question);
  if (!/\b(total|overall|how much|how many|current)\b/.test(q)) return null;
  const ad = data.totals.advertising;
  const retail = data.totals.retail;
  const profit = data.totals.profitability;
  const candidates: { terms: string[]; label: string; value: string; explanation: string; sources: string[] }[] = [
    { terms: ["ad spend", "advertising spend", "advertising cost"], label: "Total advertising spend", value: euro(ad.spend), explanation: "Sum of the validated Advertised Product cost rows.", sources: [sourcePath(data, "advertised_product")] },
    { terms: ["ad sales", "advertising sales", "attributed sales"], label: "Total advertising sales", value: euro(ad.sales), explanation: "Sum of attributed sales in the Advertised Product export.", sources: [sourcePath(data, "advertised_product")] },
    { terms: ["retail sales", "reported sales", "revenue"], label: "Reported retail sales", value: euro(retail.sales), explanation: "Ordered Product Sales for products present in the Business Report.", sources: [sourcePath(data, "business_report")] },
    { terms: ["unit", "sold"], label: "Sold units", value: whole.format(retail.units), explanation: "Units ordered in the supplied Business Report.", sources: [sourcePath(data, "business_report")] },
    { terms: ["impression"], label: "Advertising impressions", value: whole.format(ad.impressions), explanation: "Validated Advertised Product impressions.", sources: [sourcePath(data, "advertised_product")] },
    { terms: ["click"], label: "Advertising clicks", value: whole.format(ad.clicks), explanation: "Validated Advertised Product clicks.", sources: [sourcePath(data, "advertised_product")] },
    { terms: ["purchase", "order"], label: "Attributed purchases", value: whole.format(ad.purchases), explanation: "Advertising-attributed purchases from Advertised Product.", sources: [sourcePath(data, "advertised_product")] },
    { terms: ["acos"], label: "Overall ACoS", value: percent(ad.acos), explanation: "Advertising spend divided by attributed advertising sales.", sources: [sourcePath(data, "advertised_product")] },
    { terms: ["roas"], label: "Overall ROAS", value: ratio(ad.roas), explanation: "Attributed advertising sales divided by advertising spend.", sources: [sourcePath(data, "advertised_product")] },
    { terms: ["tcos"], label: "TCOS", value: percent(profit.tcos), explanation: "Advertising spend divided by reported retail sales.", sources: [sourcePath(data, "advertised_product"), sourcePath(data, "business_report")] },
    { terms: ["net margin", "contribution margin"], label: "Net contribution margin", value: percent(profit.netContributionMargin), explanation: "Net contribution divided by covered net retail sales.", sources: [sourcePath(data, "business_report"), sourcePath(data, "economics"), sourcePath(data, "advertised_product")] },
    { terms: ["cpc", "cost per click"], label: "Average CPC", value: euro(ad.cpc, true), explanation: "Advertising spend divided by clicks.", sources: [sourcePath(data, "advertised_product")] },
    { terms: ["cpa", "cost per purchase", "cost per acquisition"], label: "Average CPA", value: euro(ad.cpa, true), explanation: "Advertising spend divided by attributed purchases.", sources: [sourcePath(data, "advertised_product")] },
    { terms: ["net contribution", "profit"], label: "Net contribution", value: euro(profit.netContribution), explanation: "Covered net sales less purchase, delivery, provision and advertising cost.", sources: [sourcePath(data, "business_report"), sourcePath(data, "economics"), sourcePath(data, "advertised_product")] },
  ];
  const match = candidates.find((candidate) => candidate.terms.some((term) => q.includes(term)));
  if (!match) return null;
  return {
    headline: match.label,
    text: `${match.value} for ${dateLabel(data.reporting.start)}–${dateLabel(data.reporting.end)}. ${match.explanation}`,
    status: "answered",
    sources: match.sources,
    facts: [{ label: match.label, value: match.value }],
  };
}

function answerSources(question: string, data: AssistantSnapshot): AssistantAnswer | null {
  const qTokens = tokens(question);
  const matches = data.imports
    .map((item) => ({ item, score: textScore(qTokens, `${item.key} ${item.file} ${item.report} ${item.role}`) }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score);
  if (!matches.length) return null;
  return {
    headline: "Matching source files",
    text: `Found ${matches.length} source files whose report name, filename or assigned role matches the question.`,
    status: "answered",
    sources: matches.map(({ item }) => item.path),
    items: matches.slice(0, 8).map(({ item }) => ({
      title: item.report,
      subtitle: item.path,
      metrics: [
        { label: "Rows", value: whole.format(item.rows) },
        { label: "Status", value: item.status },
        { label: "Role", value: item.role },
      ],
    })),
  };
}

function answerTopic(question: string, topics: AssistantTopic[]): AssistantAnswer | null {
  const normalizedQuestion = normalize(question);
  const scored = topics
    .map((topic) => ({
      topic,
      score: [topic.title, ...topic.aliases].reduce((score, term) => score + (normalizedQuestion.includes(normalize(term)) ? normalize(term).length : 0), 0),
    }))
    .sort((left, right) => right.score - left.score);
  if (!scored[0] || scored[0].score <= 0) return null;
  const topic = scored[0].topic;
  return {
    headline: topic.title,
    text: topic.summary,
    status: "answered",
    sources: topic.sources,
    facts: topic.formula ? [{ label: "Calculation", value: topic.formula }] : undefined,
    followUps: [`Which products or campaigns are most affected by ${topic.title}?`],
  };
}

function answerFreeSearch(question: string, data: AssistantSnapshot): AssistantAnswer {
  const queryTokens = tokens(question);
  const productMatches = data.products
    .map((product) => ({ product, score: textScore(queryTokens, `${product.name} ${product.sku} ${product.asin} ${product.category ?? ""}`) }))
    .filter((item) => item.score >= 4)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);
  const campaignMatches = data.campaigns
    .map((campaign) => ({ campaign, score: textScore(queryTokens, campaign.name) }))
    .filter((item) => item.score >= 4)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);
  if (productMatches.length || campaignMatches.length) {
    return {
      headline: "Relevant data matches",
      text: "I found related records but the requested calculation or comparison was not explicit. Select a result by asking about its SKU or campaign name.",
      status: "interpreted",
      sources: unique([
        ...(productMatches.length ? productSources(data) : []),
        ...(campaignMatches.length ? [sourcePath(data, "campaign")] : []),
      ]),
      items: [
        ...productMatches.map(({ product }) => ({
          title: product.name,
          subtitle: `${product.sku} · ${product.asin}`,
          metrics: [{ label: "Type", value: "Product" }, { label: "Revenue", value: euro(product.retail?.sales) }],
        })),
        ...campaignMatches.map(({ campaign }) => ({
          title: campaign.name,
          metrics: [{ label: "Type", value: "Campaign" }, { label: "Spend", value: euro(campaign.spend) }],
        })),
      ],
      entities: [
        ...productMatches.map(({ product }) => ({ type: "product" as const, id: product.sku, label: product.name })),
        ...campaignMatches.map(({ campaign }) => ({ type: "campaign" as const, id: campaign.name, label: campaign.name })),
      ],
    };
  }
  return {
    headline: "The requested data is not in this snapshot",
    text: "I searched the available products, campaigns, targets, recommendations, placements, daily performance, profitability metrics and source map, but could not connect this question to a verified field. I will not invent an answer. Try naming a metric, SKU, ASIN, campaign, target, recommendation type or source file.",
    status: "unavailable",
    sources: [],
    followUps: ["What data can you answer questions about?", "Show the current snapshot", "Show top products by revenue"],
  };
}

function answerEntityReference(reference: AssistantEntityRef, context: AssistantContext, suggestions: Suggestion[]): AssistantAnswer | null {
  if (reference.type === "product") {
    const product = context.data.products.find((item) => item.sku === reference.id || item.asin === reference.id);
    return product ? productDetail(product, context.data) : null;
  }
  if (reference.type === "campaign") {
    const campaign = context.data.campaigns.find((item) => item.name === reference.id);
    return campaign ? campaignDetail(campaign, context.data, suggestions) : null;
  }
  if (reference.type === "target") {
    const target = context.data.targetPerformance.find((item) => item.id === reference.id);
    const suggestion = suggestions.find((item) => item.id.startsWith(`${reference.id}:`));
    return target ? targetDetail(target, context.data, suggestion) : null;
  }
  if (reference.type === "suggestion") {
    const suggestion = suggestions.find((item) => item.id === reference.id);
    if (!suggestion) return null;
    return {
      headline: `${suggestion.type.replaceAll("_", " ")} recommendation`,
      text: suggestion.reason,
      status: "answered",
      sources: [sourcePath(context.data, "targeting"), sourcePath(context.data, "economics")],
      facts: suggestionItem(suggestion).metrics,
      items: [{ title: suggestion.harvestTerm ?? suggestion.target, subtitle: `${suggestion.productName} · ${suggestion.campaignName}`, metrics: [{ label: "Risk", value: suggestion.risk }] }],
      entities: [reference],
    };
  }
  return null;
}

export function answerDataQuestion(question: string, context: AssistantContext): AssistantAnswer {
  const cleanQuestion = question.trim();
  const q = normalize(cleanQuestion);
  const suggestions = buildSuggestions(context.data.targetPerformance, context.settings);

  const previousReference = resolvePreviousEntity(cleanQuestion, context.previousEntities);
  if (previousReference) {
    const previousAnswer = answerEntityReference(previousReference, context, suggestions);
    if (previousAnswer) return { ...previousAnswer, status: "interpreted" };
  }

  if (/\b(current|overall|summary|snapshot|today|performance overview)\b/.test(q) || q === "overview") return answerOverview(context.data);
  if (q.includes("what data") || q.includes("what can you answer") || q.includes("capabilit")) {
    return {
      headline: "Available analytical coverage",
      text: "I can calculate and compare product retail performance, advertising performance, gross contribution, campaigns, targets, bid recommendations, harvest opportunities, daily trends, placements, profitability, coverage and source provenance. I also resolve SKUs, ASINs and campaign names, and I explicitly say when a requested field is unavailable.",
      status: "answered",
      sources: context.data.imports.map((item) => item.path),
      facts: [
        { label: "Products", value: whole.format(context.data.products.length) },
        { label: "Campaigns", value: whole.format(context.data.campaigns.length) },
        { label: "Targets", value: whole.format(context.data.targetPerformance.length) },
        { label: "Source files", value: whole.format(context.data.imports.length) },
      ],
      followUps: ["Show top products by gross contribution", "Which campaigns have the highest ACoS?", "Show harvest recommendations"],
    };
  }
  if ((q.includes("missing") || q.includes("absent") || q.includes("coverage")) && (q.includes("business report") || q.includes("retail") || q.includes("sku") || q.includes("product") || q.includes("46") || q.includes("244"))) {
    return answerMissingCoverage(cleanQuestion, context.data);
  }
  if (q.includes("total cost") || q.includes("profitability") || q.includes("net contribution") || q.includes("cost breakdown")) return answerProfitability(context.data);
  if (q.includes("placement")) return answerPlacements(cleanQuestion, context.data);
  if (q.includes("day") || q.includes("daily") || q.includes("date") || q.includes("trend")) {
    if (/\b(best|worst|highest|lowest|top|bottom|day|daily|date)\b/.test(q)) return answerDaily(cleanQuestion, context.data);
  }

  const targetMatches = findTargets(cleanQuestion, context.data.targetPerformance);
  if (targetMatches.length === 1 && !/\b(top|bottom|highest|lowest|targets)\b/.test(q)) {
    const target = targetMatches[0];
    return targetDetail(target, context.data, suggestions.find((item) => item.id.startsWith(`${target.id}:`)));
  }

  const productMatches = findProducts(cleanQuestion, context.data.products);
  const campaignMatches = findCampaigns(cleanQuestion, context.data.campaigns);
  if ((q.includes("compare") || q.includes("versus") || q.includes("difference between")) && productMatches.length >= 2) {
    return productComparison(productMatches, context.data);
  }
  const asksRecommendations = q.includes("recommend") || q.includes("suggestion") || q.includes("harvest") || q.includes("bid reduction") || q.includes("bid increase") || q.includes("pause review") || q.includes("manual review");
  if (asksRecommendations) return answerRecommendations(cleanQuestion, context, suggestions);
  const asksRanking = /\b(top|bottom|best|worst|highest|lowest|most|least|rank|performer|contribut)\b/.test(q);
  if (asksRanking && (q.includes("campaign") || campaignMatches.length)) return answerCampaignRanking(cleanQuestion, context.data);
  if (asksRanking && (q.includes("target") || q.includes("keyword") || q.includes("search term"))) return answerTargetRanking(cleanQuestion, context.data);
  if (asksRanking && (q.includes("product") || productMatches.length === 0)) return answerProductRanking(cleanQuestion, context.data);
  if (q.includes("targets") || q.includes("keywords") || q.includes("search terms")) return answerTargetRanking(cleanQuestion, context.data);

  if (productMatches.length === 1) return productDetail(productMatches[0], context.data);
  if (campaignMatches.length === 1) return campaignDetail(campaignMatches[0], context.data, suggestions);
  if (targetMatches.length > 1) return answerTargetRanking(cleanQuestion, context.data);

  if ((q.includes("source") || q.includes("file") || q.includes("where")) && !q.includes("formula")) {
    const sourceAnswer = answerSources(cleanQuestion, context.data);
    if (sourceAnswer) return sourceAnswer;
  }

  const requestedTotal = answerRequestedTotal(cleanQuestion, context.data);
  if (requestedTotal) return requestedTotal;
  const topicAnswer = answerTopic(cleanQuestion, context.topics);
  if (topicAnswer) return topicAnswer;
  return answerFreeSearch(cleanQuestion, context.data);
}
