# Build 35 K+ Phase D -- Welcome Step-6 membership paywall

Phase D replaces the complimentary-only Step-6 presentation with a stateful K+
membership orchestrator. It is acquisition UI over the existing authorities and
adds no backend, migration, webhook, store configuration or build.

```
ENTRY / ACCESS   get_my_kplus_entitlement_summary() -> useKPlusEntitlement()
ACQUISITION      Apple / Google -> RevenueCat (Phase B kplusCommerceService)
                 -> verified lifecycle (Phase C webhook) -> the canonical summary
```

Design authority: `design/kplus-paywall-storyboard` (Kimi design system and
state storyboard), with the contract corrections below.

## Files

| File | Role |
| --- | --- |
| `services/kplus/kplusPaywallModel.ts` | PURE model: entry state, screen derivation, every billing string, UI reducer, presentation config |
| `components/kplus/KPlusMembershipStep.tsx` | Step-6 orchestrator: effects, purchase / restore wiring, renders the model |
| `components/kplus/KPlusPaywallParts.tsx` | Stateless presentational pieces |
| `constants/kplusPaywallTheme.ts` | Palette: Warm Ivory, Pearl, Champagne, Brushed Gold, Deep Plum, Ink, Graphite |
| `hooks/useKPlusCommerce.ts` | `useSyncExternalStore` over the Phase B commerce snapshot |
| `app/onboarding/index.tsx` | Step 6 renders `KPlusMembershipStep`, keyed by actor id |
| `types/kplusCommerceContract.ts`, `services/kplus/kplusCommerceService.ts`, `services/kplus/revenueCatNative.ts` | Additive: store-reported Monthly intro eligibility |

`components/kplus/KPlusActivationStep.tsx` is no longer mounted at Step 6. It is
kept unchanged (the complimentary acquisition presentation and its tests);
complimentary activation remains reachable through `KPlusEarlyAccessSheet`.

## Entry evaluation (canonical only)

| Canonical state | Entry | Step 6 shows |
| --- | --- | --- |
| `loading` | CHECKING | "Checking your K+ access…" -- never the paywall |
| `error` (or anything unknown) | ENTITLEMENT_UNAVAILABLE | "We can't confirm your membership right now" -- Try again / Continue and check again later. No purchase offered |
| `active`, source `complimentary` | EXISTING_COMPLIMENTARY_KPLUS | Acknowledgement, "Continue with K+" |
| `active`, any other source | ACTIVE_KPLUS | "You're K+." / "Your K+ membership is active." -- Continue |
| `expired` | COMPLIMENTARY_EXPIRED | Acknowledgement banner + standard paid options |
| `eligible` | ACQUISITION_ELIGIBLE | Paid options |
| `unavailable` (signed out) | -- | Existing session-loss handoff (`onSkip`) |

Store products are only requested once the canonical answer is positively Free.
Paid options are **not** offered to an active complimentary member: the Phase B
service confirms a purchase from "canonical says K+", which an active
complimentary grant already satisfies, so a purchase could not be shown
resolving truthfully. The grant is never touched.

## Store-derived terms only

- Price: the store's localized string, verbatim. No fallback, no currency, no
  discount percentage anywhere in the code.
- Period: parsed from the store's ISO 8601 `subscriptionPeriod`. A Monthly
  product whose period cannot be parsed is not offered.
- Trial: shown only when the store reports a **free** intro offer **and**
  `checkTrialOrIntroductoryPriceEligibility` says `ELIGIBLE`. RevenueCat answers
  `UNKNOWN` on Android and whenever it cannot decide; its own guidance is to show
  the non-intro price then. With an intro offer present but eligibility unknown,
  the disclosure claims neither a trial nor a charge "today".
- Charge date: the disclosure supports an authoritative, already-localized date
  but nothing supplies one, so the copy is
  "Free for {trial}, then {price} every {period} unless cancelled." No date is
  ever computed.
- Missing / malformed Monthly or Lifetime: that plan is omitted (never a
  placeholder card); both missing -> PRODUCTS_UNAVAILABLE.

## Copy corrections applied

- "Pay once · yours for good" -> "One-time purchase · no recurring charge"
- "Unlock K+ for Life · {price}" -> "Get K+ Lifetime · {price}"
- Active: "Your K+ membership is active." (no "every premium experience")
- Complimentary: "Your complimentary K+ membership is active." (no "it stays yours")
- Cancelled: "Purchase cancelled." -- "No charge was made." is appended only
  when the handled outcome proves it. The Phase B outcome carries a bounded error
  code, not a proof, so it is never appended today.
- Purchase error: no "no charge was made" claim.
- Eyebrow "K SCAN AI" (product-name rule), not "K Scan K+".

## Gated seams

`KPLUS_PAYWALL_PRESENTATION` (in the model):

- `trialReminderDeliveryOperational: false` -- "We'll remind you before your
  trial ends." is omitted. Flip only when reminder delivery is proven (Phase E).
- `promoRedemptionAvailable: false` -- "Redeem an offer" renders only when this
  is true **and** a real destination is passed as `onRedeemOffer`. No text-code
  backend exists or is invented.

## Purchase / restore flow

- PURCHASING locks plan switching, disables the CTA, Restore and Free, and shows
  "Working with the store…". A synchronous lock stops a double tap before React
  re-renders; the Phase B service's `BUSY` guard is a second line.
- Store success -> "Finishing your K+ setup…" (never Free, never failure, no
  second purchase). The Phase B service re-reads the canonical summary on its
  bounded schedule (2/5/10/20 s). After that window plus 5 s the screen offers
  "Check again" (canonical re-read) and "Continue"; it still never shows Free.
- Only canonical `active` shows "You're K+.".
- Restore: RESTORING sheet -> found -> resolving (same rule) / nothing ->
  NOTHING_TO_RESTORE (Back to membership options, Free). Different-account
  lifetime transfer stays refused (Phase C); the slow-restore copy says a
  purchase made on another K Scan AI account stays with that account.

## Accessibility

Plan cards are `radio` in a `radiogroup` with `selected`/`checked` state,
announced labels including price and terms, a filled check plus heavier border
(not colour alone), `minHeight` instead of fixed heights so they grow with
Dynamic Type. CTA 52 pt, Free path 48 pt, text actions and legal links 44 pt.
Loading, purchasing, resolving and outcome states are announced. The billing
disclosure sits directly above the CTA and is part of the CTA's accessible
label.

## Validation

`__tests__/kplusPaywallPhaseD.test.js` executes the pure model and renders the
real component tree (shared `componentRenderer`) for matrix A..AF, with the
section-24 negative controls as source mutants that must turn checks red.
`__tests__/kplusRevenueCatNativeCommerce.test.js` gains PD-1..PD-4 (eligibility
read, actor scoping, adapter mapping) and an eligibility mutant.

## Manual verification still required

- Sandbox (StoreKit / Play) purchase of Monthly with and without trial
  eligibility, Lifetime, cancel, deferred (Ask to Buy), restore found / nothing.
- iOS trial eligibility answer on device; Android shows no trial copy until an
  owner decides whether Google's store-filtered offers count as eligibility.
- VoiceOver / TalkBack order, announcements and largest Dynamic Type sizes.
- Visual parity with the storyboard on small and large phones.
