import { marketplaceRegistry } from "./marketplaces.ts";
import { parseCsv, type ClassifiedUpload, type ImportValidation, type UploadFileInput } from "./runtime-import.ts";
import type { MarketplaceCostSettings, ProductIdentifierRecord } from "./marketplace-storage.ts";

type Row = Record<string, string>;
type KauflandRole = Extract<ClassifiedUpload["role"], `kaufland_${string}`>;

interface BaseProduct {
  sku: string;
  canonicalSku?: string | null;
  ean?: string | null;
  eanAmbiguous?: boolean;
  asin: string;
  name: string;
  price: number | null;
  margin: number | null;
  category: string | null;
  unitCosts?: { purchaseNet?: number | null; deliveryNet?: number | null };
}

interface BaseSnapshot {
  settings: Record<string, unknown>;
  products: BaseProduct[];
  catalogProducts?: BaseProduct[];
  imports: Array<Record<string, unknown> & { key: string }>;
}

interface AdMetrics {
  impressions: number;
  clicks: number;
  spend: number;
  purchases: number;
  sales: number;
}

interface UnmatchedProductRow {
  ean: string;
  sellerSku: string;
  source: string;
  rows: number;
  revenue: number;
  spend: number;
}

export const requiredKauflandRoles: KauflandRole[] = [
  "kaufland_sales",
  "kaufland_offers",
  "kaufland_spa_daily_campaign",
  "kaufland_spa_campaign",
  "kaufland_spa_ean",
  "kaufland_spa_daily_cost",
  "kaufland_spa_daily_cost_campaign",
];

const canonical = (value: string) => value
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_|_$/g, "");
const fields = (row: Row) => new Map(Object.entries(row).map(([key, value]) => [canonical(key), value.trim()]));
const read = (row: Row, aliases: string[]) => {
  const map = fields(row);
  for (const alias of aliases) {
    const value = map.get(canonical(alias));
    if (value) return value;
  }
  return "";
};
const numberValue = (value: string): number | null => {
  if (!value?.trim()) return null;
  const cleaned = value.replace(/\s/g, "").replace(/[^0-9,.-]/g, "");
  const normalized = cleaned.includes(",") && cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};
const num = (row: Row, aliases: string[]) => numberValue(read(row, aliases));
const round = (value: number | null, digits = 2) => value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const ratio = (a: number, b: number) => b > 0 ? a / b : null;

function dateValue(value: string): string | null {
  const clean = value.trim();
  const iso = clean.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const eu = clean.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (eu) return `${eu[3]}-${eu[2].padStart(2, "0")}-${eu[1].padStart(2, "0")}`;
  return null;
}

function headerSet(headers: string[]) { return new Set(headers.map(canonical)); }
function hasAny(headers: Set<string>, aliases: string[]) { return aliases.some((alias) => headers.has(canonical(alias))); }
function emptyAdMetrics(): AdMetrics { return { impressions: 0, clicks: 0, spend: 0, purchases: 0, sales: 0 }; }
function addAdMetrics(target: AdMetrics, value: AdMetrics) {
  target.impressions += value.impressions;
  target.clicks += value.clicks;
  target.spend += value.spend;
  target.purchases += value.purchases;
  target.sales += value.sales;
  return target;
}
function rowAdMetrics(row: Row): AdMetrics {
  return {
    impressions: num(row, ["Impressions"]) ?? 0,
    clicks: num(row, ["Clicks"]) ?? 0,
    spend: num(row, ["Cost (€)", "Costs (€)", "Cost", "Costs"]) ?? 0,
    purchases: num(row, ["Total Conversions", "Conversions"]) ?? 0,
    sales: num(row, ["Sales (€)", "Total Sales (€)", "Sales"]) ?? 0,
  };
}
function sumAdMetrics(rows: Row[]) { return rows.reduce((total, row) => addAdMetrics(total, rowAdMetrics(row)), emptyAdMetrics()); }

