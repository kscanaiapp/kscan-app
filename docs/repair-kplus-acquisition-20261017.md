# KPLUS-001 repair candidate — 2026-10-17

Campaign verdict: PARTIAL. Source repair implemented; native/device transaction acceptance, independent review and governed integration remain required. This report does not certify a customer binary.

## Source authority and initial state

- Repository: kscanaiapp/kscan-app.
- Fetched origin before editing; mobile integration: integration/build35-v1-convergence at 4080a494a1d78ffaa546cd5055eb51d122afcc9a.
- Backend authority: rebuild/backend-authority-v2 at 54e9c27d9e39df99b167126382fe8ed9f5f01edb. No backend changes.
- Initial workspace C:/Users/jsmit/KScan is bare, so git status reports “must be run in a work tree.” Its HEAD names ios/full-submission-readiness-v2; it was not used as source.
- New isolated worktree C:/kplus1017; branch codex/kplus-acquisition-repair-20261017; initial status clean. App-managed worktree creation could not resolve a worktree root for the bare repository, so git worktree add was used.
- Reviewed merged PRs #568/#569 (routing), #579 (hosted acquisition), #599 (Packing/Watchlist entry), #619 (actor-bound VTO dismissal), #621/#624/#626 (current mobile), #622 (backend), #628/#629 (metadata). Open #582/#625/#627 are metadata/verification lanes, not overlapping source repairs. No open acquisition/calendar repair was found.

## Reproduction and root cause

Two executable component tests failed on the starting source:

1. A parent supplies a new onContinue callback before the 350 ms timer fires. Cleanup clears the timer, but hostedAttemptedRef stays true. Native presentation calls: 0 instead of 1.
2. The hosted promise never settles. After 90 seconds, the opening spinner is still rendered.

These establish source failure mechanisms. They do not establish which mechanism occurred on the reported customer devices. Native modal transition conflicts are another credible contributor, not a confirmed device root cause.

Onboarding mounts the step directly. Existing-user routes mount it inside KPlusMembershipSheet; parent entitlement renders can change callbacks, and native presentation must wait for the Modal to finish showing.

## Repair and contracts

Changed production files:

- components/kplus/KPlusMembershipStep.tsx: primitive readiness, actor-owned cancellation, current callback reference, explicit idle/preparing/presenting/purchased/restored/dismissed/failed states, retries, foreground readiness and bounded recovery.
- components/kplus/KPlusMembershipSheet.tsx: onShow readiness handoff, reset on close/hidden state.
- services/kplus/kplusHostedPaywall.ts: shared commerce lease, identity revalidation after offering retrieval, cancellation checks immediately before native presentation, provider-result reconciliation.
- services/kplus/kplusCommerceService.ts: hosted/purchase/restore share one native flight; resetting an actor invalidates results but retains unresolved native work; SDK logout/rebinding waits for that flight. Hosted success, including late success, enters canonical reconciliation; another purchase is blocked while reconciliation is unresolved.
- config/build35-premium-value-baseline.json: only the changed commerce service digest is updated. All other protected digests and release holds are retained.

Tests: new kplusAcquisitionLifecycle.test.js and kplusHostedPaywallBehavior.test.js; additional native-commerce lease/late-success tests; existing hosted and paywall harnesses updated. Shared component test harness adds an AppState stub only.

No product IDs, offering identifiers, prices, trial/renewal rules, Supabase policies, entitlement queries, environment names, SDK versions or server logic changed. The existing native SDK adapter remains protected and unchanged.

### Bounded recovery and checkout safety

- Membership/product preparation exposes recovery after 20 seconds.
- Hosted presentation transitions to a recovery screen after 60 seconds. A timeout does not cancel an SDK promise.
- Any still-active native operation retains the global commerce flight; fallback checkout and hosted retries cannot overlap it. The customer can leave the screen. After real completion, a failed/dismissed attempt can be retried.
- An unresolved custom store operation also exposes recovery after 60 seconds.
- Native module absence, rejected presentation, missing offering or published-paywall failure exposes the existing store-sourced fallback. Only authentic available monthly/annual products and store disclosures render. No products: Retry, Restore and Free continuation.
- Purchased/restored is a provider fact. Both normal and late completion trigger the existing canonical Supabase reconciliation and bounded recheck schedule. Only canonical active access unlocks K+.
- Stale actor/mount completions cannot close a replacement screen or start a delayed native window. The next actor cannot rebind the SDK under the previous actor's outstanding store UI.
- A genuinely never-settling native operation intentionally retains its flight until the native runtime ends/settles. Recovery does not pretend it was cancelled. Native-device recovery must be certified.

### Source investigation coverage

