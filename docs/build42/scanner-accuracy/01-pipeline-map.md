# Build 42 Sprint 1 — Scanner pipeline map

Audit date: 2026-11-18. Read-only against the governed authorities. Repository is public: this
document carries Staging facts and source locations only; Production deployment state is
reported to the owner privately.

## Authorities audited

| Line | Branch | Commit | Notes |
|---|---|---|---|
| Mobile integration | `integration/build35-v1-convergence` | `6b4ecf60` (merge of #763) | Both approved apps were cut from this line. Its `supabase/functions/scan-identify` copy is **stale** relative to the backend authority (`index.ts`, `shoppingProvider.ts`, `scanCommerceRouter.ts` differ); `matchTier.ts`, `brandEvidence.ts`, `commerceRelevanceAgreement.ts` are identical. The app imports `matchTier.ts` from that copy for labels. |
| Backend deploy authority | `rebuild/backend-authority-v2` | `e58125a2` (merge of #759) | Only checkout permitted to deploy (`config/backend-authority.json`). |

### Deployed `scan-identify` (verified, not assumed)

The deployed bundle was downloaded with `supabase functions download scan-identify --use-api`
and every file was git-blob-hashed against `e58125a2`.

| Environment | Version | Files identical to `e58125a2` | Deploy entrypoint |
|---|---|---|---|
| Staging (`yzqjvdfgefveprobvvyw`) | v108 (2026-11-10 23:17Z) | **52 / 52** | governed CI (`/home/runner/work/...`) |
| Production | tracked privately with the owner | — | — |

Staging effective Scanner configuration (secret names read as booleans via digest comparison; no
values printed): quality tune / intelligence / relevance ON by code default; **v124 commerce
identity OFF** (unset → default false); v125 retrieval OFF; funnel v127 ON; multi-item ON;
image-product mission ON; VRI-03 master + H1/H2/H3/H4/H4b ON; Serper, Brave, Farfetch3,
Poshmark and KicksCrew providers configured.

## End-to-end flow

```
CAPTURE ──► PREPARE ──► DETECT ──► SELECT ──► IDENTIFY ──► DISCOVER ──► SCORE/RANK ──► LABEL ──► RENDER/SAVE
(mobile)   (mobile)    (Gemini)   (user)     (Gemini)     (providers)  (deterministic) (deterministic) (mobile)
```

### 1. Camera / gallery input (mobile)

| Concern | Location |
|---|---|
| Live camera, lease, ownership | `components/scan-room/LiveScanCamera.tsx`, `ScannerCameraLease.tsx`, `services/cameraOwnership.ts`, `services/scannerCameraRequirement.ts` |
| Gallery multi-select (≤5 photos), batch association | `services/multiImageScan.ts`, `hooks/useKScan.js` (`detect_items` at ~L690) |
| Capture review | `components/scan-room/CaptureReview.tsx` |

### 2. Consent and privacy processing

| Concern | Location | Behaviour |
|---|---|---|
| Resize/compress | `services/imageUtils.js` | ≤896 px wide, JPEG q0.65, base64 |
| Clean-frame preparation | `services/privacy/scannerImagePreparation.ts`, `scannerDispatchGuard.ts` | adapter over the shared privacy boundary; refuses caller "already sanitized" assertions; session-bound proof |
| Image sanitizer | `services/privacyImageSanitizer.js` | **passthrough** — no face or plate masking (disclosed in policy) |
| Transport evidence | `services/scannerEvidenceGateway.ts`, `services/scannerVisualEvidence.ts` | one prepared evidence object per image; local OCR/logo observations are **empty** (no on-device recognizer) |
| Server consent gate | `supabase/functions/_shared/geminiConsent.ts` (`requireGeminiConsent`) | paid-AI ingress requires recorded Gemini v2 consent |
| Server account/auth gates | `_shared/deletion/assertAccountActiveIfAuthenticated.ts`; `isEligiblePaidAIActor` in `index.ts` | non-anonymous, active account required for paid work |
| Quota | `scan-identify/scanQuota.ts` | durable per-user/day: image 30, commerce_only 60; fails closed |

### 3. Transport (mobile → backend)

`services/scannerScanRequest.ts` `runScannerIdentification` is the single network entry point →
`services/scannerIdentificationV2.ts` (fashion-identification-v2 contract) →
`services/scanIdentification.ts` (`functions.invoke('scan-identify')`, ≤2 MB guard, response
normalization, identification field allowlist).

### 4. Garment detection (backend, MODE A, Gemini call 1)

`index.ts` `MULTI_ITEM_IDENTIFY_PROMPT` + `MULTI_ITEM_RESPONSE_SCHEMA` (1–5 garments, normalized
bounds, category, subtype, colour, confidence) + optional multi-item brand evidence (#759,
`multiItemBrandEvidence.ts`) + VRI-03 H1 target-selection addendum. Commerce is **deferred**
(`commerce.deferred = true`). Non-fashion → `status: non_fashion`.

### 5. Attribute and brand extraction (backend, MODE A, Gemini call 2)

User selects a candidate → `identify_selected_item` → `buildSelectedItemPrompt` anchored to the
candidate's bounds; schema `SELECTED_ITEM_RESPONSE_SCHEMA` (v123) or `..._V124` when
`BACKEND_COMMERCE_IDENTITY_ENABLED`; VRI-03 H2 adds secondary colours, length, closure,
distinctive features, style tags, search queries. Model route: `_shared/llmModelRouting.ts`
(allowlisted primary + one fallback; 14 s timeout).

Brand evidence (`brandEvidence.ts` `resolveScannerBrandEvidence`): **verified** only from a
model-read wordmark (`visible_brand_text`) or a logo classified `high`; wordmark/logo conflict →
unconfirmed. `brand_evidence.independentlyVerified` is always `false` — the only brand signal is
the vision model's own report.

Quality gate (`scannerQualityGate.ts`): 0–100 identification quality score → band
(high ≥80 / moderate ≥60 / low) → commerce query detail level; suppresses unsupported brand and
material; grades v124 identity evidence when enabled.

### 6. Item disambiguation

Detection bounds + selected-item prompt ("do not switch to a larger garment"), VRI-03 H1 target
rule, Elise dominant-garment resolution (`eliseDominantGarment.ts`), per-item candidate-id echo
(`multiItemCommerceCorrelation`).

### 7. Product discovery (backend, MODE B `commerce_only`)

`services/commerceHydration.ts` (mobile, single authority for `commerce_only`) → `index.ts`
MODE B: auth + durable quota + image-payload rejection → `sanitizeIdentification` →
`applyScannerQualityGate` → `resolveScannerCategoryRoute` → `getFastCommerceResults`
(`scanCommerceRouter.ts`): category-routed queries (`commerceRelevanceQueries.ts`; brand only when
verified; exact hypothesis only with v124), providers per env (Serper primary + Brave fallback;
Farfetch3, Poshmark, KicksCrew optional), early exit on sufficiency, fast deadline 3 000 ms,
result cache, VRI-03 H3 single fallback query.

Serper maps `productLink ?? link` (`shoppingProvider.ts` `mapSerperItems`); in archived Staging
evidence every Serper offer resolved to a Google Shopping `/search` page.

### 8. Scoring and ranking

`qualityTuneCommerce.ts` → `scoreProductAgreement` (`commerceRelevanceAgreement.ts`): category 30,
subtype 25, colour 15, material 10, silhouette 10, pattern/detail 5, verified brand 5; penalties
for conflicts, generic titles, invalid/handoff destinations, missing image, malformed price; v124
identity bonus (brand ±30, model up to 30, features ≤8) only when identity is enabled. Bands:
strong ≥75, usable ≥50, weak <50. `selectByAgreementCoverage` keeps strong/usable and **pads with
weak offers up to 3** when fewer qualify; dedupe; soft diversity; VRI-03 H4 scores the full pool
before the 10-cut.

### 9. Merchant result output and labels

Offers: `{ id, title, source, price, currency, imageUrl, productUrl, type }` + watch capability
(`watchlistCapability.ts`) + `matchMetadata` (`matchTier.ts`: `exact | same_brand | similar`;
only for **direct** destinations — search-handoff offers get none) + canonical commerce
(`canonicalCommerce.ts`). The per-offer agreement score is not returned.

Mobile renders via `components/scan-results/ScanResultV2.tsx` → `PurchaseOptionsPanel.tsx`
(`commerceMatchLabel`: "Exact Match" / "Same Brand Alternatives" / "Similar Styles" — the
default for any offer without metadata), `SimilarFindsShelf.tsx`, `commerceShelfState.ts`
(no-match copy only after a completed empty result); saved to Recent Scans.

### 10. Telemetry

`scan_commerce_events` (no user column): mode, provider outcome, counts before/after
filter/dedupe, retailer count, durations, failure reason, top agreement score/band.
`vri03_gemini_usage` log line (token counts) only for VRI-03-cohort requests.
