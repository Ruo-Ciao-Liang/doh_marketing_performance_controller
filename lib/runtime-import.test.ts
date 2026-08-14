import assert from "node:assert/strict";
import test from "node:test";
import { IMPORT_CHUNK_BYTES, importChunkRanges, parseImportApiPayload } from "./import-client.ts";
import { collectImportChunksSequentially } from "./import-reassembly.ts";
import { mergeAdvertisingRange } from "./advertising-range.ts";
import { comparableSnapshot, percentageChange } from "./kpi-comparison.ts";
import { classifyUpload, optionalUploadRoles, parseCsv, prepareUploadFiles, requiredUploadRoles, type UploadFileInput } from "./runtime-import.ts";
import { advertisingRangeRequestPath, matchingSnapshot, presetDateRange, snapshotRequestPath } from "./snapshot-selection.ts";

const dates = Array.from({ length: 30 }, (_value, index) => {
  const date = new Date(Date.UTC(2026, 5, 21 + index));
  return date.toISOString().slice(0, 10);
});

const rowsForDates = (headers: string[], values: (date: string) => Record<string, string>) =>
  [headers.join(","), ...dates.map((date) => headers.map((header) => values(date)[header] ?? "x").join(","))].join("\n");

function inputFor(requirement: (typeof requiredUploadRoles)[number]): UploadFileInput {
  const classifierColumns =
    requirement.role === "business_report" ? ["(Parent) ASIN"] :
    requirement.role === "campaign" ? ["Campaign budget amount"] : [];
  const headers = [...new Set([...requirement.requiredColumns, ...classifierColumns])];
  const isDaily = ["advertised_product", "placement", "targeting"].includes(requirement.role);
  const text = isDaily
    ? rowsForDates(headers, (date) => ({
        Date: date,
        "Budget currency": "EUR",
        "Advertised product marketplace": "AMAZON_DE",
        Impressions: "10",
        Clicks: "2",
        "Total cost": "1",
        Purchases: "1",
        Sales: "10",
      }))
    : `${headers.join(",")}\n${headers.map((header) => header === "Budget currency" ? "EUR" : "x").join(",")}`;
  return { name: `${requirement.role}.csv`, size: text.length, text, sha256: requirement.role };
}

test("parses quoted Amazon CSV values without losing delimiters", () => {
  const parsed = parseCsv('Name,Sales\n"Product, blue","1,234.50"\n');
  assert.deepEqual(parsed.headers, ["Name", "Sales"]);
  assert.equal(parsed.rows[0].Name, "Product, blue");
  assert.equal(parsed.rows[0].Sales, "1,234.50");
});

test("builds an encoded API path for a selected retained snapshot", () => {
  assert.equal(snapshotRequestPath("snapshot 2026/07"), "/api/snapshots?id=snapshot%202026%2F07");
  assert.equal(snapshotRequestPath(), "/api/snapshots");
});

test("builds a daily advertising-range API path", () => {
  assert.equal(advertisingRangeRequestPath({ start: "2026-07-01", end: "2026-07-07" }), "/api/snapshots?advertisingStart=2026-07-01&advertisingEnd=2026-07-07");
});

test("builds inclusive reporting ranges from the latest available data date", () => {
  assert.deepEqual(presetDateRange("last-30", "2026-07-20"), { start: "2026-06-21", end: "2026-07-20" });
  assert.deepEqual(presetDateRange("last-full-7", "2026-07-20"), { start: "2026-07-13", end: "2026-07-19" });
  assert.deepEqual(presetDateRange("current-week", "2026-07-20"), { start: "2026-07-20", end: "2026-07-20" });
  assert.deepEqual(presetDateRange("previous-month", "2026-07-20"), { start: "2026-06-01", end: "2026-06-30" });
});

test("selects only a snapshot that exactly matches the requested custom range", () => {
  const history = [
    { id: "latest", periodStart: "2026-06-21", periodEnd: "2026-07-20" },
    { id: "older", periodStart: "2026-05-21", periodEnd: "2026-06-19" },
  ];
  assert.equal(matchingSnapshot(history, { start: "2026-06-21", end: "2026-07-20" })?.id, "latest");
  assert.equal(matchingSnapshot(history, { start: "2026-07-01", end: "2026-07-20" }), null);
});

test("selects the closest similarly sized MoM and YoY comparison snapshots", () => {
  const current = { id: "current", periodEnd: "2026-07-20", periodDays: 30 };
  const history = [
    current,
    { id: "mom-best", periodEnd: "2026-06-20", periodDays: 30 },
    { id: "mom-far", periodEnd: "2026-05-20", periodDays: 30 },
    { id: "yoy-best", periodEnd: "2025-07-20", periodDays: 30 },
    { id: "wrong-grain", periodEnd: "2026-06-20", periodDays: 7 },
  ];
  assert.equal(comparableSnapshot(history, current, "mom")?.id, "mom-best");
  assert.equal(comparableSnapshot(history, current, "yoy")?.id, "yoy-best");
});

test("calculates signed comparison movement without inventing a zero baseline", () => {
  assert.equal(percentageChange(120, 100), 0.2);
  assert.equal(percentageChange(80, 100), -0.2);
  assert.equal(percentageChange(80, 0), null);
  assert.equal(percentageChange(null, 100), null);
});

