# Live VTO Phase 1-2 — Source Authority

Section 6 deliverable of the K Scan AI Live VTO Phase 1-2 build plan: the
authoritative baseline the isolated research line (`kscan-live-vto/`, branch
`claude/kscan-live-vto-phase1-phase2-lcqyg9`) was started from.

> **AUDIT CORRECTION — 2026-09-04.** The first revision of this document
> audited `master` only and concluded that K Scan's VTO was "backend-plumbing
> only… no client screen, picker, or result view currently calls it." That
> conclusion was **wrong as a statement about K Scan's current VTO
> capability**. It was true *of `master`*, but `master` is not the VTO
> authority. A complete, governed VTO — client surface, hooks, services,
> provider-neutral contract, Edge Function with entitlement/quota/idempotency
> controls, and database migrations — exists on
> `integration/backend-kplus-complimentary-staging-v1`. The original text is
> not silently rewritten; it is superseded by the two-authority record below,
> and the specific errors are itemized in **Corrections to the first audit**.

---

## Two authorities

This program has two distinct source authorities and must not conflate them.

### A. Master baseline — what the isolated experiment was forked from

```
REPOSITORY:            kscanaiapp/kscan-app
BRANCH:                master
HEAD:                  688dc35e5bc19bed603eea9835d3f8f12afba3be
DATE INSPECTED:        2026-09-04
```

This is the commit `kscan-live-vto/` was branched from, and it remains the
correct baseline for the isolated engineering line (app shape, Expo/RN
versions, native config, privacy preferences, feature-flag conventions,
protected-path enforcement). **It is not the authority on current VTO
capability.**

### B. Current VTO release/integration authority

```
BRANCH:                integration/backend-kplus-complimentary-staging-v1
HEAD:                  4af92f4c6fe9ecb4c5b1221c26e8dc465971d61d
HEAD DATE:             2026-09-03 23:34:44 -0400 (merge of PR #289)
DATE INSPECTED:        2026-09-04
RELEVANT MERGED PRs:   #255 (TryItOnEntry reachable from shipped scan-result
                       commerce surface), #277 (VirtualTryOnSheet UX polish,
                       photo-library input, progress/minimize/save/disclaimer),
                       #289 (Android photo-picker repair, iOS photo-library
                       purpose-string repair)
```

## Required status fields

```
VTO_CLIENT_STATUS:              IMPLEMENTED AND WIRED (complete client surface,
                                reachable from the shipped scan-result commerce
                                surface)
VTO_CLIENT_AUTHORITY_BRANCH:    integration/backend-kplus-complimentary-staging-v1
VTO_CLIENT_AUTHORITY_SHA:       4af92f4c6fe9ecb4c5b1221c26e8dc465971d61d
VTO_CLIENT_FEATURE_FLAG_STATE:  Build gate EXPO_PUBLIC_VTO_UI_ENABLED defaults
                                OFF; set "true" ONLY in the eas.json
                                `staging-certification` profile. The
                                `production` profile does not set it, so a
                                production build carries no VTO UI. Two further
                                independent gates apply at runtime: the remote
                                `app_config` row `vto_generation` (server
                                authoritative, fails closed / disabled when
                                unreadable) and a K+ entitlement check.
VTO_BACKEND_AUTHORITY:          supabase/functions/vto-generate/ on the branch
                                above. The older tryon-clothes-pro proxy is
                                RETIRED (see below) — it is not the bridge target.
VTO_USER_REACHABILITY:          Not reachable by production customers today
                                (build flag off in the production profile).
                                Reachable in a staging-certification build only
                                when the remote kill switch is enabled AND the
                                account holds K+ entitlement AND the item's
                                category is in the supported set. Live values of
                                the remote row and actual deployment state were
                                NOT queried — see "What was not verified".
AUDIT_CORRECTION:               YES — first audit inspected master only and
                                therefore reported no VTO client surface. See
                                the correction notice above and the itemized
                                list below.
```

