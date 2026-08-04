# Provider edge hardening — Pass 4 (2026-08-03)

## Scope

Extends the shared security architecture proven in `stylechat-generate`
(Phase 10 / prior passes) to the 5 remaining provider-backed Edge Functions,
in the required order:

1. `product-search-deals`
2. `search-vinted-secondhand`
3. `tryon-clothes-pro`
4. `kickscrew-sneaker-description`
5. `nike-shoe-details`

Every function now has: verified auth (`_shared/security/context.ts`,
fail-closed, denies `pending_deletion`/`locked` accounts), caller-aware CORS,
content-type/size-bounded request reading, provider-cost quota reservation
via the existing `provider_request_*` tables/RPCs, bounded-retry provider
fetch with typed HTTP classification, and privacy-safe structured logging.
No new quota framework, no new migration, no client contract change, no
production change.

## Per-function summary

### product-search-deals

- Single-provider RapidAPI GET proxy. No live caller
  (`services/productSearchDeals.ts` is unimported anywhere under
  `app/components/hooks/services/contexts`).
- Fixed a privacy leak: success logging previously included the raw user
  search query (`'q=', parsed.q`); now logs only its length.
- Field-parsing (`parseRequest`) is unchanged from the pre-hardening source
  — out-of-range `limit`/`offset` are still clamped to defaults rather than
  rejected, preserving the original graceful-degradation behavior instead of
  introducing a new 400 for values the original silently tolerated.
- Quota category: `retail_search`.
- Cleared for staging redeploy (`STAGING_DEPLOYMENT_ALLOWLIST`).

### search-vinted-secondhand

- **Correction to a prior-pass finding**: this function *does* have a real,
  live, active caller. `hooks/useKScan.js` imports `searchVintedSecondhand`
  from `services/secondhand.js` and invokes it automatically after every
  scan. The earlier "no live caller" conclusion came from a grep that
  excluded `.js` files.
- Confirmed provider mechanism is **Apify** (`APIFY_API_TOKEN`,
  `APIFY_VINTED_ACTOR_ID`, `APIFY_VINTED_INPUT_TEMPLATE`,
  `APIFY_VINTED_TIMEOUT_SECS`), not RapidAPI or another mechanism — verified
  by reading the function's actual source before changing anything.
- The `{ enabled, items, error, meta }` response contract, and its
  graceful-degradation-on-any-provider-failure behavior, are preserved
  exactly. The client (`services/secondhand.js`) already tolerates any
  `invoke()` failure by falling back to an empty result, so the new
  auth/quota rejection paths (401/403/429) are safe additions, not contract
  breaks.
- Required Apify secrets are **absent from staging**. Per instruction, this
  function is hardened and tested here but stays **off**
  `STAGING_DEPLOYMENT_ALLOWLIST` — deploying it now would leave every real
  request degrading to `SECONDHAND_RESULTS_UNAVAILABLE` for lack of
  credentials.

### tryon-clothes-pro

- Confirmed provider mechanism is **RapidAPI** (shared `RAPIDAPI_KEY`), not
  ModelsLab, despite `MODELSLAB_API_KEY`/`MODELSLAB_TRYON_ENABLED` being
  present on staging (they back an unrelated path, not this function).
- Zero-Knowledge review: the function never logged or persisted raw image
  content before this change, and still doesn't — no new log line or error
  path echoes `person_image`/`top_garment`/`bottom_garment`. No blocker to
  report; the privacy boundary is satisfiable as designed.
- Closed a real gap: request size was **previously unbounded**, a genuine
  cost-abuse and privacy-surface concern given these fields carry image
  data. Added a 10 MB request-body cap (generous for two base64-encoded
  phone photos).
- No live caller (`services/tryOnClothesPro.ts` is unimported anywhere under
  `app/components/hooks/contexts`, re-verified including `.js`/`.jsx`).
  Stays undeployed; no explicit deploy decision made this pass.
- Quota category: `visual_tryon` (tightest budget of the 5: concurrent
  limit 1, cost units 4 — reflects real per-call provider cost).

### kickscrew-sneaker-description

- Live caller confirmed:
  `services/sneakers/providers/kickscrewRapidApi.ts` →
  `services/sneakers/index.ts` → `components/AnalysisCard.tsx`,
  `components/SneakerMatchCard.tsx`, `hooks/useKScan.js`. The client
  deep-normalizes the raw upstream JSON, so the success response remains the
  exact unwrapped upstream payload.
