# Tier A — LICENSED-WEB-IMAGE PILOT BENCHMARK, frozen

**Dataset version 0.3.0. Freeze date 2026-07-29.**
**Aggregate SHA-256 `ddc939dca91d202c…`** (`evals/scanner-accuracy/tier-a-freeze.v0.3.0.json`)

**Verdict: PASS — proceed to Phase 1.** Justification and the gaps that survive the
freeze are below. This is a *pilot* pass, not a certification pass.

---

## What was frozen

| | |
|---|---:|
| Cases | **41** |
| Images | **56** |
| Development / holdout | 33 / 8 |
| Images committed to Git | **0** |
| Licences | 100% verified, per image, against the original file page |

Governed storage: `C:\Users\jsmit\KScan-eval-storage-private\tier-a`, outside every
Git worktree. Opaque object names. Every image sanitised — all JPEG APPn and COM
segments stripped (EXIF, XMP, Photoshop IRB) — with original and sanitised SHA-256
both recorded.

Reproduce the freeze and governed-image verification with:

```powershell
$env:KSCAN_EVAL_STORAGE_ROOT = 'C:\Users\jsmit\KScan-eval-storage-private\tier-a'
node tools/scanner-evaluation/verify-frozen-dataset.js `
  --manifest evals/scanner-accuracy/tier-a-manifest.v0.3.0.json `
  --freeze-record evals/scanner-accuracy/tier-a-freeze.v0.3.0.json
```

### Composition

| Category | Cases |
|---|---:|
| top | 15 |
| footwear | 14 |
| dress | 8 |
| accessory | 6 |
| outerwear | 3 |
| pants | 3 |
| bag | 3 |
| non-fashion negative | 3 |
| skirt | 1 |

**12 true same-item multi-image sets** (2–3 genuinely different source photographs
of one physical object). Each set is ONE case carrying every view, never N cases —
emitting them separately would both erase the stratum and silently over-weight
that garment in every aggregate score.

### Licence breakdown (113 accepted images across all rounds)

CC BY-SA 4.0 34 · CC0 23 · CC BY 4.0 14 · CC BY-SA 3.0 12 · Public domain 8 ·
CC BY-SA 2.0 8 · CC BY 2.0 7 · CC BY 3.0 7

All from Wikimedia Commons, including MET, Nordiska museet and Rijksmuseum object
records. Nothing NonCommercial, nothing NoDerivatives, and **an unrecognised
licence string was always a rejection, never a default-accept** — that rule alone
threw out `No restrictions`, `GODL-India`, `Copyrighted free use` and an
unversioned `Attribution`. 5 further images were rejected for `personality`
restrictions. 67 rejections total.

---

## Brand evidence is graded, and only tier 1 is positive

| Tier | Cases | What it measures |
|---|---:|---|
| `product_level_evidence` | 13 | brand correctness |
| `contextual_cue_only` | 3 | **false positives** from environment-level branding |
| `no_reliable_evidence` | 40 | **false positives** invented with no signal |

The lower two tiers are not filler and were not discarded. A model that reads
"adidas" off a store wall and attributes it to the shoe in front of it is making
precisely the error those cases exist to catch.

### Positive brand recognition is EXPLORATORY, and must be reported that way

The 13 positive cases rest on only **8 distinct physical objects** and **5 brands**
(adidas, Nike, Thom Browne, Flonflon, Vignon). Six of the 13 are multiple views of
just *two* Vignon dresses. Per-case counting is what the authorisation asked for,
but quoting "13 brand cases" without that support figure would overstate diversity
by more than half.

**No brand-accuracy rate may be computed from this corpus.** Directional signal
only. The gate deliberately does not include a brand quota, and acquisition was
stopped rather than padded to reach one.

### Rulings applied consistently

Brand marks **not on the product** do not count as product-level evidence:

