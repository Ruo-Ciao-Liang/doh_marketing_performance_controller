import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Marketplace Performance Controller dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Marketplace Performance Controller<\/title>/i);
  assert.match(html, /Amazon DE control room/);
  assert.match(html, /All marketplaces/);
  assert.match(html, /Kaufland DE/);
  assert.match(html, /Advertising sales/);
  assert.match(html, /TCOS/);
  assert.match(html, /Net contribution margin/);
  assert.match(html, /Review suggestions/);
  assert.match(html, /Product ranking/);
  assert.match(html, /Methodology &amp; AI/);
  assert.match(html, /Export all data/);
  assert.match(html, /amazon-bidding-control-all-data\.xlsx/);
  assert.match(html, /Awaiting period/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps the reporting period and export action separated at narrow widths", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(styles, /\.topbar\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(styles, /\.export-all-button\s*\{[^}]*white-space:nowrap/);
  assert.match(styles, /\.topbar\{height:58px;padding:0 16px;gap:10px\}/);
  assert.match(styles, /\.top-actions>\.refresh-status,\.top-actions>\.icon-button\{display:none\}/);
});

test("keeps the rules and immutable import contract visible in source", async () => {
  const [page, rules, importer, model] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/rules-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/import_data.py", import.meta.url), "utf8"),
    readFile(new URL("../docs/data-model.md", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Manual approval required/);
  assert.match(page, /Campaign ad cost/);
  assert.match(page, /Product ad cost/);
  assert.match(page, /Open details for/);
  assert.match(page, /What this metric means/);
  assert.match(page, /Source file/);
  assert.match(page, /businessReportPath/);
  assert.match(page, /Missing-product detail/);
  assert.match(page, /download={`amazon-bidding-control-\$\{data\.reporting\.end\}\.xlsx`}/);
  assert.match(page, /aria-pressed=\{filter === card\.key\}/);
  assert.match(page, /toggleSummaryFilter\(card\.key\)/);
  assert.match(page, /aria-label=\{dayLabel\}/);
  assert.match(page, /function KnowledgeAssistant/);
  assert.match(page, /How everything is calculated/);
  assert.match(page, /No company data is sent to an external AI service/);
  assert.match(page, /Drop the \{requiredFileCount\} required CSV files here/);
  assert.match(page, /seven-report package/);
  assert.match(page, /Advertising reports reconcile/);
  assert.match(page, /Internal SKU ↔ EAN crosswalk/);
  assert.match(page, /Marketplace performance/);
  assert.match(page, /Product source of truth stays fixed/);
  assert.match(page, /Append-only history/);
  assert.match(page, /Reprocess with current product master/);
  assert.match(page, /reprocessSnapshotId/);
  assert.match(page, /MoM and YoY comparisons/);
  assert.match(page, /\/api\/snapshots/);
  assert.match(page, /answerDataQuestion/);
  assert.match(page, /Ask across the complete snapshot/);
  assert.match(page, /Verified answer/);
  assert.match(page, /assistant-results/);
  assert.match(page, /Impression → click/);
  assert.match(page, /Overall conversion/);
  assert.match(page, /Business Report SKUs ÷ active Amazon listing SKUs/);
  assert.match(page, /product-master\.xlsx/);
  assert.match(page, /completed product master/);
  assert.match(page, /function ProductRanking/);
  assert.match(page, /Rank by revenue/);
  assert.match(page, /Gross contribution margin/);
  assert.match(page, /retailCoverageProducts\}\/\{data\.quality\.activeProducts\} retail-covered/);
  assert.match(page, /Explain reported revenue contributors/);
  assert.match(page, /Explain sold-unit contributors/);
  assert.match(page, /Explain which products are ranked/);
  assert.match(page, /Explain weighted gross-margin contributors/);
  assert.match(page, /Explain unmatched Kaufland revenue/);
  assert.match(page, /Unmatched revenue/);
  assert.match(page, /Dashboard revenue/);
  assert.match(page, /No canonical SKU mapping/);
  assert.match(page, /Rank top performers by/);
  assert.match(page, /Show lowest performers first/);
  assert.match(page, /Gross contribution amount equals reported product revenue/);
  assert.match(page, /role="dialog" aria-modal="true"/);
  assert.match(page, /onClick=\{exportReviewed\}/);
  assert.match(page, /createReviewedSuggestionsWorkbook/);
  assert.match(page, /Review at least one suggestion first/);
  assert.match(page, /aria-expanded=\{sortOpen\}/);
  assert.match(page, /aria-expanded=\{filterOpen\}/);
  assert.match(page, /Filter by confidence/);
  assert.match(page, /Filter by review status/);
  assert.match(page, /applySuggestionView/);
  assert.match(page, /Recommendation \/ reason/);
  assert.match(page, /manualReviewReason\(suggestion\)/);
  assert.match(page, /manual-review-reason/);
  assert.match(page, /summarizeUnmatchedRetail/);
  assert.match(rules, /Target ACoS/);
  assert.match(rules, /HARVEST-001/);
  assert.match(importer, /sha256/);
  assert.match(importer, /netContributionMargin/);
  assert.match(model, /Search Term reports are never summed/);
});

