# Power / claim map

Mission section 8 is explicit that the collection target must be *derived*,
not picked:

> Before scaling collection, create a POWER / CLAIM MAP stating what sample
> sizes are sufficient for claims … Use that analysis to justify the final
> target. Do not spread 100 cases so thinly across dozens of cells that no
> stratum can support useful inference. Prefer depth where it produces
> actionable evidence.

This document is that analysis. It is not decorative: `lib/power.js` implements
it, `cli.js queue` prints the current classification of every claim, and a
metric whose claim classifies as `INSUFFICIENT_N` is **suppressed** from the
evaluation report rather than printed with a caveat.

---

## 1. The classification bands, and why these numbers

| Band | Unpaired n | Paired n | What it licenses |
|---|---|---|---|
| `DECISION_GRADE` | ≥ 30 | ≥ 12 | Worth acting on. **Not** "precise" — see below. |
| `DIRECTIONAL` | 15–29 | 8–11 | Enough to see a large effect and form a hypothesis. |
| `DESCRIPTIVE_ONLY` | 5–14 | 3–7 | You may say what happened in *these* cases. No generalisation. |
| `INSUFFICIENT_N` | < 5 | < 3 | Say nothing. The metric is suppressed. |

**Why 30 for unpaired `DECISION_GRADE`.** It is inherited deliberately from the
Fashion Match Quality Lab's own `MIN_N_FOR_DECISION_GRADE`, so the two labs
agree on the bar and no reader has to hold two different meanings of "decision
grade" in their head at once.

It is worth being blunt about what n=30 actually buys. For a proportion near
0.5, the 95% normal-approximation half-width at n=30 is about ±18 percentage
points. So `DECISION_GRADE` here means *"large enough that a big difference
would be visible"*, and never *"this number is accurate to a few points"*.
Anyone quoting a rate from this corpus must quote its N beside it — which is
why `lib/evaluate.js` attaches `n` and `denominatorBasis` to every metric it
emits rather than leaving them to the reader's discipline.

**Why 12 for paired `DECISION_GRADE`.** A paired design compares two captures
of *the same physical garment*, which removes between-garment variance — and
between-garment variance is the dominant noise source in this corpus, because
garments differ far more from each other than two phone cameras differ from
each other. The comparison is within-subject, so it needs materially fewer
units for the same sensitivity.

---

## 2. The claims this corpus is designed to answer

Each claim names the denominator it is computed over. That is the whole point:
"how accurate is K Scan" is not one number, and the denominators differ.

| Claim | Denominator | Target band for V1 | n needed |
|---|---|---|---|
| `OVERALL_IDENTITY_RATE` | identity-eligible cases | `DECISION_GRADE` | 30 |
| `OVERALL_SUBSTITUTE_QUALITY` | all valid real cases | `DECISION_GRADE` | 30 |
| `PAIRED_DEVICE_DIFFERENCE` | paired garments (1 pair = 1 comparison) | `DECISION_GRADE` | 12 pairs |
| `HARD_NEGATIVE_BEHAVIOUR` | cases tagged `VISUALLY_SIMILAR_DISTINCT_PRODUCT` / `SAME_BRAND_ADJACENT_STYLE` / `COLORWAY_SIBLING` | `DIRECTIONAL` | 15 |
| `LOGO_VISIBILITY_EFFECT` | min(`VISIBLE_LOGO`, `NO_VISIBLE_LOGO`) | `DIRECTIONAL` | 15 per arm |
| `DARK_GARMENT_EFFECT` | min(`DARK_GARMENT`, `LIGHT_GARMENT`) | `DIRECTIONAL` | 15 per arm |
| `PATTERN_EFFECT` | min(`PATTERNED`, `SOLID_COLOR`) | `DIRECTIONAL` | 15 per arm |
| `CAPTURE_CONDITION_EFFECT` | cases of one garment under differing conditions | `DIRECTIONAL` | 8 pairs |
| `CATEGORY_IDENTITY_RATE__<cat>` | identity-eligible cases in that category | `DESCRIPTIVE_ONLY` | 5 each |

A comparison is limited by its **smaller arm**. `min(...)` in the denominator
column is not shorthand — it is the actual rule `lib/power.js` applies, because
40 logo cases against 3 no-logo cases supports nothing.

---

## 3. Deriving the target

### The binding constraint is not the headline claim

`OVERALL_IDENTITY_RATE` needs 30 **identity-eligible** cases, and eligibility
is a subset: a garment reaches `IDENTIFIER_GRADE` only if a collector could
read a style code or GTIN off it *and* pin the colourway. In-store captures of
unbranded or tag-removed garments will not.