export function classifyKauflandUpload(headers: string[], fileName: string): KauflandRole {
  const set = headerSet(headers);
  const name = canonical(fileName);
  const hasDate = hasAny(set, ["Date", "date_inserted"]);
  const hasCampaign = hasAny(set, ["Campaign ID", "Campaign Name"]);
  const hasEan = hasAny(set, ["EAN"]);
  const hasPerformance = hasAny(set, ["Impressions"]) && hasAny(set, ["Clicks"]);
  const hasCost = hasAny(set, ["Cost (€)", "Costs (€)", "Cost", "Costs"]);
  if (name.includes("report_sales_gmu") || hasAny(set, ["id_order_unit"]) && hasAny(set, ["cancel_status"])) return "kaufland_sales";
  if (name.includes("report_account_listing_feed") || hasAny(set, ["id_offer"]) && hasEan && hasAny(set, ["shop_price"])) return "kaufland_offers";
  if (name.includes("dailycampaignperformancereport") || hasDate && hasCampaign && hasPerformance && hasCost) return "kaufland_spa_daily_campaign";
  if (name.includes("eanperformancereport") || hasEan && hasPerformance && hasAny(set, ["Total Sales (€)"])) return "kaufland_spa_ean";
  if (name.includes("dailycostcampaign") || hasDate && hasCampaign && hasCost && !hasPerformance) return "kaufland_spa_daily_cost_campaign";
  if (name.includes("dailycost") || hasDate && hasCost && !hasCampaign && !hasPerformance) return "kaufland_spa_daily_cost";
  if (name.includes("campaignperformancereport") || hasCampaign && hasPerformance && !hasDate) return "kaufland_spa_campaign";
  throw new Error(`${fileName} does not match one of the seven verified Kaufland DE exports. Keep Kaufland's original filename and headers.`);
}

function assertReconciled(label: string, actual: number, expected: number, money = false) {
  const difference = Math.abs(actual - expected);
  const tolerance = money ? Math.max(0.05, Math.abs(expected) * 0.001) : 0.0001;
  if (difference > tolerance) {
    const display = (value: number) => money ? `€${value.toFixed(2)}` : value.toLocaleString("en-GB");
    throw new Error(`${label} does not reconcile: ${display(actual)} versus ${display(expected)}. Export all seven Kaufland reports for the same range at the same time, then upload them again.`);
  }
}

