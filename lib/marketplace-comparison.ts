import { marketplaceRegistry, type MarketplaceId } from "./marketplaces.ts";

export type ComparableMetricKey = "retailSales" | "retailUnits" | "coveredProducts" | "advertisingSales" | "advertisingSpend" | "impressions" | "clicks" | "conversions" | "ctr" | "cvr" | "cpc" | "cpa" | "acos" | "roas" | "tcos" | "netContribution" | "netContributionMargin";

export const comparableMetrics: Array<{ key: ComparableMetricKey; label: string; format: "currency" | "number" | "percent"; lowerIsBetter?: boolean }> = [
  { key: "retailSales", label: "Retail sales", format: "currency" },
  { key: "retailUnits", label: "Units / orders", format: "number" },
  { key: "coveredProducts", label: "Covered products", format: "number" },
  { key: "advertisingSales", label: "Ad sales", format: "currency" },
  { key: "advertisingSpend", label: "Ad spend", format: "currency", lowerIsBetter: true },
  { key: "impressions", label: "Impressions", format: "number" },
  { key: "clicks", label: "Clicks", format: "number" },
  { key: "conversions", label: "Conversions", format: "number" },
  { key: "ctr", label: "CTR", format: "percent" },
  { key: "cvr", label: "CVR", format: "percent" },
  { key: "cpc", label: "CPC", format: "currency", lowerIsBetter: true },
  { key: "cpa", label: "CPA", format: "currency", lowerIsBetter: true },
  { key: "acos", label: "ACoS", format: "percent", lowerIsBetter: true },
  { key: "roas", label: "ROAS", format: "number" },
  { key: "tcos", label: "TCOS", format: "percent", lowerIsBetter: true },
  { key: "netContribution", label: "Net contribution", format: "currency" },
  { key: "netContributionMargin", label: "Net contribution margin", format: "percent" },
];

export interface MarketplaceComparisonRow {
  marketplaceId: MarketplaceId;
  marketplace: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  fxRateToEur: number;
  sourceStatus: "aligned" | "missing";
  sourceCount: number;
  coverageNote: string;
  metrics: Record<ComparableMetricKey, number | null>;
  mom: Partial<Record<ComparableMetricKey, number | null>>;
  yoy: Partial<Record<ComparableMetricKey, number | null>>;
}

const object = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : {};
const numeric = (source: Record<string, unknown>, key: string): number | null => typeof source[key] === "number" && Number.isFinite(source[key]) ? Number(source[key]) : null;
const change = (current: number | null, previous: number | null) => current == null || previous == null || previous === 0 ? null : (current - previous) / Math.abs(previous);

export function metricsFromSnapshot(snapshot: Record<string, unknown>): Record<ComparableMetricKey, number | null> {
  const totals = object(snapshot.totals); const advertising = object(totals.advertising); const retail = object(totals.retail); const profitability = object(totals.profitability); const quality = object(snapshot.quality);
  return {
    retailSales: numeric(retail, "sales"), retailUnits: numeric(retail, "units"), coveredProducts: numeric(quality, "retailCoverageProducts"),
    advertisingSales: numeric(advertising, "sales"), advertisingSpend: numeric(advertising, "spend"), impressions: numeric(advertising, "impressions"), clicks: numeric(advertising, "clicks"), conversions: numeric(advertising, "purchases"),
    ctr: numeric(advertising, "ctr"), cvr: numeric(advertising, "cvr"), cpc: numeric(advertising, "cpc"), cpa: numeric(advertising, "cpa"), acos: numeric(advertising, "acos"), roas: numeric(advertising, "roas"),
    tcos: numeric(profitability, "tcos"), netContribution: numeric(profitability, "netContribution"), netContributionMargin: numeric(profitability, "netContributionMargin"),
  };
}

export function comparisonRow(input: { marketplaceId: MarketplaceId; snapshot: Record<string, unknown>; previousMonth?: Record<string, unknown> | null; previousYear?: Record<string, unknown> | null; sourceCount: number }): MarketplaceComparisonRow {
  const reporting = object(input.snapshot.reporting); const current = metricsFromSnapshot(input.snapshot); const month = input.previousMonth ? metricsFromSnapshot(input.previousMonth) : null; const year = input.previousYear ? metricsFromSnapshot(input.previousYear) : null;
  const mom: MarketplaceComparisonRow["mom"] = {}; const yoy: MarketplaceComparisonRow["yoy"] = {};
  for (const definition of comparableMetrics) { mom[definition.key] = month ? change(current[definition.key], month[definition.key]) : null; yoy[definition.key] = year ? change(current[definition.key], year[definition.key]) : null; }
  return {
    marketplaceId: input.marketplaceId, marketplace: marketplaceRegistry[input.marketplaceId].name,
    periodStart: String(reporting.start ?? ""), periodEnd: String(reporting.end ?? ""), currency: String(reporting.nativeCurrency ?? reporting.currency ?? "EUR"), fxRateToEur: Number(reporting.fxRateToEur ?? 1),
    sourceStatus: "aligned", sourceCount: input.sourceCount, coverageNote: input.previousMonth || input.previousYear ? "Aligned current period with retained comparison history." : "Current period aligned; prior comparison periods are not yet retained.", metrics: current, mom, yoy,
  };
}

export function rankComparisonRows(rows: MarketplaceComparisonRow[], metric: ComparableMetricKey): Array<MarketplaceComparisonRow & { rank: number }> {
  const definition = comparableMetrics.find((item) => item.key === metric)!;
  return rows.filter((row) => row.metrics[metric] != null).sort((a, b) => {
    const delta = Number(b.metrics[metric]) - Number(a.metrics[metric]);
    return definition.lowerIsBetter ? -delta : delta;
  }).map((row, index) => ({ ...row, rank: index + 1 }));
}

export function shiftedRange(start: string, end: string, kind: "mom" | "yoy"): { start: string; end: string } {
  const shift = (value: string) => { const date = new Date(`${value}T12:00:00Z`); if (kind === "mom") date.setUTCMonth(date.getUTCMonth() - 1); else date.setUTCFullYear(date.getUTCFullYear() - 1); return date.toISOString().slice(0, 10); };
  return { start: shift(start), end: shift(end) };
}