SDK linkage checks, platform keys/configuration, authenticated Supabase UUID binding and current-offering retrieval are retained. Preparation is permitted only for positively Free/expired canonical states; active members receive membership status, and unresolved states are not sold a subscription. Auth refresh/catalog/callback churn no longer cancels an accepted attempt. Background preparation defers; foreground canonical refresh remains in useKPlusEntitlement. Android Activity and iOS native presentation behavior require device evidence.

Read-only RevenueCat inspection on 2026-10-17: project proj46588afb; App Store and Play Store applications both identify com.kscanai.app, with their store credentials configured. Current default offering ofrng222f4dae36 has monthly and annual packages mapped to both stores. Its paywall pw33de2ef97ecc44de has published_at 2026-10-14T19:54:36.275Z (revision 15). Catalog configuration is not device product-availability or payment proof. No dashboard write was made.

## Acquisition entry matrix

All rows remain source-routed to the same membership step. Store purchase, cancel, restore, return navigation and account-switch acceptance remain required on both signed platforms for every applicable route.

| Entry | Current source route | Evidence limit |
| --- | --- | --- |
| Onboarding | app/onboarding/index.tsx -> KPlusMembershipStep, actor key | Component/model regressions; no new-user device transaction |
| Account/settings | app/privacy.tsx -> KPlusMembershipSheet | Source routing; signed device acceptance pending |
| Voice Scan | HomeVoiceScanPill, TextScanFeatureRow, VoiceScanButton -> KPlusGate | Existing route/gating regressions |
| Smart Watchlist | Home, ProductShelf, PurchaseOptionsPanel -> KPlusGate | Existing source/render regressions |
| Packing | app/packing/index.tsx -> KPlusGate | Trip-preservation and entitlement regressions |
| Photo VTO | TryItOnEntry and shared VTO launch host -> KPlusGate | Existing VTO routing/isolation regressions |
| Live Camera VTO | Shared Try-On Studio/launch flow -> same K+ gate | No separate purchase controller introduced; native acceptance pending |
| Closet Intelligence | CloudClosetCard -> KPlusGate | Proof/availability and canonical gating retained |
| Wardrobe Concierge | Existing K+ source classification resolves to membership; server entitlement enforcement retained | No independent current Concierge purchase controller found; verify enabled UI routes on device |
| Other source-defined actions | Elise VTO offer, product shelves, watch actions -> shared gate | Existing regression suite; no claim that every native store journey passed |

## Validation and remaining release gates

Evidence is recorded per command under local .repair-evidence/. A fresh npm ci --ignore-scripts was used, preserving the committed lockfile and source assets. The early dependency junction was moved outside the worktree before final typecheck/native validation.

- Two failure regressions were red before the repair and green afterward.
- Focused K+ suite: initial repaired run 597 passed / 32 existing skips; final counts are recorded in the campaign handoff.
- Added iOS/Android-surface tests cover readiness, callback/catalog churn, rapid retry, background preparation, rejected/unresolved native presentation, actor switch/unmount, native result mapping, no SDK/offering, shared flight, delayed SDK rebinding and late provider success.
- The full Node suite covers Scanner, Closet, Dressing Rooms, Elise, VTO, Watchlist, onboarding, navigation and entitlement regressions. Final exact-source results are recorded in the campaign handoff.
- TypeScript --noEmit, 17 native parity checks, production/build35-release profile guards, dependency reachability and Apple source readiness are required before source sign-off.
- Dependency audit retains the existing approved findings; no new package was introduced. The security validation runner's expected localhost ZAP rejection is a negative control, not a new security defect.
- Android local compile and iOS CI compile results are recorded separately. Initial Android attempt failed because Gradle had enumerated a temporary dependency junction while it was relocated; final retry uses the clean source tree.
- No physical-device tests, paid transaction, paid AI generation, EAS build, store upload, backend modification, complimentary grant or public rollout occurred.

Remaining classifications: KPLUS-001 P1 is source-repaired, device acceptance pending; PACK-002 P2 is delivered in its separate calendar PR. Release gates (P1) are exact-head CI, independent review, approved integration and signed iOS/Android sandbox acceptance. No new P0 defect was established; this is not a whole-product defect census.

For both platforms verify new onboarding, existing Free, expired, active, returning sessions, repeated close/reopen, interruption/background/foreground, network failure, missing native module/offering, native promise timeout, purchase success/cancel/failure, pending transaction, restore, canonical refresh, account switch during pending work and return to each originating feature. Use controlled sandbox/license-test actors; real charges and paid AI requests remain unauthorized.

Release readiness: NOT READY for production release approval. Android must receive a newly eligible versionCode after checking Play authority; iOS version/signing must be selected independently. Future production iOS builds must use the production EAS profile, and Android must use its approved governed production profile. Neither is launched by this campaign. Integration stays at the fetched SHA until approved PRs are merged; re-fetch/re-read the actual integration SHA afterward.
