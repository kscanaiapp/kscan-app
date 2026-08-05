# Backend authority manifest — K Scan AI Staging in-place rebuild

Status as of 2026-08-05. Working branch `rebuild/staging-v2-backend`.

## Projects

| Role | Name | Ref | Region | Authority |
|---|---|---|---|---|
| Production | KScan App Production | `wyyuqfdxucjksghsmhry` | us-east-2 | **Read-only** behavioural and structural source of truth. Never written. |
| Staging (rebuild target) | K Scan AI Staging | `yzqjvdfgefveprobvvyw` | us-west-1 | The in-place rebuild target. Name, ref and URL retained. |

No replacement project was created. No Supabase plan change was made. The
organisation (`dtcbsuytyjpvadcnyymn`) is on the free plan with a two-active-project
limit; both slots are held by the two projects above.

## Source authority

- Working branch: `rebuild/staging-v2-backend`
- Branched from: `staging/production-parity` @ `f799cdf`
- Production-derived parent: the 81 migration names applied in production, **all
  of which have a source file in this branch** — the production contract is
  reproducible from source control, not from a dump.
- Excluded: `ios/full-submission-readiness-v2` (frozen legacy fork), all
  `audit/*`, `recovery/*`, and rejected scanner candidate branches.

## Database contract

Verified by object-level comparison, not counts. See
`scripts/staging-v2/contract-fingerprint.sql` and `contract-digest.sql`.

| Object class | Result |
|---|---|
| Tables | 52/52 production tables present on staging |
| Columns | 0 mismatches after `deletion_requests` reconciliation |
| Client-required RPCs | 29/29 match on identity args, return type, security mode, `search_path` |
| Storage policies (`style-library-images`) | 4/4 byte-identical to production |
| Storage buckets | both production buckets present |
| Edge Functions | 16/16 production functions deployed from repo source, `verify_jwt` parity exact |

### Edge Function currency

Deploying the 6 missing functions was not sufficient. The 10 that already existed
on staging were **far behind** production — `scan-identify` was at v3 against
production's v141, `stylechat-generate` v54 against v84, `handle-user-deletion`
v20 against v69 — and the stale `stylechat-generate` rejected a well-formed
request outright. All 16 were therefore redeployed from this branch's source, so
staging runs the same code the repository describes.

### Provider / model runtime validation

Deployment success proves nothing about model configuration: a retired Gemini
model fails only at invocation. `scripts/staging-v2/provider-preflight.mjs`
closes that by invoking each model-dependent function with a synthetic request.
Result on 2026-08-05: **3/3 answered, 0 failing, 0 secret-name gaps** —
`scan-identify` (classified a synthetic image as NON_FASHION),
`stylechat-generate` (`model: gemini-3.6-flash`), and `style-outfit-generate`
(returned outfit suggestions with reasoning). The retired-model hazard flagged in
the secret manifest is **not** present on staging.

## Client-required RPC inventory

Extracted from `.rpc('…')` call sites across `app/`, `components/`, `services/`,
`hooks/`, `contexts/`, `lib/`, and `supabase/functions/`. 32 distinct names; 29
belong to the production contract and are verified above. The remaining three —
`reserve_provider_request`, `complete_provider_request`, `release_provider_request`
— exist in **neither** production nor the production-derived baseline. They are
staging-only provider-quota controls called from
`supabase/functions/_shared/security/quota.ts`, created by the
`provider_request_security` migrations. Recorded as a known intentional staging
difference, not a parity gap.

## Known intentional staging differences

These exist on staging and **not** in production, deliberately:

| Object | Why |
|---|---|
| `public.waitlist_signups` | **PROTECTED.** Real website waitlist data. Never dropped, truncated, altered, or reseeded. |
| `public.website_sale_share_opt_out_requests` | **PROTECTED.** Real website privacy requests. Same treatment. |
| `public.provider_request_limits`, `provider_request_reservations`, `provider_security_events` | Staging provider-quota security controls. |
| `public.image_scan_verdicts` | Staging image-ingestion security. |
| `internal.edge_function_errors` | Staging observability. |
| Buckets `image-ingestion-clean`, `image-ingestion-quarantine` | Staging ingestion security. Both empty (0 objects). |
| Bucket `investor-docs` | Legacy, staging-only, 4 objects. See Storage classification below. |
| Edge Functions `privacy-controls`, `public-sale-share-opt-out` | Website privacy stack. Untouched. |
| Edge Functions `staging-health`, `product-match` | Staging tooling. |
| `deletion_requests.user_email`, `.scheduled_deletion_date`, `.completed_at`, `.internal_notes` | Website-era legacy columns. Left in place — dropping columns is destructive and none can block a production-shaped insert. |
| `privacy_settings` column **order** | Same column names, types, nullability and defaults as production; only ordinal position differs. PostgREST addresses columns by name, so this is not behavioural drift. |

## Storage classification

Narrow dependency search over production-derived mobile source, Edge Functions,
database function bodies, workflows and configuration:

| Bucket | Classification | Evidence |
|---|---|---|
| `legal-documents` | **production-required** | Exists in production (`public=true`). Was **absent** from staging; created by `20260805121000_legal_documents_bucket_parity.sql`. |
| `style-library-images` | **production-required** | Exists in both with identical configuration and all 4 owner-scoped policies. |
| `image-ingestion-clean` | **staging-security-required** | Referenced *only* by `20260803220100_image_ingestion_clean_storage.sql`. No application, website, or Edge Function source references it. Not in production. |
| `image-ingestion-quarantine` | **staging-security-required** | Referenced *only* by `20260803220000_image_ingestion_quarantine_storage.sql`. Same negative evidence. |
| `investor-docs` | **legacy-unused** | **Not recreated, and not present in production.** Every reference is security-audit *documentation* plus one test fixture; there is no application, website, or Edge Function dependency. It already exists on staging with 4 objects and zero client-reachable policies — left untouched rather than deleted, since removal is destructive and not required. |

## Deferred work

- `supabase/migrations-deferred/20260725100000_shared_room_item_contributions.sql`
  — not in production, and replaces three production RLS policies on
  `dressing_room_items`. See that directory's README.
- Account-deletion **behavioural** parity is deferred per the phase brief.
  Structural parity was still reconciled where it was cheap and safe.

## Waitlist

Untouched throughout. Not seeded, not activated, no website wiring changed, no
button behaviour changed, excluded from acceptance testing.

- `waitlist_signups`: 2 rows, payload md5 `d167846076356186165121c42c7ac612` — identical before and after the rebuild.
- `website_sale_share_opt_out_requests`: 8 rows, payload md5 `08d285bf73ead06328171e39ddf26d15` — identical before and after.
- Backup: `C:\src\kscan-staging-protected-backup\yzqjvdfgefveprobvvyw-protected-tables.json`
  (schema + rows + DDL), held **outside the repository**, never committed, never
  printed. Real email addresses were never rendered in plaintext in any log or
  report.

## Source-authority gaps

| Gap | Status |
|---|---|
| `can_react_to_dressing_room_item(p_item_id uuid)` | **CLOSED.** No migration created it anywhere — absent from git history, deleted branches, and `schema_migrations.statements`. Its definition was read read-only from production and reproduced in `20260805130000_production_live_derived_can_react_to_dressing_room_item.sql`, which is labelled *production-live-derived*, not a recovered historical migration. Verified byte-exact against production: contract md5 `0d87fca42ef99fe17c859ba1f4fccb4f`, body md5 `685a308aee98aae208c78cc2247b3eda`, ACL `anon=false, authenticated=true, service_role=true`. |
| 4 `provider_request_*` migrations | **Recovered** from git history (`9e4556e`, `222989f`, `3e2140f`) and restored to `supabase/migrations/`. |
| `20260804101903_legal_acceptances` | **Recovered** verbatim from staging's own `supabase_migrations.schema_migrations.statements`. History-only difference from production's `20260617000001`; resulting schema is identical. |