export function prepareKauflandUploadFiles(inputs: UploadFileInput[]): { files: ClassifiedUpload[]; validation: ImportValidation } {
  if (inputs.length !== requiredKauflandRoles.length) throw new Error(`Choose the seven required Kaufland CSV reports. ${inputs.length} files were received.`);
  const files = inputs.map((input) => {
    if (!input.name.toLowerCase().endsWith(".csv")) throw new Error(`${input.name} is not a CSV.`);
    const parsed = parseCsv(input.text);
    return { ...input, ...parsed, role: classifyKauflandUpload(parsed.headers, input.name) } as ClassifiedUpload;
  });
  const counts = new Map<KauflandRole, number>();
  for (const file of files) counts.set(file.role as KauflandRole, (counts.get(file.role as KauflandRole) ?? 0) + 1);
  const duplicate = [...counts].find(([, count]) => count > 1);
  if (duplicate) throw new Error(`Two files were classified as ${duplicate[0]}. Upload one report per required role.`);
  const missing = requiredKauflandRoles.filter((role) => !counts.has(role));
  if (missing.length) throw new Error(`Missing Kaufland reports: ${missing.map((role) => marketplaceRegistry.kaufland_de.importRequirements.find((item) => item.role === role)?.title ?? role).join(", ")}.`);

  const byRole = new Map(files.map((file) => [file.role, file]));
  const dailyCampaign = byRole.get("kaufland_spa_daily_campaign")!;
  const dailyCost = byRole.get("kaufland_spa_daily_cost")!;
  const dates = [...new Set(dailyCost.rows.map((row) => dateValue(read(row, ["Date"]))).filter((value): value is string => Boolean(value)))].sort();
  if (!dates.length) throw new Error(`${dailyCost.name} needs Kaufland's Date column.`);
  const dateSet = new Set(dates);
  const dailyCampaignDates = new Set(dailyCampaign.rows.map((row) => dateValue(read(row, ["Date"]))).filter(Boolean));
  const missingCampaignDates = dates.filter((date) => !dailyCampaignDates.has(date));
  const outsideDailyCampaign = [...dailyCampaignDates].filter((date): date is string => typeof date === "string" && !dateSet.has(date));
  const dailyCostCampaignDates = new Set(byRole.get("kaufland_spa_daily_cost_campaign")!.rows.map((row) => dateValue(read(row, ["Date"]))).filter(Boolean));
  const outsideDailyCostCampaign = [...dailyCostCampaignDates].filter((date): date is string => typeof date === "string" && !dateSet.has(date));
  const salesDates = byRole.get("kaufland_sales")!.rows.map((row) => dateValue(read(row, ["date_inserted"]))).filter((value): value is string => Boolean(value));
  const outsideSales = salesDates.filter((date) => !dateSet.has(date));
  if (outsideDailyCampaign.length || outsideDailyCostCampaign.length || outsideSales.length) {
    throw new Error("The seven Kaufland files do not cover the same reporting dates. Export every report for one identical range and upload that package together.");
  }
  const currencies = new Set(byRole.get("kaufland_offers")!.rows.map((row) => read(row, ["currency"]).toUpperCase()).filter(Boolean));
  if ([...currencies].some((currency) => currency !== "EUR")) throw new Error(`Kaufland DE imports must be in EUR. Found: ${[...currencies].join(", ")}.`);

  const authoritative = sumAdMetrics(dailyCampaign.rows);
  const campaign = sumAdMetrics(byRole.get("kaufland_spa_campaign")!.rows);
  const ean = sumAdMetrics(byRole.get("kaufland_spa_ean")!.rows);
  const accountCost = byRole.get("kaufland_spa_daily_cost")!.rows.reduce((sum, row) => sum + (num(row, ["Costs (€)"]) ?? 0), 0);
  const campaignCost = byRole.get("kaufland_spa_daily_cost_campaign")!.rows.reduce((sum, row) => sum + (num(row, ["Costs (€)"]) ?? 0), 0);
  for (const [label, metrics] of [["Campaign summary", campaign], ["EAN performance", ean]] as const) {
    assertReconciled(`${label} impressions`, metrics.impressions, authoritative.impressions);
    assertReconciled(`${label} clicks`, metrics.clicks, authoritative.clicks);
    assertReconciled(`${label} conversions`, metrics.purchases, authoritative.purchases);
    assertReconciled(`${label} spend`, metrics.spend, authoritative.spend, true);
    assertReconciled(`${label} sales`, metrics.sales, authoritative.sales, true);
  }
  assertReconciled("Daily account cost", accountCost, authoritative.spend, true);
  assertReconciled("Daily campaign cost", campaignCost, authoritative.spend, true);

  const warnings = [
    "Kaufland's seven supplied reports do not include keyword/search-term ownership or current bids. Bidding suggestions are product-level and directional; exact bid amounts, harvest and exact-conflict checks remain unavailable.",
  ];
  if (missingCampaignDates.length) warnings.push(`${missingCampaignDates.length} date(s) have an account-cost row but no campaign-performance row; spend is retained from the account control total and the other daily ad metrics are zero.`);
  const calendarDays = Math.round((Date.parse(`${dates.at(-1)}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`)) / 86_400_000) + 1;
  if (calendarDays !== dates.length) warnings.push(`The period spans ${calendarDays} calendar days but only ${dates.length} dated cost rows were supplied. Missing dates stay visible as coverage gaps.`);
  return { files, validation: { status: warnings.length ? "warning" : "ready", warnings, reportingStart: dates[0], reportingEnd: dates.at(-1)!, reportingDays: dates.length } };
}

function importRole(role: string): string {
  if (role === "kaufland_spa_daily_campaign") return "Authoritative daily advertising";
  if (role === "kaufland_spa_ean") return "Product advertising detail";
  if (role === "kaufland_sales") return "Authoritative retail order units";
  if (role === "kaufland_offers") return "Product identity and offer reference";
  return "Reconciliation control — not additive";
}

