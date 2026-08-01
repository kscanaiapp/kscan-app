# Labeling Guide - Scanner Accuracy V2

**Guide version:** `1.1.0`

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

## Controlled labeling vocabulary

The values below are the evaluation ontology implemented in
`tools/scanner-evaluation/ontology/fashion-taxonomy.v1.json`. Reviewers must use
the exact singular, lowercase, snake-case token shown. Do not pluralize a category
or write a natural-language subtype. If the visible item cannot be mapped to one
of these values, apply G-5 and use `unknown` or `not_visible`.

- `outerwear` -> `jacket` (`chore_jacket`, `bomber_jacket`, `denim_jacket`, `moto_jacket`, `puffer_jacket`, `down_jacket`, `windbreaker`, `rain_jacket`, `anorak`); `coat` (`trench_coat`, `overcoat`, `peacoat`, `raincoat`, `wool_coat`, `parka`); `parka`; `puffer`
- `blazer` -> `blazer` (`suit_jacket`, `tailored_jacket`, `sport_coat`)
- `dress` -> `dress` (`sundress`, `shift_dress`, `wrap_dress`, `maxi_dress`, `midi_dress`, `mini_dress`); `gown` (`evening_gown`, `ball_gown`)
- `pants` -> `jeans` (`straight_jeans`, `skinny_jeans`, `bootcut_jeans`, `wide_leg_jeans`, `boyfriend_jeans`); `trousers` (`chinos`, `slacks`, `dress_trousers`, `culottes`); `shorts` (`denim_shorts`, `tailored_shorts`); `leggings`; `joggers` (`sweatpants`)
- `skirt` -> `skirt` (`mini_skirt`, `midi_skirt`, `maxi_skirt`, `pleated_skirt`, `a_line_skirt`, `pencil_skirt`)
- `top` -> `shirt` (`button_down_shirt`, `oxford_shirt`, `flannel_shirt`); `blouse`; `t_shirt` (`graphic_tee`, `crew_neck_tee`, `v_neck_tee`); `tank_top` (`camisole`); `sweater` (`crew_neck_sweater`, `v_neck_sweater`, `turtleneck`, `cardigan`); `hoodie` (`pullover_hoodie`, `zip_hoodie`); `polo`; `sweatshirt` (`crewneck_sweatshirt`)
- `vest` -> `vest` (`puffer_vest`, `sweater_vest`, `tailored_vest`)
- `jumpsuit` -> `jumpsuit` (`utility_jumpsuit`, `wide_leg_jumpsuit`)
- `romper` -> `romper`
- `bodysuit` -> `bodysuit`
- `footwear` -> `sneaker` (`low_top_sneaker`, `high_top_sneaker`, `running_sneaker`, `court_sneaker`, `slip_on_sneaker`); `boot` (`ankle_boot`, `chelsea_boot`, `combat_boot`, `knee_high_boot`, `hiking_boot`, `western_boot`); `loafer` (`penny_loafer`, `horsebit_loafer`, `tassel_loafer`); `sandal` (`slide_sandal`, `strappy_sandal`, `thong_sandal`); `heel` (`pump`, `stiletto`, `block_heel`, `kitten_heel`); `flat` (`ballet_flat`, `pointed_flat`); `oxford` (`derby`, `brogue`); `mule`
- `bag` -> `handbag` (`shoulder_bag`, `top_handle_bag`, `hobo_bag`, `bucket_bag`, `satchel`); `tote` (`canvas_tote`, `leather_tote`); `crossbody` (`camera_bag`, `saddle_bag`); `backpack` (`mini_backpack`); `clutch` (`envelope_clutch`); `duffel`
- `accessory` -> `eyewear` (`sunglasses`, `optical_glasses`, `aviator_sunglasses`, `wayfarer_sunglasses`, `round_sunglasses`); `jewelry` (`necklace`, `bracelet`, `ring`, `earrings`, `brooch`); `watch` (`analog_watch`, `digital_watch`, `smart_watch`); `belt` (`leather_belt`, `woven_belt`); `hat` (`cap`, `beanie`, `bucket_hat`, `fedora`, `wide_brim_hat`); `scarf` (`silk_scarf`, `wool_scarf`); `gloves`; `tie` (`necktie`, `bow_tie`); `wallet`

Primary and secondary colors must use one exact implemented token: `black`,
`white`, `gray`, `blue`, `red`, `green`, `brown`, `pink`, `purple`, `yellow`,
`orange`, `gold`, `silver`, `multicolor`, `navy`, `dark blue`, `midnight`,
`cobalt`, `burgundy`, `oxblood`, `wine`, `maroon`, `ivory`, `ecru`, `cream`,
`bone`, `off-white`, `camel`, `taupe`, `tan`, `beige`, `khaki`, `charcoal`,
`slate`, `graphite`, `blush`, `rose`, or `magenta`. `teal` and `olive` are
implemented terminal colors with no broader-family credit. `gray` is canonical;
do not emit `grey`.

Material must use one exact supported token: `leather`, `faux leather`, `denim`,
`wool`, `wool blend`, `cotton`, `satin`, `silk`, `linen`, `knit`, `suede`,
`acetate`, `canvas`, `nylon`, `polyester`, `cashmere`, `tweed`, `corduroy`,
`velvet`, `chiffon`, `jersey`, `ribbed`, `cotton canvas`, `metal`, `gold tone`,
or `silver tone`. A visible surface whose composition cannot be established is
`unknown`, not a guessed material.

The review-only controlled values are:

- `brandEvidenceState`: `product_level_evidence`, `contextual_cue_only`, or `no_reliable_evidence`.
- `expectedBrandAssertionBehavior`: `brand_may_be_named_and_is_scored_for_correctness`, `naming_the_in_frame_brand_as_the_product_brand_is_a_false_positive`, or `any_brand_claim_is_a_false_positive`. These are the already-implemented coverage outcomes, not new production enums.
- `subjectDesignation`: `manifest_specified`, `unambiguously_dominant`, or `ambiguous_no_dominant`.
- `labelConfidence`: `high`, `medium`, `low`, or `unknown`.
- `expectedAbstention`, `nonFashion`, `visiblePerson`, and `privacyAndAuthorizationComplete`: JSON booleans only.
- `sameItemAcrossImages`: JSON `true` or `false` for multi-view cases; `not_applicable` for a single image; `unknown` only when the evidence is visible but legitimately inconclusive.

`privacyAndAuthorizationComplete` is true only when the blinded packet's
governance summary confirms approved authorization, an allowed privacy
disposition, a privacy-review date, a retention-policy reference, EXIF removal,
completed face and plate review, and an approved governed derivative. It is
false if any required control is absent or failed. This governance decision does
not change any visual label.

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

Map the evidence cohort to `expectedBrandAssertionBehavior` mechanically:
`product_level_evidence` uses
`brand_may_be_named_and_is_scored_for_correctness`;
`contextual_cue_only` uses
`naming_the_in_frame_brand_as_the_product_brand_is_a_false_positive`; and
`no_reliable_evidence` uses `any_brand_claim_is_a_false_positive`.

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
