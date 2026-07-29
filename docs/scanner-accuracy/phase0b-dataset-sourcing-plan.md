# Phase 0B — Dataset sourcing plan

The first-baseline target is 75 governed cases. **8 real apparel photographs are
accessible; 4 are admissible today, 7 after masked derivatives, and 1 is
rejected.** The shortfall is **67 cases**.

No case was fabricated to close it. This document is the plan to close it
honestly.

---

## 1. Where the shortfall is

| Stratum | Target | Have | Gap |
|---|---:|---:|---:|
| tops | 10 | 1 | 9 |
| bottoms | 9 | 1 | 8 |
| dresses | 7 | 1 | 6 |
| outerwear | 10 | 1 | 9 |
| footwear | 10 | 1 | 9 |
| bags | 8 | 1* | 7 |
| eyewear | 5 | 1* | 4 |
| jewelry | 4 | 0 | 4 |
| accessories | 6 | 0 | 6 |
| non-fashion | 6 | 1 | 5 |

\* the one bag and the one pair of sunglasses are the **same** multi-item frame.

**Cross-cutting gaps that no current source can supply at all:**

| Stratum | Target | Have |
|---|---:|---:|
| multi-image same-item sets | 10 | **0** |
| exact-product knowable | 10 | **0** |
| mirror photographs | 5 | **0** |
| screenshots / product pages | 5 | **0** |
| store-display cases | 3 | **0** |

---

## 2. Sourcing routes, in preference order

### Route 1 — Internally photographed originals *(preferred)*

Photograph garments the owner or team already possesses.

- **Solves:** every category gap; multi-image sets; mirror shots; store displays;
  and — uniquely — **exact-product-knowable cases**, because the photographer
  holds the item and can record its SKU, label and purchase record.
- **Authorization:** clean by construction. The owner owns the items, controls
  the setting, and can produce a written use record.
- **Privacy:** controllable — shoot garments flat or on a mannequin, or crop
  above the shoulders. No face, no plate, no private background, no consent
  question.
- **Effort:** ~60 items × 1–3 angles. A focused session covers most of it.
- **Recommendation:** make this the backbone of the dataset — roughly 45 of the
  67 cases.

### Route 2 — Licensed stock imagery

Purchase a commercial licence covering internal machine-evaluation use.

- **Solves:** category breadth and difficulty strata (low light, blur,
  occlusion) quickly.
- **Authorization:** a real licence document, which is exactly what the current
  8 fixtures lack.
- **Caveat:** stock rarely carries a verifiable SKU, so it does **not** solve the
  exact-product-knowable gap. **Check the licence explicitly permits AI/ML
  evaluation use** — many stock licences now exclude it.
- **Recommendation:** ~15 cases for strata that are awkward to stage.

### Route 3 — Retailer product pages *(screenshots stratum only)*

- **Solves:** the screenshot / product-page stratum, and gives verifiable SKUs.
- **Authorization:** the most delicate route. Retailer imagery is copyrighted and
  most terms of service prohibit scraping. Needs explicit legal review before a
  single image is captured. May be viable under fair-use-style internal
  evaluation in some jurisdictions; that is a legal call, not an engineering one.
- **Recommendation:** ~5 cases, **only** with owner legal sign-off. Do not start
  here.

### Route 4 — Synthetic imagery *(gap-filling only)*

Governed by section 8 and enforced by the validator:

- `sourceClass: synthetic_image`, with generation method, the documented gap it
  fills, and a realism review;
- **excluded from brand ground truth and exact-product ground truth** — the
  validator rejects a synthetic case carrying either;
- **excluded from the holdout entirely** — enforced by `datasetSplit`;
- **capped at 20% of the development set** — enforced by `validateSplit`.

With a 60-case development set the hard cap is 12 synthetic cases.

- **Recommendation:** use sparingly and last, for strata that are genuinely hard
  to stage. Do not use it to hit a number — synthetic imagery inflates apparent
  accuracy, because a generated garment tends to be cleaner, better lit and more
  prototypical than a real one.

### Route 5 — Production user imagery *(NOT RECOMMENDED)*

- **Blocked.** Recorded as `blocked` in the inventory and deliberately not
  queried during Phase 0B.
- Requires a lawful basis and user consent that do not exist today, plus face,
  plate and background review on every image.
- Would supply realistic difficulty — and is still the wrong first move.

---

## 3. Proposed composition of the 67

| Route | Cases | Notes |
|---|---:|---|
| Internally photographed | 45 | includes all 10 multi-image sets and all 10 exact-product-knowable cases |
| Licensed stock | 15 | difficulty strata and category breadth |
| Retailer product pages | 5 | **only** with legal sign-off; else reassign to Route 1 |
| Synthetic | 2 | strictly gap-filling, well under the 12 cap |
| **Total** | **67** | |

Plus **15–20 additional images** sourced separately as the calibration batch, so
reviewers do not calibrate on the evaluation set itself.

---

## 4. Sequencing

1. Owner resolves INV-1 (authorization for the existing 8) and INV-2 (the
   rejected fixture).
2. Owner authorizes a sourcing route mix and the legal review for Route 3.
3. Images captured or licensed; EXIF stripped; face/plate/background review per
   `phase0b-privacy-retention.md`; masked derivatives produced where needed.
4. Reviewers staffed; calibration batch run; qualification threshold approved.
5. Two independent reviews of all 75; disagreements adjudicated; agreement
   reported by field.
6. Split generated deterministically (`splitDataset`) and validated
   (`validateSplit`).
7. `freeze-dataset.js` run. It must return **FROZEN**, not "frozen with
   warnings" — it has no such mode.
8. Frozen manifest and freeze record committed and tagged.
9. Authorization packet re-costed against the real corpus.
10. Owner authorizes the paid run.

---

## 5. One caution about the exact-product stratum

Route 1 is the only route that can produce genuinely exact-product-knowable
cases. It is worth doing — but **measurement ceiling MC-1 means the deployed V2
path cannot return an exact-product result at all.** Those 10 cases will score
as under-identification no matter how good the model is.

That is still worth having: it establishes the ceiling quantitatively and gives
a ready-made regression set for whenever exact-product resolution is enabled. It
must simply never be reported as a model accuracy failure. The scorer flags
these cases `contractCeilingAttributable` for exactly that reason.
