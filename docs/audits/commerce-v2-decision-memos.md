# Commerce V2 (Build 35) — Decision Memos

Owner/business decisions this lane surfaced but is not authorized to make
unilaterally (Build 35 §30, §32, §88). Recorded here rather than silently
invented or silently skipped.

---

## Memo 1 — Commerce-exit click event

**Status: EVENT INSTRUMENTATION DEFERRED. `openCommerceOffer()` ships with
destination validation and opening wired; event recording is a documented
no-op seam, not a fabricated call to an unproven pipeline.**

### Current schema

- No client-side "user tapped Shop/Buy" event exists anywhere in the app
  today. Every Shop handler across `ProductShelf.tsx`, `PurchaseOptionsPanel.tsx`,
  `SecondhandShelf.tsx`, `SneakerMatchCard.tsx`, and the Watchlist detail
  screen calls `Linking.openURL`/`openExternalUrl`/`openPersistedCommerceUrl`
  directly, with no analytics call nearby (confirmed by repo-wide grep for
  `commerce_exit`, `shop_click`, `watch_click`, `buy_click` — zero matches).
- The only server-side commerce table, `scan_commerce_events`
  (`supabase/functions/scan-identify/commerceOutcomeCapture.ts`), is
  **request-level** funnel telemetry (one row per `scan-identify` call, not
  per tap) and its own header comment explicitly forbids it from ever
  storing a product/image/purchase URL. It structurally cannot become a
  click event.
- `services/analytics/posthogClient.core.ts` is live and has an explicit,
  documented "no consent authority yet" caveat in its own source (line
  ~31-38). It is wired to an allowlist of existing sinks (Closet, K+,
  Today-with-Elise, voice, VTO); commerce is not one of them.

### Missing signal

A row-level event fired at the moment a user taps Shop or Watch, carrying
enough to answer "which retailer/offer did a Shop tap actually open" —
currently unanswerable from any existing table or event stream.

### Minimal addition (proposed, not built)

A new event (`commerce_exit` or similar), bounded to non-sensitive fields
only, matching the shape `openCommerceOffer()` already computes internally:

- event type (`shop` | `watch_created`)
- resolved `retailerKey` (registry key, or `null` for unknown)
- `commerceType` (`retail` | `resale` | `null`)
- `sourceAuthority` (`declared` | `domain` | `unknown`)
- source surface (e.g. `product_shelf`, `purchase_options_panel`, `watchlist_detail`)
- scan/result context id already available to the caller (no new PII)
- timestamp

Explicitly **not** captured: raw URL/query string, any affiliate/tracking
parameter, auth tokens, PII, raw image data, user-entered text — matching
`commerceOutcomeCapture.ts`'s own existing prohibition list.

### Privacy impact

Unclear until the consent-authority gap `posthogClient.core.ts` itself
documents is resolved. Wiring a new event through PostHog before that gap
is closed would extend an already-flagged gap into a new surface — this
lane declines to do that unilaterally.

### Migration required?

Yes, either a new Supabase table (own migration, own RLS, service-role
insert only — mirroring `scan_commerce_events`'s posture) or a new PostHog
event once/if the consent-authority gap is resolved. Neither is built here.

### Reversibility

Fully reversible either way — the event is purely additive telemetry with
no read path anything else depends on. Low risk to add later; the risk
here is only in adding it *before* the consent question is settled.

**Recommendation:** owner decides sink (new table vs. PostHog-once-consent-
resolved) and confirms the field list above. Until then, `openCommerceOffer()`'s
event-recording call is a documented no-op (`recordCommerceExitEvent` in
`services/commerce/commerceExit.ts`) so it can be filled in without touching
every call site again.

---

## Memo 2 — Affiliate/attribution tagging

**Status: NOT PROVEN — confirmed absent, not invented.**

The pre-build audit found zero affiliate/partner/network parameter
handling anywhere in this codebase: no tag injection, no click-id minting,
no partner config (`services/commerceDestination.ts`, the two URL
normalizers, and every `supabase/functions/` provider adapter were
checked). `affiliateUrl` exists only as a passthrough field name, always
null in the one fixture that carries it (`data/catalog.json`), never
populated by any live provider adapter.

`openCommerceOffer()` therefore has nothing to preserve and preserves
nothing — it does not strip anything that might arrive on a URL, and it
does not add anything either. If/when a provider adapter starts supplying
a genuine affiliate URL, `openCommerceOffer()` already opens whatever safe
URL it is given byte-identical (same guarantee `commerceDestination.ts`'s
`selectCommerceDestination` already provides), so no further change would
be needed on the opening side — only on the provider-adapter side that
would start supplying the tagged URL.

**No action taken. No affiliate relationship, network, or tag was
invented.**

---

## Memo 3 — Affiliate disclosure copy

**Status: OWNER/COUNSEL ACTION REQUIRED.**

No existing approved affiliate-disclosure copy or surface exists anywhere
in the app (grep for disclosure/sponsored/commission-adjacent language
returned nothing). Per §32, this lane does not draft legal disclosure
copy on its own authority. A sensible placement, if/when copy is
approved, is a small persistent line near the Shop/Watch action group on
a commerce card (e.g. below the purchase-option list) — reserved, not
built.

**Launch readiness for a Shop-emphasized surface may remain held pending
this.**
