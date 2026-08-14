import assert from "node:assert/strict";
import test from "node:test";
import snapshot from "../data/generated/normalized.json" with { type: "json" };
import { answerDataQuestion, type AssistantContext, type AssistantSnapshot } from "./data-assistant.ts";

const baseContext: AssistantContext = {
  data: snapshot as unknown as AssistantSnapshot,
  settings: snapshot.settings,
  topics: [{
    title: "TCOS",
    summary: "Advertising spend divided by reported retail sales.",
    formula: "Advertising spend ÷ reported retail sales",
    sources: [snapshot.imports.find((item) => item.key === "advertised_product")!.path, snapshot.imports.find((item) => item.key === "business_report")!.path],
    aliases: ["total advertising cost of sales"],
  }],
};

test("answers product rankings from the full snapshot", () => {
  const answer = answerDataQuestion("Show the top 3 products by revenue", baseContext);
  assert.equal(answer.status, "answered");
  assert.equal(answer.items?.length, 3);
  assert.match(answer.items?.[0].subtitle ?? "", /SKU00042/);
  assert.equal(answer.entities?.[0].type, "product");
});

test("resolves a SKU and reports its metrics and ranks", () => {
  const answer = answerDataQuestion("Tell me everything about SKU00001", baseContext);
  assert.equal(answer.status, "answered");
  assert.match(answer.headline, /AQUENZA/i);
  assert.ok(answer.facts?.some((fact) => fact.label === "Revenue rank"));
  assert.ok(answer.sources.length >= 3);
});

test("ranks campaigns and targets using requested metrics", () => {
  const campaigns = answerDataQuestion("Which 5 campaigns spend the most?", baseContext);
  assert.match(campaigns.headline, /campaigns by advertising spend/i);
  assert.match(campaigns.items?.[0].title ?? "", /SP_Campaign_001/);

  const targets = answerDataQuestion("Show the top 3 targets by ad spend for SKU00001", baseContext);
  assert.match(targets.headline, /targets by advertising spend/i);
  assert.ok((targets.items?.length ?? 0) > 0 && (targets.items?.length ?? 0) <= 3);
  assert.ok(targets.items?.every((item) => item.subtitle?.includes("SKU00001")));
});

test("filters recommendations and includes suggested bids", () => {
  const answer = answerDataQuestion("Show clean harvests and their suggested bids", baseContext);
  assert.match(answer.headline, /harvest/i);
  assert.ok((answer.items?.length ?? 0) > 0);
  assert.ok(answer.items?.every((item) => item.title.startsWith("Harvest:")));
  assert.ok(answer.items?.every((item) => item.metrics.some((metric) => metric.label === "Bid")));

  const grouped = answerDataQuestion("Which products have the most bid reductions?", baseContext);
  assert.match(grouped.headline, /Products with matching recommendations/);
  assert.ok(grouped.items?.every((item) => item.metrics.some((metric) => metric.label === "Recommendations")));
});

test("explains missing retail coverage without treating it as zero", () => {
  const answer = answerDataQuestion("Which SKUs are absent from the Business Report?", baseContext);
  assert.match(answer.text, /198/);
  assert.match(answer.text, /unavailable, not zero/i);
  assert.equal(answer.facts?.find((fact) => fact.label === "Absent")?.value, "198");
});

test("compares multiple products and supports conversational follow-up", () => {
  const comparison = answerDataQuestion("Compare SKU00001 with SKU00088", baseContext);
  assert.equal(comparison.items?.length, 2);
  const followUp = answerDataQuestion("Tell me more about the second one", {
    ...baseContext,
    previousEntities: comparison.entities,
  });
  assert.equal(followUp.status, "interpreted");
  assert.match(followUp.text, /reported revenue/i);
});

test("returns a transparent unavailable state instead of inventing data", () => {
  const answer = answerDataQuestion("What is our competitor's warehouse inventory?", baseContext);
  assert.equal(answer.status, "unavailable");
  assert.match(answer.text, /will not invent/i);
});

test("returns current metric values when the question asks how much", () => {
  const answer = answerDataQuestion("How much is total TCOS?", baseContext);
  assert.equal(answer.headline, "TCOS");
  assert.match(answer.text, /6\.9%/);
});
