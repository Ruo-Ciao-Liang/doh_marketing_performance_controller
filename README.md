# Amazon Bidding Control

Read-only Amazon DE advertising control application. It ingests immutable CSV/XLSX
export files, normalizes them into a single reconciled snapshot, and produces
explainable, deterministic bidding recommendations. It never writes to Amazon and
requires manual review of every recommendation.

> **Demo data notice.** The embedded dataset in `data/generated/normalized.json`
> and the sample export in `public/exports/` are **synthetic and anonymized** —
> product names, SKUs, EANs, ASINs, suppliers, campaigns and all figures have been
> replaced with fictional values for this public portfolio build. Ratios and joins
> are internally consistent so the app behaves realistically, but no value reflects
> real business data.

## Import a new reporting period

Open **Data imports** in the running application and choose or drag in exactly
seven CSV files:

1. Advertised Product daily
2. Campaign
3. Placement daily
4. Search Term summary
5. Search Term daily with Target ID
6. Targeting daily
7. Business Report

A fixed product master (`product-master.xlsx`) is the canonical source for internal
SKU, EAN, supplier, cost and available price. An Amazon listing export
(`amazon-product-list.xlsx`) supplies seller SKU, title and ASIN enrichment, and a
calculation workbook supplies category and margin detail. The application validates
report roles, required columns, marketplace, currency and reporting dates before
accepting a package. These fixed sources are never accepted by the uploader.

Retained reporting periods can be reprocessed from their preserved raw files after
the fixed product master, crosswalk or marketplace cost settings change.
Reprocessing creates a new checksummed snapshot with lineage back to the original;
it never overwrites or deletes the prior snapshot.

Each accepted package is append-only: normalized period metrics are stored in the
application database and the original uploaded CSV contents are retained in durable
object storage. Older periods are not overwritten, so matching snapshots can power
MoM and YoY KPI comparisons. Exact duplicate file sets are rejected.

The command-line importer in `scripts/import_data.py` rebuilds the embedded baseline
from local source files. It reads sources without modifying them.

## Run locally

```text
pnpm install
pnpm dev
```

## Validate

```text
pnpm run test:rules
pnpm run build
```

The application never writes to Amazon and requires manual review of every
recommendation.
