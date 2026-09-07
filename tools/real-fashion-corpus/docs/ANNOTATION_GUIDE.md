# Annotation guide

Mission section 34:

> Some product facts are objective, some fashion attributes subjective. Create
> concise annotation guidance for subjective human labels. Where subjective
> labels materially affect metrics, consider a small multi-reviewer pilot to
> assess disagreement. Do not impose an arbitrary agreement threshold unless
> justified. **Record disagreement rather than forcing artificial consensus.**

---

## 1. Which labels are objective and which are not

This distinction decides how much a disagreement matters.

### Objective — there is a fact, and it is written on something

| Field | Where the fact lives |
|---|---|
| `brand` | the tag |
| `product_name` | the tag or the manufacturer's page |
| `style_code` | the tag |
| `gtin` | the barcode |
| `colorway_name` / `colorway_code` | the tag |
| `size` | the tag |
| `category` | near-objective; see §2 |
| `captured_*` dimensions, `format` | the file itself, read by ingestion |

Two annotators who disagree on any of these have made an error, not a judgment
call. One of them misread the tag. These are also the only fields that feed
**identity** eligibility, which is why the identity metric is the corpus's most
trustworthy number.

### Subjective — reasonable people differ

| Field | Why it is a judgment |
|---|---|
| `attr_silhouette` | "relaxed" versus "boxy" is a spectrum |
| `attr_material` | polyester and nylon look identical without the tag |
| `attr_pattern` | is a fine two-tone weave "solid" or "patterned"? |
| `attr_color_family` | navy/black and cream/beige are genuine boundary cases |
| `attr_price_tier` | depends on which market you have in mind |
| `attr_gender_presentation` | about the garment's *cut*, never about a person |
| `difficulty_strata` | several are explicit judgments — see §3 |

**These feed substitute quality, not identity.** A disagreement about
silhouette moves a component score; it cannot turn an `EXACT` into a `WRONG_IDENTITY`.

---

## 2. `category` — where to draw the line

Category is *nearly* objective but has real boundaries. Rules, applied in order:

1. **What would a shop file it under?** That beats what it is made of.
2. A jacket worn as an outer layer is `outerwear`, even if it is unlined.
3. An overshirt is `top` if it is worn over another top indoors, `outerwear` if
   it is the thing you put on to go outside. If genuinely both, choose `top` and
   say so in `notes`.
4. A jumpsuit or playsuit is `dress`.
5. Anything worn on the feet is `footwear`, including boots.
6. Anything carried is `bag`. Anything worn but not clothing — belt, scarf, hat,
   jewellery — is `accessory`.

If two annotators land differently, **record both** (see §4). Do not average.

---

## 3. Difficulty strata — the judgment calls

Most are unambiguous. These three are not, so they get explicit rules:

**`VISIBLE_LOGO`** — a brand mark legible in the submitted photograph at normal
viewing size. Not: a logo you know is on the garment but cannot see in this
shot; not a distinctive-but-unbranded design element. If you have to zoom in to
find it, it is `NO_VISIBLE_LOGO`.

**`DARK_GARMENT` / `LIGHT_GARMENT` / `MID_TONE_GARMENT`** — judge the dominant
colour as photographed, not as named. A "charcoal" that photographs mid-grey is
`MID_TONE_GARMENT`. Rough guide: `DARK` is roughly the bottom third of the
lightness range, `LIGHT` the top third.

**`VISUALLY_SIMILAR_DISTINCT_PRODUCT`** — apply only when you can **name the
other product** it could be confused with, and record that product in the
garment's `resultSetHardNegatives`. Without a named confusable, the label is a
feeling rather than a stratum, and it would inflate the hard-negative
denominator with cases that are not actually hard.

**`SAME_BRAND_ADJACENT_STYLE`** and **`COLORWAY_SIBLING`** require the sibling
to genuinely exist in the brand's line. Check the manufacturer's page.

---

## 4. Recording disagreement

When two annotators differ on a subjective field, the corpus records both. It
does not average them, pick the senior annotator's, or make them talk until they
agree — a forced consensus hides exactly the uncertainty a later reader needs.

Use the garment's `revisions[]` array:

```json
"revisions": [
  {
    "revisedOn": "2026-09-12",
    "reason": "second-annotator disagreement recorded (not resolved)",
    "changedFields": [],
    "annotatorDisagreement": {
      "field": "attributes.silhouette",
      "values": [
        { "annotator": "COL-01", "value": "boxy" },
        { "annotator": "COL-02", "value": "relaxed" }
      ]
    }
  }
]
```

The record keeps the first annotator's value as the operative one — a metric
needs *a* value — while making the disagreement visible to anyone reading the
garment. `revisions[]` is append-only, so this never overwrites history.

---

## 5. The multi-reviewer pilot

Mission section 34 asks for *consideration* of a multi-reviewer pilot, so here
is the recommendation and its reasoning.

**Do it, but only for the fields that can move a metric, and only after the
collection pilot.** Concretely, once ~10 real cases exist:

1. Have a second annotator independently label the **subjective fields only**
   (§1's second table) for all 10 garments, without seeing the first labels.
2. Record every disagreement using the structure in §4.
3. Report the per-field disagreement rate in the collection report.

**No agreement threshold is imposed.** Mission section 34 warns against an
arbitrary one, and it would be arbitrary: there is no prior work establishing
what inter-annotator agreement on "silhouette" *should* be for this taxonomy.
Inventing a bar like κ > 0.6 would be a number with no evidence behind it.

What the disagreement rate is *for*: if `attr_pattern` turns out to be a coin
flip between annotators, then the `pattern` component of the substitute rubric
is measuring annotator variance rather than match quality — and the honest
response is to say so in the report, not to quietly keep publishing the
component. The measurement tells you which components to trust.

The **objective** fields do not need a second annotator for agreement
measurement. They need a second annotator as an *error check*, and any
disagreement there is a defect to fix, not a rate to report.

---

## 6. What annotators must never do

- **Never look at a K Scan result before annotating.** Once you have seen the
  model's answer you cannot un-see it, and your "independent" label is now
  partly the model's. This is the single easiest way to silently destroy the
  corpus's value.
- **Never annotate an identifier you did not read.** If the style code is not
  legible in the photo and you do not have the garment in hand, leave it blank.
- **Never infer a person's characteristics.** Gender presentation is a property
  of a garment's cut. It is not a statement about whoever might wear it, and the
  corpus never records anything about a person.
- **Never resolve a disagreement by deleting one side.** Record both.
