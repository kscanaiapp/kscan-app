# K Scan AI Build 35 — K+ subscription metadata for iOS and Android release candidates

Status: **Candidate metadata prepared; NOT APPLIED to the store or submitted** (2026-10-14). This file governs intended copy/reviewer instructions only, not subscriptions, prices, receipt validation, or signed artifact certification. Source: RevenueCat project `proj46588afb`, current offering `default` / `ofrng222f4dae36`, published Paywall V2 `pw33de2ef97ecc44de` revision 15. Existing products must be reused, not recreated.

## iOS — App Store Connect K+ subscription items

Existing subscription group: **K+** (group ID `22443668`). App bundle `com.kscanai.app`.

| Field | K+ Monthly | K+ Annual |
|---|---|---|
| Product identifier | `kscan.kplus.monthly` | `kscan.kplus.annual` |
| RevenueCat product | `prod6fa234d5c6` | `prodf735b4c3d4` |
| Reference name / Display name (en-US) | K+ Monthly | K+ Annual |
| Description (en-US, 45-char maximum) | K+ fashion tools, billed monthly. | K+ fashion tools, billed annually. |
| Subscription duration | 1 month | 1 year |
| Group localization | K+ | K+ |
| Privacy | https://kscan.app/legal/privacy | https://kscan.app/legal/privacy |

**Review notes (both items):**

> K Scan AI K+ monthly and annual auto-renewing subscriptions. For review, sign in using the test account supplied separately in App Review Information, open onboarding Step 6 or a K+ feature, and view the RevenueCat hosted membership paywall. Use StoreKit sandbox to purchase and test Restore Purchases in Account. K+ access is granted only after server-side verification; customers may continue using Free features. Do not treat gated Elise Speech as live until the separate provider release gate is complete. Support https://kscan.app/support and privacy https://kscan.app/legal/privacy.

**Pending ASC items:** actual subscription review screenshot captured from a signed iOS candidate (do not use a blank placeholder as submission evidence); reviewer test credentials must be supplied privately in App Store Connect; confirm localized renewal/intro offer disclosures and current store pricing. RevenueCat live ProductStoreState returned `MISSING_METADATA`, `review_information=null`, a one-month `trial_offer` on both items, and current **US base prices of $0.99/month and $9.99/year**, whereas the owner's documented intended **renewal** is $9.99/month and $74.99/year following $0.99 first month / $9.99 first year offers. **Do not change any Apple price, trial, or introductory offer until this contradiction is reconciled with owner approval.** A staged RevenueCat App Store metadata-only plan exists at `3b48eea4-9037-4eb9-947c-02d12c06c4bb`, but **was not applied**; it warns that it would insert blank reviewer screenshots. Rework with authentic candidate screenshots before applying.

## Android — Google Play subscriptions

Existing application/package: `com.kscanai.app`.

| Field | K+ Monthly | K+ Annual |
|---|---|---|
| Subscription identifier | `kscan.kplus.monthly` | `kscan.kplus.annual` |
| Base plan ID | `monthly` | `annual` |
| RevenueCat product | `prod211cb2cda6` | `prod20dbedb923` |
| Display name (en-US) | K+ Monthly | K+ Annual |
| Billing period | P1M | P1Y |
| Existing US base price (not modified) | $9.99/month | $74.99/year |
| Existing US introductory phase (not modified) | $0.99 first month | $9.99 first year |
| Existing introductory offer ID | `kplus-launch-intro` | `kplus-launch-intro` |
| Hold state | Base plan DRAFT; offer DRAFT | Base plan DRAFT; offer DRAFT |

**Play Console subscription descriptions (en-US):**

- **Monthly:** Optional monthly K+ membership for eligible premium fashion tools in K Scan AI. Auto-renews monthly unless canceled through Google Play. Store displays applicable pricing and introductory eligibility.
- **Annual:** Optional annual K+ membership for eligible premium fashion tools in K Scan AI. Auto-renews yearly unless canceled through Google Play. Store displays applicable pricing and introductory eligibility.

**Reviewer access instructions (Play App access / release candidate):** Sign in with a dedicated reviewer account supplied via Play Console (never checked into GitHub); open onboarding Step 6 or a premium feature to view K+ membership, test monthly/annual through a licensed Google Play tester and confirm canonical server-side `k_plus` after successful purchase; test Restore Purchases from account, free continuation, cancellation and already-active complimentary K+; never grant premium from a client callback alone. Link to https://kscan.app/legal/privacy and https://kscan.app/support.

**Pending Play Console items:** confirm catalog names/localizations; activate base plans/offers **only after** approved store-readiness gates; extend eligible region coverage beyond US under separate pricing/territory review; verify AAB uploads and sandbox billing on an installed signed binary. Play returned store_status `ok` but both plans/offers remained **DRAFT** and only US pricing was configured. Metadata copy does not activate products.

## Customer-facing paywall and review disclosures

Hosted Paywall V2 is published and attached to `default` offering. Prices and eligibility presented in-app MUST come from the actual platform store and current eligibility, never the strings in this metadata file. Terms must explain automatic renewal, billing period, renewal charge, cancellation management and available Free tier. Restore must re-check canonical Supabase entitlement. Do not advertise Elise Speech as live until backend governance, security and signed-device audio verification pass. Today's owner authorization is a **future** ElevenLabs fleet cap of 25,000 generated characters per UTC day, not a live toggle.

## Submission gates and evidence

- [ ] Both ASC subscription metadata records have genuine reviewer screenshots and complete App Review information.
- [ ] Verify and reconcile Apple's live current prices/trial with intended **intro/renewal** offers; no unapproved price changes.
- [ ] Play monthly/annual plan and intro offer statuses ACTIVE for intended territories, subject to owner store activation approval.
- [ ] RevenueCat current offering/published paywall has expected packages and matching store product identifiers.
- [ ] Exact signed release-candidate IPA and AAB contain compatible native RevenueCat Purchase/PurchasesUI SDK.
- [ ] Store sandbox/tester purchase, restore, cancellation, expiration, active/complimentary/free actor switching and canonical K+ backend synchronization pass independently on iOS and Android.
- [ ] App review/test credentials supplied only through store dashboards; no production customer payments or submitted binaries as part of metadata preparation.

**Release verdict: METADATA_PREPARED / STORE_APPLICATION_PENDING / CUSTOMER_BILLING_NOT_CERTIFIED.**