test("reprocesses retained raw files without overwriting their source snapshot", async () => {
  const [route, storage] = await Promise.all([
    readFile(new URL("../app/api/snapshots/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/snapshot-storage.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /readSnapshotImportFiles\(reprocessSnapshotId, marketplaceId\)/);
  assert.match(route, /sourceSnapshotId: reprocessSnapshotId/);
  assert.match(route, /productMasterSha256/);
  assert.match(route, /current fixed product sources/);
  assert.match(storage, /SELECT \* FROM import_files WHERE snapshot_id = \?/);
  assert.match(storage, /failed its integrity check/);
  assert.doesNotMatch(storage, /DELETE FROM data_snapshots/);
});

test("persists shared decisions and personal views with revision protection", async () => {
  const [page, route, storage, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app-state/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/collaboration-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0001_lowly_secret_warriors.sql", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Reviews saved for everyone/);
  assert.match(page, /Saved for the organization/);
  assert.match(page, /Recent saved changes/);
  assert.match(page, /changePreferences/);
  assert.match(page, /expectedRevision/);
  assert.match(page, /sidebarPosition/);
  assert.match(page, /Move sidebar to/);
  assert.match(page, /MoM and YoY change/);
  assert.match(page, /Import comparison data/);
  assert.match(page, /Hover a comparison badge to see its exact comparison period/);
  assert.match(route, /getChatGPTUser/);
  assert.match(route, /body\.type === "settings"/);
  assert.match(route, /body\.type === "review"/);
  assert.match(route, /body\.type === "preferences"/);
  assert.match(storage, /RevisionConflictError/);
  assert.match(storage, /WHERE id = \? AND revision = \?/);
  assert.match(storage, /WHERE snapshot_id = \? AND suggestion_id = \? AND revision = \?/);
  assert.match(migration, /CREATE TABLE `organization_settings`/);
  assert.match(migration, /CREATE TABLE `review_decisions`/);
  assert.match(migration, /CREATE TABLE `user_preferences`/);
  assert.match(migration, /CREATE TABLE `change_audit`/);
});

test("ships the complete Excel export as a valid XLSX package", async () => {
  const workbook = await readFile(new URL("../public/exports/amazon-bidding-control-all-data.xlsx", import.meta.url));
  assert.ok(workbook.length > 100_000);
  assert.equal(workbook.subarray(0, 2).toString("ascii"), "PK");
});

test("product ranking reconciles to the reported retail totals", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../data/generated/normalized.json", import.meta.url), "utf8"));
  const rankedProducts = snapshot.products.filter((product) => product.retail != null);
  const revenue = rankedProducts.reduce((sum, product) => sum + product.retail.sales, 0);
  const units = rankedProducts.reduce((sum, product) => sum + product.retail.units, 0);
  assert.equal(rankedProducts.length, snapshot.quality.retailCoverageProducts);
  assert.ok(Math.abs(revenue - snapshot.totals.retail.sales) < 0.01);
  assert.equal(units, snapshot.totals.retail.units);
  assert.equal(snapshot.catalogProducts.length, 1709);
  assert.equal(snapshot.quality.masterCatalogProducts, 1709);
  assert.equal(snapshot.quality.masterCatalogEanProducts, 1565);
  assert.equal(snapshot.imports.find((item) => item.key === "product_master").file, "product-master.xlsx");
});
