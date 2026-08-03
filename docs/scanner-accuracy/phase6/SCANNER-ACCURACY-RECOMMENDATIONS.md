# Scanner accuracy — what to do next

Derived from the Phase 6 locked control and Candidate A evidence. Nothing here
is implemented. No further provider spend was incurred producing it.

Companion to `PHASE6-FINAL-REPORT.md`.

---

## Evidence status — read this first

Recommendations are only as good as what actually got measured. This is the
dividing line.

### PROVEN by Phase 6

| # | finding | evidence |
|---|---|---|
| P1 | Invalid scanner output is **response truncation**, not malformed JSON | `finishReason: MAX_TOKENS` on 100% of invalid outputs across two independent runs; all terminated 15–18 tokens below the certified 2,048 ceiling; every valid case finished `STOP` |
| P2 | **Thinking consumes 90.5% of billed output** | 45,506 thinking vs 4,779 response tokens over 33 control cases; successful responses need only 130–186 tokens |
| P3 | **Prompt instruction does move the provider's reasoning budget** | Candidate A cut thinking 18.0% (45,506 → 37,302) while *adding* 8,077 input tokens |
| P4 | **`clothingType` is never answered** | 0 concrete answers of 20 classifiable, in **both** control and candidate |
| P5 | Truncation is **stochastic**, not deterministic | Same case, same config, three runs: 1,505 / 1,883 / 2,033 output+reasoning tokens — valid, valid, truncated |
| P6 | Historical cost records understate spend **~3.7×** | Thinking billed at output rate; prior runs recorded only `candidatesTokenCount` |
| P7 | **Brand and exact-product accuracy are unmeasurable** on this corpus | Zero cases carry concrete brand ground truth; `positiveBrandCorrectness: not_measured` |
| P8 | Suppression gates **cannot** catch judgement loss | Candidate A: abstention *fell* 3.3 pp, answered 3 more fields, got 4 fewer right |

### OBSERVED but not statistically established

| # | finding | caveat |
|---|---|---|
| O1 | Reducing deliberation costs accuracy | 8 vs 3 discordant field-pairs, n=28, p ≈ 0.11. Directionally adverse; does not support improvement; not a proven regression |
| O2 | Absolute accuracy is low | 44.4% correct over classifiable fields; subtype 40%, category 66.7%, colour 71.4%, material 77.8% — single 33-case pilot |

### HYPOTHESIS — requires a new test

Everything in the ranked recommendations below marked **[H]**. Phase 6 measured
one prompt-only candidate against one control on one 40-case pilot corpus. It
did not test any model, generation-config, dataset, or retrieval change.

---

## Ranked recommendations

Impact = expected effect on measured scanner accuracy. Cost = provider spend
plus engineering. Difficulty = integration and contract risk.

| rank | recommendation | category | impact | cost | difficulty | status |
|---|---|---|---|---|---|---|
| 1 | Diagnose `clothingType` never being answered | dataset/taxonomy | **High** | **None** | Low | P4 |
| 2 | Gate accuracy-among-answered directly | dataset/taxonomy | Medium | None | Low | P8 |
| 3 | Correct historical cost records | — | Medium | None | Low | P6 |
| 4 | Bounded `thinkingConfig` experiment | generation | **High** | ~$0.45/run | Low | [H] |
| 5 | Raise `maxOutputTokens` — only if 4 fails | generation | Medium | ~$0.45/run | Low | [H] |
| 6 | Brand-and-product-labelled corpus | dataset/taxonomy | **High** | Medium | Medium | P7 |
| 7 | Real-capture (in-the-wild) corpus | dataset/taxonomy | **High** | Medium | Medium | [H] |
| 8 | Expand development set well beyond 33 | dataset/taxonomy | Medium | Low | Low | O1/O2 |
| 9 | Two-pass identification | recognition/model | Medium | ~$0.9/run | Medium | [H] |
| 10 | Model comparison (Pro tier / newer flash) | recognition/model | Medium | ~$1–2/run | Low | [H] |
| 11 | Category-conditioned prompting | prompt | Medium | ~$0.45/run | Medium | [H] |
| 12 | Specialist footwear / SKU identification | specialist source | Medium* | Medium | **High** | [H] |
| 13 | Resale-marketplace attribute retrieval | specialist source | Medium* | Medium | **High** | [H] |
| 14 | Broader retailer inventory | product-matching | Low* | Medium | Medium | [H] |

