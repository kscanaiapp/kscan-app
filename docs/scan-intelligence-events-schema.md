# Scan Intelligence Events Schema

Phase 1.1 adds fail-safe image-scan metadata capture in the `scan-identify` Edge Function, but it does not create or apply a database migration.

This repo does not currently contain a suitable `scan_intelligence` / `scan_events` table for that capture path. The function therefore attempts a safe insert only when the service-role environment is available, and it skips cleanly if the table is missing.

Preferred future table:

```sql
create table if not exists public.scan_intelligence_events (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null,
  user_id uuid null,
  mode text not null,
  is_fashion boolean null,

  category text null,
  item_type text null,
  subtype text null,
  brand_guess text null,
  visible_brand_text text null,
  primary_color text null,
  material text null,
  silhouette text null,
  pattern text null,

  style_tags jsonb null,
  search_queries jsonb null,
  confidence jsonb null,

  commerce_query text null,
  commerce_provider text null,
  providers_tried jsonb null,
  commerce_result_count integer null,
  catalog_count integer null,

  recommended_product_sources jsonb null,
  recommended_product_types jsonb null,

  image_hash text null,
  app_platform text null,
  app_version text null,

  created_at timestamptz not null default now()
);
```

Phase 1.1 capture rules:

- Image mode only.
- No raw base64 image storage.
- No raw provider payload storage.
- No product URL or product title storage.
- No API key, header, or secret storage.
- Single insert attempt per scan.
- Missing table or missing service role must never fail the scan response.
