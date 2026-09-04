# Live VTO Phase 1-2 — Source Authority

This document is the required Section 6 deliverable of the K Scan AI Live VTO
Phase 1-2 build plan: the authoritative baseline the isolated research line
(`kscan-live-vto/`, branch `claude/kscan-live-vto-phase1-phase2-lcqyg9`) was
started from. It records facts, not intentions. Where the plan's assumptions
and the actual codebase disagree, the conflict is recorded below rather than
silently reconciled — **source authority wins** unless a human with
governance authority says otherwise.

```
REPOSITORY:            kscanaiapp/kscan-app
AUTHORITATIVE BRANCH:  master
HEAD:                  688dc35e5bc19bed603eea9835d3f8f12afba3be
DATE:                  2026-09-04
WORKING TREE:          clean at HEAD when this document was written
ISOLATED BRANCH:       claude/kscan-live-vto-phase1-phase2-lcqyg9 (created off the above HEAD)
```

## App shape

Expo Router app (`expo ~54.0.35`, `react-native 0.81.5`, `react 19.1.0`),
`app.json` `sdkVersion 54.0.0`. `android/` is a real, already-prebuilt
(Continuous Native Generation) Gradle project — `android/app/build.gradle`,
manifests, keystore, Gradle wrapper all present. **There is no `ios/`
directory** — only Android has been ejected to a native project; iOS is
still managed-Expo. No custom native modules or `expo-modules`
scaffolding exist anywhere in the repository today. This is the first one.

`server.js` (Express, deployed per `render.yaml`/`Procfile` to Render as
service `kscan-api`) is largely a legacy/transactional-email backend now
(Resend-backed waitlist/account-deletion emails, `/api/health`). It
explicitly tombstones two legacy routes with a `410` (`/api/analyze` →
`LEGACY_ANALYZE_DISABLED`, `/catalog-images/*` → `LEGACY_CATALOG_DISABLED`).
It is **not** where VTO or image analysis happens today.

## VTO client files

- `services/tryOnClothesPro.ts` — client wrapper (`requestTryOn()`),
  `TryOnRequest { person_image, top_garment?, bottom_garment?, resolution?, restore_face? }`,
  `TryOnResult { source: 'tryon_clothes_pro', status, imageUrl, taskId, raw }`.
  25s invoke timeout.

## VTO server contracts

- `supabase/functions/tryon-clothes-pro/index.ts` — Supabase Edge Function.
  Proxies a server-side `RAPIDAPI_KEY` secret to RapidAPI's
  `try-on-clothes-pro` service (`POST /portrait/editing/try-on-clothes-pro`,
  form-encoded, `task_type=try_on`, 20s upstream timeout). Validates
  `person_image` required, at least one of `top_garment`/`bottom_garment`
  required. This is the "existing governed VTO contract" the plan refers to
  as the Live→AI Photo bridge target (Section 14, P2-I).

## Camera references

- **No camera code is reachable from the VTO service above.** The only live
  camera usage in the app is unrelated to VTO: root `app.js` (re-exported by
  `app/scan/index.tsx`) implements the K Scan **closet-intake / "identify
  this garment"** flow using `expo-camera`'s `CameraView` +
  `useCameraPermissions`. Capture is driven by `hooks/useKScan.js`
  (`cameraRef.current.takePictureAsync(...)` → `compressForUpload` → a
  client-side privacy sanitizer → `analyzeImage()` in `services/api.js`,
  which posts to `${EXPO_PUBLIC_API_URL}/api/analyze`).
- The live analyze backend for that flow is the Expo Router API route
  `app/api/analyze+api.js` (calls Gemini directly). A third,
  **unwired** implementation also exists — `supabase/functions/scan-identify/`
  — referenced only by its own tests/probes, not by any client code.
