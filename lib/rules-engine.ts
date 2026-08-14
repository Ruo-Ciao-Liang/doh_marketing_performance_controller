export type RecommendationType = "increase" | "reduce" | "hold" | "pause_review" | "harvest" | "harvest_review" | "manual_review";
export type Confidence = "high" | "medium" | "low";

export interface SearchTermEvidence {
  term: string;
  impressions: number;
  clicks: number;
  spend: number;
  purchases: number;
  sales: number;
  acos: number | null;
  cvr: number | null;
  aov: number | null;
}

export interface TargetPerformance {
  id: string;
  campaignId: string;
  campaignName: string;
  adGroupId: string;
  adGroupName: string;
  target: string;
  matchType: string;
  targetType: string;
  status: string;
  bid: number | null;
  bidUnavailableReason?: string | null;
  recommendationScope?: "target" | "product";
  sku: string | null;
  asin: string | null;
  productName: string | null;
  price: number | null;
  margin: number | null;
  category: string | null;
  ambiguousProduct: boolean;
  impressions: number;
  clicks: number;
  spend: number;
  purchases: number;
  sales: number;
  units: number;
  acos: number | null;
  roas: number | null;
  cvr: number | null;
  aov: number | null;
  topSearchTerms: SearchTermEvidence[];
}

export interface RulePolicy {
  zeroEarlyThreshold: number;
  zeroEarlyReduction: number;
  zeroTargetThreshold: number;
  zeroTargetReduction: number;
  zeroPauseThreshold: number;
  strongScaleThreshold: number;
  strongScaleMinimumPurchases: number;
  strongScaleIncrease: number;
  moderateScaleThreshold: number;
  moderateScaleMinimumPurchases: number;
  moderateScaleIncrease: number;
  holdThreshold: number;
  lightReductionThreshold: number;
  lightReduction: number;
  mediumReductionThreshold: number;
  mediumReduction: number;
  highReduction: number;
  harvestMinimumPurchases: number;
  harvestBidBuffer: number;
}

export const DEFAULT_RULE_POLICY: RulePolicy = {
  zeroEarlyThreshold: 0.75,
  zeroEarlyReduction: 0.10,
  zeroTargetThreshold: 1,
  zeroTargetReduction: 0.15,
  zeroPauseThreshold: 1.5,
  strongScaleThreshold: 0.65,
  strongScaleMinimumPurchases: 3,
  strongScaleIncrease: 0.08,
  moderateScaleThreshold: 0.80,
  moderateScaleMinimumPurchases: 2,
  moderateScaleIncrease: 0.05,
  holdThreshold: 1.10,
  lightReductionThreshold: 1.30,
  lightReduction: 0.05,
  mediumReductionThreshold: 1.60,
  mediumReduction: 0.10,
  highReduction: 0.15,
  harvestMinimumPurchases: 2,
  harvestBidBuffer: 1.10,
};

export interface RuleSettings {
  aggressivenessFactor: number;
  maxBidChange: number;
  minimumClicks: number;
  policy?: Partial<RulePolicy>;
}

export interface ExactTargetConflict {
  campaignName: string;
  adGroupName: string;
  productName: string;
  sku: string | null;
  asin: string | null;
  bid: number | null;
  status: string;
}

export interface Suggestion {
  id: string;
  type: RecommendationType;
  confidence: Confidence;
  priority: number;
  productName: string;
  sku: string | null;
  asin: string | null;
  category: string | null;
  campaignName: string;
  adGroupName: string;
  target: string;
  matchType: string;
  harvestTerm: string | null;
  sourceTarget: string | null;
  sourceMatchType: string | null;
  destinationCampaign: string | null;
  destinationCampaignIsNew: boolean;
  exactConflicts: ExactTargetConflict[];
  currentBid: number | null;
  suggestedBid: number | null;
  bidUnavailableReason?: string | null;
  recommendationScope?: "target" | "product";
  change: number;
  impressions: number;
  clicks: number;
  spend: number;
  purchases: number;
  sales: number;
  acos: number | null;
  targetAcos: number | null;
  breakEvenAcos: number | null;
  maxCpc: number | null;
  observedCpc: number | null;
  reason: string;
  evidence: string[];
  ruleId: string;
  risk: string;
}

