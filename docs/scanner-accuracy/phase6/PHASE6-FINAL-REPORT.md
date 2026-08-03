# Phase 6 — final report

    STATUS:          COMPLETE
    CLASSIFICATION:  REJECTED — CANDIDATE FAILED (prompt-only family)
    PAID EVALUATION: STOPPED at owner instruction
    PROVIDER SPEND:  $0.883479 of the $2.00 session ceiling
    OWNER APPROVAL:  required before any forward-port

Phase 6 was an isolated scanner-research program. No product, hotfix, security,
release, mobile or backend branch was modified. No candidate was activated, no
Edge Function deployed, no EAS build performed.

---

## 1. What the control established

A fresh 33-case governed control was required and run, because historical
results were not reusable: provider payload, prompt, schema, sampling, model and
parser are byte-identical between certified-v140 and the current product, but
the request and response contracts differ (`legacy-selected-item` rather than V2,
plus the added `identify_for_closet` intent). Provider-payload equivalence alone
does not license reuse.

    RUN:      baseline-v0.3.1-v140-20260803-0531-e4ac29c-development-exec
    LOCK:     4b94aef (immutable, SHA-256 checksummed)
    VERDICT:  EXPECTED_STOCHASTIC_VARIATION — lockable

| | |
|---|---|
| cases | 33 |
| valid | 29 |
| invalid output | 3 |
| unmeasured (adapter fault, 0 provider attempts) | 1 |
| p50 / p95 latency | 9,158 ms / 10,960 ms |
| dispatched cost | $0.435063 |

### The dominant failure mechanism is now PROVEN, not inferred

Every invalid output carried the provider's own `finishReason: MAX_TOKENS` and
terminated **15–18 tokens** below the certified 2,048 ceiling. Every valid case
finished `STOP`. Zero timeouts, safety blocks, malformed-but-complete responses,
or fallback escalations.

This closes a question that had been open since Build 4. `model_json_unparseable`
was never a JSON-formatting defect. It is **response truncation caused by the
response and the model's own reasoning competing for one 2,048-token budget**,
with no `thinkingConfig` set.

The magnitude is the headline number of this whole program:

    thinking tokens:  45,506
    response tokens:   4,779
    thinking share of billed output: 90.5%

**The scanner spends nine tenths of its paid output budget on reasoning it
never returns**, and the truncations are the cases where that reasoning
crowded out the answer.

### Two secondary findings from the control

**Historical cost figures were understated ~3.7×.** Gemini bills thinking tokens
at the output rate. Prior runs recorded only `candidatesTokenCount`, so the
Build 4 control's recorded $0.119 was really ~$0.43. Every historical cost
figure in Phase 2A/Build 4 documentation should be read as roughly a quarter of
true spend.

**Truncation is stochastic, not deterministic.** The same governed case, same
configuration, same prompt, produced 1,505 / 1,883 / 2,033 output+reasoning
tokens across three runs — valid, valid, truncated. Identical input; the model's
reasoning varied and that alone decided validity. This is why the anomaly
classifier keys on mechanism rather than on a rate threshold.

---

## 2. What Candidate A improved

`phase6-scanner-v1.0-a` — the Phase 2A specificity rule at a fifth of the length,
plus an explicit instruction to answer without deliberating. Overlay
`b470706f3788912e…`, appended; certified prompt never rewritten.

| | control | Candidate A | change |
|---|---|---|---|
| valid | 29 | 31 | +2 |
| invalid output | 3 | 2 | −1 |
| adapter failures | 1 | 0 | −1 |
| **thinking tokens** | 45,506 | 37,302 | **−18.0%** |
| p50 latency | 9,158 ms | 6,967 ms | **−23.9%** |
| p95 latency | 10,960 ms | 10,178 ms | −7.1% |
| dispatched cost | $0.435063 | $0.411063 | −5.5% |

Paired: 3 control-invalid became valid, 1 control-valid became invalid.

**The preregistered primary risk did not materialise.** The hypothesis record
stated that if the provider's dynamic reasoning allowance ignored the
instruction, the overlay would contribute only its added tokens and the family
would be disproven. It did not ignore it: thinking fell 18% while input grew by
8,077 tokens. **Prompt instruction demonstrably moves this provider's reasoning
budget.** That is a genuinely useful, reusable result independent of this
candidate's fate.

