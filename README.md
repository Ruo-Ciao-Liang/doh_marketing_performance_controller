# Marketplace Performance Controller

Read-only, multi-marketplace advertising and retail control application. It ingests
immutable CSV/XLSX export files, normalizes them into a single reconciled snapshot,
and surfaces explainable KPIs, product-level performance and contribution margin
across every marketplace through one shared set of pages (dashboard, time-intelligent
KPI comparison, products, product ranking, rules & settings, run history). It never
writes back to any marketplace and requires manual review of every recommendation.

## Supported marketplaces

Switch marketplaces from the top-bar selector. Each one flows through the same shared
pages, in its own native currency, and joins to your uploaded product master for
contribution margin.

| Marketplace | Currency | Reports it ingests |
|-------------|----------|--------------------|
| **Amazon DE** | EUR | Seven Amazon CSVs (Advertised Product, Campaign, Placement, Targeting, Business Report, and the Search Term reports) |
| **Kaufland DE** | EUR | The seven-report Kaufland package (Sales GMU, account listing feed, SPA campaign/EAN/cost reports) |
| **Allegro PL** | PLN, shown with EUR | Campaign statistics, offer/product summary, and (optional) traffic report — every value in złoty with a live, editable PLN→EUR rate |
| **eBay DE** | EUR | Active listings, orders report, and the Promoted Listings reports (priority campaign / listing / keyword / search query, plus general listing) |

> **Demo data notice.** The embedded Amazon baseline in `data/generated/normalized.json`
> and the sample export in `public/exports/` are **synthetic and anonymized** — product
> names, SKUs, EANs, ASINs, suppliers, campaigns and all figures have been replaced with
> fictional values for this public portfolio build. Ratios and joins are internally
> consistent so the app behaves realistically, but no value reflects real business data.

## Product master (contribution margin)

Upload your own completed product master (`.xlsx` or `.csv`) from **Data imports** on
the Amazon tab. It is the canonical source for internal SKU, EAN, supplier, cost and
available price, and it drives the **Net contribution margin** card and per-product
margins on every marketplace. Each marketplace joins to it by SKU:

- **Amazon / eBay** — by internal SKU (eBay's "custom label" / order "Bestandseinheit"),
  with a trailing variant suffix stripped as a fallback.
- **Allegro** — by the Allegro Ads campaign name (which mirrors the internal SKU), then
  by the SKU appearing in the offer title.

Unmatched products stay outside the margin calculation — absence is never coerced to
zero.

## Importing data

Open **Data imports** and drag in the reports for the selected marketplace. The
Allegro, eBay and product-master imports are parsed **entirely in the browser** — no
file is uploaded to a server — and the resulting snapshot is kept in local storage so
it survives a reload. Reports are classified by their column headers, not by file name,
so original export names are fine.

The Amazon path additionally supports server-side, append-only retention (D1 + R2) when
those bindings are configured, so matching snapshots can power MoM and YoY comparisons;
exact-duplicate file sets are rejected. The command-line importer in
`scripts/import_data.py` rebuilds the embedded Amazon baseline from local source files
without modifying them.

## Run locally

```text
pnpm install
pnpm build
pnpm start
```

`pnpm dev` runs the Vite/HMR dev server; if the RSC optimizer trips on your toolchain,
use the production build + `pnpm start` above.

## Validate

```text
pnpm run test:rules
pnpm run build
```

The application never writes back to any marketplace and requires manual review of
every recommendation.