- ski-boot wall — Salomon/Rossignol text is on the retail **shelf label**
- adidas store wall — Trefoil and wordmark on **wall panels**, no identifiable product
- all-white sneaker — three-stripe motif present, **no legible wordmark**; trade
  dress alone never qualifies, the same ruling given to the jeans red tab

All three were **kept**, reclassified into the false-positive cohort. One case
(`f1c90b7808`) qualifies as positive *despite* being a store scene, because the
foreground pair carries a legible tongue wordmark — product-level evidence decides
it, not the signage.

One Nike file was admitted as a **set member only** and excluded from the positive
count because I did not open it and would not assume its logo was legible.

---

## Gaps that survive the freeze

**These are the reasons this is a pilot, not a baseline.**

1. **Positive brand support is thin** — 8 objects, 5 brands. Exploratory only.
2. **57 accepted images remain uncurated.** 113 were acquired and licence-verified;
   56 are in the freeze. The rest have no visual decision recorded and are
   therefore *not* admitted — never approved-by-default.
3. **`exactProductKnowable` is empty and unfillable.** This is MC-1: the deployed
   contract hardcodes `exactProduct` to null, so exact-product accuracy is
   `not_measured`, not "failing".
4. **No screenshot / retailer-product-page stratum.** Structurally unobtainable
   from Commons — such a screenshot contains the retailer's own copyrighted
   imagery, so it cannot carry a provable free licence. Deferred to Tier B pending
   separate rights authorization.
5. **Three bicycle images deferred, not rejected**, because a vehicle is in frame
   and I would not assert plate illegibility without verifying, nor resume masking.
   One of them (`endorphine 5.3` on the frame) is a wanted probe for brand
   invention on a non-apparel object.
6. **Museum-heavy multi-image sets.** 11 of 12 sets are historic artifacts from
   institutional collections. Set identity for those rests on the **institutional
   object record**, not on individual visual confirmation of every member — that
   limitation is recorded per set in `identityEvidence`.
7. **Fine labels on museum cases are `unknown` on purpose.** Institutional records
   establish the object and its maker, not its colour or material. Guessing those
   would be fabrication.
8. **Single-workstation storage.** No access logging, and it cannot support two
   independent reviewers — so the 8-case holdout is currently single-reviewer.
9. **Single-reviewer holdout blocks paid execution.** Every one of the 41 cases
   preflights as `reviewStatus: draft`, and the runner refuses to execute a draft
   case. This is the two-reviewer governance gate working as designed, not a
   defect, and it was NOT overridden. Paid execution stays blocked until a second
   reviewer approves the labels.
10. **Face masking loosened by owner policy.** A new review state,
   `face_present_unmasked_permitted_by_policy`, was added rather than reusing
   `face_present_masked` (which would assert masking never applied) or
   `no_face_present` (which would assert an absence never established). It applies
   only to already-published licensed imagery, never to captured Tier B data.

## What this corpus is not

Not a real-world smart-glasses capture benchmark. It cannot represent the glasses
point of view, wearer motion blur, partial framing inside the five-second
curiosity window, or authentic retail-floor lighting and distance. Tier B real
capture covers those and remains deferred to Phase 3.

Not a comprehensive brand-accuracy corpus. See the support caveat above.

---

## Why PASS

The freeze gates are breadth gates, and all five are met: 12 same-item sets, 8
garment categories, both false-positive cohorts populated, 11 ambiguous or
insufficient-evidence cases. The corpus can already expose actionable failures —
category and subtype errors, colour and material errors, white-on-white and
black-on-white difficulty, many-items-in-frame confusion, non-fashion
over-identification, and brand invention from contextual cues.

That is enough to run Phase 1 and learn something true. It is not enough to
publish an accuracy rate for brand recognition, and no paid baseline should be
described as a certification on this corpus.

**Still owner-gated: paid model calls, object-storage migration, reviewer staffing,
and the screenshot-stratum rights decision. No paid call has been made — spend to
date is $0.00.**
