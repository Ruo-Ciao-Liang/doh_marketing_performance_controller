import assert from "node:assert/strict";
import test from "node:test";
import { buildProductComparison } from "./product-comparison.ts";

const product = (sku: string, sales: number, units: number, margin = 0.25) => ({
  sku,
  asin: `ASIN-${sku}`,
  name: `Product ${sku}`,
  category: "Core",
  margin,
  retail: { sales, units },
});

test("compares product revenue at SKU grain", () => {
  const rows = buildProductComparison([product("A", 120, 6)], [product("A", 100, 5)], "revenue");
  assert.equal(rows[0].absoluteChange, 20);
  assert.equal(rows[0].percentageChange, 0.2);
  assert.equal(rows[0].coverage, "matched");
});

test("does not turn a missing product observation into zero", () => {
  const current = { ...product("A", 120, 6), retail: null };
  const rows = buildProductComparison([current], [product("A", 100, 5)], "revenue");
  assert.equal(rows[0].currentValue, null);
  assert.equal(rows[0].absoluteChange, null);
  assert.equal(rows[0].percentageChange, null);
  assert.equal(rows[0].coverage, "reference-only");
});

test("calculates gross contribution from period revenue and product margin", () => {
  const rows = buildProductComparison([product("A", 200, 8, 0.3)], [product("A", 100, 4, 0.2)], "contribution");
  assert.equal(rows[0].currentValue, 60);
  assert.equal(rows[0].referenceValue, 20);
  assert.equal(rows[0].percentageChange, 2);
});

test("keeps a zero reference baseline transparent", () => {
  const rows = buildProductComparison([product("A", 50, 2)], [product("A", 0, 0)], "revenue");
  assert.equal(rows[0].absoluteChange, 50);
  assert.equal(rows[0].percentageChange, null);
});
