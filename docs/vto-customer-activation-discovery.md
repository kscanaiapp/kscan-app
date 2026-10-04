# VTO Customer Activation & Discovery (Build 35)

Virtual Try-On was already a K Scan capability. This lane makes it **visible**
at the moments it adds value — _See it → Find it → Try it on → Decide → Buy it_
— without changing who may try something on, which items qualify, when a photo
leaves the device, or what a generation costs.

```
BASE_BRANCH=integration/build35-v1-convergence
BASE_SHA=65565e709197c02056b586c40dc5269092b540c5
BRANCH=feature/build35-vto-customer-activation-v2

VTO_AWARENESS_SURFACES_IMPLEMENTED=kplus_step6 (benefit line), home (discovery card),
  scan_result (product control + first-use cue), product (control, legacy shelf)
VTO_AWARENESS_SURFACES_DEFERRED=commerce (ProductShelf first-use cue and surface
  attribution, pending #457); result decision loop (pending #455);
  Elise / Dressing Room / Watchlist entry points (none exist today)
```

Awareness is presentation. It adds **0 provider calls, 0 model calls, 0 paid
generations**; its only network read is the one memoized `app_config` row every
Try It On control already shares.

## What existed, and what this lane consumes

| Question | Authority (unchanged) | How awareness uses it |
| --- | --- | --- |
| Does this build carry VTO? | `EXPO_PUBLIC_VTO_UI_ENABLED` (`constants/featureFlags.ts`) | input to `resolveVtoSurfaceAvailability` |
| Is VTO on right now? | `app_config.vto_generation` via `services/vto/vtoFeatureControl.ts` | same reader, same 60 s memo |
| Is this item eligible? | `services/vto/vtoEligibility.ts`, re-derived by `vto-generate` | via `hooks/useVtoAvailability` only |
| Does this actor hold K+? | `hooks/useKPlusEntitlement` (canonical summary) | read-only; `loading`/`error` are never Free |
| May a photo be sent? | `services/vto/vtoConsent.ts` + `VtoConsentStep` + store proof | **not touched** |
| Provider, quota, idempotency | `supabase/functions/vto-generate` | **not touched** |

`VTO_SHIPPING_MODE`: AI Photo (generative), behind `EXPO_PUBLIC_VTO_UI_ENABLED`,
which is set only in the `staging-certification` and `production-certification`
EAS profiles. Live VTO is dark in every profile.

## The shared discovery model

`services/vto/vtoDiscovery.ts` — pure, no imports. Every surface renders what it
returns.

```
runtime VTO availability + canonical K+ + authoritative item eligibility
  + awareness history + surface context  →  presentation decision
```

It owns awareness shown/dismissed state, cue history and the Home-card
lifecycle. It does **not** own K+ authorization, RevenueCat state, provider
selection, quota, garment-category eligibility, mode resolution or the
generation state machine; `__tests__/vtoCustomerActivation.test.js` fails if any
of that vocabulary appears in a presentation module.

Supporting modules:

| File | Role |
| --- | --- |
| `services/vto/vtoAwareness.ts` | history accessors, per-account session memory, modal blockers, awareness telemetry |
| `services/featureAwareness.ts` | the persisted, actor-scoped history (outside `services/vto/`, because VTO files may hold no device storage — the same split `thirdPartyAiConsent` uses) |
| `hooks/useVtoAwareness.ts` | React bindings: gathers the model's inputs |
| `components/home/HomeVtoDiscoveryCard.tsx` | Home introduction |
| `components/vto/VtoFirstUseCue.tsx` | inline first-use cue |
| `components/icons/kscan/TryOnIcon.tsx` | the one Try It On glyph (`KScanIcon name="try-on"`) |

## Eligibility

```
VTO_ELIGIBILITY_SIGNAL_SOURCE=B — existing bounded resolver (hooks/useVtoAvailability)
VTO_ELIGIBILITY_NETWORK_COST=one memoized app_config row per 60 s, shared by every control; 0 per-card calls
DUPLICATED_ELIGIBILITY_LOGIC=NO
VTO_ELIGIBILITY_BACKEND_SCHEMA_REQUIRED=NO   (no backend source was edited)
VTO_ELIGIBILITY_STATES=CONFIRMED_ELIGIBLE | CONFIRMED_INELIGIBLE | UNRESOLVED
```

