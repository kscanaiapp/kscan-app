# VTO Phase 4.2 — Defect Ledger

Phase 4.2 §65. Every repaired defect carries ID, severity, location,
observed failure, root cause, fix, negative control, regression, and commit.
P7-P10 are documented only.

Severity scale as used by this program: P0-P3 must be fixed within scope;
P4-P6 may be fixed under §51's conditions; P7-P10 are documented only.

---

## P42-001 — Segmentation confidence is destroyed by compression speckle

| | |
|---|---|
| **ID** | P42-001 |
| **Severity** | **P2** — silently rejected a large fraction of otherwise-eligible addressable products; no data loss or safety impact, but it invalidated the headline Phase 4.1 metric |
| **Location** | `vto-phase4-pipeline/src/pipeline.ts`, `confidenceComponents.segmentation` |
| **Commit** | `6a2d298` |

**Observed failure.** Addressable (EASY/MEDIUM) real products were rejected
`EXTRACTION_UNRELIABLE` with a well-formed mask and no stage-gate failure.
Phase 4.1 recorded 29/220 such rejections and could not attribute any of
them, because the rejection message was a bare aggregate.

**Root cause.** The segmentation confidence component was

```ts
clamp01(fillRatio * (1 - Math.min(1, (segmentation.componentCount - 1) * 0.05)))
```

`componentCount` is **every** connected foreground component, including
single-pixel speckle produced by lossy WebP/JPEG compression on a flat studio
backdrop. At ≥21 components the penalty saturates and the component becomes
**exactly 0**. Overall confidence is the MIN of six components, so a single
saturated term forces rejection regardless of actual mask quality.

Corpus-wide evidence (490 real products): `totalComponentCount` median 16,
p75 78, p95 328, max 4487 — while `significantComponentCount` (≥1% of image
area) has median 1 and p95 3. Within the 49 addressable images, **21 (42.9%)
carried ≥21 components**. Measured examples:

- 4487 components, **1 significant**, largestComponentRatio 0.61
- 328 components, 1 significant
- 114 components, 1 significant, largestComponentRatio **0.9977** — a
  near-perfect single-garment extraction scored 0

**Fix.** Penalize the **significant** component count (≥1% of image area)
instead of the raw count. This is not a new threshold: `shotClassifier.ts`
has always used `SIGNIFICANT_COMPONENT_AREA_FRACTION` for exactly this
notion. The defect was an internal inconsistency between two modules
reasoning about "how many things are in this picture", and the fix removes it
rather than adding a tunable.

**Negative controls** (`__tests__/vtoPhase42Repairs.test.ts`):

- a genuine multi-object scene (significant count > 1) is still rejected;
- a blank frame with speckle only is still rejected;
- a wrong-fidelity source still fails `PRODUCT_FIDELITY_FAILED`, so a healthy
  segmentation score cannot mask a different limiter;
- **§46**: a HARD model-worn source is still `OCCLUSION_TOO_HIGH` and its
  segmentation component is still 0 — HARD never reaches this line at all
  (`classifyExtractionGate` returns null before extraction), so the change is
  structurally incapable of producing a HARD false-pass.

**Regression.** Nine tests, including one that recomputes **both** formulas
on the same fixture and asserts the old one scored exactly 0 while the new
one scores > 0.5 — so the defect is proven real rather than hypothesized, and
cannot be reintroduced silently.

---

## P42-002 — Confidence rejections were unattributable

| | |
|---|---|
| **ID** | P42-002 |
| **Severity** | **P3** — no wrong output, but it made every confidence rejection undiagnosable, and directly blocked §21's forensic requirement |
| **Location** | `vto-phase4-pipeline/src/eligibility.ts`, `pipeline.ts` |
| **Commit** | `200fd6f` |

**Observed failure.** A confidence-gate rejection produced
`overall confidence 0.42 is below the eligibility threshold` and nothing
else. Two of Phase 4.1's four EASY failures were unattributable for exactly
this reason — the evidence did not capture a per-component breakdown.

**Root cause.** `overallConfidence` reduced six components to one number and
discarded which component held the minimum and what each measured. Malformed
components (NaN / Infinity / absent / non-numeric) were coerced to 0
correctly but indistinguishably from a genuine measured 0.

**Fix.** `confidenceExplain.ts` is now the single place coercion happens;
`overallConfidence` delegates to it, so the reported limiting component can
never disagree with the value the gate applied. Every manifest carries
`confidenceExplanation` (all six components, their coerced scores, what was
actually observed, and any malformed reason). The rejection message names the
limiting component(s) and their values.

**Negative control.** Nine malformed-input cases assert the §24 fail-closed
guarantee is unchanged and now additionally attributed by cause (ABSENT /
NOT_A_NUMBER / NAN / INFINITE / BELOW_RANGE / ABOVE_RANGE).

