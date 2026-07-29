# Labeling Guide — Scanner Accuracy V2

## Principles

1. Prefer a broad correct identification over a confident wrong brand, material, subtype, or exact product.
2. Never guess ground truth to complete a field.
3. Use uncertainty tokens when evidence is missing.
4. Record authorization and privacy disposition on every case.

## Required case fields

See `evals/scanner-accuracy/dataset-manifest.schema.json`.

## Uncertainty tokens

| Token | Meaning |
|-------|---------|
| `unknown` | Could be knowable, but labelers do not know / not reviewed |
| `not_visible` | Not visible in the provided evidence |
| `not_applicable` | Field does not apply (e.g., brand on non-fashion control) |

## Expected result types

| Type | Use when |
|------|----------|
| `likely_exact_match` | Strong evidence for a specific sellable product identity |
| `closest_matches` | Exact product unknown; visually nearest products are the honest outcome |
| `identified_style` | Category/style identity is supportable without exact product claim |
| `insufficient_evidence` | Should abstain from fashion identity / exact claims |

## Category coverage targets (eventual 150–300 cases)

tops, bottoms, dresses, outerwear, footwear, bags, eyewear, jewelry, accessories, full outfits, screenshots, store displays, mirror photos, low-light, partial occlusion, multiple-item scenes, generic products, distinctive branded products, multi-angle sets, insufficient-evidence cases.

Do **not** fabricate cases to hit the range.

## Source priority

1. Existing approved K Scan QA fixtures
2. Tester images explicitly approved for internal evaluation
3. Build 2 Closet corrections explicitly authorized for internal QA
4. Properly licensed apparel test imagery
5. Internally generated apparel fixtures

## Review workflow

`draft` → `pending_review` → `approved` | `rejected` | `needs_masking`

Approved evaluation scoring requires `authorizationStatus` ∈ `{approved_qa_fixture, approved_internal_eval, synthetic_no_image}`.

## Terminology

Retired personalization branding terms must not be restored. Use “Signature Style” only if personalization terminology is genuinely required. Build 4 does not expand personalization scope.
