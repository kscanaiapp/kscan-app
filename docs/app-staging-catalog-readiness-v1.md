# App Staging Catalog Readiness v1

Backend: Supabase App Staging project `wyyuqfdxucjksghsmhry`, table
`public.product_catalog`.
Captured: 2026-06-30 (live `execute_sql` reads).

> No catalog rows were added or modified in this sprint. This document is a
> read-only readiness assessment plus a recommended owner action. Adding rows is
> gated on explicit owner approval.

---

## Row counts by category

| canonical_category | rows |
| ------------------ | ---- |
| outerwear          | 4    |
| blazer             | 2    |
| footwear           | 2    |
| dress              | 2    |
| bag                | 2    |
| accessory          | 2    |
| **total**          | **14** |

All 14 rows fall within the six target categories. No rows exist for
`pants` or `top` (the normalizer supports them for future rows; none seeded yet).

## Availability counts

| availability | rows |
| ------------ | ---- |
| in_stock     | 14   |

No `out_of_stock` or null-availability rows exist today.

## Color vocabulary present

`black, blue, brown/tan, gold, gray, multicolor, navy, white, white/cream`

These match the `normalizeColor` output vocabulary — retrieval-level exact color
matching is aligned. See `match-quality-robustness-baseline-v1.md`.

## Null / placeholder field audit

| field          | null count (of 14) |
| -------------- | ------------------ |
| price          | 10                 |
| currency       | 0                  |
| image_url      | 0                  |
| product_url    | 0                  |
| color_normalized | 0                |
| availability   | 0                  |
| retailer       | 0                  |
| source         | 0                  |

- Placeholder/`example.com` image URLs: **0**
- Placeholder/`example.com` product URLs: **0**
- `source` = `TEST` for **all 14** rows.
- `retailer` values: `K Scan Demo Catalog` (10), `TEST_RETAILER_A` (2),
  `TEST_RETAILER_B` (2).

The 10 null-price rows confirm the ProductShelf null-price path is exercised by
real catalog data (price simply renders nothing, no crash). All other display
fields are populated.

## Is the catalog too sparse for scoring?

**Yes.** 2–4 rows per category is far below the 10-row minimum the scoring gate
requires. Result: `CATALOG_TOO_SPARSE_FOR_SCORING`. The current catalog is
explicitly test/demo data (`source = TEST`), suitable for verifying category
isolation, color alignment, null safety, and ordering — but **not** for
observing or tuning weighted match quality.

---

## Recommended owner action

Before any advanced ranking/scoring sprint:

1. **Add 10–20 approved TEST rows per target category** (outerwear, blazer,
   footwear, dress, bag, accessory) — i.e. ~60–120 rows total — so per-category
   ordering and color distribution are observable.
2. Include **at least a few `out_of_stock` rows** so in-stock-first ordering is
   verifiable against live data, not only unit tests.
3. Include **a few rows per color** within a category so color-within-category
   sorting is observable.
4. Keep `color_normalized` within the aligned vocabulary
   (`black, white, white/cream, gray, navy, blue, brown/tan, gold, multicolor`,
   etc.) so retrieval-level exact color matching keeps working.

### Asset / data constraints (do not violate)

- Do **not** fabricate retail partnerships or imply real seller relationships.
- Do **not** use unauthorized retailer product images.
- Acceptable assets only: K Scan-owned assets, Supabase Storage test assets,
  owner-approved placeholder URLs, or approved synthetic test product URLs.
- Keep `source = TEST` (or a clearly synthetic marker) on seeded rows.