| State | Product control |
| --- | --- |
| `CONFIRMED_ELIGIBLE` + active or complimentary K+ | `TRY IT ON` → existing sheet |
| `CONFIRMED_ELIGIBLE` + positively Free | `TRY IT ON · K+` → shared K+ surface |
| `CONFIRMED_INELIGIBLE` | nothing |
| `UNRESOLVED` (row or K+ not answered) | nothing — never drawn then withdrawn |
| resolver error | nothing; the remote reader never throws, an unreadable row **is** the disabled row; no disabled control, no per-card retry |

### Fixture coverage — honest zero-case

```
VTO_FIXTURE_ELIGIBILITY_SAMPLE_SIZE=0
VTO_FIXTURE_ELIGIBLE_COUNT=UNPROVEN
VTO_FIXTURE_ELIGIBLE_RATE=UNPROVEN
VTO_ELIGIBILITY_BY_MAJOR_CATEGORY=UNPROVEN
```

The repository has 10 commerce-product-shaped fixture records
(`qa/backend-quality-tune-fixtures/fixtures.json`). None carries a category, and
category is the first thing the eligibility rule reads, so they cannot be judged
— counting them as "0 % eligible" would be measuring the fixture's shape. No
synthetic fixtures were created. What the rule itself says: four categories are
enabled by default (`top`, `outerwear`, `blazer`, `dress`); bottoms, footwear,
bags and accessories are not. Coverage is therefore narrow by design, which is
why every introduction says **eligible** look and none implies most garments
qualify.

## Free-user upgrade seam

```
FREE_USER_UPGRADE_SEAM=KPlusGate source="vto" → KPlusEarlyAccessSheet
FREE_USER_UPGRADE_SEAM_EXISTING=YES
FREE_USER_UPGRADE_SEAM_REUSE_DECISION=REUSED (already wired from TryItOnEntry; no wrapper created)
PAYWALL_COMPONENT_OR_MODEL_REUSED=components/kplus/KPlusGate.tsx + KPlusEarlyAccessSheet.tsx
NEW_PRICING_MODEL_CREATED=NO
RESOLVING_KPLUS_TREATED_AS_FREE=NO
```