**Regression.** `__tests__/confidenceExplain.test.ts` (15 tests) plus a sweep
in `vtoPhase42Repairs.test.ts` asserting no confidence-gate rejection can emit
a bare aggregate message. The 87 pre-existing tests passed unchanged through
the refactor, demonstrating behaviour preservation.

---

## P42-003 — Multi-image rescue was unreachable

| | |
|---|---|
| **ID** | P42-003 |
| **Severity** | **P3** — a capability that existed, was tested, and could never fire on real data |
| **Location** | `vto-phase4-pipeline/src/gateECohortCli.ts` |
| **Commit** | `5d37c84` |

**Observed failure.** Phase 4.1's real-catalog result was hero-only, and
reported as a product-level finding.

**Root cause.** `assembleCohort` built each product as
`images: [{ ref: p.product_photos![0] }]` — one image — while
`batch.processVariant` loads all candidates and
`imageSelection.selectBestSourceImage` ranks them. The rescue path existed
and was simply never fed. The runner even counted `multiPhotoObserved` and
then discarded the extra photos.

**Fix.** Pass every `product_photos` entry.

**Negative control / regression.** `phase42AdversarialHarness.test.ts` runs a
two-image product end-to-end through `runBatch`. Note the measured outcome:
the real feed supplies exactly one image per product (490/490), so this
repair changes no current number. It is recorded as a defect because the
capability was unreachable, and because the Phase 4.1 metric derived from it
was presented as a product-level measurement when it was an image-level one.

---

## P42-004 — Multi-image selection could substitute a different colourway

| | |
|---|---|
| **ID** | P42-004 |
| **Severity** | **P1** — would attach the wrong product's photograph to a live product identity, price and purchase link; user-visible and commercially wrong |
| **Location** | `vto-phase4-pipeline/src/imageSelection.ts` |
| **Commit** | `5d37c84` |

**Observed failure.** Latent, and opened by P42-003's fix. Demonstrated by
adversarial test before the guard existed: given a model-worn hero and a
clean flat-lay alternate **in a different colour**, ranking alone selects the
alternate.

**Root cause.** `variantResolution.groupByVariant` marks a product ambiguous
only when it carries **differing non-null** `variantId` values. In the real
feed every `variantId` is `null` and `variantAuthoritative` is false
(measured 490/490), so the guard never fires. Retailer photo arrays routinely
mix colourways. Nothing else checked that an alternate depicted the same
product.

**Fix.** `variantConsistency.ts`. When variant identity is not authoritative,
an alternate may only stand in for the hero if the two agree on dominant
garment colour. On refusal the **hero** is kept — never the next-best
alternate, which would repeat the same unsafe substitution. Unmeasurable
colour fails closed.

This does not infer variant identity from pixels (§14 forbids that): it
never assigns an identity, never splits a product, never decides which
colourway is official. It can only ever refuse, so it moves in one direction.

**Threshold derivation (§26).** 40, derived rather than invented.
Calibration tests measure same-colourway nuisance variation (speckle, tilt,
reseed) and different-colourway distance, assert the two populations are
separated by >2×, and assert the configured threshold lies **strictly inside
that gap** — so it cannot drift out from under its evidence.

**Negative controls.** A same-colourway alternate must still rescue (the
guard must not simply disable the feature); an authoritative variant bypasses
the colour check; a single-candidate product is never variant-checked.

**Regression.** `__tests__/variantConsistency.test.ts` (11 tests) plus the
end-to-end `runBatch` wrong-variant case in the adversarial harness.

---

## P42-005 — Benchmark summary statistic misrepresented a bimodal population

| | |
|---|---|
| **ID** | P42-005 |
| **Severity** | **P4** (evidence-tooling defect, fixed under §51) — no product impact, but it would have misled the architecture decision and the hostile audit |
| **Location** | `vto-phase4-pipeline/src/segmentationBenchmark.ts`, `segmentationBenchmarkCli.ts` |
| **Commit** | `(segmentation benchmark commit)` |

**Observed failure.** The first benchmark run reported `meanIoU 0.8435`,
suggesting a uniformly mediocre segmenter with broad headroom for a model.

**Root cause.** Two compounding errors in my own tooling. (1) The IoU
population is strongly bimodal — near-1.0 or near-0 — so a mean described no
actual case. (2) Results were grouped by each fixture's **intent label**,
which I assigned, rather than by its **classified** class; the classifier
disagreed on several fixtures, so the aggregate scored segmentation on images
the pipeline never sends to segmentation.

**Fix.** Report the distribution (min/p25/median/p75/max, plus counts at
≥0.99 and <0.5) before any mean, and group by classified class, with the
intent-label grouping retained alongside for comparison.