\* Improves **matching**, not identification. See the caution at the end.

---

## 1. Recognition and model improvements

**R9 — Two-pass identification. [H] Impact Medium · Cost ~$0.9/run · Difficulty Medium**

P2 shows the model reasons for ~1,400 tokens then emits ~150. A single pass
forces one budget to carry both deliberation and a structured answer. Splitting
them — pass 1 free-form observation, pass 2 structure that observation into the
schema — removes the competition P1 identifies, at roughly double the cost and a
second dispatch.

This directly contradicts the current single-dispatch invariant, so it is a
contract change, not an experiment tweak. Worth measuring precisely because
Candidate A showed deliberation is *load-bearing* for accuracy (O1): if the
model needs to think, give it somewhere to think that isn't the answer budget.

**R10 — Model comparison. [H] Impact Medium · Cost ~$1–2/run · Difficulty Low**

The certified route pins `gemini-3.6-flash` with a `gemini-3.5-flash-lite`
fallback. Nothing in Phase 6 tested whether a higher-capability tier changes the
44.4% baseline, or whether it reasons *less* per unit of accuracy. Cheap to run,
easy to interpret, but a model-family change is a certified-route change with
its own cost and latency profile.

Sequence this **after** rank 4: if the truncation ceiling is the binding
constraint, a better model evaluated under the same 2,048 budget will be
measured through the same bottleneck and undersell itself.

---

## 2. Prompt and generation changes

**R4 — Bounded `thinkingConfig`. [H] Impact High · Cost ~$0.45/run · Difficulty Low**

The single highest-value paid experiment available, and already authorized by
the Candidate A PARTIAL result.

P1 and P2 together say the response is losing a budget fight with reasoning.
Setting an explicit reasoning budget that reserves room for the answer targets
that mechanism directly, where prompt wording can only lean on it. Prefer this
**before** raising the ceiling: it is the smaller change, and responses provably
need only 130–186 tokens.

The preregistered risk is specific and must be watched: Candidate A cut thinking
18% and *lost* accuracy (O1). If bounding reasoning reproduces that trade, the
conclusion flips — the model genuinely needs the deliberation, and the answer is
a **larger** budget (rank 5), not a tighter one. Either result is informative;
that is what makes this the right next test.

**R5 — Raise `maxOutputTokens`. [H] Impact Medium · Cost ~$0.45/run · Difficulty Low**

Run only if rank 4 shows the model needs its deliberation. The existing gate
already covers the failure mode: a larger allowance that produces more
deliberation without better answers must be rejected.

**R11 — Category-conditioned prompting. [H] Impact Medium · Cost ~$0.45/run · Difficulty Medium**

Category is the strongest field (66.7%) and subtype the weakest gradeable one
(40%). Establishing category first and conditioning subtype vocabulary on it is
a plausible way to lift the weak field — but it implies either two passes
(rank 9) or a routing change, so it is not prompt-only despite the name.

**Not recommended: further prompt-only candidates.** Phase 6's authorized family
is exhausted, and B and C failed their preregistered triggers. More importantly
P1 says the dominant failure is a budget constraint, and every appended overlay
competes for that same budget. Prompt-only work has been measured and its ceiling
is now known.

---

## 3. Dataset and taxonomy improvements

**R1 — Diagnose `clothingType`. P4 · Impact High · Cost None · Difficulty Low**

**Do this first.** The scanner produces a concrete `clothingType` in **zero** of
20 classifiable cases, in both runs. This is a larger gap than anything Phase 6's
experiment moved, and it is invisible in correct-rate reporting because a field
that is never answered is never wrong.

The cause is not established and the two possibilities have opposite
implications:

- a **production** gap — the prompt or schema never elicits the field, in which
  case this is a real product defect with a real accuracy cost; or
- an **evaluation** gap — the projection or scoring mapping drops it, in which
  case every `clothingType` figure ever reported is meaningless.

Pure source investigation across the production prompt, response schema, V2
projection and eval scoring projection. No provider spend. Highest
value-per-effort item in this document by a wide margin.

**R2 — Gate accuracy-among-answered. P8 · Impact Medium · Cost None · Difficulty Low**

Candidate A proved the current gate set has a blind spot: every suppression
metric moved favourably while judgement degraded. Add accuracy-among-answered as
a first-class promotion gate before the next candidate runs, or the next
candidate can regress the same way undetected.

