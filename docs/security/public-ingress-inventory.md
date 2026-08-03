# Public Ingress Inventory — K Scan AI Perimeter Hardening

- **Date**: 2026-08-03
- **Repository**: kscanaiapp/kscan-app
- **Branch**: security/public-ingress-perimeter-hardening
- **Base**: 67c504fcfb3e56ae4f42a6aaea3539284dcd4bbf (PR #43 merged)
- **Full structured data**: `security/perimeter/public-ingress-manifest.json` (25 surfaces, machine-readable)

This document is the human-readable companion to the manifest. It answers the 14 questions posed for this phase using direct evidence (live Supabase reads, `pg_get_functiondef`, `pg_policies`, `information_schema`, and two independent repository-research passes), not inference.

## Headline correction to scope

**There is no Vercel anywhere in this repository or its hosting.** No `vercel.json`, no `next.config.js`, no Vercel-managed domain. The actual hosting for the one non-Supabase backend is **Render.com** (`kscan-app-1.onrender.com`, running `server.js`, a plain Express app deployed via `render.yaml`/`Procfile`). Phase 3's Vercel-specific instructions are addressed as "no Vercel exists to configure" rather than forced onto a platform that isn't in use — see `docs/security/perimeter-control-map.md`.

## 1. What K Scan resources are reachable from the public internet?

Four distinct origins a client can reach directly, none behind a common gateway:

1. **`yzqjvdfgefveprobvvyw.supabase.co`** (staging Supabase) — Auth, PostgREST (tables + RPCs), Storage, Edge Functions. This is where nearly all of K Scan's backend logic lives.
2. **`kscan-app-1.onrender.com`** (Render, `server.js`) — a standalone Express app with `/api/analyze` (Gemini proxy), `/api/health`, and a static `/catalog-images` mount. **Never covered by the PR #43 hardening work**, which only touched Supabase Edge Functions.
3. **`kscan.app` / `www.kscan.app`** (external website) — waitlist, legal pages, the website's own account-deletion form, and a `/api/rooms/:token` backend that the mobile app calls directly. **Entirely outside this repository** — no source, no hosting config, unauditable from here.
4. **`generativelanguage.googleapis.com`** (Google Gemini) — reached indirectly, server-side only, from both `server.js` and the dormant `app/api/analyze+api.js`.

## 2/3. Intentional public vs. requires auth

See the manifest's `riskClassification` field per surface. Summary:

- **INTENTIONALLY_PUBLIC** (5): `get_public_room_preview` RPC, `app_config` (mobile_feature_freeze key only), Supabase Auth endpoints, `server.js /api/health`, `server.js /catalog-images`.
- **PUBLIC_WITH_ABUSE_CONTROLS** (1, after this pass's fix): `get_item_reaction_counts` — see below.
- **AUTHENTICATED / AUTHENTICATED_AND_OWNER_SCOPED** (12): the 6 PR #43-hardened Edge Functions plus their non-hardened siblings, deletion/correction/export request tables, storage bucket, deep-link callback.
- **SERVICE_TO_SERVICE** (1): `investor-docs` storage bucket (zero client policies, service-role only).
- **DEPLOYMENT_UNVERIFIED** (3): `privacy-controls`, `public-sale-share-opt-out` (no source in this repo — see Critical Finding below), and the external `kscan.app` website (legitimately out of repo scope, but unverifiable from here).
- **SHOULD_NOT_BE_PUBLIC** (2, both fixed or fix-prepared this pass): `get_item_reaction_counts` (fixed — see Phase 5), `server.js /api/analyze` (fix prepared, not yet applied — see Phase 5).
- **STAGING_ONLY** (3 dormant Expo Router API routes, explicitly deprecated in source comments, no deployment target exists for them at all).

## Critical Finding: two Edge Functions with no source in this repository

`privacy-controls` and `public-sale-share-opt-out` are both `ACTIVE` on staging (confirmed live via `list_edge_functions`), both privacy/CCPA-shaped by name, and one (`public-sale-share-opt-out`) is `verify_jwt=false` — publicly invocable with no platform-level auth gate. **Neither has a corresponding directory in `supabase/functions/`, on any branch, at any point in git history** (confirmed via `git ls-tree --all` and `git log --all --follow`). They are referenced only as inert bookkeeping entries in `security/scripts/staging-deployment-allowlist.js` and prior audit docs, both stating "already live before this pass" with no further detail.

This means two internet-reachable, privacy-relevant endpoints — one of them unauthenticated — are running with **zero auditable source**. Their actual auth model, validation, rate limiting, logging, and data-handling behavior cannot be confirmed from this codebase. The one mitigating fact found: the table they most plausibly write to (`website_sale_share_opt_out_requests`) has RLS enabled with a single `service_role`-only policy and zero anon/authenticated policies, so even if the function itself has no code-level auth, no client can reach that table directly — but this says nothing about what the function does before it reaches the database (validation, rate limiting, logging, or whether it touches anything else).

**This is flagged for direct investigation outside this repository** (Supabase deploy history / dashboard / whoever has out-of-band CLI access) rather than resolved here, since it cannot be answered from repository or staging-API evidence alone.

## 4. Which surfaces require authenticated ownership checks?

All per-user data paths correctly scope via `auth.uid()`: `dressing_rooms`, `dressing_room_items`, `dressing_room_item_reactions`, `room_shares`, `privacy_settings`, `profiles`, `deletion_requests`, `privacy_correction_requests`, `privacy_export_requests` all have RLS policies keyed on `user_id = auth.uid()` or an equivalent join. The `style-library-images` storage bucket scopes by requiring the path's first folder segment to equal `auth.uid()`.

## 5. Which surfaces can incur cost?

- **Highest, most exposed**: `server.js /api/analyze` (Render) — direct Gemini call, no auth, no rate limit, no WAF. See Phase 5.
- **Bounded/hardened**: the 6 PR #43 functions (quota-reserved, concurrency-limited).
- **Unverified**: `privacy-controls`/`public-sale-share-opt-out` — cost exposure unknown without source.
- **Storage cost**: `style-library-images` uploads (owner-scoped, 5MB cap, mime-restricted — low risk).

## 6. Which surfaces accept sensitive content?

`server.js /api/analyze` and the dormant `app/api/analyze+api.js` both accept the raw scan photo (base64). `tryon-clothes-pro` (held, undeployed) accepts a person image. `style-library-images` storage accepts user photos (owner-scoped). No surface was found to intentionally expose raw face/plate/biometric imagery through public storage — both buckets are non-public with either owner-scoped or service-role-only policies.

## 7. Which surfaces bypass the primary website perimeter?

All of them, structurally — there is no "primary website perimeter" in front of Supabase or Render. The mobile app talks directly to `yzqjvdfgefveprobvvyw.supabase.co` and `kscan-app-1.onrender.com`; neither sits behind the `kscan.app` website or any CDN/WAF this repository configures.

## 8. Which surfaces lack request limits or abuse controls?

`server.js /api/analyze` (none at all), `handle-user-deletion`/`privacy-correction-request`/`privacy-data-export` (none — idempotency only, no counter), `get_public_room_preview` (none — token-enumeration is theoretically possible against a UUID keyspace), `privacy-controls`/`public-sale-share-opt-out` (unknown).

## 9/10. Database function and table exposure (anon/authenticated/service-role)

Full detail in `docs/security/supabase-exposure-audit.md`. Headline: this project's default privileges grant `anon`/`public` EXECUTE on newly created public-schema functions unless explicitly revoked — already observed and fixed once for the provider-request functions in PR #43's migration set. This pass found the same pattern on nearly every other pre-existing RPC, and one genuine gap (`get_item_reaction_counts` — no `auth.uid()` check of any kind, unlike every other RPC in the schema). Fix prepared in `security/perimeter/pending-rpc-hardening.sql`, pending application to staging.

## 11/12. Hosting-provider firewall coverage vs. direct-origin bypass

See `docs/security/perimeter-control-map.md`.

## 13. Controls preventing accidental future exposure

See Phase 4 guardrail scripts under `security/scripts/` and tests under `__tests__/security/` (perimeter-drift detection).

## 14. DDoS / degraded-mode operation

See `docs/security/ddos-and-degraded-mode-playbook.md`.