## Reachability, classified separately (do not conflate)

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | CODE EXISTS | **YES** | `components/vto/`, `hooks/useVirtualTryOn.ts`, `services/vto/*` (10 modules), `types/vto.ts`, `supabase/functions/vto-generate/*`, 4 VTO migrations |
| 2 | ROUTE / SURFACE EXISTS | **YES** | `TryItOnEntry` renders into the scan-result commerce surface via `components/scan-results/PurchaseOptionsPanel.tsx` + `components/scan-results/types.ts`; legacy `components/ProductShelf.tsx` also delegates |
| 3 | FEATURE FLAG ENABLED/DISABLED | **Build: OFF by default, ON only in `staging-certification`.** Runtime: remote kill switch + entitlement, both fail closed | `constants/featureFlags.ts` `resolveVtoUiEnabled` (`value === 'true'`, undefined ⇒ false); `eas.json` sets `EXPO_PUBLIC_VTO_UI_ENABLED` only in `staging-certification` |
| 4 | STAGING DEPLOYED | **NOT VERIFIED** — not determinable from source | Deployment state lives in the Supabase project, not the repo. Deliberately not queried; see below |
| 5 | PRODUCTION ENABLED | **NO** | `eas.json` `production` profile contains no `EXPO_PUBLIC_VTO_UI_ENABLED`; the resolver defaults to `false`, so a production build carries no VTO UI at all |

**A complete client implementation and customer-disabled are both true at
once.** That is the whole point of separating rows 1–2 from rows 3–5.

## VTO client surface (authority B)

- `components/vto/TryItOnEntry.tsx` — the single narrow Commerce seam. Renders
  nothing unless the item is eligible, *or* unless K+ entitlement is the only
  missing thing (then it opens the shared `KPlusGate`, not a VTO-specific
  paywall). Owns sheet open/minimize state; one card, one sheet, one operation.
- `components/vto/VirtualTryOnSheet.tsx` (712 lines) — the operation surface:
  photo-library input, progress stages, minimize, result presentation, save,
  disclaimers.
- `components/vto/VtoMinimizedPill.tsx`, `VtoSaveToDressingRoom.tsx`,
  `VtoSilhouetteGuide.tsx`.
- **Hooks / state:** `hooks/useVirtualTryOn.ts` (operation lifecycle),
  `hooks/useVtoAvailability.ts` (eligibility + flag resolution),
  `hooks/useVtoSessionStatus.ts` (read-only observation of a running
  generation), `services/vto/vtoRequestStore.ts` (module-scoped store).
