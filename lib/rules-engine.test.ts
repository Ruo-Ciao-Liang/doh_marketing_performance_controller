import assert from "node:assert/strict";
import test from "node:test";
import { buildSuggestions, evaluateTarget, manualReviewReason, type RuleSettings, type TargetPerformance } from "./rules-engine.ts";

const settings: RuleSettings = { aggressivenessFactor: 0.7, maxBidChange: 0.2, minimumClicks: 5 };
const target: TargetPerformance = {
  id: "1", campaignId: "c", campaignName: "Campaign", adGroupId: "a", adGroupName: "Ad group",
  target: "shower enclosure", matchType: "PHRASE", targetType: "", status: "ENABLED", bid: 1,
  sku: "CAB1", asin: "B000000000", productName: "Complete shower", price: 500, margin: 0.3,
  category: "Core", ambiguousProduct: false, impressions: 1000, clicks: 40, spend: 40, purchases: 4,
  sales: 800, units: 4, acos: 0.05, roas: 20, cvr: 0.1, aov: 200, topSearchTerms: [],
};

test("increases a proven profitable target and caps it at maximum CPC", () => {
  const suggestion = evaluateTarget(target, settings);
  assert.equal(suggestion.type, "increase");
  assert.equal(suggestion.change, 0.08);
  assert.equal(suggestion.targetAcos, 0.21);
  assert.equal(suggestion.suggestedBid, 1.08);
});

test("holds when margin is unavailable", () => {
  const suggestion = evaluateTarget({ ...target, margin: null }, settings);
  assert.equal(suggestion.type, "manual_review");
  assert.equal(suggestion.ruleId, "DATA-001");
  assert.equal(manualReviewReason(suggestion), "contribution margin unavailable");
});

test("states every missing input behind a manual review", () => {
  const suggestion = evaluateTarget({ ...target, sku: null, margin: null }, settings);
  assert.equal(manualReviewReason(suggestion), "product match and contribution margin unavailable");
  assert.equal(manualReviewReason(evaluateTarget(target, settings)), null);
});

test("keeps a capability-aware direction when the marketplace has no current bid field", () => {
  const suggestion = evaluateTarget({ ...target, bid: null, bidUnavailableReason: "Kaufland report has no bid", recommendationScope: "product" }, settings);
  assert.equal(suggestion.type, "increase");
  assert.equal(suggestion.change, 0.08);
  assert.equal(suggestion.suggestedBid, null);
  assert.match(suggestion.reason, /directional recommendation only/);
  assert.match(suggestion.evidence.at(-1)!, /Kaufland report has no bid/);
});

test("never exceeds the configured reduction cap", () => {
  const suggestion = evaluateTarget({ ...target, spend: 300, sales: 500, acos: 0.6 }, { ...settings, maxBidChange: 0.15 });
  assert.equal(suggestion.type, "pause_review");
  assert.equal(suggestion.change, -0.15);
});

test("uses saved zero-order thresholds and actions", () => {
  const suggestion = evaluateTarget({
    ...target,
    clicks: 20,
    purchases: 0,
    sales: 0,
    spend: 80,
    acos: null,
  }, {
    ...settings,
    policy: {
      zeroEarlyThreshold: 0.5,
      zeroEarlyReduction: 0.12,
    },
  });
  assert.equal(suggestion.ruleId, "ZERO-075");
  assert.equal(suggestion.change, -0.12);
});

test("uses saved ACoS-band thresholds and bid changes", () => {
  const suggestion = evaluateTarget(target, {
    ...settings,
    policy: {
      strongScaleThreshold: 0.2,
      moderateScaleIncrease: 0.12,
    },
  });
  assert.equal(suggestion.ruleId, "ACOS-080");
  assert.equal(suggestion.change, 0.12);
});

test("harvest suggestions identify both the search term and its discovery target", () => {
  const [suggestion] = buildSuggestions([
    {
      ...target,
      target: "shower enclosure",
      matchType: "PHRASE",
      topSearchTerms: [{
        term: "rain shower 87x87",
        impressions: 250,
        clicks: 12,
        spend: 20,
        purchases: 2,
        sales: 500,
        acos: 0.04,
        cvr: 2 / 12,
        aov: 250,
      }],
    },
  ], settings).filter((item) => item.type === "harvest");

  assert.equal(suggestion.harvestTerm, "rain shower 87x87");
  assert.equal(suggestion.sourceTarget, "shower enclosure");
  assert.equal(suggestion.sourceMatchType, "PHRASE");
  assert.equal(suggestion.destinationCampaign, "Campaign_Exakt");
  assert.equal(suggestion.destinationCampaignIsNew, true);
  assert.equal(suggestion.suggestedBid, 1);
  assert.match(suggestion.reason, /start at €1\.00/i);
  assert.ok(suggestion.evidence.some((item) => /Recommended exact bid €1\.00/.test(item)));
});