Planning assumption, to be replaced with the measured rate after the pilot:
**≈ 60% of collected garments reach `IDENTIFIER_GRADE`.** That is deliberately
conservative. If the pilot's ten cases show a materially different rate, this
number is corrected and the target recomputed — that is what the pilot is for.

So 30 identity-eligible development cases needs ≈ 50 development cases.

### The stratified claims bind harder

`LOGO_VISIBILITY_EFFECT` at `DIRECTIONAL` needs 15 logo **and** 15 no-logo
cases: 30 development cases, in one comparison alone. `DARK_GARMENT_EFFECT` and
`PATTERN_EFFECT` need the same. These strata overlap — one case can be
`NO_VISIBLE_LOGO` *and* `DARK_GARMENT` *and* `SOLID_COLOR`, and should be, since
that is what a genuinely hard case looks like — but they do not overlap
perfectly, and a corpus designed so that every case carries every hard label
would be a corpus of one kind of garment.

Working through it with realistic overlap, the binding requirement is:

```
development cases          72
holdout fraction         0.25
------------------------------
TOTAL VALID REAL CASES     96      (72 / 0.75)
```

### PLANNED VALID CASE TARGET: **96–120**

The mission's working planning figure was ~90–120+, and the derivation lands
inside it. The range's upper end exists because the 60% identifier-grade
assumption may prove optimistic; if the pilot measures 45%, the target rises
toward 120 rather than the claims being quietly downgraded.

### Depth, not breadth

Mission section 12 warns against mechanically populating every category.
Spreading 96 cases across seven categories gives ~13 each — under the
`DIRECTIONAL` bar for every one of them, so no category-level statement would
be possible anywhere.

**V1 covers five categories, not seven:**

| Category | Why it is in | Target cases |
|---|---|---|
| `outerwear` | High price, brand-heavy, visually similar across brands — the hardest and most commercially valuable case | ~22 |
| `top` | Highest real-world scan volume; also where "identical except colourway" is most common | ~22 |
| `footwear` | Model/colourway codes are unusually well recorded, so it is the strongest identity-eligibility source | ~20 |
| `dress` | Silhouette-driven, weak logo signal, genuinely hard for visual matching | ~18 |
| `bag` | High-value accessory commerce; logo-dominant, so it is the natural contrast arm to `dress` | ~14 |

**Explicitly NOT covered in V1: `pants`, `accessory`.** They are reported as
uncovered by `cli.js gaps`, and no claim about them may be made from this
corpus. That is a deliberate depth-over-breadth choice, not an oversight —
adding them would push every other category below the bar.

### Garments versus cases

At ~40 garments and ~96 cases the corpus averages 2.4 captures per garment,
which is what makes the paired and capture-condition claims reachable at all:

- ~20 garments captured on both iOS and Android → 20 pairs → `DECISION_GRADE`
- ~10 garments captured twice under different lighting → 10 pairs →
  `DIRECTIONAL` for `CAPTURE_CONDITION_EFFECT`

Because the partition is anchored on the **garment** (design DM-03), every
capture of one product lands on the same side of the development/holdout split.
A pair can never be broken by the split, and a holdout answer can never leak
through a development twin.

---

## 4. Classification at the corpus's current size

**CURRENT VALID REAL CASES: 0.** Every claim above therefore classifies as
`INSUFFICIENT_N` and every metric is suppressed. `cli.js queue` prints this
live; the summary today is:

```
DECISION_GRADE      0
DIRECTIONAL         0
DESCRIPTIVE_ONLY    0
INSUFFICIENT_N      8
```

This is the correct and honest state for a corpus with no collected captures,
not a defect. The infrastructure is complete; the collection has not started.

---

## 5. What this map deliberately does not do

- **It does not do a formal power calculation for a specified effect size.**
  Doing so would require a prior estimate of K Scan's identity rate, and the
  only way to get one is to run this corpus. Committing to an effect size now
  would be inventing the answer the corpus exists to measure.
- **It does not promise the bands are conservative enough for a close call.**
  They are sized to detect *material* differences. A 3-point difference between
  iOS and Android will not be resolvable at any N this corpus will reach, and
  the map says so rather than letting someone discover it after collecting.
- **It does not license any external claim at any N.** Every band here is about
  internal engineering confidence. Mission section 39 applies at n=30 exactly as
  it applies at n=0.
