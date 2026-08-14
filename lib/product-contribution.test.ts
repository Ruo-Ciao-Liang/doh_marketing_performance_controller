import assert from "node:assert/strict";
import test from "node:test";
import { buildProductContributionBreakdown, type ContributionProduct } from "./product-contribution.ts";

const products: ContributionProduct[] = [
  { sku: "A", name: "Alpha", margin: 0.3, retail: { sales: 100, sessions: 50 }, advertising: { sales: 80, spend: 20, impressions: 1000, clicks: 20 } },
  { sku: "B", name: "Beta", margin: 0.2, retail: { sales: 60, sessions: 30 }, advertising: { sales: 40, spend: 10, impressions: 500, clicks: 10 } },
  { sku: "C", name: "Charlie", margin: null, retail: null, advertising: { sales: 20, spend: 5, impressions: 250, clicks: 5 } },
];

test("product contribution sorts contributors and reconciles shares", () => {
  const breakdown = buildProductContributionBreakdown("adSales", products);
  assert.equal(breakdown.total, 140);
  assert.deepEqual(breakdown.slices.map((slice) => slice.id), ["A", "B", "C"]);
  assert.ok(Math.abs(breakdown.slices.reduce((sum, slice) => sum + slice.share, 0) - 1) < 0.000001);
});

test("ratio cards expose their additive advertising-cost numerator", () => {
  const breakdown = buildProductContributionBreakdown("acos", products);
  assert.equal(breakdown.total, 35);
  assert.equal(breakdown.centerLabel, "Ad spend");
  assert.match(breakdown.note ?? "", /ratio/i);
});

test("small donut views combine the long tail into Other products", () => {
  const breakdown = buildProductContributionBreakdown("impressions", products, 2);
  assert.equal(breakdown.slices.length, 3);
  assert.equal(breakdown.slices[2].label, "Other products");
  assert.equal(breakdown.slices[2].value, 250);
});

test("retail coverage uses covered and absent product counts", () => {
  const breakdown = buildProductContributionBreakdown("retailCoverage", products);
  assert.equal(breakdown.total, 3);
  assert.deepEqual(breakdown.slices.map((slice) => [slice.id, slice.value]), [["covered", 2], ["absent", 1]]);
});

test("net margin card labels the available gross product-contribution proxy", () => {
  const breakdown = buildProductContributionBreakdown("netMargin", products);
  assert.equal(breakdown.total, 42);
  assert.match(breakdown.title, /gross product value/i);
  assert.match(breakdown.note ?? "", /exact per-product net-contribution split is not available/i);
});
