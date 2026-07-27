# Catalog Ingest v1 — App Staging

## Purpose

This document describes how to seed and import real product data into the `product_catalog` table for the scan-identify backend retrieval layer.

## Target Project

**App Staging only.**

```text
Project ref: wyyuqfdxucjksghsmhry
```

Do **not** apply to the Privacy project.
Do **not** apply to Production without explicit validation.

---

## Required CSV Columns

| Column | Required | Description |
|--------|----------|-------------|
| `retailer` | Yes | Retailer name (e.g., "NET-A-PORTER", "SSENSE") |
| `product_name` | Yes | Product display name |
| `canonical_category` | Yes | Normalized category from ranker taxonomy (`blazer`, `outerwear`, `dress`, `pants`, `top`, `footwear`, `bag`, `accessory`, `NON_FASHION`) |
| `brand` | No | Brand or designer name |
| `description` | No | Short product description |
| `price` | No | Numeric price (e.g., `299.00`) |
| `currency` | No | ISO currency (default `USD`) |
| `product_url` | No | Purchase / product detail URL |
| `image_url` | No | Primary product image URL |
| `availability` | No | `in_stock`, `available`, `out_of_stock`, `unknown` (default `unknown`) |
| `color_normalized` | No | Normalized color (e.g., `black`, `gray/charcoal`, `white/cream`) |
| `material_tags` | No | Array of materials (e.g., `wool blend,leather`) |
| `silhouette_tags` | No | Array of silhouettes (e.g., `tailored/structured,oversized/relaxed`) |
| `style_tags` | No | Array of style tags (e.g., `minimalist,workwear,evening`) |
| `pattern_tags` | No | Array of patterns (e.g., `solid,floral,striped`) |
| `distinctive_features` | No | Array of features (e.g., `gold buttons,structured shoulders`) |
| `search_text` | No | Free-text search string |
| `source` | No | Feed source label (default `manual`) |
| `external_product_id` | No | Retailer SKU or external ID |
| `last_seen_at` | No | ISO timestamp of last feed sync |

## Template

See `scripts/catalog-template.csv` for a CSV template with example row.

**Important:** Remove the example row before importing real data. The example row is marked with `EXAMPLE_` prefixes and `EXAMPLE` source.

---

## Migration

Apply migration to App Staging before inserting products:

```bash
supabase db push --project-ref wyyuqfdxucjksghsmhry
```

Migration file:

```text
supabase/migrations/202606290001_product_catalog.sql
```

Verify table exists after migration:

```sql
SELECT count(*) FROM public.product_catalog;
```

Expected: `0` before seeding.

---

## Secrets Check

Before deploying the Edge Function, verify secrets exist on App Staging:

```bash
supabase secrets list --project-ref wyyuqfdxucjksghsmhry
```

Required secrets:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SCAN_GEMINI_MODEL
GEMINI_API_KEY
```

If `SUPABASE_SERVICE_ROLE_KEY` is missing, catalog retrieval is silently disabled and `recommendedProducts` remains `[]`. This is a staging deployment blocker for catalog retrieval.

Do **not** print secret values in logs or terminal output.

---

## Import Real Products

### Option 1: SQL INSERT (small batches)

```sql
INSERT INTO public.product_catalog (
  retailer, brand, product_name, canonical_category, description,
  price, currency, product_url, image_url, availability,
  color_normalized, material_tags, silhouette_tags, style_tags,
  distinctive_features, search_text, source, external_product_id, last_seen_at
) VALUES
  ('NET-A-PORTER', 'Gucci', 'Double-breasted wool blazer', 'blazer', 'Tailored wool blazer with gold buttons', 2190, 'USD', 'https://example.com/p/1', 'https://example.com/img/1.jpg', 'in_stock', 'black', '{"wool blend","silk lining"}', '{"tailored/structured"}', '{"minimalist","workwear","luxury"}', '{"gold buttons","structured shoulders"}', 'black tailored blazer gold buttons', 'feed', 'net-12345', now()),
  ('SSENSE', 'Acne Studios', 'Oversized denim jacket', 'outerwear', 'Relaxed oversized denim jacket in washed blue', 450, 'USD', 'https://example.com/p/2', 'https://example.com/img/2.jpg', 'in_stock', 'blue', '{"denim"}', '{"oversized/relaxed"}', '{"casual","streetwear"}', '{"distressed hem","oversized pockets"}', 'blue denim jacket oversized', 'feed', 'ss-67890', now());
```

### Option 2: CSV Import via Supabase Dashboard

1. Prepare `scripts/catalog-template.csv` with real data, removing the example row.
2. Open App Staging SQL Editor or Table Editor.
3. Import CSV into `public.product_catalog`.

### Option 3: Programmatic (recommended for recurring feeds)

Use `supabase-js` service-role client with upsert:

```js
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

await supabase.from('product_catalog').upsert(rows, { onConflict: 'external_product_id' });
```

---

## Verify Product Rows

```sql
SELECT canonical_category, count(*) FROM public.product_catalog GROUP BY canonical_category;
```

Expected: non-zero counts for each category you seeded.

---

## Deploy Edge Function

Use the guarded path — see [docs/edge-function-deployment.md](edge-function-deployment.md).
A raw `supabase functions deploy` runs no parity verification and can ship a
non-canonical branch copy.

```bash
node scripts/deploy-edge-functions.js --function scan-identify --confirm-deploy scan-identify
```

---

## Scan Smoke Test

After deployment and seeding, run a scan through the app or a curl test:

```bash
curl -X POST https://wyyuqfdxucjksghsmhry.supabase.co/functions/v1/scan-identify \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"mode":"text","textQuery":"black tailored blazer with gold buttons"}'
```

Expected: `recommendedProducts` should contain real products from `product_catalog` with `matchScore`, `similarityPercentage`, and `confidenceTier` fields.

If `recommendedProducts` is `[]`, check:

1. `product_catalog` has rows for the queried category.
2. `SUPABASE_SERVICE_ROLE_KEY` is set in App Staging secrets.
3. Edge Function logs show `[scan-identify] catalog_client_not_available` (missing key) or `[catalogRetrieval] query_error` (query issue).

---

## Non-Fashion Behavior

Non-fashion scans will also query `product_catalog` by `canonical_category`. If the category is `NON_FASHION`, the catalog query returns `[]` because `product_catalog` should not contain `NON_FASHION` rows. This is expected.

---

## RLS and Security

- `product_catalog` has RLS enabled.
- No public read policies exist in v1.
- Edge Functions access via `SUPABASE_SERVICE_ROLE_KEY`.
- No raw scan images, base64, or PII are stored in the catalog.

---

## Retailer Neutrality

The catalog does not privilege any retailer. All retailers are indexed equally. The ranker scores by attribute overlap, not by retailer name.

---

## Limitations v1

- No vector / semantic search. Queries are exact `canonical_category` match only.
- No price filtering or availability hard-block. Availability is a sort boost, not a filter.
- No pagination. Returns up to 30 rows, ranks top 10.
- No automatic feed sync. `last_seen_at` is manual or feed-script managed.