- Kept intentionally minimal per instruction ("do not make this the
  architecture reference implementation") — same standard control set as
  the others, no extra abstraction.
- Cleared for staging redeploy.

### nike-shoe-details

- Zero live callers (re-confirmed). Removed from staging in the prior
  cleanup pass (`unintended-staging-deployments-2026-08-03.md`).
- Hardened and tested per the "harden even undeployed functions" requirement,
  but stays undeployed — no live caller, no explicit deploy decision made
  this pass.

## Quota seed review

Reviewed the existing seeded `provider_request_limits` rows (migration
`20260803020000_provider_request_security.sql`) against each function's
actual timeout/retry behavior after hardening:

| Function | `reservation_ttl_seconds` | Worst-case call duration after hardening |
|---|---|---|
| product-search-deals | 20s | ~40.2s (2 × 20s upstream timeout + backoff) |
| search-vinted-secondhand | 20s | ~31.5s (Apify's own configurable timeout, unrelated to this pass — no retry was added here) |
| tryon-clothes-pro | 60s | ~40.2s (2 × 20s + backoff) — comfortably within TTL |
| kickscrew-sneaker-description | 15s | ~8.2s (2 × 4s + backoff) — within TTL |
| nike-shoe-details | 15s | ~16.2s (2 × 8s + backoff) — slightly exceeds TTL |

**Finding, not acted on**: for `product-search-deals` and `nike-shoe-details`,
the bounded retry added this pass can theoretically exceed the seeded
reservation TTL, but only in the pathological case of two consecutive
full-timeout provider failures — not normal operation (a real 429/5xx
response returns fast; the retry adds low latency in practice).
`search-vinted-secondhand`'s TTL was already tight against Apify's own
timeout ceiling, independent of anything changed this pass. None of this
rises to "incompatible with normal function behavior," so **no quota
threshold was changed**, consistent with the standing pause on quota-
threshold edits. Flagging for awareness; recommend a dedicated review if
this becomes a real timeout-vs-TTL race in staging telemetry.

No migration was required this pass — all 5 functions already had seeded
`provider_request_limits` rows from the earlier migration.

## Deployment

`STAGING_DEPLOYMENT_ALLOWLIST` (`security/scripts/staging-deployment-allowlist.js`)
now reads:

```
privacy-controls, public-sale-share-opt-out, handle-user-deletion,
privacy-correction-request, privacy-data-export, stylechat-generate,
product-search-deals, kickscrew-sneaker-description
```

`search-vinted-secondhand`, `tryon-clothes-pro`, and `nike-shoe-details`
remain off the allowlist — hardened and tested in source, but not deployed,
per their respective conditions (Apify secrets absent / no explicit deploy
decision / no live caller) not being met this pass.

## Testing

299 tests passing across this pass's scope:

- 137 Deno integration tests across the 5 hardened functions (31 + 26 + 28 +
  26 + 26), each covering Auth, Validation, Quota, Provider, Privacy, and
  Contract categories via a `RequestOverrides` test-injection seam
  (`authenticate`/`fetchImpl`) mirroring the existing `clientFactory` pattern
  in `_shared/security/context.ts`.
- 68 Deno unit tests for the shared security modules (unchanged, re-verified).
- 8 Deno tests for the `stylechat-generate` reference implementation
  (unchanged, re-verified).
- 86 Node tests for `security/scripts/*` (unchanged plus the 7
  deployment-allowlist tests built to support this pass).

`deno check` passes cleanly for all 5 hardened functions.

## Secrets referenced (names only)

`RAPIDAPI_KEY` (product-search-deals, tryon-clothes-pro,
kickscrew-sneaker-description, nike-shoe-details), `APIFY_API_TOKEN`,
`APIFY_VINTED_ACTOR_ID`, `APIFY_VINTED_INPUT_TEMPLATE`,
`APIFY_VINTED_TIMEOUT_SECS`, `SECONDHAND_VINTED_ENABLED`
(search-vinted-secondhand). No secret was added, rotated, or printed as part
of this pass.

## Production

Not touched. All work targets `yzqjvdfgefveprobvvyw` (App Staging) only.
