export type ProductComparisonMetric = "revenue" | "units" | "contribution";

export interface ComparableProduct {
  sku: string;
  asin: string;
  name: string;
  category: string | null;
  margin: number | null;
  retail: { sales: number; units: number } | null;
}

export interface ProductComparisonRow {
  sku: string;
  asin: string;
  name: string;
  category: string | null;
  currentValue: number | null;
  referenceValue: number | null;
  absoluteChange: number | null;
  percentageChange: number | null;
  currentMargin: number | null;
  referenceMargin: number | null;
  coverage: "matched" | "current-only" | "reference-only";
}

export function productComparisonValue(product: ComparableProduct | undefined, metric: ProductComparisonMetric): number | null {
  if (!product?.retail) return null;
  if (metric === "units") return product.retail.units;
  if (metric === "contribution") return product.margin == null ? null : product.retail.sales * product.margin;
  return product.retail.sales;
}

export function buildProductComparison(
  currentProducts: ComparableProduct[],
  referenceProducts: ComparableProduct[],
  metric: ProductComparisonMetric,
): ProductComparisonRow[] {
  const currentBySku = new Map(currentProducts.map((product) => [product.sku, product]));
  const referenceBySku = new Map(referenceProducts.map((product) => [product.sku, product]));
  const skus = new Set([...currentBySku.keys(), ...referenceBySku.keys()]);

  return [...skus].flatMap((sku) => {
    const current = currentBySku.get(sku);
    const reference = referenceBySku.get(sku);
    const currentValue = productComparisonValue(current, metric);
    const referenceValue = productComparisonValue(reference, metric);
    if (currentValue == null && referenceValue == null) return [];
    const bothAvailable = currentValue != null && referenceValue != null;
    const absoluteChange = bothAvailable ? currentValue - referenceValue : null;
    const percentageChange = bothAvailable && referenceValue !== 0
      ? (currentValue - referenceValue) / Math.abs(referenceValue)
      : null;
    const identity = current ?? reference;
    if (!identity) return [];
    return [{
      sku,
      asin: identity.asin,
      name: identity.name,
      category: identity.category,
      currentValue,
      referenceValue,
      absoluteChange,
      percentageChange,
      currentMargin: current?.retail && current.margin != null ? current.margin : null,
      referenceMargin: reference?.retail && reference.margin != null ? reference.margin : null,
      coverage: bothAvailable ? "matched" : currentValue != null ? "current-only" : "reference-only",
    }];
  });
}