test("merges daily advertising facts and keeps the newest overlapping upload", () => {
  const merged = mergeAdvertisingRange([
    {
      id: "older",
      createdAt: "2026-07-21T10:00:00Z",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-02",
      daily: [
        { date: "2026-07-01", impressions: 100, clicks: 10, spend: 5, purchases: 1, sales: 20 },
        { date: "2026-07-02", impressions: 100, clicks: 10, spend: 6, purchases: 1, sales: 20 },
      ],
    },
    {
      id: "newer",
      createdAt: "2026-07-27T10:00:00Z",
      periodStart: "2026-07-02",
      periodEnd: "2026-07-03",
      daily: [
        { date: "2026-07-02", impressions: 120, clicks: 12, spend: 7, purchases: 2, sales: 28 },
        { date: "2026-07-03", impressions: 80, clicks: 8, spend: 4, purchases: 1, sales: 16 },
      ],
    },
  ], "2026-07-01", "2026-07-04");
  assert.equal(merged.daily.find((day) => day.date === "2026-07-02")?.spend, 7);
  assert.equal(merged.coverage.overlappingDates, 1);
  assert.deepEqual(merged.coverage.missingDates, ["2026-07-04"]);
  assert.equal(merged.totals.spend, 16);
  assert.equal(merged.totals.sales, 64);
  assert.equal(merged.totals.acos, 0.25);
});

test("parses successful staged-upload responses", () => {
  assert.deepEqual(parseImportApiPayload('{"fileId":"abc","name":"report.csv"}', 201), {
    fileId: "abc",
    name: "report.csv",
  });
});

test("splits multi-megabyte CSV files into request-safe chunks without gaps", () => {
  const fileSize = 5_300_123;
  const ranges = importChunkRanges(fileSize);
  assert.ok(ranges.length > 1);
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges.at(-1)?.end, fileSize);
  assert.ok(ranges.every((range) => range.end - range.start <= IMPORT_CHUNK_BYTES));
  assert.ok(ranges.slice(1).every((range, index) => range.start === ranges[index].end));
});

test("reassembles stored chunks without concurrent reads", async () => {
  let activeReads = 0;
  let maximumConcurrentReads = 0;
  const chunks = await collectImportChunksSequentially(12, async (chunkIndex) => {
    activeReads += 1;
    maximumConcurrentReads = Math.max(maximumConcurrentReads, activeReads);
    await Promise.resolve();
    activeReads -= 1;
    return chunkIndex;
  });
  assert.equal(maximumConcurrentReads, 1);
  assert.deepEqual(chunks, Array.from({ length: 12 }, (_value, index) => index));
});

test("turns a plain-text payload limit response into a useful upload error", () => {
  assert.match(
    String(parseImportApiPayload("Payload Too Large", 413).error),
    /chunk.*too large.*refresh.*retry/i,
  );
});

test("classifies the two Search Term variants by their actual columns", () => {
  assert.equal(classifyUpload(["Search term", "Date range"], "summary.csv"), "search_term_summary");
  assert.equal(classifyUpload(["Search term", "Date", "Target ID"], "daily.csv"), "search_term_daily");
});

test("accepts one complete and date-consistent five-file package", () => {
  const inputs = requiredUploadRoles.map(inputFor);
  const prepared = prepareUploadFiles(inputs);
  assert.equal(prepared.files.length, 5);
  assert.equal(prepared.validation.status, "ready");
  assert.equal(prepared.validation.reportingStart, "2026-06-21");
  assert.equal(prepared.validation.reportingEnd, "2026-07-20");
  assert.equal(prepared.validation.reportingDays, 30);
});

test("accepts the date-range Search Term summary as an optional sixth file", () => {
  const requirement = optionalUploadRoles[0];
  const headers = requirement.requiredColumns;
  const text = `${headers.join(",")}\n${headers.map((header) => header === "Date range" ? '"Jun 21, 2026 - Jul 20, 2026"' : header === "Budget currency" ? "EUR" : "x").join(",")}`;
  const inputs = [
    ...requiredUploadRoles.map(inputFor),
    { name: "search-term-summary.csv", size: text.length, text, sha256: "summary" },
  ];
  const prepared = prepareUploadFiles(inputs);
  assert.equal(prepared.files.length, 6);
  assert.equal(prepared.files.at(-1)?.role, "search_term_summary");
  assert.equal(prepared.validation.status, "ready");
});

test("rejects the redundant daily Search Term export with a clear explanation", () => {
  const headers = ["Search term", "Date", "Target ID", "Budget currency", "Impressions", "Clicks", "Total cost", "Purchases", "Sales"];
  const text = rowsForDates(headers, (date) => ({
    Date: date,
    "Budget currency": "EUR",
    Impressions: "10",
    Clicks: "2",
    "Total cost": "1",
    Purchases: "1",
    Sales: "10",
  }));
  assert.throws(
    () => prepareUploadFiles([
      ...requiredUploadRoles.map(inputFor),
      { name: "daily-search-term.csv", size: text.length, text, sha256: "daily" },
    ]),
    /not needed.*Targeting export already contains the same daily search-term evidence/s,
  );
});

test("rejects duplicate report roles before normalization", () => {
  const text = "Search term,Date range,Budget currency,Impressions,Clicks,Total cost,Purchases,Sales\nterm,range,EUR,1,1,1,1,1";
  assert.throws(() => prepareUploadFiles([
    { name: "one.csv", size: text.length, text, sha256: "one" },
    { name: "two.csv", size: text.length, text, sha256: "two" },
  ]), /Missing required files|Duplicate types/);
});
