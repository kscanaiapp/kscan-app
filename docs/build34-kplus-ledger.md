# Build 34 — K+ Complimentary Early Access: Source-of-Truth Ledger

Status: **K+ COMPLIMENTARY GATE CLOSED — BUILD 34 PRODUCT BUILDS UNBLOCKED**
Closure date: 2026-08-29
Production promotion: **NOT PERFORMED** (staging only, per owner decision)

## Frozen K+ Foundation (source authorities)

| Authority | Branch | SHA | Remote match | Clean |
|---|---|---|---|---|
| Backend | `integration/backend-kplus-complimentary-staging-v1` | `4f0b8f12980c6e914ed4440163359e63226538fe` | YES | YES |
| iOS | `integration/ios-build34-kplus-foundation-v1` | `a6962b962010402106ce9e52717dacc14b6f0165` | YES | YES |
| Android | `integration/android-build34-kplus-foundation-v1` | `f893568d7dc5eaa6d26c8eeb9f299d01e5f763f1` | YES | YES |
| Migration authority | `maintenance/staging-migration-authority-reconciliation` | `e8ae6fb95810ce00ff49b0523e8a6a7786d6ccce` | YES | YES |

The backend SHA moved from `573510f` to `4f0b8f1` during closure (two forward-only commits fixing the RevenueCat integration — see below); the other three authorities are unchanged from when this closure pass began.

**Known integration gap, out of scope for this ledger:** `maintenance/b34-def001-backend-authority` does not yet contain the K+ backend work above, due to a merge-order race when PRs #207–#210 were merged in quick succession (PR #207 carried the pre-K+ state of the migration-authority branch into it before PR #208 merged K+ into that same branch). Not a K+ defect; flagged for the next integration pass.

## Feature / Fix Matrix

| Feature / Fix | Source branch | Source SHA | iOS | Android | Backend | Staging verified | Production verified |
|---|---|---|---|---|---|---|---|
| K+ entitlement schema (`user_entitlements`, `kplus_activation_events`) | backend | `573510f` (schema), `4f0b8f1` unaffected | N/A | N/A | YES | YES — both migrations applied and confirmed live via `list_migrations` | NO |
| Complimentary activation (`kplus-activate` Edge Function + client call) | backend / iOS / Android | backend `573510f`; iOS `a6962b9`; Android `f893568` | YES | YES | YES | YES — live authenticated activation proven end-to-end with real staging test identities | NO |
| Six-month expiration (exact grant window) | backend | `573510f` | YES (display only) | YES (display only) | YES | YES — live grant measured exactly `granted_at + 6 months` | NO |
| One-time grant protection (idempotent, cannot restart after expiry) | backend | `573510f` | N/A | N/A | YES | YES — duplicate activation returns identical `expiresAt`; backdated-expired entitlement confirmed unable to restart the campaign | NO |
| RLS (own-row read only, no client mutation path) | backend | `573510f` | N/A | N/A | YES | YES — cross-account read returns empty, cross-account **and same-account** direct mutation both return `42501 permission denied` | NO |
| Server entitlement authority (client body never trusted) | backend / iOS / Android | backend `573510f`; iOS `a6962b9`; Android `f893568` | YES | YES | YES | YES — tampered request body (fake user_id/expiry/tier) fully ignored by the server | NO |
| RevenueCat promotional synchronization | backend | `4f0b8f1` | N/A | N/A | YES | YES — real staging grant synced, customer UUID and entitlement/expiry parity confirmed via live DB read | NO |
| RevenueCat failure/retry behavior (local grant never blocked; no duplicate re-sync) | backend | `4f0b8f1` | N/A | N/A | YES | YES — proven under a real, then-genuine RevenueCat failure (V1/V2 key incompatibility) that local K+ remained valid throughout; post-fix, a second reconcile pass correctly no-ops on an already-synced row | NO |
| K+ upgrade sheet (`KPlusEarlyAccessSheet.tsx`) | iOS / Android | iOS `a6962b9`; Android `f893568` | YES | YES | N/A | YES — code-verified to call the real `kplus-activate` contract; no simulator/device run performed in this environment | NO |
| Profile entitlement state (`app/privacy.tsx` K+ block) | iOS / Android | iOS `a6962b9`; Android `f893568` | YES | YES | N/A | YES — code-verified, real server expiry displayed; no device run performed | NO |
| Voice Scan entitlement placeholder | iOS / Android | iOS `a6962b9`; Android `f893568` | YES (placeholder, unbuilt) | YES (placeholder, unbuilt) | N/A | N/A — no backend feature exists to verify | N/A |

## Notes for the next phase

- Neither platform renders the literal compound heading "K+ Early Access" as a single string (it's split across a short "K+" label and a separate "Early Access"-bearing pill/subtitle). Consistent on both platforms — not a parity defect, just a wording nuance worth a follow-up pass if the exact phrase matters for marketing/legal copy.
- RevenueCat's V2 API requires the customer record to exist before `grant_entitlement` will succeed (V1 auto-created it; V2 does not) — handled via an idempotent `ensureCustomerExists` call in `supabase/functions/_shared/revenuecat/revenueCatClient.ts`.
- If/when K+ is promoted to production, the same two staging secrets (`REVENUECAT_SYNC_ENABLED`, `KPLUS_RECONCILE_INTERNAL_SECRET`) will need to be set there too — the owner has already updated `REVENUECAT_SECRET_API_KEY` on both staging and production.
