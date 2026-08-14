import { marketplaceRegistry } from "./marketplaces.ts";

export type UploadRole =
  | "advertised_product"
  | "campaign"
  | "placement"
  | "search_term_summary"
  | "search_term_daily"
  | "targeting"
  | "business_report"
  | "kaufland_sales"
  | "kaufland_offers"
  | "kaufland_spa_campaign"
  | "kaufland_spa_ean"
  | "kaufland_spa_daily_campaign"
  | "kaufland_spa_search_term"
  | "kaufland_spa_daily_cost"
  | "kaufland_spa_daily_cost_campaign"
  | "kaufland_spa_settings";

export interface UploadFileInput {
  name: string;
  size: number;
  text: string;
  sha256: string;
}

export interface ClassifiedUpload extends UploadFileInput {
  role: UploadRole;
  rows: CsvRow[];
  headers: string[];
}

export interface ImportValidation {
  status: "ready" | "warning";
  warnings: string[];
  reportingStart: string;
  reportingEnd: string;
  reportingDays: number;
}

export interface RuntimeImportResult {
  snapshot: Record<string, unknown>;
  files: ClassifiedUpload[];
  validation: ImportValidation;
}

type CsvRow = Record<string, string>;
type NumberMap = Record<string, number>;

interface BaseProduct {
  sku: string;
  canonicalSku?: string | null;
  ean?: string | null;
  eanAmbiguous?: boolean;
  asin: string;
  name: string;
  price: number | null;
  active?: boolean;
  margin: number | null;
  category: string | null;
  economicsDescription?: string | null;
  unitCosts?: {
    purchaseNet: number | null;
    deliveryNet: number | null;
    landedNet?: number | null;
    provisionRate: number;
    sourceSku: string;
  } | null;
}

interface BaseSnapshot {
  settings: Record<string, unknown>;
  products: BaseProduct[];
  catalogProducts?: BaseProduct[];
  imports: {
    key: string;
    file: string;
    path: string;
    report: string;
    role: string;
    rows: number;
    status: string;
    sha256: string;
  }[];
}

const VAT_RATE = 0.19;
const PROVISION_RATE = 0.15;

export const requiredUploadRoles: {
  role: UploadRole;
  title: string;
  description: string;
  filenameHint: string;
  requiredColumns: string[];
}[] = [
  {
    role: "advertised_product",
    title: "Advertised Product",
    description: "Daily product-level advertising totals. This is the authoritative dashboard advertising source.",
    filenameHint: "Advertised_product_*.csv",
    requiredColumns: ["Budget currency", "Advertised product marketplace", "Advertised product SKU", "Date", "Impressions", "Clicks", "Total cost", "Purchases", "Sales"],
  },
  {
    role: "campaign",
    title: "Campaign",
    description: "Campaign budgets, states, strategies and campaign-level cost.",
    filenameHint: "Campaign_*.csv",
    requiredColumns: ["Campaign name", "Country", "State", "Type", "Targeting", "Campaign bid strategy", "Total cost", "Sales"],
  },
  {
    role: "placement",
    title: "Placement",
    description: "Daily placement performance for Top of Search, Detail Page and other placements.",
    filenameHint: "Placement_*.csv",
    requiredColumns: ["Budget currency", "Placement classification", "Date", "Impressions", "Clicks", "Total cost", "Purchases", "Sales"],
  },
  {
    role: "targeting",
    title: "Targeting",
    description: "Daily keyword and product-target evidence used by the bidding rules engine.",
    filenameHint: "Targeting_*.csv",
    requiredColumns: ["Budget currency", "Campaign ID", "Ad group ID", "Targeting", "Targeting match type", "Target ID", "Target bid", "Date", "Impressions", "Clicks", "Total cost", "Purchases", "Sales"],
  },
  {
    role: "business_report",
    title: "Business Report",
    description: "Product retail revenue, units and sessions for the same reporting period.",
    filenameHint: "BusinessReport-*.csv",
    requiredColumns: ["(Child) ASIN", "SKU", "Sessions – Total", "Units ordered", "Ordered Product Sales"],
  },
];

