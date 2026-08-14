import assert from "node:assert/strict";
import test from "node:test";
import { productGrossContribution, sortRankedProducts, summarizeUnmatchedRetail, type RankableProduct } from "./product-ranking.ts";

const products: RankableProduct[] = [
  { name: "Alpha", sku: "A", margin: 0.2, retail: { sales: 100, units: 5 } },
  { name: "Bravo", sku: "B", margin: 0.4, retail: { sales: 80, units: 8 } },
  { name: "Charlie", sku: "C", margin: null, retail: { sales: 120, units: 2 } },
];

test("sorts product rankings in both directions while keeping missing margins last", () => {
  assert.deepEqual(sortRankedProducts(products, "revenue", "desc").map((product) => product.sku), ["C", "A", "B"]);
  assert.deepEqual(sortRankedProducts(products, "units", "asc").map((product) => product.sku), ["C", "A", "B"]);
  assert.deepEqual(sortRankedProducts(products, "margin", "desc").map((product) => product.sku), ["B", "A", "C"]);
  assert.deepEqual(sortRankedProducts(products, "margin", "asc").map((product) => product.sku), ["A", "B", "C"]);
});

test("calculates the product-level gross contribution amount", () => {
  assert.equal(productGrossContribution(products[0]), 20);
  assert.equal(productGrossContribution(products[1]), 32);
  assert.equal(productGrossContribution(products[2]), null);
});

test("summarizes only unmatched retail order units", () => {
  const summary = summarizeUnmatchedRetail([
    { source: "Sales GMU", sellerSku: "SKU-A", ean: "1", rows: 2, revenue: 199.98 },
    { source: "Sales GMU", sellerSku: "SKU-B", ean: "2", rows: 1, revenue: 49.99 },
    { source: "SPA EAN performance", sellerSku: "", ean: "3", rows: 4, spend: 20 },
  ]);
  assert.equal(summary.revenue, 249.97);
  assert.equal(summary.units, 3);
  assert.equal(summary.identifiers, 2);
  assert.deepEqual(summary.rows.map((row) => row.sellerSku), ["SKU-A", "SKU-B"]);
});
