# DDoS and Degraded-Mode Playbook

- **Date**: 2026-08-03 · Companion to `docs/security/public-ingress-inventory.md` and `docs/security/supabase-exposure-audit.md`

## Detection signals

| Signal | Where observed | Threshold to investigate | Threshold to act |
|---|---|---|---|
| Request volume | Supabase Edge Function logs (`get_logs`, service `edge-function`); Render request logs | 3× the highest 5-minute volume seen in the trailing 7 days for a given function | 10× — begin emergency controls |
| Error rate (5xx) | Same logs, `status_code >= 500` | >5% of requests over 5 minutes | >20% over 5 minutes |
| 401/403 rate | Same logs | Sudden spike with no corresponding deploy (credential-stuffing signal) | Sustained >50% of traffic to one function |
| Provider failure rate | `provider_security_events` table (`outcome='provider_error'`); `_shared/security/provider.ts` retry/timeout logs | >10% of provider calls failing over 10 minutes | >40% — treat provider as degraded, see below |
| Database connection pressure | Supabase dashboard connection-pool metrics (not queryable from this repo's tooling) | Pool >70% utilized | Pool >90% utilized |
| Storage pressure | `storage.buckets`/`storage.objects` growth rate vs. historical baseline | 2× normal daily upload volume | 5× — investigate for abuse before it becomes a cost event |
| Email-delivery abuse | Supabase Auth signup rate (no per-repo metric; dashboard-only) | Signup rate 3× baseline | Signup rate 10× baseline — likely automated account creation |
| Account-creation abuse | `profiles` row growth rate | Same as above | Same as above |
| Waitlist abuse | Out of repo scope (website-owned) — flag to website team | n/a | n/a |
| Privacy-form abuse | `deletion_requests`/`privacy_correction_requests`/`privacy_export_requests` insert rate | 5× baseline per-IP-equivalent (no per-request rate limit exists today — see finding below) | Sustained volume that could indicate automated form-spam |
| Provider-cost exhaustion | `provider_request_reservations`/`provider_request_limits` (rolling/daily counts approaching `rolling_limit`/`daily_limit`); Render/Gemini billing dashard for `/api/analyze` (no per-repo quota exists there — see finding below) | 80% of any function's daily_limit consumed before 50% of the day has elapsed | 95% consumed at any time |

**Known gap, stated plainly**: `handle-user-deletion`, `privacy-correction-request`, `privacy-data-export`, and `server.js /api/analyze` currently have **no rate limiting or quota mechanism** to generate the signals above automatically (the `/api/analyze` gap is partially closed by this pass's in-memory limiter; the three privacy/deletion functions remain unmetered). Until they're instrumented, detecting abuse on those specific paths relies on manual log review or Supabase's platform-level metrics, not on this repo's own tooling.

## Incident roles

- **Incident lead**: coordinates the response, owns the go/no-go decision on emergency controls, communicates status.
- **Staging verifier**: runs the existing verification suite (synthetic-auth tests, staging health checks, contract tests) against staging before *any* control is promoted, confirming it doesn't break legitimate flows.
- **Evidence keeper**: exports the relevant `get_logs`/`provider_security_events`/CI-artifact snapshots *before* any mitigation changes state, so root cause remains reconstructable afterward.

A single person may hold more than one role for a small-scale incident; a real DDoS/degraded event should have at least two people involved before an emergency control is promoted to production-equivalent effect.

## Emergency controls (staging-verified before any promotion)

In priority order, per the brief's prioritization (privacy → auth → existing user access → scan → retailer-neutral discovery → transactional paths → nonessential enrichment):

1. **Temporary route restriction** — for a single abusive Edge Function, lower `provider_request_limits.rolling_limit`/`concurrent_limit` via an additive migration (same mechanism as the TTL-tuning pass) rather than taking the function offline entirely, preserving service for legitimate users while capping the abusive volume.
2. **Provider disablement** — if a specific upstream provider (Gemini, RapidAPI, Apify, OpenRouter) is itself degraded (high failure rate, not K Scan's own traffic), the existing `_shared/security/provider.ts` timeout/retry classification already fails closed to `provider_unavailable` (503) per-request; no code change needed to "disable" a provider — it already degrades gracefully. For `server.js /api/analyze`, the existing `ALLOW_DEV_FALLBACK` env var already provides a non-provider fallback path if explicitly enabled during an incident (existing mechanism, not new).
3. **Read-only mode** — not currently implemented anywhere in this codebase as a single toggle. If needed, the fastest safe path is scoped to the specific abused write path (e.g., temporarily set a function's `provider_request_limits.enabled = false`, which `reserve_provider_request` already treats as "use conservative built-in defaults," not "fail open" — confirmed in the migration source).
4. **Commerce fallback behavior** — retailer-neutral ordering must be preserved even in a degraded state (`normalizeProviderError`'s retailer-neutrality guarantee, tested in `provider.test.ts`, holds regardless of load). **Do not** preferentially route to a single retailer during a provider outage — if `product-search-deals`' fan-out to multiple retailers is degraded, return whatever subset succeeded rather than substituting a "favored" retailer.
5. **User-facing status behavior** — the existing `provider_unavailable` (503) / `rate_limited` (429, with `Retry-After`) error contracts already give the client enough information to show a friendly, non-alarming status message without exposing internals (verified in `docs/security/provider-edge-compatibility-validation.md`, Pass H). No new user-facing status page exists in this repo; that would be a product decision outside this phase's scope.

## Recovery verification

After any emergency control is lifted:

1. Re-run `security/scripts/report-staging-inventory-diff.js` equivalent (deployed-function count before/after) to confirm no unintended state change persisted.
2. Re-run the synthetic-auth tests and staging health checks to confirm normal traffic is unaffected.
3. Confirm `provider_request_limits` values match their last-known-good state (git-diff the migration history — any emergency threshold change should itself be an additive migration, reversible the same way).
4. Confirm legitimate staging data (waitlist/privacy/deletion counts) is unchanged from the pre-incident snapshot.

## Rollback

Every control above is either (a) an additive migration (reversible by another additive migration restoring prior values — never edit an already-applied migration file) or (b) a code-level toggle already gated behind an existing env var (`ALLOW_DEV_FALLBACK`, `provider_request_limits.enabled`). Nothing in this playbook proposes an irreversible action.

## Evidence preservation

Before lifting any emergency control, export: the relevant `get_logs` window, the `provider_security_events` rows for the incident window, and the CI run URLs for whichever workflow runs were active. Store alongside the incident write-up — this repo does not currently have an automated evidence-export script; that is a reasonable Phase-4-style follow-up, not implemented in this pass.

## Preserving the primary experience during partial failure

Consistent with the stated priority order:

1. **Privacy** — the privacy/deletion/export/correction paths must keep functioning even during a provider incident (they don't depend on any external provider at all — pure Supabase Auth + Postgres), so they should be the *last* thing throttled, not the first.
2. **Authentication** — Supabase Auth is a separate platform service from the Edge Functions layer; an Edge Function incident does not affect login/signup.
3. **Existing user access** — reading previously-saved scans/looks/dressing rooms has no provider dependency; unaffected by a provider-cost incident.
4. **Scan functionality** — the core value proposition; degrade gracefully (503 `provider_unavailable`) rather than hang or error opaquely.
5. **Retailer-neutral discovery** — must degrade to "fewer results," never to "one favored retailer's results."
6. **Transactional paths** — not yet implemented in this codebase (no payment/checkout flow found in this repo); not applicable today.
7. **Nonessential enrichment** (secondhand search, sneaker lookups, style chat) — first to throttle/disable under load, per the existing per-function `provider_request_limits` already differentiating cost/priority by function.
