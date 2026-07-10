# Identification Accuracy — Before/After Comparison (v1)

Measurement: offline text proxy via `node scripts/accuracy-matrix.js`
(before = committed HEAD `scanHelpers.ts`, after = working tree). Real visual
accuracy must still be confirmed by a human running image scans on-device.

## 10 baseline scan phrases (Phase 3 / Phase 13)

| phrase | model item_type | before category | after category | result |
|---|---|---|---|---|
| black puffer jacket | puffer jacket | outerwear | outerwear | unchanged ✓ |
| cream wool coat | wool coat | outerwear | outerwear | unchanged ✓ |
| navy blazer | blazer | blazer | blazer | unchanged ✓ |
| white sneakers | sneakers | **sneakers (wrong)** | footwear | **IMPROVED** |
| brown leather handbag | handbag | bag | bag | unchanged ✓ |
| floral midi dress | midi dress | dress | dress | unchanged ✓ |
| black tote bag next to jacket | jacket | outerwear | outerwear | unchanged ✓ (garment dominant) |
| lamp on table | NON_FASHION | NON_FASHION | NON_FASHION | unchanged ✓ |
| dark blurry clothing | unknown | unknown (no catalog) | unknown (no catalog) | unchanged ✓ |
| person wearing jacket and carrying bag | jacket | outerwear | outerwear | unchanged ✓ (garment dominant) |

## Expanded normalization set (27 representative item_types)

- Misclassified before: **13**
- Misclassified after: **0**
- Improved: **13**
- Regressed: **0**

Newly-correct (`raw string → real catalog category`):
`puffer`, `raincoat`, `overcoat`, `bomber`, `windbreaker`,
`sneakers`, `white sneakers`, `boots`, `ankle boots`, `loafers`, `heels`, `sandals`, `pumps`.

Each of these previously produced a canonical category with **no catalog rows**, so
the product shelf was empty even when matching products existed (footwear/outerwear).

## Confidence calibration (after)

| score | label | note |
|---|---|---|
| 0.95 | High | |
| 0.80 | High | threshold edge (was Medium before) |
| 0.79 | Medium | |
| 0.65 | Medium | **was Low before** |
| 0.60 | Medium | threshold edge |
| 0.59 | Low | |
| 0.30 | Low | |
| 0.90 + scan_quality_note | Medium | downgraded (was High) |
| 0.92 + item_type=unknown | Medium | downgraded (was High) |

## Net result

**Net improvement: YES.** Fewer category misclassifications (13 → 0 on the test
set), better confidence calibration, no regressions. Non-fashion and
unknown/low-confidence scans still return no products. Wrong-category ProductShelf
results remain prevented by the existing hard category filter in
`catalogRetrieval.fetchCatalogCandidates`.