export function buildKauflandSnapshot(input: {
  files: ClassifiedUpload[];
  validation: ImportValidation;
  baseSnapshot: BaseSnapshot;
  snapshotId: string;
  identifiers: ProductIdentifierRecord[];
  costSettings: MarketplaceCostSettings;
}): Record<string, unknown> {
  const byRole = new Map(input.files.map((file) => [file.role, file]));
  const catalogProducts = input.baseSnapshot.catalogProducts?.length ? input.baseSnapshot.catalogProducts : input.baseSnapshot.products;
  const baseBySku = new Map(catalogProducts.map((product) => [product.sku, product]));
  const identifierMap = new Map(input.identifiers.map((record) => [`${record.identifierType}:${record.identifierValue}`, record.canonicalSku]));
  const eanToSku = new Map(input.identifiers.filter((record) => record.identifierType === "ean").map((record) => [record.identifierValue, record.canonicalSku]));
  const masterEanOwners = new Map<string, Set<string>>();
  for (const product of catalogProducts) {
    if (!product.ean) continue;
    const owners = masterEanOwners.get(product.ean) ?? new Set<string>();
    owners.add(product.sku);
    masterEanOwners.set(product.ean, owners);
  }
  const ambiguousMasterEans = new Set([...masterEanOwners.entries()].filter(([, owners]) => owners.size > 1).map(([ean]) => ean));
  for (const [ean, owners] of masterEanOwners) {
    if (owners.size !== 1) continue;
    const canonicalSku = [...owners][0];
    const saved = eanToSku.get(ean);
    if (saved && saved !== canonicalSku) throw new Error(`EAN ${ean} is assigned to ${saved} in the saved crosswalk but to ${canonicalSku} in the fixed product master. Resolve the conflict before importing.`);
    eanToSku.set(ean, canonicalSku);
  }
  const sellerSkuToSku = new Map<string, string>();
  for (const sku of baseBySku.keys()) sellerSkuToSku.set(sku, sku);
  for (const record of input.identifiers.filter((item) => item.identifierType === "seller_sku" || item.identifierType === "offer_id")) sellerSkuToSku.set(record.identifierValue, record.canonicalSku);

  const blockedIdentityPairs = new Set<string>();
  const identifierConflicts: Array<{ sellerSku: string; ean: string; sellerSkuCandidate: string; eanCandidate: string; reason: string }> = [];
  const identifierWarnings: Array<{ sellerSku: string; ean: string; canonicalSku: string; reason: string }> = [];
  const offerBySku = new Map<string, Row>();
  let autoMappedIdentifiers = 0;
  for (const offer of byRole.get("kaufland_offers")!.rows) {
    const sellerSku = read(offer, ["id_offer"]);
    const ean = read(offer, ["ean"]);
    const sellerSkuCandidate = sellerSkuToSku.get(sellerSku) ?? identifierMap.get(`offer_id:${sellerSku}`);
    const eanCandidate = eanToSku.get(ean);
    const expectedEan = sellerSkuCandidate ? baseBySku.get(sellerSkuCandidate)?.ean : null;
    const conflictReason = sellerSkuCandidate && eanCandidate && sellerSkuCandidate !== eanCandidate
      ? `Seller SKU resolves to ${sellerSkuCandidate}, while EAN resolves to ${eanCandidate}.`
      : null;
    if (conflictReason) {
      blockedIdentityPairs.add(`${sellerSku}\u0000${ean}`);
      identifierConflicts.push({ sellerSku, ean, sellerSkuCandidate: sellerSkuCandidate ?? "", eanCandidate: eanCandidate ?? "", reason: conflictReason });
      continue;
    }
    const sku = sellerSkuCandidate ?? eanCandidate;
    if (!sku || !baseBySku.has(sku)) continue;
    if (sellerSkuCandidate && expectedEan && ean && expectedEan !== ean && !eanCandidate) {
      identifierWarnings.push({
        sellerSku,
        ean,
        canonicalSku: sellerSkuCandidate,
        reason: `Matched by exact internal seller SKU ${sellerSkuCandidate}; Kaufland EAN ${ean} is an additional marketplace identifier and differs from master EAN ${expectedEan}.`,
      });
    }
    if (ean) {
      const previous = eanToSku.get(ean);
      if (previous && previous !== sku) throw new Error(`EAN ${ean} resolves to both ${previous} and ${sku}. Correct the saved crosswalk before importing.`);
      if (!previous) autoMappedIdentifiers += 1;
      eanToSku.set(ean, sku);
    }
    if (sellerSku && !sellerSkuCandidate) sellerSkuToSku.set(sellerSku, sku);
    const current = offerBySku.get(sku);
    if (!current || !read(current, ["id_offer"])) offerBySku.set(sku, offer);
  }

  const unmatched = new Map<string, UnmatchedProductRow>();
  const noteUnmatched = (source: string, ean: string, sellerSku: string, revenue = 0, spend = 0) => {
    const key = `${source}:${ean || sellerSku || "missing-identifier"}`;
    const current = unmatched.get(key) ?? { ean: ean || "—", sellerSku: sellerSku || "—", source, rows: 0, revenue: 0, spend: 0 };
    current.rows += 1;
    current.revenue += revenue;
    current.spend += spend;
    unmatched.set(key, current);
  };
  for (const conflict of identifierConflicts) noteUnmatched("Account listing identifier conflict", conflict.ean, conflict.sellerSku);

  const retail = new Map<string, { sales: number; units: number; orders: Set<string> }>();
  const seenOrderUnits = new Set<string>();
  let retailSales = 0;
  let retailUnits = 0;
  let validSalesRows = 0;
  let cancelledSalesRows = 0;
  let returnedSalesRows = 0;
  let duplicateSalesRows = 0;
  for (const row of byRole.get("kaufland_sales")!.rows) {
    const unitId = read(row, ["id_order_unit"]);
    if (unitId && seenOrderUnits.has(unitId)) { duplicateSalesRows += 1; continue; }
    if (unitId) seenOrderUnits.add(unitId);
    const cancelStatus = canonical(read(row, ["cancel_status"]));
    const returnStatus = canonical(read(row, ["return_status"]));
    if (cancelStatus && cancelStatus !== "not_cancelled") { cancelledSalesRows += 1; continue; }
    if (returnStatus && returnStatus !== "not_returned") { returnedSalesRows += 1; continue; }
    validSalesRows += 1;
    const ean = read(row, ["ean"]);
    const sellerSku = read(row, ["offer_id"]);
    const revenue = (num(row, ["price"]) ?? 0) / 100;
    retailSales += revenue;
    retailUnits += 1;
    const sku = blockedIdentityPairs.has(`${sellerSku}\u0000${ean}`)
      ? undefined
      : sellerSkuToSku.get(sellerSku) ?? identifierMap.get(`offer_id:${sellerSku}`) ?? eanToSku.get(ean);
    if (!sku || !baseBySku.has(sku)) { noteUnmatched("Sales GMU", ean, sellerSku, revenue); continue; }
    const current = retail.get(sku) ?? { sales: 0, units: 0, orders: new Set<string>() };
    current.sales += revenue;
    current.units += 1;
    current.orders.add(read(row, ["order_number"]) || unitId);
    retail.set(sku, current);
  }

  const productAdvertising = new Map<string, AdMetrics>();
  const targetRows: Array<{ row: Row; ean: string; sku: string | null; metrics: AdMetrics }> = [];
  for (const row of byRole.get("kaufland_spa_ean")!.rows) {
    const ean = read(row, ["EAN"]);
    const metrics = rowAdMetrics(row);
    const sku = eanToSku.get(ean) ?? null;
    if (!sku || !baseBySku.has(sku)) {
      if (metrics.impressions || metrics.clicks || metrics.spend || metrics.purchases || metrics.sales) noteUnmatched("SPA EAN performance", ean, "", 0, metrics.spend);
    } else {
      addAdMetrics(productAdvertising.get(sku) ?? productAdvertising.set(sku, emptyAdMetrics()).get(sku)!, metrics);
    }
    if (metrics.impressions || metrics.clicks || metrics.spend || metrics.purchases || metrics.sales) targetRows.push({ row, ean, sku, metrics });
  }

  const campaignRows = byRole.get("kaufland_spa_campaign")!.rows;
  const campaigns = campaignRows.map((row, index) => {
    const metrics = rowAdMetrics(row);
    return {
      id: read(row, ["Campaign ID"]) || `campaign-${index + 1}`,
      name: read(row, ["Campaign Name"]) || `Campaign ${index + 1}`,
      state: read(row, ["Campaign Status"]),
      spend: round(metrics.spend), sales: round(metrics.sales), impressions: metrics.impressions, clicks: metrics.clicks, purchases: metrics.purchases,
      acos: round(ratio(metrics.spend, metrics.sales), 4), roas: round(ratio(metrics.sales, metrics.spend), 4),
    };
  });
  const authoritative = sumAdMetrics(byRole.get("kaufland_spa_daily_campaign")!.rows);
  const dailyMap = new Map<string, AdMetrics>();
  for (const row of byRole.get("kaufland_spa_daily_campaign")!.rows) {
    const date = dateValue(read(row, ["Date"]));
    if (!date) continue;
    addAdMetrics(dailyMap.get(date) ?? dailyMap.set(date, emptyAdMetrics()).get(date)!, rowAdMetrics(row));
  }
  for (const row of byRole.get("kaufland_spa_daily_cost")!.rows) {
    const date = dateValue(read(row, ["Date"]));
    if (!date) continue;
    const current = dailyMap.get(date) ?? emptyAdMetrics();
    if (!dailyMap.has(date)) current.spend = num(row, ["Costs (€)"]) ?? 0;
    dailyMap.set(date, current);
  }

  const candidateSkus = new Set([...offerBySku.keys(), ...retail.keys(), ...productAdvertising.keys()]);
  const products = catalogProducts.filter((product) => candidateSkus.has(product.sku)).map((product) => {
    const retailPerformance = retail.get(product.sku);
    const advertising = productAdvertising.get(product.sku);
    const offer = offerBySku.get(product.sku);
    const eans = [...eanToSku.entries()].filter(([, sku]) => sku === product.sku).map(([ean]) => ean);
    const offerPrice = offer ? (num(offer, ["shop_price", "price"]) ?? 0) / 100 : null;
    const hasAdvertising = Boolean(advertising && (advertising.impressions || advertising.clicks || advertising.spend || advertising.purchases || advertising.sales));
    return {
      ...product,
      name: offer ? read(offer, ["item_title", "title"]) || product.name : product.name,
      price: offerPrice && offerPrice > 0 ? round(offerPrice) : product.price,
      marketplaceIdentifiers: { eans, sellerSku: offer ? read(offer, ["id_offer"]) : null },
      retail: retailPerformance ? { sessions: null, pageViews: null, units: retailPerformance.units, sales: round(retailPerformance.sales), orders: retailPerformance.orders.size, conversion: null, buyBox: null } : null,
      advertising: hasAdvertising && advertising ? { ...advertising, spend: round(advertising.spend), sales: round(advertising.sales), acos: round(ratio(advertising.spend, advertising.sales), 4), roas: round(ratio(advertising.sales, advertising.spend), 4) } : null,
      advertisingStatus: hasAdvertising ? "Observed Kaufland EAN activity" : "No activity in SPA EAN report",
      offerStatus: offer ? read(offer, ["status"]) : null,
    };
  });

  const productsBySku = new Map(products.map((product) => [product.sku, product]));
  const targets = targetRows.map(({ row, ean, sku, metrics }, index) => {
    const product = sku ? productsBySku.get(sku) : undefined;
    return {
      id: `kaufland-ean-${ean || index + 1}`,
      campaignId: "", campaignName: "Kaufland SPA · product-level", adGroupId: "", adGroupName: "",
      target: ean ? `EAN ${ean}` : "EAN unavailable", matchType: "EAN", targetType: "Product", status: "Observed",
      bid: null, bidUnavailableReason: "The supplied seven-file Kaufland package contains no current product or keyword bid field.", recommendationScope: "product",
      sku, asin: product?.asin ?? null, productName: product?.name ?? null, price: product?.price ?? null,
      margin: product?.margin ?? null, category: product?.category ?? (read(row, ["Category"]) || null), ambiguousProduct: false,
      ...metrics, units: metrics.purchases,
      acos: round(ratio(metrics.spend, metrics.sales), 4), roas: round(ratio(metrics.sales, metrics.spend), 4), cvr: round(ratio(metrics.purchases, metrics.clicks), 4), aov: round(ratio(metrics.sales, metrics.purchases)), topSearchTerms: [],
    };
  });

  let coveredGrossSales = 0;
  let coveredNetSales = 0;
  let purchaseCost = 0;
  let deliveryCost = 0;
  let commissionCost = 0;
  let coveredAdSpend = 0;
  let covered = 0;
  const missingCostProducts: Array<{ sku: string; grossSales: number }> = [];
  const economicsSkus = new Set<string>();
  for (const product of products) {
    const base = baseBySku.get(product.sku)!;
    if (base.unitCosts?.purchaseNet != null && base.unitCosts?.deliveryNet != null) economicsSkus.add(product.sku);
    if (!product.retail) continue;
    if (base.unitCosts?.purchaseNet == null || base.unitCosts?.deliveryNet == null || input.costSettings.commissionRate == null || !input.costSettings.confirmed) {
      missingCostProducts.push({ sku: product.sku, grossSales: Number(product.retail.sales) });
      continue;
    }
    const grossSales = Number(product.retail.sales);
    const units = Number(product.retail.units);
    const netSales = grossSales / (1 + input.costSettings.vatRate);
    coveredGrossSales += grossSales;
    coveredNetSales += netSales;
    purchaseCost += units * base.unitCosts.purchaseNet;
    deliveryCost += units * base.unitCosts.deliveryNet;
    commissionCost += netSales * (input.costSettings.categoryOverrides[base.category ?? ""] ?? input.costSettings.commissionRate);
    covered += 1;
  }
  for (const [sku, metrics] of productAdvertising) if (economicsSkus.has(sku)) coveredAdSpend += metrics.spend;
  const profitabilityReady = input.costSettings.confirmed && input.costSettings.commissionRate != null;
  const netContribution = profitabilityReady ? coveredNetSales - purchaseCost - deliveryCost - commissionCost - coveredAdSpend : null;
  const capabilities = { ...marketplaceRegistry.kaufland_de.capabilities, profitability: profitabilityReady };
  const fixedImports = input.baseSnapshot.imports.filter((item) => ["product_master", "amazon_listing", "economics"].includes(item.key));
  const imports = [
    ...input.files.map((file) => ({
      key: file.role,
      file: file.name,
      path: `Persistent uploads/kaufland_de/${input.snapshotId}/${file.name}`,
      report: marketplaceRegistry.kaufland_de.importRequirements.find((item) => item.role === file.role)?.title ?? file.role,
      role: importRole(file.role),
      rows: file.rows.length,
      status: "Ready",
      sha256: file.sha256,
    })),
    ...fixedImports,
  ];
  const unmatchedProductRows = [...unmatched.values()].map((item) => ({ ...item, revenue: round(item.revenue), spend: round(item.spend) }));

  return {
    generatedAt: new Date().toISOString(),
    reporting: { start: input.validation.reportingStart, end: input.validation.reportingEnd, days: input.validation.reportingDays, currency: "EUR", nativeCurrency: "EUR", fxRateToEur: 1, marketplaceId: "kaufland_de", marketplace: "Kaufland DE", timezone: "Europe/Berlin", capabilities },
    settings: input.baseSnapshot.settings,
    totals: {
      advertising: { impressions: authoritative.impressions, clicks: authoritative.clicks, spend: round(authoritative.spend), purchases: authoritative.purchases, sales: round(authoritative.sales), units: authoritative.purchases, ctr: round(ratio(authoritative.clicks, authoritative.impressions), 4), cvr: round(ratio(authoritative.purchases, authoritative.clicks), 4), acos: round(ratio(authoritative.spend, authoritative.sales), 4), roas: round(ratio(authoritative.sales, authoritative.spend), 4), cpc: round(ratio(authoritative.spend, authoritative.clicks)), cpa: round(ratio(authoritative.spend, authoritative.purchases)), aov: round(ratio(authoritative.sales, authoritative.purchases)) },
      retail: { sales: round(retailSales), sessions: null, units: retailUnits, conversion: null },
      profitability: { tcos: round(ratio(authoritative.spend, retailSales), 4), netContribution: round(netContribution), netContributionMargin: round(netContribution == null ? null : ratio(netContribution, coveredNetSales), 4), coveredGrossSales: round(coveredGrossSales), coveredNetSales: round(coveredNetSales), retailSalesCoverage: round(ratio(coveredGrossSales, retailSales), 4), purchaseCost: profitabilityReady ? round(purchaseCost) : null, deliveryCost: profitabilityReady ? round(deliveryCost) : null, provisionCost: profitabilityReady ? round(commissionCost) : null, advertisingCost: profitabilityReady ? round(coveredAdSpend) : null, totalCost: profitabilityReady ? round(purchaseCost + deliveryCost + commissionCost + coveredAdSpend) : null, vatRate: input.costSettings.vatRate, provisionRate: input.costSettings.commissionRate, missingCostProducts, unavailableReason: profitabilityReady ? null : "Confirm the Kaufland commission rate in marketplace settings." },
    },
    daily: [...dailyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, metrics]) => ({ date, impressions: metrics.impressions, clicks: metrics.clicks, spend: round(metrics.spend), purchases: metrics.purchases, sales: round(metrics.sales), acos: round(ratio(metrics.spend, metrics.sales), 4) })),
    placements: [], campaigns, products, targetPerformance: targets, promotionCandidates: [], imports,
    quality: {
      activeProducts: products.length,
      masterCatalogProducts: catalogProducts.length,
      masterCatalogEanProducts: catalogProducts.filter((product) => product.ean).length,
      ambiguousMasterEans: ambiguousMasterEans.size,
      identifierConflicts,
      identifierWarnings,
      retailCoverageProducts: retail.size,
      economicsCoverageProducts: products.filter((product) => product.margin != null).length,
      netContributionCoverageProducts: covered,
      advertisedActiveProducts: products.filter((product) => product.advertising).length,
      targets: targets.length,
      targetsMatchedToActiveProduct: targets.filter((target) => target.sku).length,
      ambiguousTargetProductJoins: 0,
      unmatchedAdvertisingProducts: unmatchedProductRows.filter((item) => item.source === "SPA EAN performance").length,
      excludedNonEuroAdvertisedRows: 0,
      unmatchedProductRows,
      autoMappedIdentifiers,
      validSalesRows,
      cancelledSalesRows,
      returnedSalesRows,
      duplicateSalesRows,
      verifiedCurrentBidTargets: 0,
      advertisingReconciliation: { authoritativeSource: "SPA daily campaign performance", spend: round(authoritative.spend), sales: round(authoritative.sales), impressions: authoritative.impressions, clicks: authoritative.clicks, purchases: authoritative.purchases, reconciledSources: 5 },
      duplicateProtection: "Daily campaign performance controls advertising totals. Campaign summary, EAN performance, daily account cost and daily campaign cost are reconciled but never added to those totals.",
      importWarnings: input.validation.warnings,
    },
    sourceManifest: imports.map((item) => ({ path: item.path, sha256: item.sha256 })),
  };
}

export function normalizeKauflandImport(input: {
  files: UploadFileInput[];
  baseSnapshot: BaseSnapshot;
  snapshotId: string;
  identifiers: ProductIdentifierRecord[];
  costSettings: MarketplaceCostSettings;
}) {
  const prepared = prepareKauflandUploadFiles(input.files);
  return { ...prepared, snapshot: buildKauflandSnapshot({ ...prepared, baseSnapshot: input.baseSnapshot, snapshotId: input.snapshotId, identifiers: input.identifiers, costSettings: input.costSettings }) };
}