---

## 3. What Candidate A degraded

Accuracy, measured strictly over the 28 cases scoreable in **both** runs so a
reliability change cannot masquerade as an accuracy change:

| field | control-only correct | candidate-only correct | net |
|---|---|---|---|
| category | 3 | 2 | −1 |
| **subtype** | **3** | **0** | **−3** |
| primaryColor | 2 | 1 | −1 |
| clothingType, material, pattern, brand | 0 | 0 | 0 |

8 discordant field-pairs favour the control against 3 favouring the candidate.
Subtype — the field the hypothesis specifically predicted would improve — lost
three and gained none.

### It is not a suppression artifact, and that matters

The preregistered secondary risk was suppression: that the decisiveness rule
would abstain on answers the evidence supported. **The opposite happened.**

| | control | Candidate A |
|---|---|---|
| abstention rate | 34.4% | 31.1% (−3.3 pp) |
| answered (classifiable) | 59 | 62 |
| correct | 40 | 36 |
| accuracy among answered | 67.8% | 58.1% (**−9.7 pp**) |

The candidate answered three more fields and got four fewer right. **Every
suppression metric moved favourably while the candidate got worse**, so the
suppression gate — the specific guard designed to stop a candidate passing by
abstaining — would not have caught this. Less deliberation bought reliability at
the cost of judgement.

**Strength of evidence:** 11 discordant pairs split 8/3 is roughly p ≈ 0.11 at
n = 28. Directionally adverse; not statistically established. It does not
support improvement, and it should not be reported as a proven regression
either.

---

## 4. Current limits on scanner success

Ranked by size of the gap, from the locked control.

**1. `clothingType` is never answered — 0 of 20 classifiable, in both runs.**
The scanner produces a concrete value for this field in zero cases. This is a
larger accuracy gap than anything the prompt experiment moved, and it is
invisible in "correct rate" reporting because a field that is never answered is
never wrong. Cause is not established: it may be a production prompt/schema gap
or an evaluation projection/mapping defect. **It should be the first thing
investigated, and it is cheap to investigate — no provider spend required.**

**2. The 2,048-token shared budget caps achievable reliability.** With 90.5% of
billed output going to reasoning, the response is competing for scraps.
Prompt-only work can nudge this (−18% demonstrated) but cannot remove the
constraint.

**3. Overall accuracy is low in absolute terms.** 44.4% correct over classifiable
fields on the control. Category 66.7%, primaryColor 71.4%, material 77.8%,
subtype 40%, clothingType 0%.

**4. Brand is not measurable on this corpus.** Zero concrete brand predictions,
zero false positives, 26-case cohort, `positiveBrandCorrectness: not_measured`.
The dataset has no case with a concrete brand ground truth, so brand precision
and visible-brand recall are untested.

**5. Exact product is `not_measured`.** Never evaluated in this pilot.

**6. The corpus is a 40-case licensed-web-image pilot**, self-described as *not*
a real-world smart-glasses benchmark and *not* a comprehensive brand corpus.
33 development / 7 holdout. The holdout was never opened.

---

## 5. What we learned about prompt-only optimization

**It works on the mechanism it targets, and it is not free.** The instruction to
stop deliberating cut reasoning 18% and latency 24%. The same instruction cost
9.7 points of accuracy among answered fields. On this evidence the two are the
same lever: the model's deliberation is *doing something useful* for
identification, and suppressing it to protect the token budget trades away the
work you wanted.

**Length is a first-class variable, not a detail.** Phase 2A's ~1,000-token
overlay drove invalid output from 18.2% to 42.4%. Candidate A's ~192-token
overlay did not repeat that. Any appended-overlay mechanism competes with the
response for the same ceiling, so overlay size must be budgeted, not just
reviewed for content.

**Suppression gates do not catch judgement loss.** The guard designed to stop
"passing by abstaining" reported *favourable* movement on every metric while
accuracy fell. Accuracy-among-answered must be gated directly.