**Effect on the conclusion.** It reversed it. Regrouped, PATH A scores median
IoU **1.000** with zero failures on the population that reaches it — there is
no headroom, and a local model is not warranted (§32).

**Regression.** `phase42Diagnostics.test.ts` asserts median IoU ≥ 0.99, zero
segmentation failures, and zero catastrophic cases on the addressable
population, so the decision's basis fails loudly if PATH A erodes.

---

## P42-006 — This lane's own commit picked up stray harness temp files

| | |
|---|---|
| **ID** | P42-006 |
| **Severity** | **P3** — repository contamination introduced by this lane; no runtime or data impact, but it broke a governed gate and would have shipped junk paths |
| **Location** | commit `9d74739` (this branch) |
| **Commit** | fix in the follow-up commit; entries added to `.gitignore` |

**Observed failure.** CI's scope guard failed on this branch —
`this lane touched a path the manifest does not authorize` — while the same
guard passed locally at the same SHA.

**Root cause.** Running the full repository suite locally executes the VTO
E2E harness, which writes an absolute Windows temp path. Under git-bash on
Windows that path materializes as a **literal filename in the repository
root** (the `:` becomes U+F03A), so four files named
`C<U+F03A>UsersjsmitAppDataLocalTempvto-e2e-a{1,2}-<uuid>.json` appeared at
the top level. A subsequent `git add -A` committed them.

They were **zero-byte** (all four hash to git's canonical empty blob
`e69de29`), which is why Gitleaks and the security scanners passed — there
was no content to find. The failure was structural, not a secret leak.

The local/CI divergence had a simple cause: locally I ran the guard *before*
the contaminating `git add -A`, so the paths were untracked and invisible to
a diff-based check; CI ran it against the pushed commit that contained them.

**Fix.** Removed the four files from the index and added two `.gitignore`
patterns so a local full-suite run cannot contaminate a branch again.

**Negative control / regression.** The guard itself is the regression: it
refused the paths, which is the guard working exactly as intended. Re-running
it against the corrected tree yields `changed: 38, unauthorized: 0`.

**Note for the audit.** This is recorded rather than quietly amended because
it is a defect this lane introduced, and because it is a reusable Windows
trap for any future lane that runs the full suite locally before committing.

---

## Documented only (P7-P10)

**P42-D01 — `sourceQuality` is a raw pixel-count proxy.** `clamp01(w*h /
(300*300))` treats a 300×300 image as perfect and has no notion of garment
occupancy, sharpness, or texture resolution at torso scale. It is the
limiting component for small sources (measured: a 200×180 source scores
exactly 0.4 and is rejected). It is not repaired here because §26 requires a
replacement threshold be justified by observed evidence, and the real corpus
shows resolution was never the limiter for the addressable slice (min short
side 183px, median 603px; Phase 4.1 recorded ADEQUATE for all ten addressable
cases). `sourcePreflight.ts` now measures everything a better formula would
need. Severity P7.

**P42-D02 — Padding is handled implicitly.** A quarter of a typical real
image is uniform-background margin (median `paddingTotalFraction` 0.278),
routinely asymmetric (median asymmetry 0.148). The segmenter crops to the
winning component's bounding box, so margin is excluded rather than absorbed,
and an adversarial test pins that a 100×100 garment on a 600×600 canvas does
not absorb it. No explicit normalization was added: §26 requires evidence,
and the evidence is that padding is not currently causing failures, while
trimming carries its own risk to real garment pixels (§35). Severity P8.

**P42-D03 — `search-vinted-secondhand` discards photo arrays.**
`imageFrom()` iterates `raw.images ?? raw.photos` and returns the first
match, discarding the rest, so an upstream that supplies multiple photos is
collapsed to one before the app sees it. This is a contract-level cause of
the one-image-per-product ceiling. Not repaired: changing it is a Commerce
redesign and a staging mutation, both out of scope (§51/§53/§58). Recorded as
the leading §61 recommendation. Severity P7 as a defect; higher as a
strategic constraint.

**P42-D04 — Provider quota caps corpus size below §7's target.** The shared
RapidAPI key rate-limits after ~28 requests (HTTP 429), which capped this
lane's corpus at 490 products against a ≥1,000 target. Not a code defect and
not evadable within §7. Mitigated by bounded backoff and a transient corpus
cache so future quota extends the corpus rather than re-measuring it.
Severity P7 (external constraint).

---

## P0-P3 status

```
P0 FOUND      0
P1 FOUND      1   (P42-004)   FIXED
P2 FOUND      1   (P42-001)   FIXED
P3 FOUND      3   (P42-002, P42-003, P42-006)   FIXED

P0-P3 REMAINING OPEN:  0
P4-P6 FIXED:           1   (P42-005)
P7-P10 DOCUMENTED:     4   (P42-D01 .. P42-D04)
```
