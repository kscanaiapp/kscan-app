# Build 35 paid K+ -- Phase B: native RevenueCat commerce foundation

Status: implemented on `feature/build35-kplus-revenuecat-native-v1`, cut from
`integration/build35-v1-convergence` at `0cbdee2ca7417a5215da89d960839b2dd0ce430c`
(PR #493, Early Access decoupling, is an ancestor). Not deployed anywhere. No
staging, production, Supabase, EAS, App Store Connect, Play Console or RevenueCat
dashboard change was made.

This phase builds the native purchase / restore machinery that will sit under the
future paid paywall. It builds **no paywall UI, no price, no product id, no trial
length**, and no server-side provider lifecycle (that is Phase C).

## Authority

    APPLE / GOOGLE STORE
            -> REVENUECAT
            -> VERIFIED PROVIDER LIFECYCLE        (Phase C, not built here)
            -> SUPABASE CANONICAL K+ AUTHORITY
            -> MOBILE CANONICAL ENTITLEMENT READER (useKPlusEntitlement)

RevenueCat is not the application authorization database. A purchase result, a
restore result and a CustomerInfo update are **provider facts**. The only thing
any of them does in this app is cause a canonical re-read
(`refreshKPlusEntitlement`). Features keep consuming `useKPlusEntitlement()`.

Until canonical authority says K+, a completed purchase / restore reads
`*_ENTITLEMENT_RESOLVING` -- not free, not active. `ENTITLEMENT_CONFIRMED` is
derived only from the canonical store. Because Phase C (verified server-side
lifecycle ingestion) does not exist yet, a real store purchase will legitimately
stay in RESOLVING until it does.

## Files

| file | role |
|---|---|
| `types/kplusCommerceContract.ts` | pure types + policy: states, normalized product, offering normalizer, public-key policy, native port interface. No RN, no SDK, no env. |
| `services/kplus/revenueCatNative.ts` | the **only** importer of `react-native-purchases`; implements the port; reduces provider objects to bounded facts. |
| `services/kplus/revenueCatConfig.ts` | reads the two public SDK key variables (literal `process.env` accesses so Metro inlines them). |
| `services/kplus/kplusCommerceService.ts` | state machine, identity lifecycle, purchase, restore, canonical-refresh coupling, actor reset. |
| `contexts/AuthSessionContext.tsx` | `resetActorScopedRuntimeState` now also calls `resetKPlusCommerce()` (the only edit to existing code). |
| `__tests__/kplusRevenueCatNativeCommerce.test.js` | matrix A-Z + negative controls. |

## Package

`react-native-purchases` **10.10.2**, pinned exactly (no range).

- Peer dependencies: `react >= 16.6.3`, `react-native >= 0.73.0` -- this repo is
  Expo 54 / React Native 0.81.5 / React 19.1.0. Compatible.
- 10.11.0 was the registry `latest` but was published on 2026-10-01, one day
  before this work. 10.10.2 (2026-09-24) was chosen: same peer range, a week of
  exposure. Moving to 10.11.0 is a one-line owner decision.
- No Expo config plugin is required or added. Autolinking was verified for both
  platforms with `expo-modules-autolinking react-native-config` (Android
  `sourceDir` / `packageInstance`; iOS `podspecPath`).
- It needs a **development / release build**. Expo Go cannot run it; the adapter
  reports `UNSUPPORTED_RUNTIME` rather than letting the SDK fall back to its
  browser/preview mode (whose products are not the store's).

## Configuration boundary

Two public SDK keys, platform-specific, read at build time:

    EXPO_PUBLIC_REVENUECAT_IOS_PUBLIC_SDK_KEY
    EXPO_PUBLIC_REVENUECAT_ANDROID_PUBLIC_SDK_KEY

Not set anywhere in this repository (no `eas.json` change). Absent / malformed
=> `UNAVAILABLE / NOT_CONFIGURED`: no crash, no fabricated products, no fake
pricing. The policy additionally refuses an `sk_` secret key, a key carrying the
other store's prefix, and a `test_` Test Store key outside a development build.
The RevenueCat REST secret key stays server-side and never gets an `EXPO_PUBLIC_`
name.

`EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED` does not touch any of this. It governs
only legacy complimentary acquisition. Nothing in the commerce code imports or
reads it.

## Identity

The RevenueCat customer is the authenticated **Supabase user UUID**, the same id
the Build 34 server mirror already uses (`appUserId: user_id`). Never an email,
phone, device or advertising id.

- The SDK is configured once, **already identified** (`appUserID` = the UUID), so
  no anonymous customer is created at start-up.
- A later actor is switched with `logIn(uuid)`; the SDK is never re-configured.
- Sign-out / any actor change runs `reset()` synchronously: a generation is
  bumped, offerings and status are dropped, the provider listener is detached,
  in-flight completions are discarded, and the SDK is logged out (serialised
  behind any login so the two can never interleave).
- Before any purchase or restore the SDK's *current* customer is read back and
  must equal the actor. An anonymous SDK customer therefore cannot buy.
- No subscriber attributes are sent; identifier collection is disabled
  (`automaticDeviceIdentifierCollectionEnabled: false`); SDK log level is ERROR.

## Offerings

Read from the **current (active)** RevenueCat offering. Monthly and Lifetime are
resolved independently, by package type:

- no package of that kind -> `unavailable / MISSING_FROM_OFFERING`. Never
  substituted for the other kind.
- two candidates, a package claimed by both kinds, or a malformed store product
  -> `configuration_error`. Fail closed.
- every field (`localizedPrice`, `priceAmount`, `currencyCode`,
  `subscriptionPeriod`, intro metadata, store product id) is copied from the
  store. Missing stays `null`. Intro metadata's presence is **not** eligibility.

The optional typed `KPlusProductMappingConfig` (package identifiers) is the
boundary for a future explicit mapping. This repository supplies no values.

## Operations and states

States: `IDLE`, `CONFIGURING`, `READY`, `PURCHASING`, `RESTORING`,
`USER_CANCELLED`, `STORE_ERROR`, `PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING`,
`RESTORE_COMPLETED_ENTITLEMENT_RESOLVING`, `NOTHING_RESTORED`,
`ENTITLEMENT_CONFIRMED`, `UNAVAILABLE` (+ reason).

- `purchaseMonthly()` / `purchaseLifetime()` -- single-flight (`BUSY`).
  Cancellation is its own outcome; a store failure carries only a bounded code
  and never touches canonical state. A deferred payment is reported `pending`.
- `restorePurchases()` -- explicit action, authenticated and actor-bound. The
  adapter reduces CustomerInfo to one boolean (`providerOwnership`) that only
  picks the honest message; canonical authority is re-read either way.
- After a provider success, bounded canonical re-checks (2 / 5 / 10 / 20 s) run
  while the answer is still resolving; they die with the actor.
- CustomerInfo listener: actor-bound, ignores the payload, and can only trigger a
  canonical re-read.

## Privacy

Nothing provider-shaped is persisted or logged: no CustomerInfo, receipt,
transaction or purchase token. Errors are reduced to their RevenueCat code. The
adapter never returns those objects. No email / name / profile / Closet / scan /
location / photo data goes to RevenueCat.

## Left for later phases

- Phase C: verified server-side RevenueCat lifecycle ingestion (webhooks,
  renewal / cancellation / refund / revocation, lifetime transition). The existing
  `revenueCatClient.ts` is promotional-mirror code only and is unchanged.
- Phase D: the Welcome paywall UI. A hook over `kplusCommerceService` is the
  obvious seam; it is deliberately not added here.
- Owner: product ids, prices, trial length, the RevenueCat offering / package
  structure, store capabilities, and the public SDK keys in the EAS environment.
- Android `MainActivity` is `launchMode="singleTask"`. RevenueCat's installation
  guide asks for `standard` or `singleTop` so a purchase is not cancelled when the
  app is backgrounded during store verification. Not changed here (it also
  affects deep-link handling); it needs a device decision and a purchase test.