**Finding for the K+ lane (not changed here).** The shared post-onboarding
surface presents the _complimentary Early Access_ offer (or "not available in
this build" when that flag is off). Step 6 now sells Monthly / Lifetime (#496).
So a Free actor who taps `TRY IT ON · K+` — or any other K+ gate — after
onboarding is offered something different from what Step 6 offered. That is a
property of the one shared sheet and affects Voice Scan, Watchlist and Packing
equally; converging it onto the paywall model is a K+ commerce decision and was
deliberately not made inside a VTO lane.

## Consent routing

```
CONSENT_GATE_PRESENT=YES
CONSENT_POSITION=inside VirtualTryOnSheet: after the photo is chosen, before any transmission;
  the request store refuses the real transport without a consent proof
CONSENT_COPY_OWNER_REVIEW_REQUIRED=NO NEW COPY (existing copy already carries
  VTO_CONSENT_COPY_LEGAL_REVIEW_REQUIRED=YES and is digest-pinned; unchanged)
UNVERIFIED_RETENTION_CLAIM_ADDED=NO
```

Every awareness route ends at the same product control, which opens the same
sheet:

```
Home card        → Scanner → eligible item → TRY IT ON → sheet → choose photo → consent → request
first-use cue    →                           TRY IT ON (the control's own handler)
K+ benefit line  → (no action; a line of text)
```

No awareness module imports the sheet, the consent step, the photo chooser, the
camera or the try-on client — asserted by test.

## Step 6 placement (#496 authority preserved)

VTO was already a row in the capability-truth catalog. This lane changes its
copy and nothing else:

| | Before | After |
| --- | --- | --- |
| title | Virtual Try-On | Try it on with AI |
| line | Visualize selected styles on you. | See how an eligible look might work on you before you buy. |

Benefit count is unchanged (catalog of four; at most two advertised today). Order
is unchanged. `KPlusMembershipStep` gains one effect that records that the row
was shown. The paywall model, parts, theme and commerce hooks are untouched.

```
PR496_PAYWALL_AUTHORITY_PRESERVED=YES
MONTHLY_DEFAULT_UNCHANGED=YES
FREE_PATH_UNCHANGED=YES
RESTORE_VISIBILITY_UNCHANGED=YES
TRIAL_METADATA_AUTHORITY_UNCHANGED=YES
```

Proven by rendering the real step with and without the row and requiring the
whole commercial surface to be deep-equal (`__tests__/kplusPaywallPhaseD.test.js`).

## Home discovery

`HOME_SURFACE_INFRASTRUCTURE`: `HomeLuxuryTechV1` had no dismissible
education-card primitive, so one small native card was added. It is not a CMS.

```
HOME_CARD_NO_SCANS_BEHAVIOR=ROUTE_TO_SCANNER
```

Home has no product, so the card never opens a try-on. Its one action is
`router.push('/scan')` for every actor.

| State | Card |
| --- | --- |
| `NEVER_ENGAGED` | shown |
| `HOME_CARD_DISMISSED` | hidden, permanently |
| `VTO_INITIATED` | retired (the actor opened a try-on) |
| `VTO_COMPLETED` | stays retired |
| `VTO_UNAVAILABLE` | hidden (flag off, switch off, dimmed, signed out) |
| `DEFERRED_AFTER_STEP6` | hidden for this session only |
| `UNRESOLVED` | hidden until every input is known |

## First-use cue

An **inline** block above the control — not a Modal, not an overlay. Opt-in per
host (`firstUseEducation`); only `PurchaseOptionsPanel` (the shipped scan-results
surface) opts in, and it declares its own modal through `useVtoAwarenessBlocker`.

```
MEANINGFULLY_VIEWED_DEFINITION=the whole Try It On control measures inside the window,
  on a focused screen with the app foreground-active, continuously for 1200 ms
  (sampled every 400 ms). Mounted off-screen, clipped, or passing through does not count.
COACHMARK_COLLISION_POLICY=suppressed while K+ is resolving, another modal is presenting,
  a try-on request or photo choice is active, a purchase/restore is processing, the host
  screen is unfocused, or the app is not foreground-active. Suppressed is SPENT, not
  queued: nothing appears when the collision clears; the cue is reconsidered only after
  the control has left the window and been viewed afresh.
```

Known limit: "another modal is presenting" is known only for modals that declare
themselves. The try-on sheet and the scan-results Watch modal do. Modals hosted
above the results surface by `app.js` / `AnalysisCard` (for example Add to
Dressing Room) do not, so a dwell can complete underneath one. The cue is inline,
so it can never stack on such a modal — the worst case is that it is already
present when the modal closes. Declaring those hosts is a one-line
`useVtoAwarenessBlocker(visible)` each and is left for device review.

Limits: once per session; at most two sessions ever; "Not now" retires it
permanently; any try-on use retires it; not shown in a session where Step 6
already pitched Try It On. Controls are only measured while the cue could still
be shown — for everyone else no timer runs.

## Awareness state

```
VTO_AWARENESS_STATE_STORAGE=device-local AsyncStorage via services/featureAwareness.ts
VTO_AWARENESS_STATE_KEY_SCOPE=kscan.featureAwareness.v1:virtual_try_on:<actorId>  (per account)
ACCOUNT_SWITCH_AWARENESS_ISOLATION=YES (storage, memory cache and session memory are all keyed by actor)
```

- **Logout** removes nothing; the record stays under the account that made it. A
  signed-out reader gets `null` and is shown nothing.
- **Reinstall** resets it.
- **Multi-device**: not synchronized. A second device may introduce the feature
  once more. No backend table was added.
- **Unknown ≠ never seen**: unreadable or corrupt storage shows nothing.
- No reusable local-preference/education mechanism existed; this follows the
  actor-scoped pattern of `services/thirdPartyAiConsent.ts`. It is not registered
  with account-deletion purge (neither is the consent record); it holds four
  booleans and a counter.

## Remote dimming

```
VTO_AWARENESS_REMOTE_DIMMING=AVAILABLE (source) — vto_generation.awareness.enabled=false
```

An additive, nested field on the existing row, read by the existing reader. It
dims the Home card, the first-use cue and the K+ benefit line while generation
and the product control keep working. It can only reduce: absent / malformed
behaves exactly as before, and it is `false` whenever `enabled` is. No row was
changed by this lane.

Release consideration: dimming removes the Try It On benefit line. If that was
the only advertised capability, Step 6 skips itself, exactly as it already does
when VTO is switched off.

## Public / anonymous

`PUBLIC_ANONYMOUS_VTO_CTA=NONE`. `useVtoAvailability` and every awareness hook
require an authenticated actor (not even the config row is read otherwise), and
`app/(public)/rooms/[token].tsx` mounts no try-on surface.

## Telemetry

```
VTO_AWARENESS_TELEMETRY=vto_awareness_impression | vto_awareness_tap | vto_awareness_dismissed
TELEMETRY_SURFACE_ATTRIBUTION=surface ∈ {kplus_step6, home, coachmark, product, scan_result, commerce}
  + actor_kplus_state ∈ {free, active, complimentary, resolving}
VTO_FUNNEL_MEASURABLE_LIVE=NO
```

Both properties are closed sets; a value outside the set is dropped. Impressions
are counted once per surface per session per account. The sink is bridged to
PostHog, but only when `EXPO_PUBLIC_POSTHOG_API_KEY` / `_HOST` are configured, and
no `eas.json` profile sets them — so the funnel is instrumented, not proven live.
`commerce` is declared for #457's shelf and not emitted yet.

## Quota exhaustion

Unchanged. `rate_limited` renders "You've reached the try-on limit for now. Try
again later." inside the sheet. No number is hardcoded, no new request is made,
and nothing in the sheet opens the K+ surface. The server-supplied retry guidance
is #455's work.

## PR convergence

| File | Current owner | This lane's change | Convergence note |
| --- | --- | --- | --- |
| `components/vto/TryItOnEntry.tsx` | #455 | model-driven control, awareness bookkeeping, optional cue, `surface` prop | #455 restructures this file on a divergent base; re-apply the five seams (cta, impression, initiated/completed, blocker, cue) onto its final shape |
| `services/vto/vtoTelemetry.ts` | #455 | 3 events, 2 bounded properties | additive; #455 appends at the tail, these sit after `vto_entry_tap` |
| `__tests__/vtoPrivacyAndWiring.test.js` | #455 | import-allowlist enrolment for 4 new modules | additive rows |
| `types/vto.ts`, `VirtualTryOnSheet.tsx`, `vtoRequestStore.ts`, `vtoFailures.ts` | #455 | none | — |
| `components/ProductShelf.tsx` | #457 | none | pass `surface="commerce"` and, if wanted, `firstUseEducation` + `useVtoAwarenessBlocker` for its two modals |
| `components/kplus/KPlusMembershipStep.tsx`, `kplusActivationCatalog.ts` | #496 (merged) | benefit copy; one bookkeeping effect | commercial surface proven unchanged |

`#455` and `#457` target `fix/notifications-final-convergence-v1`, which has
diverged from this integration branch (210 / 267 commits), so neither can merge
here as-is.

```
RESULT_DECISION_LOOP=UNVERIFIED_PENDING_455
```

## Certification still required

```
SOURCE_COMPLETE=YES
DEVICE_CERTIFIED=NO
REAL_PROVIDER_CERTIFIED=NO
OUTPUT_QUALITY_CERTIFIED=NO
LIVE_VTO_CERTIFIED=NO
```

Before public launch: device pass (VoiceOver, TalkBack, large text, compact
width, the real meaningful-view timing in a scrolling list), a real-provider
generation proof, and an owner-approved output-quality threshold across the
supported categories. Until quality is certified the copy stays factual — no
"photorealistic", no fit or sizing language, no before/after imagery — and
promotion can be reduced with the dimmer above.