export function manualReviewReason(suggestion: Pick<Suggestion, "type" | "ruleId" | "sku" | "breakEvenAcos" | "reason">): string | null {
  if (suggestion.type !== "manual_review") return null;
  if (suggestion.ruleId === "DATA-001") {
    const missing = [
      suggestion.sku ? null : "product match",
      suggestion.breakEvenAcos == null ? "contribution margin" : null,
    ].filter((value): value is string => Boolean(value));
    return `${missing.length ? missing.join(" and ") : "Required product economics"} unavailable`;
  }
  if (suggestion.ruleId === "DATA-002") return "Multiple products make the margin match ambiguous";
  if (suggestion.ruleId === "ZERO-000") return "Product price unavailable for the zero-purchase check";
  if (suggestion.ruleId === "DATA-003") return "Attributed sales do not support a valid ACoS";
  return suggestion.reason;
}

const roundMoney = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
export const resolveRulePolicy = (settings: RuleSettings): RulePolicy => ({ ...DEFAULT_RULE_POLICY, ...(settings.policy ?? {}) });

function confidenceFor(target: TargetPerformance): Confidence {
  if (target.purchases >= 5 || target.clicks >= 40) return "high";
  if (target.purchases >= 2 || target.clicks >= 15) return "medium";
  return "low";
}

function result(
  target: TargetPerformance,
  settings: RuleSettings,
  type: RecommendationType,
  requestedChange: number,
  ruleId: string,
  reason: string,
  risk: string,
): Suggestion {
  const targetAcos = target.margin == null ? null : target.margin * settings.aggressivenessFactor;
  const maxCpc = targetAcos != null && target.aov != null && target.cvr != null
    ? target.aov * target.cvr * targetAcos
    : null;
  const change = clamp(requestedChange, -settings.maxBidChange, settings.maxBidChange);
  let suggestedBid = target.bid == null ? null : roundMoney(Math.max(0.02, target.bid * (1 + change)));
  if (change > 0 && maxCpc != null && suggestedBid != null) suggestedBid = roundMoney(Math.min(suggestedBid, maxCpc));
  const normalizedChange = Math.round((target.bid && suggestedBid != null ? (suggestedBid - target.bid) / target.bid : change) * 10000) / 10000;
  const directionalOnly = target.bid == null && type !== "manual_review";
  const targetLabel = target.target || "Unnamed target";
  const priority = Math.round(
    target.spend * (type === "reduce" || type === "pause_review" ? 1.5 : 0.35)
      + target.sales * (type === "increase" ? 0.08 : 0.01)
      + target.purchases * 4,
  );
  return {
    id: `${target.id}:${ruleId}`,
    type,
    confidence: confidenceFor(target),
    priority,
    productName: target.productName || "Product match unavailable",
    sku: target.sku,
    asin: target.asin,
    category: target.category,
    campaignName: target.campaignName,
    adGroupName: target.adGroupName,
    target: targetLabel,
    matchType: target.matchType,
    harvestTerm: null,
    sourceTarget: null,
    sourceMatchType: null,
    destinationCampaign: null,
    destinationCampaignIsNew: false,
    exactConflicts: [],
    currentBid: target.bid,
    suggestedBid,
    bidUnavailableReason: target.bidUnavailableReason ?? null,
    recommendationScope: target.recommendationScope ?? "target",
    change: normalizedChange,
    impressions: target.impressions,
    clicks: target.clicks,
    spend: target.spend,
    purchases: target.purchases,
    sales: target.sales,
    acos: target.acos,
    targetAcos,
    breakEvenAcos: target.margin,
    maxCpc,
    observedCpc: target.clicks > 0 ? target.spend / target.clicks : null,
    reason: directionalOnly ? `${reason} This is a directional recommendation only because the source package has no verified current bid; no bid amount is estimated from CPC.` : reason,
    evidence: [
      `${target.clicks.toLocaleString("en-GB")} clicks and ${target.purchases.toLocaleString("en-GB")} purchases in the evidence window`,
      `€${target.spend.toFixed(2)} spend and €${target.sales.toFixed(2)} attributed sales`,
      targetAcos == null ? "Contribution margin unavailable" : `Target ACoS ${(targetAcos * 100).toFixed(1)}% = margin ${(target.margin! * 100).toFixed(1)}% × factor ${(settings.aggressivenessFactor * 100).toFixed(0)}%`,
      ...(directionalOnly ? [target.bidUnavailableReason || "Verified current bid unavailable; exact bid amount intentionally omitted"] : []),
    ],
    ruleId,
    risk,
  };
}

