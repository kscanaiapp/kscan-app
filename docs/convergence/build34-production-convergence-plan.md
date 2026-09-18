# K Scan AI — Backend Production Convergence: Plan & Findings

Status: **investigation and governed tooling complete; no production mutation performed.**
Scope: the 11 named categories from the convergence directive, plus the two
Build 33 P3 defects and the #431 reaction-counts authority. VTO, wearables,
closet items, style profiles, waitlist, investor inquiries, and other
staging-only work are explicitly **out of scope** — see "Remaining
differences" below.

This document is the record for that scope. It does not itself change
production. Production changes happen only through
`.github/workflows/production-controlled-deploy.yml`, triggered by a human
with the required-reviewer approval it's gated on.

---

## URGENT — the exact gap this convergence exists to close, needs priority sequencing

**Production's deployed `scan-identify` (version 158) does not yet carry the
two security repairs #432 added on top of it, because #432 merged today
(2026-09-16) and no production deploy path existed until this PR.** This is
not a mystery or a long-standing drift — PR #432's own body explains it
precisely, and confirming it directly (diffing the actual deployed bundles,
not just hashes, via `mcp__Supabase__get_edge_function`) matches that account
exactly:

- **PR #432 started by forward-porting B33-COM-001 and B33-OBS-001 FROM
  production INTO governed source** — production had already been hotfixed
  with a longer Commerce timeout budget and correct timeout classification
  that governed source didn't contain, so #432 pulled those two into the
  branch first ("after the forward-port, production v158 is 42/42
  byte-identical to this tree"). **Confirmed still true today**: comparing
  the two deployed bundles directly, every file except `index.ts` and
  `scanQuota.ts` is byte-identical between staging and production, and the
  one diff hunk in the observability area is a comment reword, not a logic
  change. **B33-COM-001 and B33-OBS-001 are already effectively on
  production.**
- **PR #432 then added B33-SEC-002 and B33-SEC-003 to governed source and
  validated them on staging — and that is as far as it could go**, because
  no production deploy workflow existed. Staging's `scan-identify` (this
  session confirms) is byte-identical to this branch's current working tree;
  production's is not. **These two are validated and ready, sitting one
  deploy away from production:**
  - **B33-SEC-003 (mode-canonicalization).** Production still keys the daily
    scan quota bucket off the raw, caller-supplied `mode` string. #432's
    staging measurement: one authenticated user reached the 30/day limit
    **eight separate times** (`image`, `img`, `image2`, `image-2`, `imagex`,
    `scan`, `a`, `image ` with a trailing space) — 240 paid scans against a
    30/day limit, because only `IMAGE`/`image` lowercased to the same bucket.
    **Exploitable on production right now.**
  - **B33-SEC-002 (MODE B auth + durable quota).** Production's
    "commerce-only" (MODE B) path has no authentication check and no
    durable, database-backed quota — only an isolate-local limiter #432
    measured as admitting essentially every request (45 requests, 42
    distinct isolates). MODE B spends real provider money per call.
    **Unauthenticated and anonymous callers can trigger uncapped paid
    provider calls against production right now.**

