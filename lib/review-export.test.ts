import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import snapshot from "../data/generated/normalized.json" with { type: "json" };
import { buildSuggestions } from "./rules-engine.ts";
import { createReviewedSuggestionsWorkbook, reviewedSuggestionsFilename } from "./review-export.ts";

test("creates a genuine Excel workbook containing only reviewed suggestions", async () => {
  const settings = { aggressivenessFactor: 0.7, maxBidChange: 0.2, minimumClicks: 5 };
  const suggestions = buildSuggestions(snapshot.targetPerformance, settings);
  assert.ok(suggestions.length >= 2);
  const decisions = {
    [suggestions[0].id]: "approved" as const,
    [suggestions[1].id]: "rejected" as const,
  };
  const workbook = createReviewedSuggestionsWorkbook(suggestions, decisions, snapshot.reporting.end);

  assert.equal(new TextDecoder().decode(workbook.subarray(0, 2)), "PK");
  const content = new TextDecoder().decode(workbook);
  assert.match(content, /Reviewed suggestions/);
  assert.match(content, /Review decision/);
  assert.match(content, /Approved/);
  assert.match(content, /Rejected/);
  assert.match(content, new RegExp(suggestions[0].id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(content, new RegExp(suggestions[2]?.id?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "never-match"));
});

test("uses a dated xlsx filename", () => {
  assert.equal(reviewedSuggestionsFilename("2026-07-20"), "amazon-bidding-control-reviewed-2026-07-20.xlsx");
});
