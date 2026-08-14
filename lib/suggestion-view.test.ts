import assert from "node:assert/strict";
import test from "node:test";
import snapshot from "../data/generated/normalized.json" with { type: "json" };
import { buildSuggestions } from "./rules-engine.ts";
import { applySuggestionView } from "./suggestion-view.ts";

const suggestions = buildSuggestions(snapshot.targetPerformance, { aggressivenessFactor: 0.7, maxBidChange: 0.2, minimumClicks: 5 });

test("sorts suggestions by each user-facing metric", () => {
  const common = { confidence: "all" as const, review: "all" as const, decisions: {} };
  const byPriority = applySuggestionView(suggestions, { ...common, sort: "priority" });
  const bySpend = applySuggestionView(suggestions, { ...common, sort: "spend" });
  const byProduct = applySuggestionView(suggestions, { ...common, sort: "product" });

  assert.ok(byPriority[0].priority >= byPriority[1].priority);
  assert.ok(bySpend[0].spend >= bySpend[1].spend);
  assert.ok(byProduct[0].productName.localeCompare(byProduct[1].productName) <= 0);
});

test("filters by confidence and review decision", () => {
  const highSuggestions = applySuggestionView(suggestions, { sort: "priority", confidence: "high", review: "all", decisions: {} });
  assert.ok(highSuggestions.length > 0);
  assert.ok(highSuggestions.every((suggestion) => suggestion.confidence === "high"));

  const decisions = { [suggestions[0].id]: "approved" as const, [suggestions[1].id]: "rejected" as const };
  const approved = applySuggestionView(suggestions, { sort: "priority", confidence: "all", review: "approved", decisions });
  const rejected = applySuggestionView(suggestions, { sort: "priority", confidence: "all", review: "rejected", decisions });
  const unreviewed = applySuggestionView(suggestions, { sort: "priority", confidence: "all", review: "unreviewed", decisions });

  assert.deepEqual(approved.map((suggestion) => suggestion.id), [suggestions[0].id]);
  assert.deepEqual(rejected.map((suggestion) => suggestion.id), [suggestions[1].id]);
  assert.ok(unreviewed.every((suggestion) => !decisions[suggestion.id]));
});
