# Amazon Bidding Control data model

## Source hierarchy

| Source | Grain | Canonical role |
|---|---|---|
| Completed article master | One canonical internal SKU, with EAN, supplier, cost and available price | Cross-marketplace product source of truth |
| Amazon Product List | One active listing per seller SKU/ASIN | Amazon listing enrichment and active-listing scope |
| Calculation workbook | One economics record per SKU | Contribution margin and strategic category |
| Advertised Product | Date × campaign × ad group × advertised SKU | Dashboard totals, daily trend, product advertising performance |
| Targeting | Date × campaign × ad group × target × search term | Target performance and bidding evidence |
| Placement | Date × campaign × ad group × placement | Placement analysis |
| Campaign | One campaign snapshot | Budget, bid strategy, Top-of-Search settings |
| Business Report | One SKU/child ASIN | Retail sessions, sales, conversion and Buy Box |
| Search Term daily | Date × campaign × ad group × target × search term | Validation only; overlaps Targeting |
| Search Term summary | Variable date range × search term | Validation only; never added to daily totals |

Dashboard totals are sourced only from Advertised Product. Targeting drives recommendations. The two Search Term reports are never summed with either source.

The completed article master contains 1,709 unique internal SKUs, including 1,565 populated EAN rows. Amazon retains its separate 244-listing scope; the supplied Business Report contains 46 distinct Amazon SKU rows, so Amazon retail coverage remains 46/244. Missing retail rows retain `retail: null`; absence is never converted to zero sales or sessions.

## Canonical records

### Product

Primary key: `sku`; fallback lookup: `asin`.

Fields include active status, name, price, contribution margin, strategic category, retail metrics, advertising metrics and observed advertising status. Missing retail or economics data remains `null` and is displayed as `—`.

### Target performance

Primary key: Amazon `Target ID`; fallback key: campaign + ad group + targeting text.

Daily Targeting rows are aggregated to the 30-day target level. Each target is joined to a product through its campaign/ad-group membership in Advertised Product. If an ad group contains more than one product, `ambiguousProduct` is set and the rules engine requires manual review.

### Daily advertising performance

Primary key: ISO date. Metrics are impressions, clicks, spend, purchases, sales and units. Derived ratios—CTR, CVR, ACoS, ROAS, CPC, CPA and AOV—are calculated after aggregation.

### Portfolio profitability

- **TCOS** = all 30-day advertising spend ÷ total 30-day retail sales.
- **Net contribution** = covered net retail sales − purchase cost − delivery cost − provision − all advertising cost.
- **Net contribution margin** = net contribution ÷ covered net retail sales.
- Retail sales are converted from gross to net with the current 19% VAT assumption. Provision is currently assumed at 15% of net sales.
- **Cost coverage** is the share of the retail gross sales already present in the Business Report for which both per-unit purchase and delivery costs are available. Missing cost inputs are excluded from covered sales and listed explicitly; advertising cost is still deducted in full. It is not full-catalog Business Report coverage.

Campaign ad cost in Bidding Suggestions comes from the Campaign export. Product ad cost comes from Advertised Product and reconciles to dashboard advertising spend. Because Campaign and Advertised Product are different exports, a small source-level variance can remain visible instead of being silently forced to match.

### Import and source manifest

Every source stores its relative path, byte size and SHA-256 digest. `scripts/import_data.py --check` compares the current originals with the manifest captured during normalization.

## Locale and scope

- Marketplace: Amazon DE
- Currency: EUR
- Timezone: Europe/Berlin
- Evidence window: 30 days
- Current snapshot: 2026-06-21 through 2026-07-20
- Non-EUR Advertised Product rows are excluded and counted in data quality.

## Missing-data rules

- Missing values are unavailable, not zero.
- Missing contribution margin blocks profitability-based bid changes.
- Missing or ambiguous product joins force manual review.
- No observed advertising activity means only that the SKU is absent from the supplied 30-day Advertised Product export; it does not prove the SKU is outside all campaigns.

## Excel export

The global **Export all data** action generates a multi-sheet XLSX workbook from the active normalized snapshot in the browser. This means a newly imported latest period is exported immediately rather than returning the embedded baseline. The workbook is read-only and never edits or replaces the original advertising, Business Report, product source files, or retained upload archive.

## Snapshot reprocessing

The Data Imports history can rebuild any uploaded snapshot from the exact raw CSV objects retained in persistent storage. Before normalization, each preserved file is re-hashed and compared with its recorded SHA-256 value. The new snapshot uses the current fixed product master, saved marketplace mappings and current marketplace cost settings, records the source snapshot ID and product-master hash, and is appended to history. The original snapshot and its raw files remain unchanged.

The workbook contains Snapshot summary, Daily performance, Products, Campaigns, Placements, Targets, Promotion candidates, Source files, and Data quality sheets. The packaged file in `public/exports/` remains a fallback for the embedded baseline.

## Persistent import history

- The import interface accepts one complete package of seven Amazon CSV files.
- Report roles are detected from headers rather than filenames.
- The completed article master, Amazon listing enrichment and calculation workbook remain fixed and are never accepted by the uploader.
- Raw accepted CSV files and the normalized snapshot are stored in durable object storage.
- Snapshot dates, KPIs, creator and audit metadata are stored in the application database.
- Storage is append-only in the user interface. Exact duplicate source sets are rejected.
- The latest reporting end date drives the dashboard. Older periods remain available for audit and comparison.
- MoM uses a similarly sized snapshot closest to one month earlier; YoY uses one closest to one year earlier. If no suitable snapshot exists, KPI cards show **Awaiting period** rather than inventing a comparison.