export function evaluateTarget(target: TargetPerformance, settings: RuleSettings): Suggestion {
  const policy = resolveRulePolicy(settings);
  if (!target.sku || target.margin == null) {
    return result(
      target,
      settings,
      "manual_review",
      0,
      "DATA-001",
      "Hold for manual review because the product match or contribution margin is unavailable.",
      "A profitability-safe recommendation cannot be calculated until the missing product match or margin is resolved.",
    );
  }

  if (target.ambiguousProduct) {
    return result(
      target,
      settings,
      "manual_review",
      0,
      "DATA-002",
      "Hold because this ad group contains multiple advertised products and the target-to-product margin join is ambiguous.",
      "Applying one product margin to a multi-product ad group could overstate or understate the safe bid.",
    );
  }

  const targetAcos = target.margin * settings.aggressivenessFactor;
  if (target.clicks < settings.minimumClicks) {
    return result(
      target,
      settings,
      "hold",
      0,
      "EVIDENCE-001",
      `Hold because ${target.clicks} clicks are below the ${settings.minimumClicks}-click evidence floor.`,
      "Low-volume results fluctuate; wait for more evidence before changing the bid.",
    );
  }

  if (target.purchases === 0) {
    const targetCostPerOrder = target.price == null ? null : target.price * targetAcos;
    if (targetCostPerOrder == null) {
      return result(target, settings, "manual_review", 0, "ZERO-000", "Hold because zero-purchase spend cannot be compared with a target acquisition cost without a product price.", "The zero-sale threshold is incomplete.");
    }
    const spendRatio = target.spend / targetCostPerOrder;
    if (spendRatio >= policy.zeroPauseThreshold) {
      return result(target, settings, "pause_review", -settings.maxBidChange, "ZERO-150", `Pause or reduce for review: zero purchases after spending ${(spendRatio * 100).toFixed(0)}% of the target cost per order.`, "A pause can reduce discovery coverage; confirm search-term relevance first.");
    }
    if (spendRatio >= policy.zeroTargetThreshold) {
      return result(target, settings, "reduce", -policy.zeroTargetReduction, "ZERO-100", `Reduce ${Math.round(policy.zeroTargetReduction * 100)}% because there are no purchases and spend reached ${(spendRatio * 100).toFixed(0)}% of the target cost per order.`, "The next purchase may arrive after the attribution delay; recheck next week.");
    }
    if (spendRatio >= policy.zeroEarlyThreshold) {
      return result(target, settings, "reduce", -policy.zeroEarlyReduction, "ZERO-075", `Reduce ${Math.round(policy.zeroEarlyReduction * 100)}% because there are no purchases and spend reached ${(spendRatio * 100).toFixed(0)}% of the target cost per order.`, "Evidence is directional rather than conclusive.");
    }
    return result(target, settings, "hold", 0, "ZERO-WAIT", `Hold: the zero-purchase target has not yet spent ${Math.round(policy.zeroEarlyThreshold * 100)}% of its target cost per order.`, "Continue monitoring search-term relevance and conversion.");
  }

  if (target.acos == null) {
    return result(target, settings, "manual_review", 0, "DATA-003", "Hold because attributed sales do not support a valid ACoS calculation.", "The purchase and sales fields are inconsistent.");
  }
  if (target.purchases === 1 && target.acos <= targetAcos) {
    return result(target, settings, "hold", 0, "EVIDENCE-ONE", "Hold despite profitable ACoS because one purchase is not enough evidence for a bid increase.", "One order can materially distort ACoS.");
  }
  if (target.acos > target.margin) {
    return result(target, settings, "pause_review", -0.20, "ACOS-BE", `Reduce by the maximum ${Math.round(settings.maxBidChange * 100)}% and review because ACoS is above the product's contribution-margin break-even.`, "Do not pause automatically; verify margin, attribution, and search-term relevance.");
  }

  const performanceRatio = target.acos / targetAcos;
  if (performanceRatio <= policy.strongScaleThreshold && target.purchases >= policy.strongScaleMinimumPurchases) {
    return result(target, settings, "increase", policy.strongScaleIncrease, "ACOS-065", `Increase up to ${Math.round(policy.strongScaleIncrease * 100)}% because ACoS is at or below ${Math.round(policy.strongScaleThreshold * 100)}% of target with at least ${policy.strongScaleMinimumPurchases} purchases, capped by maximum CPC.`, "Scaling can raise CPC and ACoS; recheck after one weekly cycle.");
  }
  if (performanceRatio <= policy.moderateScaleThreshold && target.purchases >= policy.moderateScaleMinimumPurchases) {
    return result(target, settings, "increase", policy.moderateScaleIncrease, "ACOS-080", `Increase up to ${Math.round(policy.moderateScaleIncrease * 100)}% because ACoS is at or below ${Math.round(policy.moderateScaleThreshold * 100)}% of target with at least ${policy.moderateScaleMinimumPurchases} purchases, capped by maximum CPC.`, "Evidence supports controlled scaling, not an unrestricted increase.");
  }
  if (performanceRatio <= policy.holdThreshold) {
    return result(target, settings, "hold", 0, "ACOS-110", `Hold because ACoS is within the operating band up to ${Math.round(policy.holdThreshold * 100)}% of target.`, "No material bid change is justified.");
  }
  if (performanceRatio <= policy.lightReductionThreshold) {
    return result(target, settings, "reduce", -policy.lightReduction, "ACOS-130", `Reduce ${Math.round(policy.lightReduction * 100)}% because ACoS is above the hold band and no more than ${Math.round(policy.lightReductionThreshold * 100)}% of target.`, "Use a small correction because performance is only moderately above target.");
  }
  if (performanceRatio <= policy.mediumReductionThreshold) {
    return result(target, settings, "reduce", -policy.mediumReduction, "ACOS-160", `Reduce ${Math.round(policy.mediumReduction * 100)}% because ACoS is above the light-reduction band and no more than ${Math.round(policy.mediumReductionThreshold * 100)}% of target.`, "Recheck for conversion or listing issues before a larger cut.");
  }
  return result(target, settings, "reduce", -policy.highReduction, "ACOS-OVER160", `Reduce ${Math.round(policy.highReduction * 100)}% because ACoS is above ${Math.round(policy.mediumReductionThreshold * 100)}% of target.`, "High ACoS may also reflect price, listing, or search-term relevance problems.");
}

