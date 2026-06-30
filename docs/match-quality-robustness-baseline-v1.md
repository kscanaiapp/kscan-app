# Match Quality Robustness Baseline v1

Sprint: Match Quality Robustness v1
Branch: `fix/match-quality-robustness-v1` (from `fix/identification-accuracy-v1` @ f2d6da3)
App Staging backend: Supabase project `wyyuqfdxucjksghsmhry`, `scan-identify` ACTIVE v79 (pre-sprint)
Date captured: 2026-06-30

This baseline records the live App Staging `product_catalog` density and color
vocabulary at the start of the sprint, and the decisions that follow from it.
All figures below are from live `execute_sql` reads against the App Staging
project. No Production or Privacy-project data was touched.

---

## 1. Catalog density (Phase 3 gate)

```sql
select canonical_category, count(*) as row_count
from public.product_catalog
group by canonical_category
order by canonical_category;
```

| canonical_category | row_count |
| ------------------ | --------- |
| accessory          | 2         |
| bag                | 2         |
| blazer             | 2         |
| dress              | 2         |
| footwear           | 2         |
| outerwear          | 4         |

Total rows: **14**. All rows fall within the six target categories.

### Availability

```sql
select canonical_category, availability, count(*)
from public.product_catalog
group by canonical_category, availability;
```

Every row is `availability = in_stock` (14 / 14). There are **no** `out_of_stock`
or null-availability rows in the live catalog today — the out-of-stock / null
ordering paths are therefore covered only by unit tests, not by live data.

### Density gate decision

> **Result: `CATALOG_TOO_SPARSE_FOR_SCORING`.**

Every target category has **2–4 rows**, far below the 10-row threshold. Per the
sprint gate:

- No weighted/advanced scoring was added.
- Retrieval keeps **simple deterministic ordering only**:
  1. exact `canonical_category` match (PostgREST `.eq`)
  2. exact color match sorts within category (catalog vocabulary only)
  3. `in_stock` first (then unknown/null, then out_of_stock)
  4. `last_seen_at desc`, then `created_at desc` as the stable tiebreaker

(Note: a soft attribute re-rank — `rankRecommendedProducts` in `scanHelpers.ts` —
already existed from the prior identification-accuracy sprint. It was **not**
extended in this sprint. It re-orders an already category-isolated candidate set
and never widens it, so it is safe under sparse data. No new weights were tuned.)

---

## 2. Color vocabulary (Phase 5)

```sql
select distinct color_normalized
from public.product_catalog
where color_normalized is not null
order by color_normalized;
```

Live catalog `color_normalized` values:

```
black, blue, brown/tan, gold, gray, multicolor, navy, white, white/cream
```

By category:

| category  | colors present              |
| --------- | --------------------------- |
| accessory | brown/tan, gold             |
| bag       | black, brown/tan            |
| blazer    | black, navy                 |
| dress     | multicolor, white/cream     |
| footwear  | brown/tan, white            |
| outerwear | black, blue, gray, navy     |

### Comparison with the normalizer (`scanHelpers.ts → normalizeColor`)

The normalizer emits: `black, white, white/cream, gray/charcoal, gray, navy,
brown/tan, gold, silver, multicolor`, and passes through any other literal color
(e.g. `blue`, `red`).

> **Result: `COLOR_VOCABULARY_ALIGNED`.**

The catalog deliberately uses the same vocabulary the normalizer produces —
including the compound values `brown/tan` and `white/cream`. Retrieval-level
exact color matching (`color_normalized === canonicalColor`) therefore works for
every color the catalog actually stores. No normalization changes were required.

**Known minor limitation (not a correctness bug):** the normalizer can emit
`gray/charcoal` (for charcoal/slate/dark-gray inputs) while the catalog stores
only `gray`. This affects color *sorting* within an already-correct category — a
charcoal coat will not get the exact-color boost against a `gray` row — but it
**never eliminates rows** and never changes which category is returned. Left
as-is to avoid over-fitting to sparse data; revisit if/when charcoal rows are
seeded.

---

## 3. Code posture confirmed by this baseline

- **Category isolation:** `catalogRetrieval.fetchCatalogCandidates` filters with
  PostgREST `.eq('canonical_category', canonicalCategory)` — exact match, no
  `ILIKE`, no cross-category fallback. Unknown/empty/`NON_FASHION` categories and
  zero-match categories return `[]`. → `CATEGORY_ISOLATION_ALREADY_ACTIVE`.
- **Non-fashion:** the `scan-identify` non_fashion branch was changed this sprint
  to force `recommendedProducts: []` (previously it fetched catalog candidates,
  which could leak rows when the model emitted a plausible `item_type` alongside
  `non_fashion: true`).
- **Null availability ordering:** `availabilityPriority` was changed this sprint
  to treat null/missing availability as "unknown" (tier 1), below `in_stock` (2)
  and above explicit `out_of_stock` (0).
