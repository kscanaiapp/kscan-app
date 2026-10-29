# Secondary commerce client preparation

This branch is mobile/shared UI preparation only. Canonical backend work is on
`codex/black-owned-discovery-v1`, targeting `rebuild/backend-authority-v2`.
Use its engineering report and Activation Runbook for schema, server controls,
staff sandbox setup, prospect intake and release approvals. Do not deploy this
branch's copy of Supabase functions.

`services/blackOwnedDiscovery.ts` defines the versioned public subset and an
abortable request helper. Call it with the existing authenticated Supabase
function invoker after primary commerce settles, passing `enabled:true` and
`primarySettled:true`. Only sanitized fashion attributes, market and primary
product IDs/URLs are projected. It never sends scan photos or modifies primary
results. Errors, cancellation and an 1,800 ms deadline leave the secondary absent.

Server organic discovery and ownership badges default ON by owner instruction;
explicit `false` is each server rollback. Optional card metadata is never inferred
from a name. `BlackOwnedDiscoveryShelf` is a prepared, default-unmounted surface:
it supports real inventory, the existing guarded Shop action and an optional
host-supplied Save callback. Empty/unavailable results render no placeholder.

`SponsorshipSandboxShelf` is exclusively a prepared internal demo surface. It
requires the `sponsorship-sandbox-v1` contract, `sandbox:true`, a staff-verified
host context and per-product `previewOnly:true` plus `disclosure:'Sponsored'`.
It always renders Sandbox and Sponsored and offers no purchase/save handoff.
Public endpoint authorization and explicit non-production checks remain
server-side; no client parameter grants access. There is no customer sponsored
renderer and no active campaign in this change.

Optional `ownershipIdentity` and `sponsoredDisclosure` props on the existing
ProductCard preserve ordinary rendering when omitted. Server primaryOwnership
metadata can be attached by ID to live props without sorting or persisting it.
The metadata-only telemetry module allowlists events/counters, is bridged to the
existing PostHog sink, and never treats a Shop click as a confirmed conversion.

## Host integration (live Scan Results)

The live surface is `components/scan-results/ScanResultV2.tsx` (mounted by
`app.js` when `SCAN_RESULTS_V2_UI_ENABLED`). `hooks/useBlackOwnedDiscovery.ts`
issues the request only once `isPrimaryCommerceSettled` is true (inline products,
or deferred commerce reaching success/empty/error; never during multi-item
confirmation or for non-fashion), aborts it on a new request key or unmount, and
discards superseded responses. `services/blackOwnedDiscoveryHost.ts` projects the
structured identification snapshot (legacy metadata fallback), market `US`, and
primary `{id, productUrl}` only. The client gate is the existing remote
`priceDiscovery` kill switch; no new EAS flag was added. Server flags remain
authoritative.

`BlackOwnedDiscoveryShelf` renders below the primary panels only with genuine,
organic, non-duplicate products. `primaryOwnership` is filtered to verified,
current, permitted identities for rendered primary ids and passed as an id-keyed
map to `SimilarFindsShelf` (badge overlaid on the fixed-ratio card image) and
`PurchaseOptionsPanel` (inline on the existing retailer line), so a late badge
does not move layout or reorder/reclassify primary cards. This surface has no
per-product Save for primary cards, so the organic shelf offers Shop only.
`SponsorshipSandboxShelf` is not mounted anywhere customer-facing.

No EAS artifact is built by this change; mobile binary deployment is deferred by
the owner. Device review of the badge overlay, retailer-line badge, shelf layout,
accessibility and image loading on iOS and Android remains required.
Run `node --test __tests__/blackOwnedDiscoveryClient.test.js
__tests__/sponsorshipSandboxRender.test.js` and `npx tsc --noEmit -p tsconfig.json`.
Actual iOS/Android layout, keyboard, accessibility and image loading need device
review when a host mounts these prepared components. Render tests use React DOM
with native view stubs and verify disclosure and default ordinary-card behavior.

CI remediation: exact patched overrides/lock entries for compression 1.8.2,
proxy-addr 2.0.8, shell-quote 1.12.0, source-map-js 1.2.2 and node-forge 1.4.2
repair the older mobile base's dependency reachability failure. No dependency
exception was broadened. The live reachability check passes. Linux Project checks
passed on the initial client commit; local Windows full-suite failures include
inherited ESM absolute-path loader limitations and recorded baseline failures.
The focused client, privacy-scrubbing and real disclosure-render tests pass, and
TypeScript passes. Backend: https://github.com/kscanaiapp/kscan-app/pull/641.
Client: https://github.com/kscanaiapp/kscan-app/pull/642.