const normalizeKeyword = (value: string | null | undefined) => (value || "").trim().toLocaleLowerCase("de-DE").replace(/\s+/g, " ");

function sameProduct(left: TargetPerformance, right: TargetPerformance) {
  if (left.asin && right.asin && left.asin.toUpperCase() === right.asin.toUpperCase()) return true;
  return !!(left.sku && right.sku && left.sku.toUpperCase() === right.sku.toUpperCase());
}

function proposedExactCampaignName(campaignName: string) {
  const replaced = campaignName.replace(/([_\s-])(phrase|broad|auto)$/i, "$1Exakt");
  return replaced === campaignName ? `${campaignName}_Exakt` : replaced;
}

export function buildSuggestions(targets: TargetPerformance[], settings: RuleSettings): Suggestion[] {
  const policy = resolveRulePolicy(settings);
  const base = targets.map((target) => evaluateTarget(target, settings));
  const harvest: Suggestion[] = [];
  const exactTargets = targets.filter((target) => target.matchType.toUpperCase() === "EXACT");

  for (const target of targets) {
    if (target.margin == null || target.matchType.toUpperCase() === "EXACT") continue;
    const targetAcos = target.margin * settings.aggressivenessFactor;
    for (const term of target.topSearchTerms || []) {
      if (/^B0[A-Z0-9]{8}$/i.test(term.term) || term.purchases < policy.harvestMinimumPurchases || term.acos == null || term.acos > targetAcos) continue;

      const matchingExactTargets = exactTargets.filter((exact) => normalizeKeyword(exact.target) === normalizeKeyword(term.term));
      if (matchingExactTargets.some((exact) => sameProduct(target, exact))) continue;

      const productExactCampaigns = exactTargets
        .filter((exact) => sameProduct(target, exact))
        .map((exact) => exact.campaignName)
        .filter((name, index, names) => names.indexOf(name) === index)
        .sort((left, right) => left.localeCompare(right));
      const conflicts: ExactTargetConflict[] = matchingExactTargets.map((exact) => ({
        campaignName: exact.campaignName,
        adGroupName: exact.adGroupName,
        productName: exact.productName || "Product match unavailable",
        sku: exact.sku,
        asin: exact.asin,
        bid: exact.bid,
        status: exact.status,
      }));
      const requiresConflictReview = conflicts.length > 0;
      const destinationCampaign = productExactCampaigns[0] || proposedExactCampaignName(target.campaignName);
      const suggestion = result(
        { ...target, target: term.term, clicks: term.clicks, spend: term.spend, purchases: term.purchases, sales: term.sales, acos: term.acos, cvr: term.cvr, aov: term.aov },
        settings,
        requiresConflictReview ? "harvest_review" : "harvest",
        0,
        requiresConflictReview ? "HARVEST-002" : "HARVEST-001",
        requiresConflictReview
          ? `Review “${term.term}” before creating it because the same exact keyword already advertises ${conflicts.length} other product${conflicts.length === 1 ? "" : "s"}.`
          : `Create an exact-match target for “${term.term}” because it produced ${term.purchases} purchases at or below target ACoS.`,
        requiresConflictReview
          ? "Confirm which product should own the exact keyword to avoid cross-product auction overlap."
          : "Keep the discovery source running at a controlled bid; do not automatically negate it.",
      );
      suggestion.id = `${target.id}:${suggestion.ruleId}:${normalizeKeyword(term.term)}`;
      suggestion.harvestTerm = term.term;
      suggestion.sourceTarget = target.target || "Unnamed discovery target";
      suggestion.sourceMatchType = target.matchType || null;
      suggestion.destinationCampaign = destinationCampaign;
      suggestion.destinationCampaignIsNew = productExactCampaigns.length === 0;
      suggestion.exactConflicts = conflicts;
      const fallbackBid = suggestion.observedCpc == null ? suggestion.maxCpc : suggestion.observedCpc * policy.harvestBidBuffer;
      const startingBid = target.bid ?? fallbackBid;
      suggestion.suggestedBid = startingBid == null
        ? null
        : roundMoney(Math.max(0.02, suggestion.maxCpc == null ? startingBid : Math.min(startingBid, suggestion.maxCpc)));
      const bidBasis = target.bid == null
        ? `${Math.round(policy.harvestBidBuffer * 100)}% of observed CPC (€${suggestion.observedCpc?.toFixed(2) ?? "—"})`
        : `the discovery target bid (€${target.bid.toFixed(2)})`;
      suggestion.reason = `${suggestion.reason} If approved, start at €${suggestion.suggestedBid?.toFixed(2) ?? "—"} in ${destinationCampaign}, using ${bidBasis} without exceeding the safe maximum CPC.`;
      suggestion.evidence.push(
        `Recommended exact bid €${suggestion.suggestedBid?.toFixed(2) ?? "—"} uses ${bidBasis}${suggestion.maxCpc == null ? "" : `, capped at €${suggestion.maxCpc.toFixed(2)} maximum CPC`}`,
        `${productExactCampaigns.length === 0 ? "Proposed new" : "Existing"} destination campaign: ${destinationCampaign}`,
      );
      harvest.push(suggestion);
    }
  }
  return [...base, ...harvest].sort((a, b) => b.priority - a.priority);
}