export const optionalUploadRoles: {
  role: UploadRole;
  title: string;
  description: string;
  filenameHint: string;
  requiredColumns: string[];
}[] = [
  {
    role: "search_term_summary",
    title: "Search Term summary",
    description: "Optional date-range search-term validation export. It is never added to dashboard totals.",
    filenameHint: "Search_term_*.csv (contains Date range)",
    requiredColumns: ["Budget currency", "Date range", "Search term", "Impressions", "Clicks", "Total cost", "Purchases", "Sales"],
  },
];

function repairText(value: string): string {
  return value.replace(/^\uFEFF/, "").trim();
}

function parseCsvMatrix(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(repairText(field));
      field = "";
    } else if (character === "\n") {
      row.push(repairText(field.replace(/\r$/, "")));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  row.push(repairText(field.replace(/\r$/, "")));
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function delimiterFor(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [",", ";", "\t", "|"];
  return candidates
    .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length }))
    .sort((left, right) => right.count - left.count)[0]?.delimiter ?? ",";
}

export function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const matrix = parseCsvMatrix(text, delimiterFor(text));
  if (!matrix.length) return { headers: [], rows: [] };
  const headers = matrix[0].map(repairText);
  const rows = matrix.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, repairText(values[index] ?? "")])),
  );
  return { headers, rows };
}

function includesHeader(headers: string[], header: string): boolean {
  return headers.some((value) => value.toLocaleLowerCase() === header.toLocaleLowerCase());
}

export function classifyUpload(headers: string[], filename: string): UploadRole {
  const has = (header: string) => includesHeader(headers, header);
  if (has("(Child) ASIN") && has("SKU") && has("Ordered Product Sales")) return "business_report";
  if (has("Advertised product SKU") && has("Advertised product marketplace")) return "advertised_product";
  if (has("Placement classification") || has("Placement name")) return "placement";
  if (has("Targeting") && has("Target bid") && has("Target ID")) return "targeting";
  if (has("Search term") && has("Date range")) return "search_term_summary";
  if (has("Search term") && has("Date") && has("Target ID")) return "search_term_daily";
  if (has("Campaign name") && has("Campaign bid strategy") && has("Type")) return "campaign";
  throw new Error(`"${filename}" does not match any supported Amazon advertising or Business Report export.`);
}

function parseNumber(value: string | number | null | undefined, percentValue = false): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let text = repairText(value);
  if (!text || text === "—" || text === "-" || text === "<5%") return null;
  const negative = text.startsWith("(") && text.endsWith(")");
  text = text.replace(/[^0-9,.\-]/g, "");
  if (!text || text === "-") return null;
  if (text.includes(",") && text.includes(".")) {
    text = text.lastIndexOf(",") < text.lastIndexOf(".") ? text.replaceAll(",", "") : text.replaceAll(".", "").replace(",", ".");
  } else if (text.includes(",")) {
    const tail = text.split(",").at(-1) ?? "";
    text = tail.length === 3 ? text.replaceAll(",", "") : text.replaceAll(".", "").replace(",", ".");
  }
  const result = Number(text);
  if (!Number.isFinite(result)) return null;
  const signed = negative ? -result : result;
  return percentValue ? signed / 100 : signed;
}

const metric = (value: number | null | undefined) => value == null || Number.isNaN(value) ? 0 : value;
const rounded = (value: number | null | undefined, digits = 4) => value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits;
const safeRatio = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;

function cleanId(value: string): string {
  const cleaned = repairText(value);
  const wrapped = cleaned.match(/^="(.*)"$/);
  return wrapped ? wrapped[1] : cleaned;
}

function parseDate(value: string): string | null {
  const text = repairText(value);
  let match = text.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (match) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(match[1].toLowerCase());
    if (month >= 0) return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  }
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? text : null;
}

function addMetric(bucket: NumberMap, key: string, value: number): void {
  bucket[key] = (bucket[key] ?? 0) + value;
}

