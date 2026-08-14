import type { Suggestion } from "./rules-engine.ts";

export type SuggestionSort = "priority" | "acos" | "spend" | "change" | "product";
export type ConfidenceFilter = "all" | Suggestion["confidence"];
export type ReviewFilter = "all" | "unreviewed" | "approved" | "rejected";
export type SuggestionDecision = "approved" | "rejected";

export interface SuggestionViewOptions {
  sort: SuggestionSort;
  confidence: ConfidenceFilter;
  review: ReviewFilter;
  decisions: Record<string, SuggestionDecision>;
}

const descendingNullable = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? Number.NEGATIVE_INFINITY : value;

export function applySuggestionView(suggestions: Suggestion[], options: SuggestionViewOptions) {
  const filtered = suggestions.filter((suggestion) => {
    const confidenceMatches = options.confidence === "all" || suggestion.confidence === options.confidence;
    const decision = options.decisions[suggestion.id];
    const reviewMatches = options.review === "all"
      || (options.review === "unreviewed" ? !decision : decision === options.review);
    return confidenceMatches && reviewMatches;
  });

  return [...filtered].sort((left, right) => {
    if (options.sort === "acos") return descendingNullable(right.acos) - descendingNullable(left.acos) || right.priority - left.priority;
    if (options.sort === "spend") return right.spend - left.spend || right.priority - left.priority;
    if (options.sort === "change") return Math.abs(right.change) - Math.abs(left.change) || right.priority - left.priority;
    if (options.sort === "product") return left.productName.localeCompare(right.productName) || right.priority - left.priority;
    return right.priority - left.priority || left.productName.localeCompare(right.productName);
  });
}
