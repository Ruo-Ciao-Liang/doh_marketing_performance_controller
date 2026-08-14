export type ProductRankingMetric = "revenue" | "units" | "margin";
export type ProductRankingDirection = "desc" | "asc";

export interface RankableProduct {
  name: string;
  sku: string;
  margin: number | null;
  retail: { sales: number; units: number } | null;
}

export interface UnmatchedRetailRow {
  ean?: string;
  sellerSku?: string;
  source?: string;
  rows?: number;
  revenue?: number;
  spend?: number;
}

export function summarizeUnmatchedRetail(rows: UnmatchedRetailRow[]) {
  const retailRows = rows
    .filter((row) => row.source === "Sales GMU" && (row.revenue ?? 0) > 0)
    .sort((left, right) => (right.revenue ?? 0) - (left.revenue ?? 0));
  return {
    rows: retailRows,
    revenue: retailRows.reduce((sum, row) => sum + (row.revenue ?? 0), 0),
    units: retailRows.reduce((sum, row) => sum + (row.rows ?? 0), 0),
    identifiers: retailRows.length,
  };
}

export function productGrossContribution(product: RankableProduct) {
  return product.margin == null ? null : (product.retail?.sales ?? 0) * product.margin;
}

export function productRankingValue(product: RankableProduct, metric: ProductRankingMetric) {
  if (metric === "units") return product.retail?.units ?? 0;
  if (metric === "margin") return product.margin;
  return product.retail?.sales ?? 0;
}

export function sortRankedProducts<T extends RankableProduct>(products: T[], metric: ProductRankingMetric, direction: ProductRankingDirection) {
  return [...products].sort((left, right) => {
    const leftValue = productRankingValue(left, metric);
    const rightValue = productRankingValue(right, metric);
    if (leftValue == null && rightValue == null) return left.name.localeCompare(right.name);
    if (leftValue == null) return 1;
    if (rightValue == null) return -1;
    const difference = direction === "desc" ? rightValue - leftValue : leftValue - rightValue;
    return difference || (right.retail?.sales ?? 0) - (left.retail?.sales ?? 0) || left.name.localeCompare(right.name);
  });
}
