# Phase 0B — Taxonomy reference and labeling standard

Status: **READY, NOT STARTED — reviewer staffing unresolved.**

Formal labeling has not begun. Section 9 forbids starting before reviewer
availability is identified, and it is not. This document is the guide that
labeling will follow once the owner staffs it.

---

## 1. Reviewer roles

| Role | Responsibility | Assigned |
|---|---|---|
| Primary reviewer | Independent first label of every case | **UNASSIGNED** |
| Independent second reviewer | Independent second label, blind to the first | **UNASSIGNED** |
| Adjudicator | Resolves fields where the two disagree | **UNASSIGNED** |

One person may hold the adjudicator role **and** one reviewer role, provided the
two initial labels are produced independently and blind. One person may **not**
hold both reviewer roles — that produces one label recorded twice, and an
agreement rate computed from it is meaningless.

### Why this is currently blocking

Two independent human reviews cannot be synthesised. An AI agent labeling the
same image twice is one labeler run twice, not two reviewers, and any
"inter-reviewer agreement" derived from it would be a fabricated statistic.

What **can** be produced without staffing, and what this phase offers, is a
machine-assisted **draft primary label** clearly attributed as such, with the
secondary slot left empty. Draft labels are `reviewStatus: draft` and are not
admissible to a frozen dataset.

---

## 2. Field vocabulary

Values come from the versioned ontology, not from a reviewer's own vocabulary:

- `tools/scanner-evaluation/ontology/fashion-taxonomy.v1.json`
- `tools/scanner-evaluation/ontology/color-families.v1.json`
- `tools/scanner-evaluation/ontology/material-families.v1.json`
- `tools/scanner-evaluation/ontology/brand-normalization.v1.json`

### Category (level 1)

`blazer`, `outerwear`, `dress`, `pants`, `skirt`, `top`, `vest`, `jumpsuit`,
`romper`, `bodysuit`, `footwear`, `bag`, `accessory`, `NON_FASHION`.

These are the values production's `normalizeCategory` actually returns. Note:

- **blazer is not a child of outerwear.** Production tests blazer first and
  returns it as its own category. Label a blazer `blazer`.
- **eyewear and jewelry are not categories.** Both are `accessory` at level 1,
  with `eyewear` / `jewelry` at level 2.
- **skirt is its own category.** It is not in production's `pants` regex. Do not
  label a skirt as `bottoms`.

### Clothing type (level 2) and subtype (level 3)

See the `hierarchy` block of the taxonomy file. A subtype must sit under the
clothing type you assigned, and that clothing type under the category. The
validator rejects a subtype that does not.

### Colour

Label the **shade you can actually see** (`navy`), not the family (`blue`). The
scorer credits a family-level prediction against a shade label as acceptably
broad; it cannot do the reverse. Labeling the family throws away information.

`teal` and `olive` have **no agreed family**. Use them only as exact labels and
expect them to score as unrelated against anything else. Flag any case that
depends on them.

**A monochrome image has no colour ground truth.** Label `not_visible`.

### Material

Only from the supported list. Never guess a fibre from appearance.

- `leather` and `faux leather` are different substances. If you cannot tell,
  the answer is `unknown`, never a coin-flip.
- `denim` is its own terminal value. Do not label denim as `cotton`.
- Hedged appearance ("looks like leather") is **not** a material label.

---

## 3. Uncertainty tokens — the three are not interchangeable

| Token | Meaning | Use when |
|---|---|---|
| `not_visible` | The attribute exists on the item but this image does not show it | Brand tag is out of frame; garment is monochrome; back of the item is unseen |
| `unknown` | The attribute is visible but you cannot determine it | You can see the fabric but cannot tell the fibre |
| `not_applicable` | The attribute does not exist for this item | Sleeve length on a handbag; any fashion field on a non-fashion image |

Choosing between these changes the score. `not_visible` + a model abstention is
**correct**. `unknown` + a model abstention is a **correct abstention**.
`not_applicable` + a populated model field is **incorrect**. Getting the token
wrong misattributes the model's behaviour.