**R3 — Correct historical cost records. P6 · Impact Medium · Cost None · Difficulty Low**

All Build 4 / Phase 2A cost figures are ~3.7× understated. Correct them before
they are used for budgeting, or every future run ceiling will be set from
fiction.

**R6 — Brand-and-product-labelled corpus. P7 · Impact High · Cost Medium · Difficulty Medium**

Brand precision, visible-brand recall and exact-product identification are all
currently **unmeasurable** — not poor, unmeasurable. The corpus has no case with
a concrete brand ground truth. Any claim about commerce-grade identification is
unsupportable by this benchmark today, and every specialist-source
recommendation below is unevaluable without this.

Requires governed, authorization-cleared images with known brand and product.
This is the prerequisite for ranks 12–14 being assessable at all.

**R7 — Real-capture corpus. [H] Impact High · Cost Medium · Difficulty Medium**

The frozen corpus is licensed web imagery — museum and catalogue photography,
well-lit, centred, unoccluded. Production scans are handheld, mixed-lighting,
partially occluded, frequently worn. The distribution gap is completely
unquantified and is the most likely source of benchmark-to-production surprise.
The freeze record says as much itself: *not* a real-world benchmark.

**R8 — Expand the development set. O1/O2 · Impact Medium · Cost Low · Difficulty Low**

At n=33 an invalid-count swing of ±3 is ordinary noise (P5), and Candidate A's
adverse accuracy signal sits at p ≈ 0.11 — real enough to act on, too weak to
conclude from. The corpus cannot resolve the effect sizes these experiments
produce. Everything above is measured through this limitation.

---

## 4. Product-matching and inventory / API improvements

**R14 — Broader retailer inventory. [H] Impact Low (for accuracy) · Cost Medium · Difficulty Medium**

Wider catalogue coverage raises match rate for `identify_and_shop`. It does not
improve identification. Evaluate on commerce conversion, not scanner accuracy,
and do not let it be scored as an accuracy win.

---

## 5. Specialist sources

**R12 — Specialist footwear / SKU identification. [H] Impact Medium* · Cost Medium · Difficulty High**

Footwear is heavily represented in the corpus and is exactly where a specialist
identifier — sneaker databases, SKU-level catalogues — outperforms a general
vision model. The backend already has `kicksCrewProvider` and `nike-shoe-details`
surfaces, so precedent exists.

This is a **routing** change, not a prompt change: it needs its own request
contract, latency budget, failure policy and cost model, and it changes what one
scan dispatches. High integration risk relative to the other items.

**R13 — Resale-marketplace attribute retrieval. [H] Impact Medium* · Cost Medium · Difficulty High**

Resale inventory carries dense human-authored attributes — brand, model,
colourway, material, era — which is exactly the metadata the scanner is weakest
at. The `search-vinted-secondhand` surface is precedent. Potentially useful both
as a commerce path and as a grounding signal for identification.

**Privacy boundary, flagged explicitly:** sending user imagery to a marketplace
is a materially different data flow from sending it to the current identification
provider. It requires its own privacy review, user disclosure and retention
decision, and must not be treated as an extension of existing scanner consent.

### The caution that applies to all of ranks 12–14

All three improve **matching an item once it has been described**. None of them
address a single failure this report measured: not truncation (P1), not
`clothingType` (P4), not 40% subtype accuracy (O2).

A retrieval layer built on a weak description inherits the weakness — and worse,
it can *look* like it is working while returning confident matches for a
misidentified garment. Fix identification first. Then these become force
multipliers rather than amplifiers of an upstream error.

---

## Suggested sequence

1. **Free, immediately:** ranks 1, 2, 3. No provider spend, no product change.
   Rank 1 may reframe the accuracy picture entirely.
2. **One paid experiment:** rank 4, bounded `thinkingConfig`, preregistered.
   Escalate to rank 5 only if rank 4 shows deliberation is load-bearing.
3. **Then invest in measurement:** ranks 6, 7, 8. Without these the benchmark
   cannot support any commerce-grade claim, and cannot resolve effects this size.
4. **Only then** consider ranks 9–11 (recognition changes) and 12–14 (commerce
   and specialist sources), which all require contract decisions and owner
   approval.

Everything above rank 6 is measurable inside the existing Phase 6 framework.
Everything below it needs new corpus or new contracts.