**Prompt-only work cannot resolve the dominant failure.** Truncation went 3 → 2
and remains the dominant actionable mechanism, with both survivors 15 tokens
from the ceiling. The real repair is a generation-config change, which is
outside the prompt-only boundary by construction.

Against the preregistered triggers, **neither Candidate B nor C is justified**:
B was conditioned on accuracy improving with suppression rising (accuracy fell,
suppression fell); C on reliability landing worse than predicted (it landed
better). Those triggers were not rewritten after seeing results. Under §16 the
prompt-only family is therefore **REJECTED — CANDIDATE FAILED**, which is an
explicitly valid Phase 6 outcome.

---

## 6. Recommendations for the next experiments

Ordered by evidence strength and cost. None of these are implemented; all
require owner approval.

### Tier 1 — free, and highest expected value

**R1. Diagnose why `clothingType` is never answered.** Zero of 20. Pure source
investigation across the production prompt, the response schema, the V2
projection and the evaluation scoring projection. If it is a product defect it
is likely the single largest accuracy win available; if it is an eval mapping
defect, every `clothingType` number ever reported is wrong. Either outcome
matters and neither costs a provider call.

**R2. Re-audit historical cost claims.** Thinking tokens were unbilled in all
prior records. Correct the Build 4 / Phase 2A figures to ~3.7× before they are
used for planning.

**R3. Gate accuracy-among-answered explicitly.** Candidate A demonstrates that
suppression metrics can move favourably while judgement degrades. Add it to the
promotion gates before the next candidate runs.

### Tier 2 — the confirmed mechanism (~$0.45/run)

**R4. Generation-budget family (`phase6-generation-budget-v1`, max 2 variants).**
Already authorized by the Candidate A PARTIAL result and preregistration-ready.
The smallest evidence-supported change first: an explicit `thinkingConfig`
budget that reserves room for the response, rather than a larger
`maxOutputTokens`. Responses need only 130–186 tokens; reasoning is consuming
~1,400 on success and ~1,960 on failure. Bounding reasoning is a *smaller*
change than raising the ceiling and directly targets the proven mechanism.
Watch for the Candidate A effect repeating: if bounding reasoning also degrades
accuracy, the model genuinely needs that deliberation and the answer is a larger
budget, not a tighter one.

**R5. Only then consider raising `maxOutputTokens`.** A larger allowance that
merely produces more deliberation without better answers must be rejected —
that gate is already written.

### Tier 3 — dataset and measurement capability

**R6. A corpus that can actually measure brand and exact product.** The current
40-case pilot has no concrete brand ground truth, so brand precision, visible-
brand recall and exact-product identification are all unmeasurable. Any claim
about commerce-grade identification is currently unsupportable by this
benchmark. Needs governed, authorized images with known brand and product.

**R7. Real-capture fashion data.** The corpus is licensed web images —
museum and catalogue photography, well-lit and centred. Production scans are
handheld, mixed-lighting, partially occluded, often worn. The gap between these
distributions is unquantified and is the most likely source of
benchmark-to-production surprise.

**R8. Expand beyond 33 development cases.** At n=33, an invalid-count swing of
±3 is ordinary sampling noise, and an 8-vs-3 discordant split is p ≈ 0.11. The
current corpus cannot resolve the effect sizes these experiments produce.

### Tier 4 — product-scope options, documented not recommended for Phase 6

These change what the scanner *is*, not how well the current design performs.
Each is a product decision with its own commercial, privacy and contract
implications, and none should be folded into a scanner-accuracy experiment.

**R9. Specialist footwear / product identification APIs.** Footwear is heavily
represented in the corpus and is exactly the category where a specialist
identifier (sneaker databases, SKU-level catalogues) outperforms a general
vision model. The existing backend already has `kicksCrewProvider` and
`nike-shoe-details` surfaces. A specialist call is a *routing* change, not a
prompt change, and would need its own contract, latency budget and failure
policy.

**R10. Resale-marketplace endpoints.** Resale inventory carries dense, human-
authored attribute metadata — brand, model, colourway, material, era. The
existing `search-vinted-secondhand` surface is precedent. Useful both as a
commerce path and, potentially, as a retrieval signal to ground identification.
Note the privacy boundary: sending user imagery to a marketplace is a materially
different data flow from sending it to the current provider, and would require
explicit review.