- **Conclusion for this program**: there is no existing camera abstraction
  to extend for Live VTO, and none should be reused — the closet-intake
  camera is a single-shot "identify a garment" tool with a different
  interaction model, permission copy ("K Scan uses your camera to
  photograph your outfit for style analysis"), and lifecycle than a
  continuous Live Preview capture surface. Phase 1's native camera shell
  (P1-B1) is new work, built inside `kscan-live-vto/native/`.
- `app.json` already declares `expo-camera` (permission string above) and
  `expo-image-picker` plugins with permission copy at the app level;
  Android manifest already carries `CAMERA`, `INTERNET`, `VIBRATE`
  (`RECORD_AUDIO` explicitly blocked). Any future integration-candidate
  work (Section 23) inherits these existing permission declarations rather
  than introducing new ones.

## Garment / product metadata

- `types/scan.ts`: `Product { id, name, retailer, price, imageUrl, imageCategory?, productUrl?, purchaseUrl?, affiliateUrl? }`;
  `AnalysisResult { result, metadata: { category, color, silhouette, itemType?, brand?, size? }, products: Product[], secondhand?, sneakerReference? }`.
- AI-side canonical enums (from `app/api/analyze+api.js`): `category` ∈
  `{Tops, Bottoms, Outerwear, Footwear, Accessories, Dresses}`; `silhouette`
  ∈ `{Oversized, Fitted, Relaxed, Boxy, Cropped, Wide-leg, Slim, Flowy,
  Straight, Layered}` — plus free-text `style`, `material`, `itemType`,
  `color`. `GarmentDescriptor` (Section P1-D1, this program) maps onto this
  existing vocabulary where possible rather than inventing a parallel
  taxonomy; fields with no existing K Scan equivalent (sleeveLength,
  garmentLength, neckline, closure, templateFamily) are new.
- `services/productSearchDeals.ts` and `components/ProductShelf.tsx` carry
  their own near-duplicate `Product`/`ProductSearchItem` shapes — noted for
  completeness, not consumed by this program.
- `data/catalog.json` (60 demo items) has several `imageUrl` values pointing
  at `https://kscan-app-1.onrender.com/catalog-images/...`, a host now
  tombstoned (410) by `server.js`. Not usable as a live fixture source.

## Privacy references

`contexts/PrivacyPreferencesContext.tsx` models `PrivacyMode` (`booting |
local | remote-authenticated`), `SyncStatus`, and persisted CCPA/CPRA
(`opt_out_of_sale`, `limit_sensitive_processing`, consent version
`ccpa_cpra_mobile_v1`) and GDPR consent fields, plus a minor-protection rule
(under-16 accounts are force-opted-out of sale/sharing and cannot toggle
back on). Supporting: `services/privacyPolicy.js`,
`services/privacyLocalStore.js`, `services/supabasePrivacy.js`,
`services/privacyImageSanitizer.js`, `app/privacy.tsx`,
`docs/privacy-data-management.md`.

**No existing privacy copy anywhere in the repo addresses camera, photo,
body-image, or biometric-style data specifically.** `KSCAN_Legal_PreLaunch_Checklist.md`
mentions photo IP/DMCA ownership only. `scan-identify`'s own header comment
asserts "no biometric/demographic traits" are returned by that (unwired)
function, but this claim is not reflected in any user-facing privacy
document. Section 14/16 candidate disclaimer language for Live VTO
(`docs/vto-risk-register.md`, Section 13-16 of the plan) is genuinely new
territory, not an extension of existing copy — final wording still requires
legal/product approval per the plan.

## Feature-flag conventions

Two independent mechanisms exist:
1. A global remote kill switch (Supabase `app_config` table, key
   `mobile_feature_freeze`) gating a fixed `CORE_FEATURE_KEYS` /
   `NON_CORE_FEATURE_KEYS` list (`constants/featureFlags.ts`,
   `services/featureFreeze.ts`, `hooks/useFeatureFreeze.ts`,
   `components/FeatureFreezeFallback.tsx`). Per-feature remote control is
   noted in-repo as "deferred" — today it is one global on/off freeze.
2. Per-Edge-Function boolean env vars, e.g. `SCAN_IDENTIFY_AI_ENABLED`,
   `STYLECHAT_AI_ENABLED` (`Deno.env`, checked inside the function).

**Neither convention currently has a Live VTO / VTO entry.** Any future
integration-candidate flag (Section 23) needs a new key in
`NON_CORE_FEATURE_KEYS` at minimum — that edit is out of scope for this
isolated program (`constants/featureFlags.ts` is a protected path).

## Known doc/source conflicts

1. **The plan's core premise — "K Scan AI already has a generative Virtual
   Try-On capability... [with] interaction model... choose/capture image →
   submit → wait → generated result" — is only true at the backend-plumbing
   level.** `services/tryOnClothesPro.ts` and
   `supabase/functions/tryon-clothes-pro/` exist and are functionally
   complete, but **zero client screens, components, or navigation routes
   call `requestTryOn()`**, there is no VTO capture/picker UI, no
   result-display screen, no before/after or comparison UI, no feature flag
   entry, and no documentation anywhere in `docs/` or the legal checklist
   mentions try-on/VTO. The asynchronous flow this program is meant to
   "make smarter" is not something users can reach today. This program
   proceeds treating `tryon-clothes-pro` as the governed cloud contract for
   the eventual AI Photo bridge (P2-I) — its request/response shape is real
   and stable — but "improve the existing VTO UX" should be understood as
   "build the first VTO UX, informed by this backend contract," not as
   modifying a shipping flow. This also means there is no existing
   production VTO screen this program could accidentally regress by simply
   editing app code; the isolation guardrail in `kscan-live-vto/` protects
   the *paths*, which remains correct regardless.
2. **Three parallel "analyze" backends exist** for the unrelated
   closet-intake flow: `server.js` (`/api/analyze`, tombstoned 410),
   `app/api/analyze+api.js` (live, Gemini-direct), and
   `supabase/functions/scan-identify/` (fully built, unwired, only
   referenced by its own tests). Not a VTO concern directly, but recorded
   because it shows this repository tolerates built-and-unwired backend
   paths as a pattern — reinforcing that "a service function exists" is not
   evidence of "a user can reach this."
3. **`data/catalog.json` demo image URLs are dead** (point at a tombstoned
   host). Not used by this program.

## Existing disclaimers

No VTO/camera/body-data disclaimer copy exists in-app today (see Privacy
references above). Candidate language proposed in Section 14-16 of the plan
is net-new and is tracked in `docs/vto-risk-register.md`, pending legal/
product approval before any production use.

## Current native configuration

`app.json`: `expo-camera` plugin with `cameraPermission: "K Scan uses your
camera to photograph your outfit for style analysis."`; `expo-image-picker`
plugin with `photosPermission` copy about Style Library / Dressing Rooms;
`expo-router`, `expo-apple-authentication`, `expo-font` plugins. iOS
`deploymentTarget: 16.0`, `usesAppleSignIn: true`. Android:
`CAMERA`/`INTERNET`/`VIBRATE` permissions declared, `RECORD_AUDIO`
explicitly blocked.

## Relevant backend/provider interfaces

- RapidAPI `try-on-clothes-pro` (via `tryon-clothes-pro` Edge Function) —
  the governed cloud VTO provider for the Section 27/P2-I bridge.
- No pose, segmentation, or garment-asset provider exists in the repo today
  — Phase 1's pose/segmentation/asset-pipeline work (P1-B2, P1-D3) has no
  prior art in this codebase to extend or conflict with.

## Isolation note

This document itself, and this program's other docs, are the only files
this research line is authorized to add under the otherwise-protected
`docs/` tree — see `kscan-live-vto/tools/protected-paths.json`
(`ALLOWED_EXCEPTIONS`) and the accompanying CI guardrail
`.github/workflows/live-vto-protected-paths.yml`. All engineering work
lives under `kscan-live-vto/`, which is not referenced by the root
`package.json` and is not a production dependency.