- **Person input:** `services/vto/vtoPersonInput.ts` — system photo picker
  only, no pre-picker permission gate (deliberate; see #289), re-encoded via
  `prepareImageForPrivacyUpload` (genuine EXIF strip by re-encode),
  max dimension 1024, JPEG q0.8, payload ceiling 2,000,000 base64 chars,
  cache derivative deleted by `releaseVtoPersonInput`.
- **Garment derivation:** `services/vto/vtoCommerceGarment.ts` —
  `buildVtoGarmentFromCommerceRecord` is the ONE place a commerce record
  becomes `VtoGarmentInput`.
- **Eligibility:** `services/vto/vtoEligibility.ts` — canonical category
  tokens, `resolveVtoGarmentSlot`, `evaluateVtoEligibility`. Default supported
  set is deliberately conservative: `['top','outerwear','blazer','dress']`
  (bottoms recognized but not enabled pending benchmark evidence).
- **Feature control:** `services/vto/vtoFeatureControl.ts` — reads
  `app_config.vto_generation`, deliberately **not** cached to storage (a kill
  switch that survives on a stale "enabled" is not a kill switch);
  unreadable ⇒ disabled; 60s in-memory memo of enabled answers only.
- **Transport:** `services/vto/vtoClient.ts` — invokes the `vto-generate`
  Edge Function, 55s client ceiling (deliberately longer than the server's 45s
  so a server-classified `provider_timeout` wins the race), reads only
  `error.code`.
- **Result / save bridge:** `services/vto/vtoResultExport.ts` — materializes
  the session-scoped `data:` URI to a cache file **only** on an explicit
  "Save to Dressing Room" tap; `discardVtoResultExport` removes it if
  abandoned. The person photo is never exported.
- **Telemetry:** `services/vto/vtoTelemetry.ts`.

### Current disclaimer copy (authority B, verbatim)

- `AI VISUALIZATION — NOT A PHOTO, AND NOT A FIT PREDICTION`
- `AI-generated visualization for inspiration only. Check the size guide for
  your exact fit.` (the "size guide" is a link to the retailer's own sizing
  page when Commerce has one)

This is materially stronger than the "no VTO disclaimer copy exists anywhere"
statement in the first audit, which was again true of `master` only.

## VTO backend contract (authority B)

`supabase/functions/vto-generate/` — handler, contract, eligibility,
entitlement, feature control, guards, reservation, result validation,
telemetry, and provider adapters (`aiLabToolsProvider`, `mockProvider`).

- **Client → backend request:** `{ requestId, origin, garment: VtoGarmentInput,
  personDataUri (base64, ≤ 2,000,000 chars), requestGeneration?, devScenario? }`.
- **Backend → client response:** `{ provider, dataUri, mediaType, width,
  height, latencyMs }`; failures return only an enum `error.code` from
  `VTO_FAILURE_CODES` (16 codes) — provider text never reaches the UI.
- **Image encoding:** person = base64 JPEG data URI (client-sanitized);
  garment = remote **https** URL (`isSupportedGarmentImageUrl` rejects
  `data:`/`file:`/`content:`); output media restricted to
  `image/jpeg | image/png | image/webp`, result bytes bounded
  `VTO_RESULT_MIN_BYTES` 1 KiB … `VTO_RESULT_MAX_BYTES` 8 MiB.
- **Product/garment fields:** `VtoGarmentInput { productRef, imageUrl,
  category, brand, commerceSource }`. `productRef` is a correlation handle,
  never an authorization input — the server re-derives eligibility and takes
  identity from the verified JWT.
- **Provider-specific translation:** `VtoProviderInput { personDataUri,
  garmentImageUrl, slot, canonicalCategory }` — an adapter never learns who
  the user is.
- **Polling/state:** client-side lifecycle is a status machine
  (`VTO_STATUSES`, 10 states, 3 terminal) driven by a single invoke with
  progress staging (`vtoProgressStages.ts`), not backend polling.
- **Reservation / idempotency / spend:** `vtoReservation.ts`
  (`buildVtoIdempotencyKey`, `vtoDailyLimit`, `vtoLeaseMinutes`) plus
  migrations `vto_generation_reservations`,
  `vto_paid_quota_attempt_counting`, `vto_non_billable_attempt_release`.
  Adapters report `billable`; **absent defaults to billable** on purpose, and a
  provably-unsent submit returns the user's daily attempt.

### The legacy proxy is retired — correcting a specific first-audit error

`supabase/functions/tryon-clothes-pro/` still exists on authority B, but as a
**retired handler that refuses** (`retiredHandler.ts`), guarded by
`__tests__/legacyVtoRetirement.test.js`. Its own test file states it was
deleted from staging because it was "an anon-key bypass of auth, K+, the kill
switch and quota, all of which vto-generate now enforces."

The first audit described `tryon-clothes-pro` as "the governed cloud contract
for the eventual AI Photo bridge (P2-I)". That is wrong twice over: it is not
governed, and it is not the bridge target. **The Live → AI Photo bridge target
is `vto-generate`.**

## Corrections to the first audit, itemized

| First-audit claim | Correct position |
|---|---|
| "zero client screens, components, or navigation routes call `requestTryOn()`… no VTO capture/picker UI, no result-display screen" | True of `master`. On authority B a complete client surface exists and is wired to the shipped scan-result commerce surface. |
| "no feature flag entry" | A dedicated build gate (`EXPO_PUBLIC_VTO_UI_ENABLED`), a dedicated remote kill switch (`app_config.vto_generation`), and a K+ entitlement gate all exist. |
| "no documentation anywhere in `docs/` … mentions try-on/VTO" | `docs/vto-foundation.md` (336 lines) and `docs/vto-provider-benchmark.md` exist on authority B. |
| "No existing privacy copy anywhere in the repo addresses camera, photo, body-image… data specifically" | Authority B carries explicit VTO disclaimer copy (above) and an explicit privacy posture in `vtoPersonInput.ts`, including the honest statement that it does **not** mask faces and "is not zero-knowledge and must never be described as such". |
| "`tryon-clothes-pro` … the governed cloud contract for the eventual AI Photo bridge" | Retired anon-bypass path. The bridge target is `vto-generate`. |
| "there is no existing production VTO screen this program could accidentally regress" | A full VTO client exists on the integration line. The protected-path guardrail (which protects `components/`, `services/`, `supabase/`, `hooks/`, `types/` by path) remains correct and sufficient, but the *reasoning* was wrong: the isolation matters more, not less. |

Everything the first audit recorded about **`master`** (app shape, camera code
in root `app.js`/`hooks/useKScan.js`, three parallel analyze backends, dead
`data/catalog.json` image URLs, privacy-preferences model, feature-freeze
convention, native config) was verified against `master` and stands.

## What was NOT verified (and deliberately so)

- **Deployment state** of `vto-generate` on staging or production, and the
  **live value** of the `app_config.vto_generation` row. These are runtime
  facts in the Supabase project, not source facts. This isolated research lane
  does not query, and must not mutate, staging or production state — so both
  are reported as unverified rather than guessed. An authorized operator can
  read the row directly; the answer belongs in this table, not in an inference
  from source.
- Whether a `staging-certification` build is currently distributed to anyone.

## Impact on the isolated Live VTO program (and on PR #291)

**No rebase is performed, and none is currently required.** Assessment:

1. **No interface incompatibility exists today.** `kscan-live-vto/` imports
   nothing from the app and is imported by nothing in it. The isolated
   contracts (`BodyFrame`, `GarmentDescriptor`, `.ksgarment`) are new types in
   a separate npm workspace; authority B's `types/vto.ts` is untouched by this
   program.
2. **Two reference-contract updates are now warranted** (documentation, not
   code):
   - The Live → AI Photo bridge target changes from `tryon-clothes-pro` to
     **`vto-generate`**, with the request/response shape recorded above. See
     `docs/vto-integration-candidate.md`.
   - `GarmentDescriptor` should be mapped against authority B's real
     `VtoGarmentInput` + canonical category tokens
     (`top|outerwear|blazer|dress|pants|…`) rather than only the
     `app/api/analyze+api.js` enum from `master`. Both vocabularies are now
     recorded; the mapping is documented in
     `docs/vto-integration-candidate.md`.
3. **A future person-input seam is now identifiable and narrow.**
   `VtoPersonInputSource` is currently the single-member union
   `'photo_library'`. Guided capture / Live capture would eventually add one
   member and one producer of `VtoPersonInput`, leaving the rest of the
   contract untouched. This is architecture observation only — no such change
   is proposed or made here.

A rebase of PR #291 onto authority B would pull an entire unrelated release
branch into an isolated research PR for no interface benefit, so it is **not
recommended** unless a human decides the research line should track the
integration branch instead of `master`.

---

# Appendix — Master baseline detail (authority A, unchanged)

Retained from the first audit; verified against `master` @ `688dc35e`.

## App shape

Expo Router app (`expo ~54.0.35`, `react-native 0.81.5`, `react 19.1.0`),
`app.json` `sdkVersion 54.0.0`. `android/` is a real, already-prebuilt (CNG)
Gradle project. **There is no `ios/` directory.** No custom native modules or
`expo-modules` scaffolding existed anywhere in the repository before this
program. `server.js` (Express, deployed per `render.yaml`/`Procfile` to Render
as `kscan-api`) is largely a legacy/transactional-email backend and tombstones
`/api/analyze` and `/catalog-images/*` with `410`.

## Camera references (master)

The only live camera usage is unrelated to VTO: root `app.js` (re-exported by
`app/scan/index.tsx`) implements the closet-intake / "identify this garment"
flow using `expo-camera`'s `CameraView` + `useCameraPermissions`, with capture
in `hooks/useKScan.js` (`takePictureAsync` → `compressForUpload` → privacy
sanitizer → `analyzeImage()`). The live analyze backend is the Expo Router API
route `app/api/analyze+api.js`; a third, unwired implementation exists at
`supabase/functions/scan-identify/`.

**Conclusion for this program (unchanged):** there is no existing camera
abstraction to extend for Live VTO, and none should be reused — the
closet-intake camera is a single-shot "identify a garment" tool with a
different interaction model, permission copy, and lifecycle than a continuous
Live Preview capture surface. Phase 1's native camera shell (P1-B1) is new
work inside `kscan-live-vto/native/`.

`app.json` already declares `expo-camera` (`cameraPermission`: "K Scan uses
your camera to photograph your outfit for style analysis.") and
`expo-image-picker`; Android manifest carries `CAMERA`, `INTERNET`, `VIBRATE`
(`RECORD_AUDIO` blocked); iOS `deploymentTarget: 16.0`.

## Garment / product metadata (master)

`types/scan.ts`: `Product { id, name, retailer, price, imageUrl,
imageCategory?, productUrl?, purchaseUrl?, affiliateUrl? }`; `AnalysisResult
{ result, metadata: { category, color, silhouette, itemType?, brand?, size? },
products, secondhand?, sneakerReference? }`. AI-side enums from
`app/api/analyze+api.js`: `category` ∈ `{Tops, Bottoms, Outerwear, Footwear,
Accessories, Dresses}`; `silhouette` ∈ `{Oversized, Fitted, Relaxed, Boxy,
Cropped, Wide-leg, Slim, Flowy, Straight, Layered}`.

**Now superseded for VTO purposes** by authority B's canonical token set
(`top`, `outerwear`, `blazer`, `dress`, `pants`, `skirt`, `footwear`, `bag`,
`accessory`) and `VtoGarmentSlot` (`top | bottom | full_body`).

`data/catalog.json` demo `imageUrl` values point at a tombstoned host — not a
usable fixture source.

## Privacy references (master)

`contexts/PrivacyPreferencesContext.tsx` models `PrivacyMode` (`booting |
local | remote-authenticated`), `SyncStatus`, CCPA/CPRA fields
(`opt_out_of_sale`, `limit_sensitive_processing`, consent version
`ccpa_cpra_mobile_v1`), GDPR consent fields, and a minor-protection rule.
Supporting: `services/privacyPolicy.js`, `privacyLocalStore.js`,
`supabasePrivacy.js`, `privacyImageSanitizer.js`, `app/privacy.tsx`,
`docs/privacy-data-management.md`.

> Note: authority B's `vtoPersonInput.ts` explicitly declines to use
> `services/privacyImageSanitizer.js`, calling it "a passthrough that returns
> its input unchanged, so it would give the appearance of sanitation without
> performing any." Any future guided-capture work must use the real
> re-encoding path (`prepareImageForPrivacyUpload`), not the passthrough.

## Feature-flag conventions (master)

1. Global remote kill switch (`app_config.mobile_feature_freeze`) over
   `CORE_FEATURE_KEYS` / `NON_CORE_FEATURE_KEYS` (`constants/featureFlags.ts`,
   `services/featureFreeze.ts`, `hooks/useFeatureFreeze.ts`).
2. Per-Edge-Function env kill switches (`SCAN_IDENTIFY_AI_ENABLED`,
   `STYLECHAT_AI_ENABLED`).
3. Build-time `EXPO_PUBLIC_*` flags per EAS profile — which is the family
   `EXPO_PUBLIC_VTO_UI_ENABLED` belongs to on authority B.

## Isolation note

This document and this program's other docs are the only files this research
line is authorized to add under the otherwise-protected `docs/` tree — see
`kscan-live-vto/tools/protected-paths.json` (`ALLOWED_EXCEPTIONS`) and
`.github/workflows/live-vto-protected-paths.yml`. All engineering work lives
under `kscan-live-vto/`, which is not referenced by the root `package.json`
and is not a production dependency.