**R11. Broader retailer inventory coverage.** Wider catalogue coverage improves
match rate for `identify_and_shop` but does not improve identification itself.
It should be evaluated on commerce conversion metrics, not scanner accuracy.

**A caution on R9–R11.** All three improve *matching* once an item is described.
None of them address the measured failures in this report — truncation,
`clothingType`, or 40% subtype accuracy. A retrieval layer built on a weak
description inherits the weakness. Fix identification first.

---

Detailed, ranked and impact-costed recommendations — split by recognition/model,
prompt/generation, dataset/taxonomy, product-matching, and specialist sources,
with every conclusion labelled proven or hypothesis — are in
`SCANNER-ACCURACY-RECOMMENDATIONS.md`.

---

## 7. Benchmark findings for the audit handoff

Four defects surfaced during execution. None were repaired mid-measurement
except where explicitly approved.

1. **Pre-dispatch reservation retention.** A case failing at countTokens with
   `providerRequests: 0` retained a conservative $0.0235 against the run
   ceiling. Resume reconstruction removes it, but a single-pass run that fails
   late loses budget it never spent. *Not repaired.*
2. **Resume-identity asymmetry.** The runner records the *resolved*
   `candidateVersion` but compares against the *raw* CLI argument on resume, so
   a control run that omits the flag writes a manifest it cannot resume without
   passing a flag it was never given. *Not repaired.*
3. **Suppression label scope.** Labels were resolved from the current
   invocation's case selection rather than the manifest, so a resumed run
   summarized 33 records against a 2-entry map and died in reporting after all
   provider work had succeeded. **Repaired with owner approval** (`6c46f14`);
   changes no label, denominator or score.
4. **Zero-work resume exit code.** `ok` compares run-wide completed count
   against the current invocation's plan count, so a no-op resume exits 1
   despite succeeding. Cosmetic. *Not repaired.*

A fifth is an operator trap rather than a defect: `--overlay-file` is documented
as optional but is **mandatory for any candidate**. The registry already knows
each candidate's overlay id, so the launcher could derive it. It caught a
mistake of mine correctly — without that guard Candidate A would have silently
run the *control* prompt across 33 cases and produced a plausible null result.

---

## 8. Final state

    PHASE 6 STATUS:              COMPLETE
    FINAL CLASSIFICATION:        REJECTED — CANDIDATE FAILED (prompt-only family)

    BENCHMARK BRANCH:            scanner/phase6-autonomous
    CANDIDATE BRANCH:            scanner/phase6-candidate
    AUDIT BRANCH:                scanner/phase6-audit (untouched, reserved)

    CONTROL BASELINE LOCKED:     YES (4b94aef)
    HISTORICAL RESULTS REUSED:   NO
    CANDIDATES TESTED:           1 of 3 authorized
    CANDIDATE A DECISION:        PARTIAL
    PROMPT CANDIDATES B / C:     not justified by preregistered triggers
    GENERATION-CONFIG VARIANTS:  0 (authorized, not run — paid evaluation stopped)
    INDEPENDENT AUDIT:           not performed

    PROVIDER CALLS:              66 generation attempts across smoke, control, candidate
    TOTAL SESSION COST:          $0.883479 of $2.00
    COST CEILING RESPECTED:      YES — never altered

    PRODUCT BRANCHES MODIFIED:   NO
    ELISE HOTFIX MODIFIED:       NO  (locked inputs e63d594 / 1ace13f)
    SECURITY BRANCH MODIFIED:    NO
    PRODUCTION SCANNER MODIFIED: NO
    RESPONSE CONTRACT CHANGED:   NO
    PARSER / SCHEMA CHANGED:     NO
    CANDIDATE ACTIVATED:         NO
    BACKEND DEPLOYED:            NO
    EAS BUILD PERFORMED:         NO

    OWNER APPROVAL REQUIRED:     YES
    PHASE CLOSED:                YES

No candidate is recommended for forward-port to a future physical Build 6. The
locked control, the Candidate A evidence, and the confirmed truncation mechanism
are the deliverables, and they are what the next experiment should build on.