function enrichMetrics<T extends Record<string, unknown>>(record: T): T & Record<string, unknown> {
  const impressions = metric(record.impressions as number | null);
  const clicks = metric(record.clicks as number | null);
  const spend = metric(record.spend as number | null);
  const purchases = metric(record.purchases as number | null);
  const sales = metric(record.sales as number | null);
  return {
    ...record,
    ctr: rounded(safeRatio(clicks, impressions)),
    cvr: rounded(safeRatio(purchases, clicks)),
    acos: rounded(safeRatio(spend, sales)),
    roas: rounded(safeRatio(sales, spend)),
    cpc: rounded(safeRatio(spend, clicks)),
    cpa: rounded(safeRatio(spend, purchases)),
    aov: rounded(safeRatio(sales, purchases)),
    ...Object.fromEntries(["impressions", "clicks", "spend", "purchases", "sales", "units"]
      .filter((key) => key in record)
      .map((key) => [key, rounded(metric(record[key] as number | null), 2)])),
  };
}

function dateBounds(rows: CsvRow[]): { start: string | null; end: string | null; dates: string[] } {
  const dates = unique(rows.map((row) => parseDate(row.Date)).filter((value): value is string => Boolean(value))).sort();
  return { start: dates[0] ?? null, end: dates.at(-1) ?? null, dates };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function validateClassifiedFiles(files: ClassifiedUpload[]): ImportValidation {
  const redundantDailySearchTerm = files.find((file) => file.role === "search_term_daily");
  if (redundantDailySearchTerm) {
    throw new Error(
      `${redundantDailySearchTerm.name} is a daily Search Term export and is not needed. ` +
      "The Targeting export already contains the same daily search-term evidence. " +
      "Upload the five required files; the date-range Search Term summary is optional.",
    );
  }
  const byRole = new Map(files.map((file) => [file.role, file]));
  const missing = requiredUploadRoles.filter((required) => !byRole.has(required.role));
  if (missing.length) throw new Error(`Missing required files: ${missing.map((item) => item.title).join(", ")}.`);
  if (byRole.size !== files.length) {
    const duplicates = unique(files.map((file) => file.role).filter((role, index, roles) => roles.indexOf(role) !== index));
    throw new Error(`Upload only one file for each report type. Duplicate types: ${duplicates.join(", ")}.`);
  }
  for (const requirement of [...requiredUploadRoles, ...optionalUploadRoles]) {
    const file = byRole.get(requirement.role);
    if (!file) continue;
    const missingHeaders = requirement.requiredColumns.filter((header) => !includesHeader(file.headers, header));
    if (missingHeaders.length) throw new Error(`${file.name} is missing required columns: ${missingHeaders.join(", ")}.`);
    if (!file.rows.length) throw new Error(`${file.name} contains no data rows.`);
  }

  const advertised = byRole.get("advertised_product")!;
  const advertisedBounds = dateBounds(advertised.rows);
  if (!advertisedBounds.start || !advertisedBounds.end || !advertisedBounds.dates.length) {
    throw new Error(`${advertised.name} does not contain readable daily dates.`);
  }
  const validAdvertised = advertised.rows.filter((row) => row["Budget currency"] === "EUR" && row["Advertised product marketplace"] === "AMAZON_DE");
  if (!validAdvertised.length) throw new Error(`${advertised.name} has no EUR / AMAZON_DE rows.`);

  const warnings: string[] = [];
  for (const role of ["placement", "targeting"] as UploadRole[]) {
    const file = byRole.get(role)!;
    const bounds = dateBounds(file.rows);
    if (bounds.start !== advertisedBounds.start || bounds.end !== advertisedBounds.end) {
      throw new Error(`${file.name} covers ${bounds.start ?? "unknown"} to ${bounds.end ?? "unknown"}, but Advertised Product covers ${advertisedBounds.start} to ${advertisedBounds.end}. Upload one consistent reporting period.`);
    }
  }
  if (advertisedBounds.dates.length !== 30) {
    warnings.push(`The uploaded period contains ${advertisedBounds.dates.length} advertising days rather than 30. MoM and YoY comparisons will use the exact uploaded dates.`);
  }
  const excluded = advertised.rows.length - validAdvertised.length;
  if (excluded > 0) warnings.push(`${excluded} Advertised Product rows outside EUR / AMAZON_DE will be excluded.`);
  return {
    status: warnings.length ? "warning" : "ready",
    warnings,
    reportingStart: advertisedBounds.start,
    reportingEnd: advertisedBounds.end,
    reportingDays: advertisedBounds.dates.length,
  };
}

function roleMetadata(role: UploadRole): { report: string; purpose: string; status: string } {
  const requirement = [...requiredUploadRoles, ...optionalUploadRoles].find((item) => item.role === role);
  if (!requirement) {
    return { report: "Unsupported report", purpose: "Not imported", status: "Rejected" };
  }
  if (role === "search_term_summary") {
    return { report: requirement.title, purpose: "Optional validation only; never added to totals", status: "Validation only" };
  }
  if (role === "business_report") {
    return { report: requirement.title, purpose: "Retail performance; partial catalog coverage", status: "Partial" };
  }
  const purposes: Partial<Record<UploadRole, string>> = {
    advertised_product: "Dashboard source",
    campaign: "Budgets and campaign settings",
    placement: "Placement analysis",
    targeting: "Bidding evidence",
  };
  return { report: requirement.title, purpose: purposes[role] ?? requirement.description, status: "Ready" };
}

export function prepareUploadFiles(inputs: UploadFileInput[]): { files: ClassifiedUpload[]; validation: ImportValidation } {
  if (!inputs.length) throw new Error("Choose the five required CSV files.");
  const files = inputs.map((input) => {
    if (!input.name.toLowerCase().endsWith(".csv")) {
      throw new Error(`${input.name} is not a CSV. Product source-of-truth XLSX files remain fixed and must not be uploaded.`);
    }
    const parsed = parseCsv(input.text);
    return { ...input, ...parsed, role: classifyUpload(parsed.headers, input.name) };
  });
  return { files, validation: validateClassifiedFiles(files) };
}

export function buildRuntimeSnapshot(
  classifiedFiles: ClassifiedUpload[],
  validation: ImportValidation,
  baseSnapshot: BaseSnapshot,
  snapshotId: string,
): Record<string, unknown> {
  const byRole = new Map(classifiedFiles.map((file) => [file.role, file]));
  const advertisedRows = byRole.get("advertised_product")!.rows;
  const campaignRows = byRole.get("campaign")!.rows;
  const placementRows = byRole.get("placement")!.rows;
  const targetingRows = byRole.get("targeting")!.rows;
  const businessRows = byRole.get("business_report")!.rows;

  const activeProducts = new Map(baseSnapshot.products.map((product) => [product.sku, { ...product, active: true }]));
  const asinToSku = new Map(baseSnapshot.products.filter((product) => product.asin).map((product) => [product.asin, product.sku]));
  const daily = new Map<string, NumberMap>();
  const productAds = new Map<string, NumberMap & { sku?: string; asin?: string; name?: string }>();
  const adGroupProducts = new Map<string, Map<string, NumberMap>>();
  const validAdvertisedRows = advertisedRows.filter((row) => row["Budget currency"] === "EUR" && row["Advertised product marketplace"] === "AMAZON_DE");

  for (const row of validAdvertisedRows) {
    const date = parseDate(row.Date);
    if (!date) continue;
    const sku = repairText(row["Advertised product SKU"] ?? "");
    const asin = cleanId(row["Advertised product ID"] ?? "");
    const productKey = sku || asin;
    const values: NumberMap = {
      impressions: metric(parseNumber(row.Impressions)),
      clicks: metric(parseNumber(row.Clicks)),
      spend: metric(parseNumber(row["Total cost"])),
      purchases: metric(parseNumber(row.Purchases)),
      sales: metric(parseNumber(row.Sales)),
      units: metric(parseNumber(row["Units sold"])),
    };
    const day = daily.get(date) ?? {};
    for (const [key, value] of Object.entries(values)) addMetric(day, key, value);
    daily.set(date, day);
    if (productKey) {
      const productBucket = productAds.get(productKey) ?? {};
      for (const [key, value] of Object.entries(values)) addMetric(productBucket, key, value);
      productBucket.sku = sku;
      productBucket.asin = asin;
      productBucket.name = repairText(row["Advertised product name"] ?? "");
      productAds.set(productKey, productBucket);
    }
    const campaignId = cleanId(row["Campaign ID"] ?? "");
    const adGroupId = cleanId(row["Ad group ID"] ?? "");
    if (campaignId && adGroupId && productKey) {
      const groupKey = `${campaignId}\u0000${adGroupId}`;
      const members = adGroupProducts.get(groupKey) ?? new Map<string, NumberMap>();
      const member = members.get(productKey) ?? {};
      for (const key of ["impressions", "clicks", "spend", "sales"]) addMetric(member, key, values[key]);
      members.set(productKey, member);
      adGroupProducts.set(groupKey, members);
    }
  }

  const adGroupProductMap = new Map<string, { productKey: string; ambiguous: boolean; candidateCount: number }>();
  for (const [key, members] of adGroupProducts) {
    const ranked = [...members.entries()].sort((left, right) =>
      (right[1].spend ?? 0) - (left[1].spend ?? 0)
      || (right[1].clicks ?? 0) - (left[1].clicks ?? 0)
      || (right[1].impressions ?? 0) - (left[1].impressions ?? 0));
    adGroupProductMap.set(key, { productKey: ranked[0][0], ambiguous: ranked.length > 1, candidateCount: ranked.length });
  }

  const retailBySku = new Map<string, Record<string, number | null>>();
  for (const row of businessRows) {
    const sku = repairText(row.SKU ?? "") || asinToSku.get(cleanId(row["(Child) ASIN"] ?? "")) || "";
    if (!sku) continue;
    const sessions = metric(parseNumber(row["Sessions – Total"]));
    const units = metric(parseNumber(row["Units ordered"]));
    retailBySku.set(sku, {
      sessions: rounded(sessions, 0),
      pageViews: rounded(metric(parseNumber(row["Page views – Total"])), 0),
      units: rounded(units, 0),
      sales: rounded(metric(parseNumber(row["Ordered Product Sales"])), 2),
      conversion: rounded(parseNumber(row["Unit Session Percentage"], true)),
      buyBox: rounded(parseNumber(row["Featured Offer (Buy Box) percentage"], true)),
    });
  }

  const normalizedProducts = baseSnapshot.products.map((baseProduct) => {
    const ad = productAds.get(baseProduct.sku) ?? (baseProduct.asin ? productAds.get(baseProduct.asin) : undefined);
    const retail = retailBySku.get(baseProduct.sku) ?? null;
    return {
      ...baseProduct,
      active: true,
      retail,
      advertising: ad ? enrichMetrics(Object.fromEntries(["impressions", "clicks", "spend", "purchases", "sales", "units"].map((key) => [key, metric(ad[key])]))) : null,
      advertisingStatus: ad ? "Observed activity" : "No activity observed",
    };
  }).sort((left, right) => metric((right.advertising as Record<string, number> | null)?.sales) - metric((left.advertising as Record<string, number> | null)?.sales));

  const placementBuckets = new Map<string, NumberMap>();
  for (const row of placementRows) {
    if (row["Budget currency"] !== "EUR") continue;
    const name = repairText(row["Placement classification"] || row["Placement name"] || "Unclassified");
    const bucket = placementBuckets.get(name) ?? {};
    for (const [source, destination] of [["Impressions", "impressions"], ["Clicks", "clicks"], ["Total cost", "spend"], ["Purchases", "purchases"], ["Sales", "sales"]]) {
      addMetric(bucket, destination, metric(parseNumber(row[source])));
    }
    placementBuckets.set(name, bucket);
  }
  const placements = [...placementBuckets.entries()]
    .map(([name, values]) => enrichMetrics({ name, ...values }))
    .sort((left, right) => Number(right.spend) - Number(left.spend));

  const campaigns = campaignRows
    .filter((row) => repairText(row.Country) === "Germany")
    .map((row) => {
      const spend = metric(parseNumber(row["Total cost"]));
      const sales = metric(parseNumber(row.Sales));
      return {
        name: repairText(row["Campaign name"]),
        state: repairText(row.State),
        type: repairText(row.Type),
        targeting: repairText(row.Targeting),
        strategy: repairText(row["Campaign bid strategy"]),
        budget: rounded(parseNumber(row["Campaign budget amount"]), 2),
        topOfSearchShare: rounded(parseNumber(row["Top-of-search impression share (IS)"], true)),
        topOfSearchAdjustment: rounded(parseNumber(row["Top-of-search bid adjustment"], true)),
        spend: rounded(spend, 2),
        sales: rounded(sales, 2),
        acos: rounded(safeRatio(spend, sales)),
        roas: rounded(safeRatio(sales, spend)),
      };
    })
    .sort((left, right) => metric(right.spend) - metric(left.spend));

  const targets = new Map<string, Record<string, unknown>>();
  const targetTerms = new Map<string, Map<string, NumberMap>>();
  const targetDates = new Map<string, string[]>();
  for (const row of targetingRows) {
    if (row["Budget currency"] !== "EUR") continue;
    const campaignId = cleanId(row["Campaign ID"] ?? "");
    const adGroupId = cleanId(row["Ad group ID"] ?? "");
    const targetId = cleanId(row["Target ID"] ?? "") || `${campaignId}|${adGroupId}|${repairText(row.Targeting)}`;
    const target = targets.get(targetId) ?? {
      id: targetId,
      campaignId,
      campaignName: repairText(row["Campaign name"]),
      adGroupId,
      adGroupName: repairText(row["Ad group name"]),
      target: repairText(row.Targeting),
      matchType: repairText(row["Targeting match type"]),
      targetType: repairText(row["Target type"]),
      status: repairText(row["Target status"]),
      bid: rounded(parseNumber(row["Target bid"]), 2),
      impressions: 0,
      clicks: 0,
      spend: 0,
      purchases: 0,
      sales: 0,
      units: 0,
    };
    for (const [source, destination] of [["Impressions", "impressions"], ["Clicks", "clicks"], ["Total cost", "spend"], ["Purchases", "purchases"], ["Sales", "sales"], ["Units sold", "units"]]) {
      target[destination] = metric(target[destination] as number) + metric(parseNumber(row[source]));
    }
    targets.set(targetId, target);
    const currentDate = parseDate(row.Date);
    if (currentDate) targetDates.set(targetId, [...(targetDates.get(targetId) ?? []), currentDate]);
    const term = repairText(row["Search term"] ?? "");
    if (term) {
      const terms = targetTerms.get(targetId) ?? new Map<string, NumberMap>();
      const bucket = terms.get(term) ?? {};
      for (const [source, destination] of [["Impressions", "impressions"], ["Clicks", "clicks"], ["Total cost", "spend"], ["Purchases", "purchases"], ["Sales", "sales"]]) {
        addMetric(bucket, destination, metric(parseNumber(row[source])));
      }
      terms.set(term, bucket);
      targetTerms.set(targetId, terms);
    }
  }

  let matchedTargetCount = 0;
  let ambiguousTargetCount = 0;
  const targetList = [...targets.entries()].map(([targetId, target]) => {
    const mapping = adGroupProductMap.get(`${String(target.campaignId)}\u0000${String(target.adGroupId)}`);
    const adProduct = mapping ? productAds.get(mapping.productKey) : undefined;
    const sku = repairText(adProduct?.sku ?? "") || (adProduct?.asin ? asinToSku.get(adProduct.asin) ?? "" : "");
    const product = sku ? activeProducts.get(sku) : undefined;
    if (product) matchedTargetCount += 1;
    if (mapping?.ambiguous) ambiguousTargetCount += 1;
    const dates = (targetDates.get(targetId) ?? []).sort();
    const terms = [...(targetTerms.get(targetId) ?? new Map()).entries()]
      .map(([term, values]) => enrichMetrics({ term, ...values }))
      .sort((left, right) => Number(right.sales) - Number(left.sales) || Number(right.spend) - Number(left.spend) || Number(right.clicks) - Number(left.clicks))
      .slice(0, 5);
    return enrichMetrics({
      ...target,
      sku: sku || null,
      asin: product?.asin ?? adProduct?.asin ?? null,
      productName: product?.name ?? null,
      price: product?.price ?? null,
      margin: product?.margin ?? null,
      category: product?.category ?? null,
      ambiguousProduct: Boolean(mapping?.ambiguous),
      productCandidateCount: mapping?.candidateCount ?? 0,
      dateStart: dates[0] ?? null,
      dateEnd: dates.at(-1) ?? null,
      topSearchTerms: terms,
    });
  }).sort((left, right) => Number(right.spend) - Number(left.spend) || Number(right.sales) - Number(left.sales));

  const promotionCandidates = normalizedProducts
    .filter((product) => !product.advertising)
    .map((product) => {
      const retail = product.retail as Record<string, number | null> | null;
      const evidence = ["Abverkauf", "Preiseinstieg"].includes(product.category ?? "") ? "Do not promote"
        : product.margin != null && metric(retail?.units) > 0 ? "Strong candidate"
          : product.margin != null ? "Potential candidate" : "Insufficient evidence";
      const score = metric(product.margin) * 100 + metric(retail?.conversion) * 100 + Math.min(metric(retail?.sessions) / 100, 20);
      return {
        sku: product.sku,
        asin: product.asin,
        name: product.name,
        price: product.price,
        margin: product.margin,
        category: product.category,
        retail,
        level: evidence,
        score: rounded(score, 1),
        reason: "No advertising activity was observed in the supplied Advertised Product export.",
      };
    })
    .sort((left, right) => metric(right.score) - metric(left.score));

  const dailyList = [...daily.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, values]) => enrichMetrics({ date, ...values }));
  const adTotals = enrichMetrics(Object.fromEntries(["impressions", "clicks", "spend", "purchases", "sales", "units"].map((key) => [
    key,
    dailyList.reduce((sum, day) => sum + metric(day[key] as number), 0),
  ])));
  const retailTotals: Record<string, number | null> = {
    sales: rounded([...retailBySku.values()].reduce((sum, value) => sum + metric(value.sales), 0), 2),
    sessions: rounded([...retailBySku.values()].reduce((sum, value) => sum + metric(value.sessions), 0), 0),
    units: rounded([...retailBySku.values()].reduce((sum, value) => sum + metric(value.units), 0), 0),
  };
  retailTotals.conversion = rounded(safeRatio(metric(retailTotals.units), metric(retailTotals.sessions)));

  let coveredGrossSales = 0;
  let coveredNetSales = 0;
  let purchaseCost = 0;
  let deliveryCost = 0;
  let provisionCost = 0;
  let coveredCostProducts = 0;
  const missingCostProducts: { sku: string; grossSales: number | null }[] = [];
  for (const product of normalizedProducts) {
    const retail = product.retail as Record<string, number | null> | null;
    const grossSales = metric(retail?.sales);
    if (grossSales <= 0) continue;
    const purchaseUnit = product.unitCosts?.purchaseNet;
    const deliveryUnit = product.unitCosts?.deliveryNet;
    if (purchaseUnit == null || deliveryUnit == null) {
      missingCostProducts.push({ sku: product.sku, grossSales: rounded(grossSales, 2) });
      continue;
    }
    const units = metric(retail?.units);
    const netSales = grossSales / (1 + VAT_RATE);
    coveredGrossSales += grossSales;
    coveredNetSales += netSales;
    purchaseCost += units * purchaseUnit;
    deliveryCost += units * deliveryUnit;
    provisionCost += netSales * PROVISION_RATE;
    coveredCostProducts += 1;
  }
  const adSpend = metric(adTotals.spend as number);
  const totalCost = purchaseCost + deliveryCost + provisionCost + adSpend;
  const netContribution = coveredNetSales - totalCost;
  const profitability = {
    tcos: rounded(safeRatio(adSpend, metric(retailTotals.sales))),
    netContribution: rounded(netContribution, 2),
    netContributionMargin: rounded(safeRatio(netContribution, coveredNetSales)),
    coveredGrossSales: rounded(coveredGrossSales, 2),
    coveredNetSales: rounded(coveredNetSales, 2),
    retailSalesCoverage: rounded(safeRatio(coveredGrossSales, metric(retailTotals.sales))),
    purchaseCost: rounded(purchaseCost, 2),
    deliveryCost: rounded(deliveryCost, 2),
    provisionCost: rounded(provisionCost, 2),
    advertisingCost: rounded(adSpend, 2),
    totalCost: rounded(totalCost, 2),
    vatRate: VAT_RATE,
    provisionRate: PROVISION_RATE,
    missingCostProducts,
  };

  const uploadedImports = classifiedFiles.map((file) => {
    const metadata = roleMetadata(file.role);
    return {
      key: file.role,
      file: file.name,
      path: `Persistent uploads/${snapshotId}/${file.name}`,
      report: metadata.report,
      role: metadata.purpose,
      rows: file.rows.length,
      status: metadata.status,
      sha256: file.sha256,
    };
  });
  const fixedImports = baseSnapshot.imports.filter((item) => ["product_master", "amazon_listing", "economics"].includes(item.key));
  const imports = [...uploadedImports, ...fixedImports];
  const advertisedActiveSkus = normalizedProducts.filter((product) => product.advertising).length;
  const adProductKeys = unique([...productAds.values()].map((value) => value.sku || value.asin || "").filter(Boolean));
  const unmatchedAdvertisingProducts = adProductKeys.filter((key) => !activeProducts.has(key) && !asinToSku.has(key)).length;

  return {
    generatedAt: new Date().toISOString(),
    reporting: {
      start: validation.reportingStart,
      end: validation.reportingEnd,
      days: validation.reportingDays,
      currency: "EUR",
      nativeCurrency: "EUR",
      fxRateToEur: 1,
      marketplaceId: "amazon_de",
      marketplace: "Amazon DE",
      timezone: "Europe/Berlin",
      capabilities: marketplaceRegistry.amazon_de.capabilities,
    },
    settings: baseSnapshot.settings,
    totals: { advertising: adTotals, retail: retailTotals, profitability },
    daily: dailyList,
    placements,
    campaigns,
    products: normalizedProducts,
    targetPerformance: targetList,
    promotionCandidates,
    imports,
    quality: {
      activeProducts: normalizedProducts.length,
      retailCoverageProducts: retailBySku.size,
      economicsCoverageProducts: normalizedProducts.filter((product) => product.margin != null).length,
      netContributionCoverageProducts: coveredCostProducts,
      advertisedActiveProducts: advertisedActiveSkus,
      targets: targetList.length,
      targetsMatchedToActiveProduct: matchedTargetCount,
      ambiguousTargetProductJoins: ambiguousTargetCount,
      unmatchedAdvertisingProducts,
      excludedNonEuroAdvertisedRows: advertisedRows.length - validAdvertisedRows.length,
      duplicateProtection: "Dashboard totals use Advertised Product only. Targeting drives recommendations and already contains the daily search-term evidence. The optional Search Term summary is validation-only.",
      importWarnings: validation.warnings,
    },
    sourceManifest: imports.map((item) => ({ path: item.path, sha256: item.sha256 })),
  };
}

export function normalizeRuntimeImport(
  inputs: UploadFileInput[],
  baseSnapshot: BaseSnapshot,
  snapshotId: string,
): RuntimeImportResult {
  const { files, validation } = prepareUploadFiles(inputs);
  return {
    files,
    validation,
    snapshot: buildRuntimeSnapshot(files, validation, baseSnapshot, snapshotId),
  };
}
