# Labeling Guide - Scanner Accuracy V2

**Guide version:** `1.0.0`

**Phase 1 status:** locked for blinded review after G-1 through G-8 repair

## Principles

1. Prefer a broad correct identification over a confident wrong brand, material, subtype, or exact product.
2. Never guess ground truth to complete a field.
3. Use uncertainty tokens when evidence is missing.
4. Record authorization and privacy disposition on every case.

## Required case fields

See `evals/scanner-accuracy/dataset-manifest.schema.json` and the enforced
validator in `tools/scanner-evaluation/lib/datasetValidate.js`.

## Uncertainty tokens

| Token | Meaning |
|-------|---------|
| `unknown` | Sufficient visual evidence exists, but the reviewer cannot map it confidently to an allowed value. |
| `not_visible` | Evidence required to determine the value is absent, obscured, blurred, cropped out, or unreadable. |
| `not_applicable` | The field does not apply. This is the canonical unavailable value for every item-specific field on a non-fashion control. |

Reviewers must not choose their own meanings for these tokens. A field that is
visible but genuinely indeterminate is resolved as `unknown`; that is a completed
label, not an unresolved guide gap.

## Expected result types

| Type | Use when |
|------|----------|
| `likely_exact_match` | Strong evidence for a specific sellable product identity. Under MC-1 this remains future evidence and is not a Phase 1 metric. |
| `closest_matches` | Exact product unknown; visually nearest products are the honest outcome. |
| `identified_style` | Category/style identity is supportable without exact product claim. |
| `insufficient_evidence` | The Scanner should abstain from fashion identity or exact claims. |

## G-1 - Multi-item subject designation

Apply the first matching rule:

1. If case metadata explicitly identifies the subject, label that subject.
2. Otherwise, if one item is unambiguously dominant through framing, focus, and
   composition, label that item.
3. Otherwise set `expectedResultType: insufficient_evidence`, set
   `expectedAbstention: true`, and use `unknown` for item-specific fields.

Record the decision as `manifest_specified`, `unambiguously_dominant`, or
`ambiguous_no_dominant` in review-linked metadata. The production and evaluation
ontologies contain no `multi_item_ambiguous` result state, so no such enum is
introduced.

## G-2 - Non-fashion encoding

A non-fashion case must use the certified abstention state and an explicit flag:

```json
{
  "nonFashion": true,
  "expectedResultType": "insufficient_evidence",
  "expectedAbstention": true
}
```

`category`, `clothingType`, `subtype`, `primaryColor`, `secondaryColors`,
`material`, `pattern`, `brand`, and `exactProduct` are all `not_applicable`.
Do not put an arbitrary object class such as `ceramic_mug` into a fashion field.

## G-3 - Color under artificial or ambiguous lighting

Label the most specific visible shade the pixels support. If that shade is not
defensible, use the broader allowed color family. If neither is defensible, use
`unknown` and explain the uncertainty in the existing evidence or notes field.
Label the visible evidence, not an assumed real-world substrate color. Do not add
a secondary apparent-color field.

## G-4 - Brand evidence

A positive brand label requires a product-level signal: a legible wordmark or
label, product-attached logo, product code, or authoritative object record tied
directly to the item. Store signage, branded backgrounds, nearby displays,
silhouette, design language, stitching, trade dress, and resemblance do not
establish a positive brand by themselves.

Review metadata classifies brand evidence into the measurement cohorts
`product_level_evidence`, `contextual_cue_only`, and `no_reliable_evidence`.
These are evaluation cohorts, not production enums. Contextual cues may be noted
but never authorize a positive brand label.

## G-5 - `not_visible` versus `unknown`

Use `not_visible` only when the evidence needed to decide the field is missing or
unreadable. Use `unknown` when the relevant evidence is visible but cannot be
mapped confidently to an allowed value. Use `not_applicable` only when the field
does not apply.

## G-6 - Exact product

Under measurement ceiling MC-1, exact-product metrics are structurally
`not_measured`. Case-level future exact-product evidence may remain in review
notes, but it does not produce exact-product accuracy, `exactProductPrecision`,
or `incorrectExactMatchRate`, and is not a Phase 1 scoring gate.

## G-7 - `visiblePerson`

`visiblePerson` is true when any actual human body part is visible, including a
face, hand, arm, torso, leg, or reflection of a person. Mannequins, statues,
illustrations, and printed photographs are not live visible persons.

## G-8 - Same-item identity

Images show the same physical item only when metadata explicitly designates the
set or evidence supports shared object identity through identical wear, matching
damage, handmade variation, unique markings, inscription detail, hardware
placement, or manufacturing irregularities. Same brand, model, color, or SKU is
not enough. If uncertain, keep the items separate unless the case is explicitly
designated as a same-item set.

## Source priority

1. Existing approved K Scan QA fixtures
2. Tester images explicitly approved for internal evaluation
3. Build 2 Closet corrections explicitly authorized for internal QA
4. Properly licensed apparel test imagery
5. Internally generated apparel fixtures

## Category coverage targets (eventual 150-300 cases)

Tops, bottoms, dresses, outerwear, footwear, bags, eyewear, jewelry,
accessories, full outfits, screenshots, store displays, mirror photos,
low-light, partial occlusion, multiple-item scenes, generic products,
distinctive branded products, multi-angle sets, and insufficient-evidence cases.

Do not fabricate cases to hit the range.

## Review workflow

`draft` -> `pending_review` -> `approved` | `rejected` | `needs_masking`

Approved evaluation scoring requires `authorizationStatus` in
`{approved_qa_fixture, approved_internal_eval, synthetic_no_image}`.

Reviewer sessions use opaque case and image identifiers, deterministic
non-semantic ordering, no curator labels, no Scanner outputs, and role-only
identity metadata. Reviews are described as independent isolated AI review
passes, never as human review.

## Terminology

Retired personalization branding terms must not be restored. Use "Signature
Style" only if personalization terminology is genuinely required. Build 4 does
not expand personalization scope.
