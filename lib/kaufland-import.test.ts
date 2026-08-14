import test from "node:test";
import assert from "node:assert/strict";
import { buildKauflandSnapshot, classifyKauflandUpload, prepareKauflandUploadFiles } from "./kaufland-import.ts";

const file = (name: string, text: string) => ({ name, text, size: text.length, sha256: name });
const packageFiles = () => [
  file("report_sales_gmu_de_hash.csv", "date_inserted;order_number;id_order_unit;ean;offer_id;price;cancel_status;return_status\n2026-07-01 10:00:00;A1;U1;4006381333931;SKU1;11900;not_cancelled;not_returned\n2026-07-01 11:00:00;A2;U2;4006381333931;SKU1;11900;cancelled;not_returned"),
  file("report_account_listing_feed_de_hash.csv", "item_title\tean\tstatus\tprice\tshop_price\tid_offer\tcurrency\nProduct\t4006381333931\tAVAILABLE\t11900\t11900\tSKU1\tEUR"),
  file("SPA_DailyCampaignPerformanceReport_de_01-Jul-2026_01-Jul-2026.csv", "Date;Campaign ID;Campaign Name;Campaign Status;Impressions;Clicks;Total Conversions;Cost (€);Sales (€)\n01.07.2026;1;Test;Active;100;10;2;5,00;20,00"),
  file("SPA_CampaignPerformanceReport_de_01-Jul-2026_01-Jul-2026.csv", "Campaign ID;Campaign Name;Campaign Status;Impressions;Clicks;Total Conversions;Cost (€);Sales (€)\n1;Test;Active;100;10;2;5,00;20,00"),
  file("SPA_EanPerformanceReport_de_01-Jul-2026_01-Jul-2026.csv", "EAN;Category;Impressions;Clicks;Cost (€);Total Conversions;Total Sales (€)\n4006381333931;Bath;100;10;5,00;2;20,00"),
  file("SPA_DailyCost_de_01-Jul-2026_01-Jul-2026.csv", "Date;Costs (€)\n01.07.2026;5,00"),
  file("SPA_DailyCostCampaign_de_01-Jul-2026_01-Jul-2026.csv", "Date;Campaign Name;Costs (€)\n01.07.2026;Test;5,00"),
];

test("classifies all seven verified Kaufland report structures", () => {
  assert.equal(classifyKauflandUpload(["date_inserted", "id_order_unit", "cancel_status"], "report_sales_gmu_de_hash.csv"), "kaufland_sales");
  assert.equal(classifyKauflandUpload(["ean", "id_offer", "shop_price"], "report_account_listing_feed_de_hash.csv"), "kaufland_offers");
  assert.equal(classifyKauflandUpload(["Date", "Campaign ID", "Impressions", "Clicks", "Cost (€)"], "SPA_DailyCampaignPerformanceReport.csv"), "kaufland_spa_daily_campaign");
  assert.equal(classifyKauflandUpload(["Campaign ID", "Impressions", "Clicks", "Cost (€)"], "SPA_CampaignPerformanceReport.csv"), "kaufland_spa_campaign");
  assert.equal(classifyKauflandUpload(["EAN", "Impressions", "Clicks", "Total Sales (€)"], "SPA_EanPerformanceReport.csv"), "kaufland_spa_ean");
  assert.equal(classifyKauflandUpload(["Date", "Costs (€)"], "SPA_DailyCost.csv"), "kaufland_spa_daily_cost");
  assert.equal(classifyKauflandUpload(["Date", "Campaign Name", "Costs (€)"], "SPA_DailyCostCampaign.csv"), "kaufland_spa_daily_cost_campaign");
});

test("requires and reconciles the complete seven-report Kaufland package", () => {
  const prepared = prepareKauflandUploadFiles(packageFiles());
  assert.equal(prepared.files.length, 7);
  assert.equal(prepared.validation.reportingStart, "2026-07-01");
  assert.match(prepared.validation.warnings[0], /directional/);
});

test("uses daily performance once, excludes cancellations, and auto-maps listing offer IDs", () => {
  const prepared = prepareKauflandUploadFiles(packageFiles());
  const snapshot = buildKauflandSnapshot({
    ...prepared,
    snapshotId: "test",
    identifiers: [],
    baseSnapshot: {
      settings: {},
      imports: [],
      products: [{ sku: "SKU1", asin: "ASIN1", name: "Product", price: 120, margin: 0.3, category: "Bath", unitCosts: { purchaseNet: 40, deliveryNet: 10 } }],
    },
    costSettings: { marketplaceId: "kaufland_de", commissionRate: 0.12, vatRate: 0.19, categoryOverrides: {}, confirmed: true, revision: 1, updatedAt: "", updatedBy: "" },
  }) as any;
  assert.equal(snapshot.totals.advertising.spend, 5);
  assert.equal(snapshot.totals.advertising.sales, 20);
  assert.equal(snapshot.totals.retail.sales, 119);
  assert.equal(snapshot.totals.retail.units, 1);
  assert.equal(snapshot.products.length, 1);
  assert.equal(snapshot.products[0].advertising.spend, 5);
  assert.equal(snapshot.quality.cancelledSalesRows, 1);
  assert.equal(snapshot.quality.autoMappedIdentifiers, 1);
});

