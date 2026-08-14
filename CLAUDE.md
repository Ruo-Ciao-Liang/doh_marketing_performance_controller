# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install            # Node >= 22.13, pnpm 11.9 (packageManager is pinned)
pnpm dev                # vinext dev server (Vite + Cloudflare plugin, HMR)
pnpm build              # vinext build (also the primary type-check gate)
pnpm start              # serve the production build

pnpm run test:rules     # all lib/*.test.ts unit tests (fast, no build)
pnpm test               # test:rules + build + tests/rendered-html.test.mjs
pnpm run lint           # eslint (ignores dist and .next)

pnpm run db:generate    # drizzle-kit generate -> new migration in drizzle/
pnpm run import:data     # python scripts/import_data.py  (rebuild embedded baseline)
pnpm run data:check      # verify local source files against the stored manifest
```

Run a **single** unit test (tests are plain `node --test` over TS, no Jest/Vitest):

```bash
node --experimental-strip-types --test lib/rules-engine.test.ts
```

There is no watch mode for tests; re-run the command. `pnpm build` is the authoritative type-check — there is no separate `tsc` script.

## Architecture

A **read-only** Amazon DE advertising-control dashboard. It reads immutable CSV/XLSX exports and produces explainable, deterministic bidding suggestions. It **never** writes to Amazon and requires manual review of every recommendation. Treat those two properties as hard invariants when changing code.

**Runtime stack:** `vinext` (a Next.js-App-Router-compatible framework, package name is still `site-creator-vinext-starter`) built with Vite and deployed to **Cloudflare Workers**. `worker/index.ts` is the Worker entry: it handles `/_vinext/image` optimization and delegates everything else to the vinext app-router handler. Bindings come from `.openai/hosting.json`: **D1** database as `DB`, **R2** bucket as `IMPORTS`, plus an `IMAGES` binding. `db/getDb()` throws a clear error if `DB` is missing.

**Two data planes — know which one you're touching:**
- **Embedded baseline:** `data/generated/normalized.json` (~2 MB) is imported *directly* into `app/page.tsx` and ships with the build. It is regenerated only by the Python importer (`scripts/import_data.py`) from the immutable source files in the parent folders. Do not hand-edit it.
- **Runtime imports:** users upload a package of exactly seven Amazon CSVs in the app. These are normalized in TypeScript (`lib/runtime-import.ts`), the raw files are retained in R2, and snapshot metadata/KPIs go into D1. Storage is **append-only**; exact-duplicate file sets are rejected; older periods are kept for MoM/YoY comparison.

**UI:** `app/page.tsx` is a single large `"use client"` component (~2300 lines) — an SPA-style dashboard whose sections are switched via a `PageKey` union (dashboard, marketplace_performance, comparisons, suggestions, products, ranking, imports, rules, knowledge, history). Most logic is delegated to `lib/` rather than living in the component.

**`lib/` is the domain core** — pure, individually unit-tested TypeScript modules. Key ones:
- `rules-engine.ts` — the deterministic bidding engine. `buildSuggestions`/`evaluateTarget` emit a `Suggestion` carrying rule ID, exact evidence, calculation values, risk and limitation. Rule order: missing-evidence → ambiguous join → min-click evidence → zero-order spend → break-even ACoS → ACoS bands. Policy: Target ACoS = `contribution margin × aggressiveness` (default 70%); Max CPC = `AOV × ad CVR × Target ACoS`; changes capped by Max CPC and a weekly max.
- `runtime-import.ts` — CSV parsing plus role classification **from headers, not filenames**, and package validation (roles, columns, marketplace, currency, dates).
- `data-assistant.ts` — natural-language Q&A over a snapshot. `kpi-comparison.ts` / `marketplace-comparison.ts` / `product-*.ts` — comparison and ranking logic. `*-export.ts` — in-browser multi-sheet XLSX generation. `*-storage.ts` — D1/R2 persistence helpers.

**Database:** Drizzle ORM over D1 (SQLite). Schema in `db/schema.ts` (`data_snapshots`, `import_files`, `organization_settings`, `review_decisions`, `user_preferences`, `change_audit`, `product_identifier*`, `marketplace_settings`). Migrations are committed SQL in `drizzle/` — generate with `db:generate`, never edit generated migrations by hand.

**Auth:** `app/chatgpt-auth.ts` reads `oai-authenticated-user-*` request headers — the app is currently hosted on OpenAI's app platform, so identity is injected by that host rather than by app-owned auth.

## Domain invariants (see docs/data-model.md)

These encode real business rules; violating them produces wrong financial output:
- **Missing means unavailable, never zero.** Null retail/economics render as `—`; absence is never coerced to 0 sales/sessions. Missing contribution margin blocks profitability-based bid changes.
- **Dashboard totals come only from Advertised Product.** Targeting drives recommendations. The two Search Term reports are validation-only and are **never** summed into totals.
- Missing or ambiguous product↔target joins force manual review (an ad group with more than one product sets `ambiguousProduct`).
- The completed article master is the canonical product source of truth; the Amazon Product List and calculation workbook only enrich it. The uploader never accepts these fixed sources.
- Snapshots are append-only and reprocessing creates a new checksummed snapshot with lineage — it never overwrites the prior one. Every source stores path, byte size and SHA-256.
- Scope is Amazon DE / EUR / Europe-Berlin / 30-day evidence window; non-EUR rows are excluded and counted in data quality.

## Filesystem note

`vite.config.ts` relocates Vite's optimizer cache to the OS temp dir because some synced filesystems transiently lock frequently-renamed generated directories. Keep generated/cache output out of the source tree.

## Demo data

The embedded snapshot (`data/generated/normalized.json`) and the sample export in `public/exports/` are synthetic and anonymized — see the README's demo-data notice. Values are internally consistent (ratios, joins and reconciliation hold) but do not reflect real business data.