**Unknown is a valid, respected answer.** Do not force a value to make a case
look complete. The harness penalises an unsupported confident label far more
than it penalises an honest unknown, and that asymmetry is deliberate.

---

## 4. Brand — evidence standard

Admissible:

- a visible logo in the image;
- a visible brand label or care tag in the image;
- a verified purchase record;
- verified fixture metadata;
- a verified product record.

**Never admissible:** style resemblance, silhouette, "this looks like a
Burberry trench", or a commerce search result.

If a garment carries a wordmark you cannot verify against a real brand — the
`COQ` mark on `top.jpg` is the live example — the brand is `not_visible`. A
mock-up wordmark is not a brand.

## 5. Exact product — evidence standard

Admissible: a SKU or product code, a verified product page, a verified receipt
or purchase record, or approved fixture metadata tied to the exact item.

**Never admissible:** visual resemblance, however strong.

> **Measurement ceiling MC-1.** The deployed V2 path hardcodes `exactProduct:
> null` and can never return `exact_product` or `model_family` resolution. Every
> case labelled `likely_exact_match` will score as under-identification no
> matter what the model does. Label exact product honestly anyway — it is needed
> for future comparison — but understand that the first baseline cannot measure
> it, and no report may present that as a model failure.

---

## 6. Expected result state

The four states are **evaluation abstractions**, not production fields. Assign
the state the evidence in the image supports:

| State | Assign when |
|---|---|
| `likely_exact_match` | Verifiable SKU/product evidence exists (see MC-1) |
| `closest_matches` | The item is a recognisable commercial product but the exact SKU is not determinable |
| `identified_style` | The garment's category and style are clear; brand and product are not determinable |
| `insufficient_evidence` | Too little visual information to identify, or the image is not fashion |

---

## 7. Multi-image sets

1. Reviewers must **first confirm the images show the same item.** If they
   cannot agree, `sameItemAcrossImages` is not `true` and the set is not
   scorable. Do not force it.
2. Each image gets its **own independent evidence annotation** — what is visible
   in *that* frame.
3. The set then gets **one consolidated ground truth.**
4. **Direct evidence outranks inference.** One logo or label frame beats any
   number of frames that merely resemble a brand.
5. Unresolved conflict is recorded as `conflicting_evidence`. Those fields are
   reported separately and not scored. A majority of guesses does not resolve a
   conflict.

---

## 8. Calibration protocol

Before any reviewer labels a governed case:

1. Each reviewer independently labels the calibration batch
   (`evals/scanner-accuracy/labels/calibration-batch.v1.json`).
2. Agreement is computed per field.
3. Disagreements are reviewed together, and the guide is amended where the
   disagreement came from an ambiguous rule rather than reviewer error.
4. The owner approves the qualification threshold before labeling starts.

### Proposed qualification threshold — owner approval required

| Field group | Proposed minimum agreement |
|---|---|
| `category` | 95% |
| `clothingType` | 85% |
| `subtype` | 70% |
| `primaryColor` | 85% |
| `brand` | 95% (near-total: the admissible-evidence rule is close to mechanical) |
| `exactProduct` | 95% |
| `expectedResultType` | 80% |

These are **proposals with no empirical basis** — no calibration has run, so
there is no measured distribution to set them from. They are starting points for
the owner, not validated thresholds.

**The threshold must not be lowered to accommodate a staffing shortfall.** If
reviewers cannot reach it, the correct outcome is a better guide or better
reviewers, not a lower bar. Lowering it converts a labeling problem into a
silently unreliable dataset.

---

## 9. What is recorded per case

- both reviewers' labels, independently;
- each reviewer's confidence (`high` / `medium` / `low` / `unknown`);
- the fields they disagreed on;
- whether adjudication was required;
- the final adjudicated value;
- adjudication notes.

Reviewer **identities are not stored in the case record** — a role and a policy
reference is sufficient, and the validator rejects a case record containing a
reviewer name, email or id.