test("uses the completed product master EAN when the marketplace seller SKU differs", () => {
  const files = packageFiles().map((input, index) => index < 2 ? file(input.name, input.text.replaceAll("SKU1", "MARKET-1")) : input);
  const prepared = prepareKauflandUploadFiles(files);
  const snapshot = buildKauflandSnapshot({
    ...prepared,
    snapshotId: "master-ean",
    identifiers: [],
    baseSnapshot: {
      settings: {},
      imports: [],
      products: [],
      catalogProducts: [{ sku: "INTERNAL-1", ean: "4006381333931", asin: "", name: "Master product", price: 120, margin: 0.3, category: "Bath", unitCosts: { purchaseNet: 40, deliveryNet: 10 } }],
    },
    costSettings: { marketplaceId: "kaufland_de", commissionRate: 0.12, vatRate: 0.19, categoryOverrides: {}, confirmed: true, revision: 1, updatedAt: "", updatedBy: "" },
  }) as any;
  assert.equal(snapshot.products[0].sku, "INTERNAL-1");
  assert.equal(snapshot.products[0].retail.sales, 119);
  assert.equal(snapshot.quality.masterCatalogProducts, 1);
  assert.equal(snapshot.quality.unmatchedProductRows.length, 0);
});

test("does not force a match when seller SKU and master EAN identify different products", () => {
  const prepared = prepareKauflandUploadFiles(packageFiles());
  const snapshot = buildKauflandSnapshot({
    ...prepared,
    snapshotId: "master-conflict",
    identifiers: [],
    baseSnapshot: {
      settings: {},
      imports: [],
      products: [],
      catalogProducts: [
        { sku: "SKU1", ean: "1111111111111", asin: "", name: "Seller SKU product", price: 120, margin: 0.3, category: "Bath", unitCosts: { purchaseNet: 40, deliveryNet: 10 } },
        { sku: "SKU2", ean: "4006381333931", asin: "", name: "EAN product", price: 120, margin: 0.3, category: "Bath", unitCosts: { purchaseNet: 40, deliveryNet: 10 } },
      ],
    },
    costSettings: { marketplaceId: "kaufland_de", commissionRate: 0.12, vatRate: 0.19, categoryOverrides: {}, confirmed: true, revision: 1, updatedAt: "", updatedBy: "" },
  }) as any;
  assert.equal(snapshot.totals.retail.sales, 119);
  assert.equal(snapshot.products.find((product: any) => product.sku === "SKU2")?.retail, null);
  assert.equal(snapshot.quality.identifierConflicts.length, 1);
  assert.equal(snapshot.quality.unmatchedProductRows.find((row: any) => row.source === "Sales GMU")?.revenue, 119);
});

test("accepts an exact internal seller SKU with a marketplace-specific EAN", () => {
  const prepared = prepareKauflandUploadFiles(packageFiles());
  const snapshot = buildKauflandSnapshot({
    ...prepared,
    snapshotId: "marketplace-ean-alias",
    identifiers: [],
    baseSnapshot: {
      settings: {},
      imports: [],
      products: [],
      catalogProducts: [
        { sku: "SKU1", ean: "1111111111111", asin: "", name: "Seller SKU product", price: 120, margin: 0.3, category: "Bath", unitCosts: { purchaseNet: 40, deliveryNet: 10 } },
      ],
    },
    costSettings: { marketplaceId: "kaufland_de", commissionRate: 0.12, vatRate: 0.19, categoryOverrides: {}, confirmed: true, revision: 1, updatedAt: "", updatedBy: "" },
  }) as any;
  assert.equal(snapshot.products[0].retail.sales, 119);
  assert.equal(snapshot.quality.identifierConflicts.length, 0);
  assert.equal(snapshot.quality.identifierWarnings.length, 1);
  assert.equal(snapshot.quality.unmatchedProductRows.find((row: any) => row.source === "Sales GMU"), undefined);
});

test("blocks mismatched overlapping advertising reports", () => {
  const files = packageFiles();
  files[3] = file(files[3].name, files[3].text.replace("5,00;20,00", "7,00;20,00"));
  assert.throws(() => prepareKauflandUploadFiles(files), /does not reconcile/);
});
