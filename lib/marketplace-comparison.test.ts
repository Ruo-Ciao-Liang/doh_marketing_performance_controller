import test from "node:test";
import assert from "node:assert/strict";
import { comparisonRow, metricsFromSnapshot, rankComparisonRows, shiftedRange } from "./marketplace-comparison.ts";

const snapshot = (marketplaceId: "amazon_de" | "kaufland_de", sales: number, acos: number) => ({
  reporting: { marketplaceId, marketplace: marketplaceId, start: "2026-07-01", end: "2026-07-30", currency: "EUR", fxRateToEur: 1 },
  totals: { advertising: { sales: 100, spend: 20, impressions: 1000, clicks: 100, purchases: 10, ctr: .1, cvr: .1, cpc: .2, cpa: 2, acos, roas: 5 }, retail: { sales, units: 20 }, profitability: { tcos: .1, netContribution: 30, netContributionMargin: .2 } },
  quality: { retailCoverageProducts: 10 },
});

test("normalizes comparable marketplace metrics without filling unavailable values", () => {
  const metrics = metricsFromSnapshot(snapshot("amazon_de", 200, .2));
  assert.equal(metrics.retailSales, 200);
  assert.equal(metrics.netContributionMargin, .2);
  assert.equal(metrics.coveredProducts, 10);
});

test("ranks inverse efficiency metrics lower-first and revenue higher-first", () => {
  const amazon = comparisonRow({ marketplaceId: "amazon_de", snapshot: snapshot("amazon_de", 200, .3), sourceCount: 5 });
  const kaufland = comparisonRow({ marketplaceId: "kaufland_de", snapshot: snapshot("kaufland_de", 100, .1), sourceCount: 5 });
  assert.equal(rankComparisonRows([amazon, kaufland], "retailSales")[0].marketplaceId, "amazon_de");
  assert.equal(rankComparisonRows([amazon, kaufland], "acos")[0].marketplaceId, "kaufland_de");
});

test("uses exact shifted calendar ranges for MoM and YoY lookups", () => {
  assert.deepEqual(shiftedRange("2026-07-01", "2026-07-30", "mom"), { start: "2026-06-01", end: "2026-06-30" });
  assert.deepEqual(shiftedRange("2026-07-01", "2026-07-30", "yoy"), { start: "2025-07-01", end: "2025-07-30" });
});