**Also flagged by #432, still open, relevant to Phase 7 below:** staging and
production were running a byte-identical bundle at the time (same
`ezbr_sha256`), meaning they read the same seven provider-credential secret
*names* — #432 could not determine from within its environment whether the
*values* differ, and logged `OPS_ACTION_REQUIRED — STAGING_PROVIDER_KEY_SEPARATION`
for a human to resolve. Also unresolved: the staging-side
`BACKEND_COMMERCE_FUNNEL_V127_ENABLED` funnel was never disabled (no secrets
tooling available to #432's environment either) — SEC-002 is the durable
containment regardless of that flag's state, but it's worth closing out
alongside the credential-separation question.

**Recommendation:** this is the single most time-sensitive item in this
document. The fix is validated on staging, already in this branch, and
`production-controlled-deploy.yml` (added in this PR) can deploy it as soon
as the workflow is approved and usable — treat it as the first thing run
through that pipeline, ahead of the migration promotion in Phase 5.

---

## A. Final authority

| Field | Value |
| --- | --- |
| Branch | `claude/k-scan-backend-convergence-68gwew` (pushed from local `backend-authority-v2-work`) |
| Base / canonical branch | `rebuild/backend-authority-v2` — declared canonical by `config/backend-authority.json` (`canonicalBranch`), which does not exist on `master` |
| HEAD SHA (this work) | `1f6e6dc08e786a347706cf37c9692031cb88cfa3` |
| PR | #435 (draft) against `rebuild/backend-authority-v2` |
| Merged PRs this convergence builds on | #432 (Build 33 backend closeout — governed/production Commerce drift, MODE B auth, quota namespaces), #433 (migration ledger reconciliation), both merged into `rebuild/backend-authority-v2` |
| Superseded, not merged as-is | #431 (draft) — its `get_item_reaction_counts` fix is corrected and superseded by this branch's `20260917010000_reaction_counts_bind_anonymous_share_token.sql`; see PR #435 body |

**Branch-topology finding (corrected mid-session):** this work was initially
built on `master`. `master` does not carry #432/#433 and has no
`config/backend-authority.json` at all — it is not the governed backend
authority branch. That file, present only on `rebuild/backend-authority-v2`,
explicitly declares itself canonical and declares `release/kscan-pre-freeze-v1`
(the base of #431) "integration-convergence-non-authoritative." All work in
PR #435 was rebuilt on `rebuild/backend-authority-v2` after this was
discovered; nothing in the final PR is built on `master`.

---

## Phase 1 — Staging → production delta (scoped)

Live-inspected via Supabase MCP tools against both projects
(`wyyuqfdxucjksghsmhry` production, `yzqjvdfgefveprobvvyw` staging), not
inferred from filenames alone.

**Overall scale, for context:** production carries 99 applied migrations;
staging carries ~180. Production has 18 deployed Edge Functions; staging has
30. Per the decision to scope this convergence to the 11 named categories,
the great majority of that gap (K+ beyond entitlement-authority basics, VTO,
wearables, `user_closet_items`, `user_style_profiles`, investor inquiries,
waitlist signups, image-ingestion quarantine, content-report AI-output
extensions, and more) is **explicitly out of scope** for this pass — see
"Remaining differences."

### Migrations — the 11 named categories

| # | Category | Migration file | Staging | Production | Action |
| - | --- | --- | --- | --- | --- |
| 1 | Watchlist push receipts | `20260909115726_watchlist_push_receipts.sql`* | applied | absent | promote (+ dependency closure, Phase 5) |
| 2 | Watchlist F-03 | `20260909170000_watchlist_f03_push_token_actor_isolation_reconciliation.sql`* | applied | absent | promote (+ dependency closure) |
| 3 | Cross-actor snapshot hardening | `20260914120000_close_authenticated_cross_actor_owned_item_snapshot.sql` | applied | absent | promote |
| 4 | K+ entitlement authority | `20260915030553_kplus_entitlement_authority.sql` | applied | absent | promote (+ dependency closure) |
| 5 | K+ reconciliation queue | `20260915124849_kplus_reconcile_queue_excludes_inactive_rows.sql` | applied | absent | promote (+ dependency closure) |
| 6 | Trigger-function EXECUTE hardening | `20260915133739_revoke_client_execute_on_updated_at_trigger_functions.sql` | applied | absent | promote |
| 7 | K+ mirror retirement | `20260915181554_kplus_revenuecat_mirror_retirement.sql` | applied | absent | promote (+ dependency closure) |
| 8 | K+ mirror search_path hardening | `20260915181910_kplus_promotional_mirror_sources_search_path.sql` | applied | absent | promote (+ dependency closure) |
| 9 | Signature Style entitlement | `20260915214857_signature_style_free_entitlement.sql` | applied | absent | promote (+ dependency closure) |
| 10 | Signature Style closet evidence | `20260915232402_signature_style_free_closet_evidence.sql` | applied | absent | promote (+ dependency closure) |
| 11 | Reaction-count authorization (#431) | `20260917010000_reaction_counts_bind_anonymous_share_token.sql` (this PR; supersedes #431's `20260916203000`) | not yet applied anywhere (new, this session) | absent | promote — self-contained, no dependency gap (production already has the predecessor hardening pass `20260916031250_build33_reaction_counts_honour_dressing_room_block`) |

\* Filename/timestamp drift noted: staging's live ledger records these two
under different timestamps (`20260909171001`, `20260909171017`) than the
local files on `rebuild/backend-authority-v2` (`20260909115726`,
`20260909170000`) — same logical migrations, renumbered at some point. See
Phase 5 / migration-authority-manifest note below; this needs a reconciliation
entry before a `supabase db push`-based tool would treat it correctly, though
the MCP `apply_migration` path used for this session's staging validation
work is unaffected by it.

**Items 1–10 are each the LAST migration in a chain**, not a self-contained
unit — production has *zero* K+, Watchlist, or Signature Style schema today.
Promoting any of them requires their full prerequisite chain first. See
Phase 5.

### Edge Functions (relevant to this scope)

| Function | Staging | Production | Note |
| --- | --- | --- | --- |
| `scan-identify` | deployed, current governed source (byte-identical to this branch's working tree) | deployed, older source **missing SEC-002/SEC-003** | see URGENT section above |
| `kplus-activate` | deployed | absent | governed source exists (`supabase/functions/kplus-activate/`); needed to make K+ entitlement authority functionally reachable — see Phase 6 |
| `kplus-reconcile-revenuecat` | deployed | absent | governed source exists; needed for K+ mirror retirement to be functionally complete — see Phase 6 |
| `commerce-watch-refresh` | deployed | absent | governed source exists; this is the Watchlist sweep worker. **Deliberately staging-only by existing governance** — `.github/workflows/watchlist-tier2-sweep.yml` header states "production activation is a separate, deliberate owner decision and is intentionally not expressible from this file." Not proposed for promotion here. |

Everything else that differs between the two projects' Edge Function lists
(`privacy-controls`, `public-sale-share-opt-out`, `product-match`,
`staging-health`, `wearable-*` ×4, `vto-provider-diag`, `rapidapi-*` ×2,
`vto-generate`, `deletion-status`) is either explicitly declared
not-governed-by-this-repo-tree or explicitly reserved for a separate owner
decision in `config/backend-authority.json`, and is out of scope here.

### Config / RLS / grants

No RLS or grant divergence was found relevant to the 11 named categories
beyond what each migration itself establishes (each is additive: new tables,
new RLS policies scoped to the new tables, or narrowing an existing grant —
none loosen an existing production grant). Production's security advisories
(`get_advisors`, type=security) show no ERROR/CRITICAL findings; existing
WARN/INFO findings (SECURITY DEFINER function counts, anonymous sign-in
being allowed, leaked-password-protection setting) are pre-existing,
platform-wide, and unrelated to this scope.

---

## Phase 5 — Migration promotion plan (dependency closures)

Production has zero K+, Watchlist, or Signature Style schema today. Each of
the 10 named migrations (items 1–10) is the *last* migration in its
subsystem's chain, not a self-contained unit. The full ordered closures below
were traced by reading every migration's actual SQL body (which
tables/functions/columns it touches), not inferred from filenames or dates.

### K+ subsystem (items 4, 5, 6, 7, 8) — 7 migrations, apply in this order

| # | File | Why it's required |
| - | --- | --- |
| 1 | `20260829120000_kplus_entitlements.sql` | Base tables `user_entitlements`, `kplus_activation_events`; base functions `kplus_has_active_entitlement`, `grant_kplus_early_access`, sync-status functions. Everything else in K+ — and every K+ check inside Watchlist and Signature Style — traces back to this. |
| 2 | `20260829180000_fix_grant_kplus_early_access_variable_conflict.sql` | Forward-only bugfix for #1's activation RPC (fixes a `42702` variable-conflict error on every call without it). |
| 3 | `20260915030553_kplus_entitlement_authority.sql` **(item 4)** | Adds the entitlement-grant/activation/transition tables and resolver functions; replaces #1's `kplus_has_active_entitlement`/`grant_kplus_early_access`. |
| 4 | `20260915124849_kplus_reconcile_queue_excludes_inactive_rows.sql` **(item 5)** | Replaces #1's `list_kplus_pending_revenuecat_sync` to filter by #3's row-active predicate. |
| 5 | `20260915133739_revoke_client_execute_on_updated_at_trigger_functions.sql` **(item 6)** | See "self-contained items" below — sequenced here because it targets a function #1 creates. |
| 6 | `20260915181554_kplus_revenuecat_mirror_retirement.sql` **(item 7)** | Adds mirror-retirement tables and triggers on #1's and #3's tables. |
| 7 | `20260915181910_kplus_promotional_mirror_sources_search_path.sql` **(item 8)** | Pure `create or replace` follow-up to #6's function; depends only on #6. |

### Watchlist subsystem (items 1, 2) — 13 migrations + K+ base, apply in this order

Requires the K+ base pair above first (`create_user_commerce_watch` and
several claim RPCs call `kplus_has_active_entitlement`).

| # | File | Why it's required |
| - | --- | --- |
| 1 | `20260830150000_user_commerce_watches.sql` | Base `user_commerce_watches` table. |
| 2 | `20260830151500_user_commerce_watch_events_and_rpcs.sql` | `user_commerce_watch_events` table + core watch RPCs; calls K+ base's `kplus_has_active_entitlement`. |
| 3 | `20260830161500_watch_push_enabled.sql` | Adds `push_enabled` + `set_watch_push_enabled` RPC. |
| 4 | `20260830162500_claim_watchable_commerce_watches.sql` | Tier-2 background claim RPC. |
| 5 | `20260830190500_watchlist_create_honours_changed_intent.sql` | Replaces #2's create RPC to honor a changed intent on idempotent re-watch. |
| 6 | `20260830212508_user_device_push_tokens.sql` | Base `user_device_push_tokens` table + v1 register/revoke RPCs. `watchlist_push_receipts` (item 1) FKs directly to this table. |
| 7 | `20260830190000_watchlist_push_token_actor_isolation.sql` | Hardens #6's register function; adds a live-token unique index. |
| 8 | `20260831120000_watchlist_device_ownership_claim.sql` | `claim_device_for_actor` RPC on #6. |
| 9 | `20260831000100_watchlist_worker_enablement.sql` | Seeds the `watchlist_worker_enabled` kill-switch (already `false`; the worker itself is deliberately not being promoted — see Phase 6). |
| 10 | `20260831120500_claim_user_commerce_watches_for_refresh.sql` | Tier-1 user-open-refresh claim RPC; depends on #1 and K+ base. |
| 11 | `20260902120000_watchlist_device_route_and_account_state.sql` | Adds a device unique index on #6; adds the active-account gate used by #4/#10. |
| 12 | `20260909115726_watchlist_push_receipts.sql` **(item 1)** | `watchlist_push_receipts` table, FK → #6. |
| 13 | `20260909170000_watchlist_f03_push_token_actor_isolation_reconciliation.sql` **(item 2, F-03)** | Re-applies #7's hardening in true ledger order, after #6/#8/#11/#12; precondition-guarded (raises if `user_device_push_tokens` is missing). |

### Signature Style subsystem (items 9, 10) — 9 migrations + K+ base, apply in this order

| # | File | Why it's required |
| - | --- | --- |
| 1 | `20260829203657_user_closet_items.sql` | Base `user_closet_items` table + K+-gated RLS wrapper `has_active_k_plus()`. Requires K+ base. |
| 2 | `20260829204635_user_closet_items_optimize_rls_initplan.sql` | RLS performance follow-up to #1, same predicate. |
| 3 | `20260829220316_user_closet_items_media.sql` | Adds storage/media columns to #1. |
| 4 | `20260830060000_user_style_profiles.sql` | Base `user_style_profiles` table + its `updated_at` trigger function (also item 6's other target). |
| 5 | `20260830070000_upsert_style_dna_profile_rpc.sql` | RPC on #4 (later revoked in #6). |
| 6 | `20260830131956_signature_style_server_authority.sql` | Revokes #5's RPC from `authenticated`; creates the original K+-gated `recompute_signature_style()`, reading #1/#3, writing #4. |
| 7 | `20260830140000_fix_recompute_signature_style_column_ambiguity.sql` | Bugfix replace of #6's function. |
| 8 | `20260915214857_signature_style_free_entitlement.sql` **(item 9)** | Replaces #6/#7's function, removing the K+ gate. |
| 9 | `20260915232402_signature_style_free_closet_evidence.sql` **(item 10)** | Replaces #8's function again to also read `public.wardrobe_utility_items` — **see blocker below.** |

### ⚠️ Blocker: item 10 has an unapproved-for-production dependency

`20260915232402_signature_style_free_closet_evidence.sql` (item 10) reads
`public.wardrobe_utility_items` directly. That table is created by
`20260704175544_free_tier_utility_tables.sql` — a migration **outside** all
three subsystem chains above, whose own file header states:

> Status: REVIEWED — approved for KScan App Staging (wyyuqfdxucjksghsmhry)
> only. Not for Production until validated.

`docs/FREE_TIER_BACKEND_INTEGRATION_MAP.md` independently says the same
("DO NOT APPLY NOW" for production). **Item 10 cannot function on
production without this table, and this table's own governance note
explicitly withholds production approval.** This is not a judgment call this
document should make — it needs explicit owner sign-off (either approve
`free_tier_utility_tables` for production now, promoting it alongside item
10, or hold item 10 back until that separate approval happens). **Do not
include item 10 in a production migration run without that sign-off.**

### Needs a direct verification step before finalizing (not blockers, but unconfirmed)

- **Item 3's dependency** (`20260914120000_close_authenticated_cross_actor_owned_item_snapshot.sql`,
  touching `build_owned_item_snapshot()`) depends only on
  `20260711000001_ai_stylist_looks_extension.sql`. That file's own header
  says "not applied to any remote environment," which is contradicted by
  live proof in `config/migration-authority-manifest.json` that it's on
  *staging* — but production status is unconfirmed either way. Verify with
  `list_migrations`/`to_regprocedure` against production before treating
  item 3 as zero-prerequisite.
- **Items 4–10's ledger-version identity is not covered by the existing
  reconciliation manifest** (`config/migration-authority-manifest.json`'s
  `ledgerReconciliation` only confirms items 1, 2, 3, and the pre-2026-09-15
  chain files — its own `confirmedOn` date predates the Sept-15 K+/Signature
  Style migrations entirely). Given filename/ledger-version drift is proven
  real and systemic for every adjacent file in this period (table below),
  **do not assume filename version = applied version for items 4–10**
  without an explicit `list_migrations` check immediately before promotion.

### Filename ↔ staging-ledger version drift (confirmed via the existing reconciliation manifest)

All `EQUIVALENT_RENUMBER` / `CONSOLIDATED_IN_REMOTE` — same content, staging
just recorded it under a different version than the repo filename. Relevant
for writing the actual production migration script (which should apply the
*local file content* regardless of what staging happened to number it):

| Repo filename version | Logical name | Staging ledger version(s) |
| --- | --- | --- |
| `20260830131956` | signature_style_server_authority | `20260830145412` |
| `20260830150000` | user_commerce_watches | `20260830211956` |
| `20260830151500` | user_commerce_watch_events_and_rpcs | `20260830212244/212316/212326/212412/212444` (5 rows) |
| `20260830190000` | watchlist_push_token_actor_isolation | `20260830214752` |
| `20260830212508` | user_device_push_tokens | `20260830212518` (table+RLS vs RPCs, 2 rows) |
| `20260909115726` | watchlist_push_receipts (item 1) | `20260909171001` |
| `20260909170000` | watchlist_f03_... (item 2) | `20260909171017` |
| `20260914120000` | cross-actor snapshot hardening (item 3) | `20260914201155` |
| *(+ 8 more Watchlist/Signature-Style chain files, same pattern)* | | |

None of this affects the STAGING validation already done in this session
(the MCP `apply_migration` path used doesn't depend on filename-version
matching) — it matters for whichever tool actually pushes to production,
including `production-deploy-preflight.mjs` in this PR, which reads this
same manifest and fails closed on an unreconciled production entry (there
currently is none — see Phase 1).

### Item 3 and item 6 — self-containment

- **Item 3** (cross-actor snapshot hardening): self-contained given its one
  dependency (`ai_stylist_looks_extension.sql`) is confirmed on production —
  see verification step above.
- **Item 6** (trigger-function EXECUTE hardening): structurally self-contained
  (its `DO $$ ... IF EXISTS ...` body is a no-op if the target functions
  don't exist yet) but functionally pointless without the K+ base and
  Signature Style base migrations it targets — sequence it after both, which
  its own filename timestamp already does naturally.

### Reaction-count authorization (item 11)

Self-contained — see Phase 1 table. No dependency gap; production already
has the predecessor hardening pass.

---

## Phase 6 — Edge Function parity detail

### `scan-identify`

Diffed the two deployed bundles directly (all 42 bundled files fetched via
`mcp__Supabase__get_edge_function` for both projects) rather than relying on
the mismatched hash schemes (`ezbr_sha256` from Supabase vs. this repo's own
`config/edge-function-manifest.json` bundle-hash convention — the two are
computed differently and are not directly comparable). Result: staging's
deployed `index.ts` is byte-identical to this branch's current working tree
(confirms staging runs current governed source exactly); production's
`index.ts` and `scanQuota.ts` differ from both, missing the SEC-002/SEC-003
work — detailed above under URGENT.

`verify_jwt`: `false` on both staging and production, matching the governed
manifest expectation for this function.

### `kplus-activate` / `kplus-reconcile-revenuecat`

Governed source exists in this repo (`supabase/functions/kplus-activate/`,
`supabase/functions/kplus-reconcile-revenuecat/`), listed in
`config/edge-function-manifest.json`'s `expectedFunctions`. Both are deployed
to staging, neither to production. **Recommendation, not yet acted on:**
promoting the K+ entitlement-authority migrations without also deploying
these two leaves K+ with schema but no way for a client to actually activate
or reconcile an entitlement server-side. Whether to deploy them alongside the
migrations, or hold them for a later, explicit step, is a product/release
call this document surfaces rather than makes — the migrations themselves are
inert (new tables/columns, no new client-reachable surface) until either an
Edge Function or a client build exercises them.

### `commerce-watch-refresh`

Governed source exists; deliberately staging-only per existing governance
(see Phase 1 table). Not proposed for promotion.

### `reconcile-orphan-media`

Governed source exists, deployed nowhere (staging or production).
`config/backend-authority.json` reserves its first deployment as "an explicit
owner decision" — unrelated to the 11 named categories, not touched here.
(This is the general, deleted-user orphan-media reconciler; the narrower,
per-request B33-STO-004 fix in this PR is a separate, already-applied
client-side compensating delete — see PR #435.)

---

## Phase 7 — Configuration & secret parity

No tool in this session can list configured secret *names* on either Supabase
project (no Management API secrets-list surfaced via the available MCP
tools, and per the earlier scoping decision this session does not run the
Supabase CLI against production directly). What follows is REQUIRED secret
names, discovered by reading the governed source of the functions this
scope's migrations make relevant, with presence reported only where directly
observable (a function is deployed and reachable) — everything else needs a
human check against the Supabase dashboard or `supabase secrets list
--project-ref wyyuqfdxucjksghsmhry`. No secret values are included or were
read.

| SECRET_NAME | STAGING_PRESENT | PRODUCTION_PRESENT | REQUIRED_BY | READY / BLOCKED |
| --- | --- | --- | --- | --- |
| `GEMINI_API_KEY` | inferred present (scan-identify serves live traffic) | inferred present (scan-identify serves live traffic) | `scan-identify` | READY (already in use by both) |
| `SUPABASE_SERVICE_ROLE_KEY` | present (platform-provided) | present (platform-provided) | `scan-identify`, `kplus-activate`, `kplus-reconcile-revenuecat` | READY |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | present (platform-provided) | present (platform-provided) | all functions | READY |
| `REVENUECAT_SECRET_API_KEY` | not independently verified | not independently verified | `kplus-reconcile-revenuecat` | **needs human verification before deploying that function to production** |
| `REVENUECAT_PROJECT_ID` | not independently verified | not independently verified | `kplus-reconcile-revenuecat` | needs human verification |
| `REVENUECAT_KPLUS_ENTITLEMENT_ID` | not independently verified | not independently verified | `kplus-reconcile-revenuecat` | needs human verification |
| `REVENUECAT_SYNC_ENABLED` | not independently verified | not independently verified | `kplus-reconcile-revenuecat` | needs human verification (this looks like a kill switch; confirm intended production default) |
| `KPLUS_RECONCILE_INTERNAL_SECRET` | not independently verified | not independently verified | `kplus-reconcile-revenuecat` (internal-invoker auth) | needs human verification |
| `WATCHLIST_WORKER_SECRET` | referenced by `watchlist-tier2-sweep.yml`, staging-scoped | not applicable — worker deliberately not promoted (see Phase 6) | N/A for this scope | N/A |

### Client-side feature flags (build-time, `EXPO_PUBLIC_*`)

These gate UI, not backend data — the corresponding migrations are inert
without them regardless of this convergence:

| Flag | Current default | Governs | Note |
| --- | --- | --- | --- |
| `EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED` | off | K+ UI surfaces | promoting K+ migrations does not turn this on; a future build decision |
| `EXPO_PUBLIC_SMART_WATCHLIST_V1` | off | Watchlist UI | same |
| `EXPO_PUBLIC_DRESSING_ROOM_DEDUPE_V1` | off | client-side dedupe check-before-insert path | this PR's B33-CON-001 fix is a backend-only hardening of the mechanism this flag gates, independent of the flag's own state — see PR #435 |

No `app_config` table rows specific to K+/Watchlist/Signature Style feature
gating were found beyond `watchlist_worker_enabled` (seeded `false`, backend
kill-switch for the deliberately-not-promoted sweep worker).

---

## Remaining differences (explicitly out of scope this pass)

Everything staging carries that isn't one of the 11 named categories, the two
P3 defects, or the reaction-counts fix — listed so nothing is silently
dropped from view, not because any of it is a defect:

- **VTO** (`vto_feature_control`, `vto_generation_reservations`,
  `vto_paid_quota_attempt_counting`, `vto-generate` function, etc.) — Build
  34/35 in-progress.
- **Wearables** (`wearable_pairings_sessions`, `wearable_security_hardening`,
  `wearable-bridge`/`wearable-save`/`wearable-open-on-phone`/`wearable-scan`
  functions) — per `config/backend-authority.json`, governed by a different
  repository entirely.
- **`user_closet_items`, `user_style_profiles`** and their RLS/media
  migrations — Build 34/35 in-progress closet/style-profile work.
- **Investor inquiries, waitlist signups** — unrelated intake features.
- **Image-ingestion quarantine, content-report AI-output extensions** —
  unrelated moderation-pipeline work.
- **Watchlist beyond the 2 named migrations** — the ~16 other Watchlist
  migrations are prerequisites for those 2 (see Phase 5) and so travel with
  them; Watchlist product surfaces beyond push-receipts/F-03 (the worker
  itself, device-route/account-state beyond what's load-bearing) are not
  independently promoted.
- **K+ beyond the 5 named migrations** — same shape: prerequisites travel
  with the named items; nothing beyond them (e.g. any K+ work dated after
  2026-09-15) is in scope.
- Staging-only diagnostic/tooling Edge Functions (`staging-health`,
  `product-match`, `vto-provider-diag`, `rapidapi-key-diag`,
  `rapidapi-current-audit`) — explicitly not-governed or diagnostic residue
  per `config/backend-authority.json`.

---

## Final verdict

**PRODUCTION_BACKEND_CONVERGENCE_BLOCKED**

Not blocked on any defect in this plan — blocked because, per explicit
decision this session, production is never mutated directly from this
session; it is mutated only by a human dispatching
`production-controlled-deploy.yml` (added in this PR) with required-reviewer
approval. Closure conditions:

1. PR #435 reviewed and merged to `rebuild/backend-authority-v2`.
2. A GitHub "production" Environment configured with required reviewers
   (repo-settings prerequisite the workflow file documents but cannot itself
   configure).
3. **The scan-identify SEC-002/SEC-003 gap (URGENT, above) closed on
   production** — independently of everything else here, on its own
   urgency. Ready to deploy today via `production-controlled-deploy.yml`.
4. Owner sign-off on `20260704175544_free_tier_utility_tables.sql` for
   production (item 10's blocker, Phase 5) — either approve it for
   production now, or hold item 10 back.
5. Direct `list_migrations` verification of item 3's dependency
   (`ai_stylist_looks_extension.sql`) against production, and of items
   4–10's true ledger-version identity, immediately before running the
   promotion (Phase 5).
6. Each of the 30 migrations across the three dependency closures (Phase 5,
   K+ 7 + Watchlist 13 + Signature Style 9 + reaction-counts 1 — plus
   `free_tier_utility_tables.sql` only if #4 above clears it) explicitly
   approved — not applied merely because staging has them.
7. `production-controlled-deploy.yml` run, once per approved item, by a
   human reviewer.