test("caps a harvested keyword bid at its safe maximum CPC", () => {
  const [suggestion] = buildSuggestions([
    {
      ...target,
      bid: 10,
      topSearchTerms: [{
        term: "rain shower 87x87",
        impressions: 250,
        clicks: 12,
        spend: 20,
        purchases: 2,
        sales: 500,
        acos: 0.04,
        cvr: 2 / 12,
        aov: 250,
      }],
    },
  ], settings).filter((item) => item.type === "harvest");

  assert.equal(suggestion.maxCpc, 8.75);
  assert.equal(suggestion.suggestedBid, 8.75);
});

test("suppresses harvest when the same product already has the exact keyword", () => {
  const discovery = {
    ...target,
    topSearchTerms: [{
      term: "rain shower 87x87", impressions: 250, clicks: 12, spend: 20,
      purchases: 2, sales: 500, acos: 0.04, cvr: 2 / 12, aov: 250,
    }],
  };
  const existingExact = {
    ...target,
    id: "2",
    campaignName: "Campaign_Exakt",
    target: "Komplettwalk in shower 74x74  90x90",
    matchType: "EXACT",
    topSearchTerms: [],
  };

  const harvest = buildSuggestions([discovery, existingExact], settings)
    .filter((item) => item.type === "harvest" || item.type === "harvest_review");
  assert.equal(harvest.length, 0);
});

test("flags an exact keyword used by another product for conflict review", () => {
  const discovery = {
    ...target,
    topSearchTerms: [{
      term: "rain shower 87x87", impressions: 250, clicks: 12, spend: 20,
      purchases: 2, sales: 500, acos: 0.04, cvr: 2 / 12, aov: 250,
    }],
  };
  const otherProductExact = {
    ...target,
    id: "3",
    campaignName: "Other_Product_Exakt",
    target: "rain shower 87x87",
    matchType: "EXACT",
    sku: "CAB2",
    asin: "B000000002",
    productName: "Other complete shower",
    topSearchTerms: [],
  };

  const [suggestion] = buildSuggestions([discovery, otherProductExact], settings)
    .filter((item) => item.type === "harvest_review");
  assert.equal(suggestion.ruleId, "HARVEST-002");
  assert.equal(suggestion.exactConflicts.length, 1);
  assert.equal(suggestion.exactConflicts[0].campaignName, "Other_Product_Exakt");
});

test("routes a new keyword to an existing exact campaign for the same product", () => {
  const discovery = {
    ...target,
    campaignName: "Campaign_Phrase",
    topSearchTerms: [{
      term: "rain shower 87x87", impressions: 250, clicks: 12, spend: 20,
      purchases: 2, sales: 500, acos: 0.04, cvr: 2 / 12, aov: 250,
    }],
  };
  const otherExactKeyword = {
    ...target,
    id: "4",
    campaignName: "Campaign_Exakt",
    target: "rain shower 79x79",
    matchType: "EXACT",
    topSearchTerms: [],
  };

  const [suggestion] = buildSuggestions([discovery, otherExactKeyword], settings)
    .filter((item) => item.type === "harvest");
  assert.equal(suggestion.destinationCampaign, "Campaign_Exakt");
  assert.equal(suggestion.destinationCampaignIsNew, false);
});

test("uses saved harvest evidence and CPC buffer", () => {
  const discovery = {
    ...target,
    bid: null,
    topSearchTerms: [{
      term: "rain shower 87x87", impressions: 250, clicks: 12, spend: 20,
      purchases: 2, sales: 500, acos: 0.04, cvr: 2 / 12, aov: 250,
    }],
  };
  const stricter = buildSuggestions([discovery], {
    ...settings,
    policy: { harvestMinimumPurchases: 3 },
  }).filter((item) => item.type === "harvest");
  assert.equal(stricter.length, 0);

  const [buffered] = buildSuggestions([discovery], {
    ...settings,
    policy: { harvestMinimumPurchases: 2, harvestBidBuffer: 1.2 },
  }).filter((item) => item.type === "harvest");
  assert.equal(buffered.suggestedBid, 2);
});
