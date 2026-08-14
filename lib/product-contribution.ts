export type ProductContributionMetric =
  | "adSales"
  | "adSpend"
  | "acos"
  | "tcos"
  | "retailSales"
  | "netMargin"
  | "impressions"
  | "clicks"
  | "retailSessions"
  | "retailCoverage";

export interface ContributionProduct {
  sku: string;
  name: string;
  margin: number | null;
  retail: { sales: number; sessions: number } | null;
  advertising: { sales: number; spend: number; impressions: number; clicks: number } | null;
}

export interface ProductContributionSlice {
  id: string;
  label: string;
  secondary: string;
  value: number;
  share: number;
  productCount: number;
  aggregate: boolean;
}

export interface ProductContributionBreakdown {
  title: string;
  subtitle: string;
  centerLabel: string;
  valueKind: "currency" | "integer";
  total: number;
  slices: ProductContributionSlice[];
  note?: string;
}

interface MetricDefinition {
  title: string;
  subtitle: string;
  centerLabel: string;
  valueKind: "currency" | "integer";
  value: (product: ContributionProduct) => number;
  note?: string;
}

const metricDefinitions: Record<Exclude<ProductContributionMetric, "retailCoverage">, MetricDefinition> = {
  adSales: {
    title: "Products contributing advertising sales",
    subtitle: "Attributed advertising sales by advertised product.",
    centerLabel: "Ad sales",
    valueKind: "currency",
    value: (product) => product.advertising?.sales ?? 0,
  },
  adSpend: {
    title: "Products contributing advertising spend",
    subtitle: "Advertising cost by advertised product.",
    centerLabel: "Ad spend",
    valueKind: "currency",
    value: (product) => product.advertising?.spend ?? 0,
  },
  acos: {
    title: "Products contributing the ACoS cost",
    subtitle: "Advertising spend by product—the additive numerator behind portfolio ACoS.",
    centerLabel: "Ad spend",
    valueKind: "currency",
    value: (product) => product.advertising?.spend ?? 0,
    note: "ACoS itself is a ratio and cannot be divided into additive product shares. This donut therefore shows which products contributed the advertising-cost numerator.",
  },
  tcos: {
    title: "Products contributing the TCOS cost",
    subtitle: "Advertising spend by product—the additive numerator behind portfolio TCOS.",
    centerLabel: "Ad spend",
    valueKind: "currency",
    value: (product) => product.advertising?.spend ?? 0,
    note: "TCOS is a ratio. The donut shows product advertising-cost contributions; reported retail sales remain the denominator.",
  },
  retailSales: {
    title: "Products contributing reported retail sales",
    subtitle: "Ordered Product Sales by product for SKUs present in the Business Report.",
    centerLabel: "Retail sales",
    valueKind: "currency",
    value: (product) => product.retail?.sales ?? 0,
  },
  netMargin: {
    title: "Products contributing gross product value",
    subtitle: "Reported retail sales × product contribution margin, before provision and advertising.",
    centerLabel: "Gross contribution",
    valueKind: "currency",
    value: (product) => product.margin == null ? 0 : (product.retail?.sales ?? 0) * product.margin,
    note: "The current data model stores purchase, delivery, provision and advertising costs at portfolio level, so an exact per-product net-contribution split is not available yet. This is the transparent gross product-contribution view.",
  },
  impressions: {
    title: "Products contributing advertising impressions",
    subtitle: "Advertising exposure by advertised product.",
    centerLabel: "Impressions",
    valueKind: "integer",
    value: (product) => product.advertising?.impressions ?? 0,
  },
  clicks: {
    title: "Products contributing advertising clicks",
    subtitle: "Advertising clicks by advertised product.",
    centerLabel: "Clicks",
    valueKind: "integer",
    value: (product) => product.advertising?.clicks ?? 0,
  },
  retailSessions: {
    title: "Products contributing reported retail sessions",
    subtitle: "Sessions by product for SKUs present in the Business Report.",
    centerLabel: "Sessions",
    valueKind: "integer",
    value: (product) => product.retail?.sessions ?? 0,
  },
};

function withShares(slices: Omit<ProductContributionSlice, "share">[], total: number): ProductContributionSlice[] {
  return slices.map((slice) => ({ ...slice, share: total > 0 ? slice.value / total : 0 }));
}

export function buildProductContributionBreakdown(
  metric: ProductContributionMetric,
  products: ContributionProduct[],
  maxIndividualSlices = 5,
): ProductContributionBreakdown {
  if (metric === "retailCoverage") {
    const covered = products.filter((product) => product.retail != null).length;
    const absent = products.length - covered;
    const total = products.length;
    return {
      title: "Retail coverage composition",
      subtitle: "Active catalog products with and without a matching Business Report row.",
      centerLabel: "Active SKUs",
      valueKind: "integer",
      total,
      slices: withShares([
        { id: "covered", label: "Retail-covered products", secondary: "Business Report row available", value: covered, productCount: covered, aggregate: true },
        { id: "absent", label: "Absent products", secondary: "Retail values unavailable", value: absent, productCount: absent, aggregate: true },
      ].filter((slice) => slice.value > 0), total),
      note: "Coverage is a product-count composition. Missing products are unavailable and are not interpreted as zero sales.",
    };
  }

  const definition = metricDefinitions[metric];
  const contributors = products
    .map((product) => ({ product, value: definition.value(product) }))
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
    .sort((left, right) => right.value - left.value || left.product.name.localeCompare(right.product.name));
  const total = contributors.reduce((sum, item) => sum + item.value, 0);
  const individual = contributors.slice(0, Math.max(1, maxIndividualSlices));
  const remainder = contributors.slice(individual.length);
  const slices: Omit<ProductContributionSlice, "share">[] = individual.map(({ product, value }) => ({
    id: product.sku,
    label: product.name,
    secondary: product.sku,
    value,
    productCount: 1,
    aggregate: false,
  }));
  if (remainder.length > 0) {
    slices.push({
      id: "other-products",
      label: "Other products",
      secondary: `${remainder.length} additional contributors`,
      value: remainder.reduce((sum, item) => sum + item.value, 0),
      productCount: remainder.length,
      aggregate: true,
    });
  }
  return {
    title: definition.title,
    subtitle: definition.subtitle,
    centerLabel: definition.centerLabel,
    valueKind: definition.valueKind,
    total,
    slices: withShares(slices, total),
    note: definition.note,
  };
}
