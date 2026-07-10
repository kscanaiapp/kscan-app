# Identification Accuracy Sprint (v1)

Branch intent: `fix/identification-accuracy-v1` (work performed on
`fix/real-image-scan-readiness-v1`; see git handoff below).
No AAB / EAS / version / iOS / Production / Privacy / visual-match changes.

## What changed

Backend Edge Function (`supabase/functions/`):

1. **`_shared/scanHelpers.ts` — `normalizeCategory`**: rewritten to be
   plural-tolerant and synonym-aware. The prior regex used trailing `\b` with
   singular stems, so "sneakers", "boots", "loafers", "heels", "sandals",
   "pumps" never matched footwear, and "puffer", "raincoat", "overcoat",
   "bomber", "windbreaker" never matched outerwear — each produced a canonical
   category with no catalog rows. `blazer` is kept as its own category (the
   catalog has it). Bottoms-before-footwear ordering preserved so "bootcut
   jeans" → pants, not footwear.
2. **`_shared/scanHelpers.ts` — `deriveConfidenceLabel` (new, exported)**:
   single source of truth for confidence labels. High ≥ 0.80, Medium 0.60–0.79,
   Low < 0.60, with downgrades to Medium when a `scan_quality_note` is present or
   the item type is `unknown`/non-fashion.
3. **`_shared/scanHelpers.ts` — `safeParseAiJson` + `stripTrailingCommas` (new)**:
   the JSON repair path now also tolerates trailing commas, both on the cleaned
   text and on the extracted `{...}` slice.
4. **`scan-identify/index.ts` — `buildDisplayResult`**: now uses
   `deriveConfidenceLabel`, so `displayResult.confidenceLabel` is calibrated.
5. **`scan-identify/index.ts` — `buildIdentificationFromAttributes` (new)**:
   when the model returns only legacy `attributes` (no `identification`), a
   minimal identification is derived so catalog retrieval still gets a
   canonicalCategory (previously this path returned no products).
6. **`scan-identify/index.ts` — prompts**: added explicit dominant-item rules
   (a garment wins over a co-present bag/shoe/accessory; choose exactly one
   dominant item; prefer `item_type: "unknown"` + low confidence over a confident
   wrong category) and aligned the scan_quality_note guidance to the 0.60/0.80
   thresholds.

Tests / harness:

7. **`__tests__/fixtures/scanAccuracyCases.js` (new)** + **`__tests__/scanAccuracy.test.js` (new)**:
   golden matrix for category normalization (incl. plurals + dominant-item),
   confidence calibration, and JSON parse/repair.
8. **`scripts/accuracy-matrix.js` (new)**: offline before/after matrix (HEAD vs
   working tree) — no JWT, no network, no image.
9. **`scripts/smoke-scan-identify.js`**: extended with `--text "<query>"` and
   `--batch` (10 baseline queries), richer safe per-query reporting, and an
   explicit `AUTHENTICATED_SMOKE_NOT_RUN_NO_JWT` line when no JWT is set.

## Misclassification guard

Already structurally present: `catalogRetrieval.fetchCatalogCandidates` queries
`WHERE canonical_category = <normalized>` and returns `[]` when there are no
matches (no silent fallback to unrelated categories). `recommendedProducts` is
otherwise `[]`. So an outerwear/footwear scan can never surface bag/accessory
products as primary results — the real fix needed was getting the canonical
category right (done in #1). No second guard was added (avoids double-filtering).

## Response contract

Unchanged top-level shape. `attributes`, `identification`, `displayResult`,
`recommendedProducts` all preserved; `displayResult.confidenceLabel` calibrated;
non-fashion still returns `recommendedProducts: []`.

## Baseline / after results

See `identification-accuracy-baseline-v1.md` and
`identification-accuracy-comparison-v1.md`. Summary: 13/27 representative item
types misclassified before → 0 after, 13 improvements, 0 regressions; confidence
labels recalibrated; non-fashion/unknown still return no products.

## Tests run

- `node --test` across scan suites (scanAccuracy, scanHelpers, catalogRetrieval,
  scanIdentification, scanIdentifyEdgeContract, scanIdentifyMockValidation,
  textScanBackend, textScanCanonicalPath, savedScansCloud): **263 pass / 0 fail**
  (was 111 across the four core scan suites at baseline; +new golden assertions).
- `npx tsc --noEmit`: **PASS** (exit 0).
- TypeScript transpile syntax check of the three Deno files: **0 syntax errors**.
- `deno check`: **NOT_AVAILABLE** (deno not installed in this environment). Run
  locally: `deno check supabase/functions/scan-identify/index.ts`.
- Authenticated staging smoke: **AUTHENTICATED_SMOKE_NOT_RUN_NO_JWT**.

## Known limitations

- Text-proxy measurement only. Real visual accuracy (dominant-item selection on
  cluttered/blurry photos) depends on the vision model and must be confirmed by a
  human running image scans on-device.
- Accuracy is bounded by the configured Gemini model (default gemini-1.5-flash).
- `pants`/`top` normalize correctly but have no catalog rows, so those scans
  intentionally return an empty shelf.

## How the owner should manually test with real scans

1. Set `EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED=true` and run the Metro/dev build.
2. Scan: a jacket/coat, a sneaker/boot, a dress, a handbag, a hat/scarf, and a
   non-fashion object (e.g. a lamp).
3. Confirm: correct category, sensible confidence label, products only for
   categories the catalog stocks (outerwear, blazer, dress, footwear, bag,
   accessory), empty shelf + guidance otherwise, and no products for non-fashion.
4. Optional live API check: `STAGING_USER_JWT=… node scripts/smoke-scan-identify.js --batch`.

## App Staging deploy

Edge Function source changed. Deploy was **NOT** performed in this session (deno
check unavailable here; deploy gated on Edge Function checks passing locally).
Deploy when ready with:
`supabase functions deploy scan-identify --project-ref wyyuqfdxucjksghsmhry`
(App Staging only — do not deploy to Production).
