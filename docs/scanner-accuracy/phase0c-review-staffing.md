# Phase 0C Lane B — Reviewer staffing options and labor estimate

**No reviewer is assigned. No reviewer assignment is fabricated here.**

Two options for owner decision. Both are viable; they differ in how much
confidence the resulting ground truth carries, and the difference must be stated
in the baseline report either way.

---

## Option 1 — Independent review *(preferred)*

| Role | Responsibility |
|---|---|
| Primary reviewer | Independent first label of every case |
| Independent second reviewer | Independent second label, blind to the first |
| Adjudicator | Resolves every disagreement, records the reason |

One person may hold the adjudicator role **and** one reviewer role, provided both
initial labels are independent and blind. One person may **not** hold both
reviewer roles.

**Required, without exception, for:**

- all 15 holdout cases;
- every brand label;
- every exact-product evidence tag;
- disputed subtype labels;
- disputed expected-result states.

**Produces:** genuine inter-reviewer agreement per field, and a defensible
ground-truth confidence claim.

---

## Option 2 — Provisional development-only review

**Usable only if the owner explicitly accepts reduced ground-truth confidence.**

- One qualified reviewer labels the 60 development cases.
- The reviewer records confidence and the evidence basis for every field.
- A delayed self-check on a sample measures **intra-rater consistency**.
- Any disputed or low-confidence field stays `unknown`.
- Brand still requires direct evidence — a label, a logo, or a purchase record.
- Exact product remains future-only under MC-1.
- **The 15 holdout cases still require independent review before the paid
  baseline.** This is not negotiable within either option: the holdout is the
  only thing standing between a tuned harness and a self-confirming result.

### The language rule

**Intra-rater consistency must never be described as inter-reviewer agreement.**

They measure different things. Intra-rater consistency measures whether one
person is stable over time. Inter-reviewer agreement measures whether the
labeling *rules* are unambiguous enough that two people reach the same answer.
A single reviewer can be perfectly self-consistent and consistently wrong, and
that failure is invisible to a self-check.

Any report using Option 2 must state, in the metrics section rather than a
footnote: *development-set ground truth carries single-reviewer confidence;
inter-reviewer agreement is not available for it.*

---

## Reviewer qualification package

| Artifact | Status |
|---|---|
| Taxonomy guide | **DONE** — `phase0b-labeling-guide.md` §2 |
| Uncertainty guide | **DONE** — §3, the three tokens as distinct scoring outcomes |
| Brand evidence guide | **DONE** — §4 |
| Expected-result-state guide | **DONE** — §6 |
| Calibration batch | **DEFINED** — `labels/calibration-batch.v1.json`, 7 cases |
| Qualification scoring report | **BLOCKED** — no reviewer to score |

### Calibration weakness, restated

The calibration batch can only be drawn from the same 7 reviewable images the
governed dataset would use, so reviewers would calibrate on the evaluation set
itself. It detects gross vocabulary misunderstanding and nothing more.

**Recommendation:** source 15–20 calibration images *separately* from the 75
governed cases. The capture specification makes this cheap — an extra half hour
of shooting — and it is the difference between a calibration that means
something and one that does not.

### Qualification threshold

**No mandatory percentage is invented here.** A threshold set before any
calibration data exists would be a number with no referent.

The recommendation is procedural: run the calibration, report observed agreement
per field, and set the threshold from that distribution — with the floor that
`brand` and `exactProduct` should approach total agreement, because their
admissible-evidence rules are close to mechanical, so disagreement there
indicates a reviewer who has not internalised the rule rather than a genuinely
hard case.

The threshold must not be lowered to accommodate a staffing shortfall. If
reviewers cannot reach it, the answer is a better guide or better reviewers.

---

## Labor estimate

Per-case rates assume a reviewer who has completed calibration. Cases with
multiple images take longer.

| Activity | Rate | Option 1 | Option 2 |
|---|---|---|---|
| Calibration (per reviewer) | 1.5 h | 3.0 h (2 reviewers) | 1.5 h |
| Primary labeling, 75 cases | ~6 min/case | 7.5 h | 6.0 h (60 dev cases) |
| Second independent labeling | ~6 min/case | 7.5 h | 1.5 h (15 holdout only) |
| Adjudication | ~8 min per disputed case, est. 25% dispute rate | 2.5 h | 0.5 h |
| Intra-rater self-check | ~4 min on a 20-case sample | — | 1.5 h |
| Privacy review (face/plate/background) | ~2 min/case | 2.5 h | 2.5 h |
| Provenance and authorization records | ~2 min/case | 2.5 h | 2.5 h |
| Split validation and freeze | scripted | 0.5 h | 0.5 h |
| **Total** | | **~26 h** | **~16.5 h** |

The 25% dispute rate is an assumption, not a measurement — no calibration has
run. If the real rate is higher, adjudication grows and Option 1's total grows
with it.

Excludes image sourcing itself, estimated separately at 9–10 h in the capture
specification.

**The delta is roughly 9.5 hours.** That is the price of genuine inter-reviewer
agreement across the development set. Whether it is worth paying is the owner's
call, and it should be made knowing the baseline report will have to state which
was chosen.

---

## Recommendation

**Option 1 if the ~26 hours is available.** The first baseline sets the reference
every later candidate is compared against; single-reviewer error in it
propagates silently into every future comparison, and nothing downstream will
surface it.

**Option 2 is a legitimate fallback** — it is honest as long as the confidence
limitation is reported in the metrics rather than buried. The holdout requirement
is what keeps it defensible, and it must not be waived to save the remaining
1.5 hours.
