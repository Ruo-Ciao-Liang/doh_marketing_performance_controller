# Amazon Bidding Control implementation plan

## Implemented in this version

- Immutable multi-file import with source hashing and verification.
- Normalized product, retail, advertising, placement, campaign and target records.
- 30-day Amazon DE dashboard with reconciled KPIs, funnel, daily trend, placement view and product table.
- Product catalog with missing-data-safe joins.
- Explainable, deterministic bidding suggestions with product-level target ACoS.
- Editable aggressiveness, bid-change cap and evidence threshold settings.
- Manual approve/reject state in the interface; no Amazon write capability.
- Import audit, join-quality report, promotion-candidate data and initial run history.

## Rule policy

Target ACoS is `Contribution margin × Aggressiveness factor` with a 70% default. Maximum CPC is `AOV × advertising CVR × Target ACoS`. Bid increases are capped by maximum CPC and all changes are capped by the configured weekly maximum.

The engine evaluates missing evidence first, then ambiguous joins, minimum click evidence, zero-order spend thresholds, break-even ACoS, and finally ACoS bands. Every output contains the rule ID, exact evidence, calculation values, risk and limitation.

## Next phases

1. Add a browser-assisted import workflow for newly downloaded files while retaining the immutable archive.
2. Persist reviewer decisions, notes and weekly run history in an authenticated private data store.
3. Add campaign budget suggestions after budget-exhaustion-by-day data is available.
4. Add stock, return, claim, price-competitiveness and seasonality inputs before enabling those safeguards.
5. Backtest at least four to eight weekly snapshots before considering any Amazon API execution.

Automatic campaign changes are intentionally outside this version.
