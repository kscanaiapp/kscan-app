# VTO Phase 4.2 — Segmentation Benchmark

Phase 4.2 §28-§34. §28 forbids spending the phase incrementally patching the
deterministic segmenter without first establishing whether a local model
would be materially better. This is that evidence.

Machine-readable: `evidence/vto-phase4-2/segmentation-benchmark.json`.
Reproduce with `npm run seg:benchmark` in `vto-phase4-pipeline/`.

## 1. Verdict

```
PATH A  deterministic background subtraction   EVALUATED
PATH B  one local segmentation model           NOT INTEGRATED
                                               — evidence did not justify it

SELECTED ARCHITECTURE:  DETERMINISTIC PRIMARY, no fallback path added
EXTERNAL SEGMENTATION CALLS:  0
```

Not "we ran out of time" — a measured headroom finding, stated in §3 below,
and pinned by a regression test so it cannot silently rot.

## 2. Method, and one methodological correction

Both paths implement one interface (`SegmentationPath`) and are scored
against **ground truth**: the synthetic generator's own `garmentPolygon`,
rasterized with the *same* `fillPolygon` that drew the garment. That makes
IoU / precision / recall genuinely meaningful for these fixtures.

§31 is honoured strictly: **no IoU is computed for any real product photo**,
because no ground-truth mask exists for one. Real-corpus segmentation quality
is `NO_REFERENCE` and is reported as such, never as a pass.

17 fixtures span the same visual strata the real corpus is queried across
(plain / logo / patterned / dark / light / soft-knit / structured) plus the
nuisance factors actually measured on real imagery: background noise, tilt,
and low resolution.

**The correction.** The first run reported `meanIoU 0.8435` grouped by each
fixture's *intent label*. Two things were wrong with that number:

1. The IoU population is strongly **bimodal** — cases are near-1.0 or
   near-0. A mean described none of them. The summary now reports the
   distribution (min / p25 / median / p75 / max, plus counts at ≥0.99 and
   <0.5) before any mean.
2. The intent labels were **my labels, not measurements**, and the classifier
   disagreed with several: `easy-stripes-v` and `easy-softknit` classify
   UNSUPPORTED; `medium-tilt-noise` classifies HARD. Scoring segmentation on
   images the pipeline never sends to segmentation answers a question nobody
   asked.

Results are therefore grouped by **classified** class — the population that
actually reaches extraction. An image routed to HARD or UNSUPPORTED is
rejected *before* extraction, so its mask quality cannot change any pipeline
outcome.

## 3. Results — PATH A

By **classified** class (decision-relevant):

| classified | cases | seg. failures | IoU min | IoU median | ≥0.99 | <0.5 | precision | recall |
|---|---|---|---|---|---|---|---|---|
| **EASY** | 9 | 0 | 0.856 | **1.000** | 8/9 | 0 | 0.991 | 0.991 |
| **MEDIUM** | 1 | 0 | 1.000 | **1.000** | 1/1 | 0 | 1.000 | 1.000 |
| HARD | 4 | 1 | 0.002 | 0.935 | 0 | 1 | 0.971 | 0.652 |
| UNSUPPORTED | 3 | 2 | 0.083 | 0.083 | 0 | 1 | 1.000 | 0.083 |

By intent label, for completeness and to show the difference the regrouping
makes: EASY meanIoU 0.885 (2 failures), MEDIUM 0.714 (1 failure), HARD 0.935.

## 4. The §32 decision, and why

**On the population that actually reaches segmentation, PATH A scores median
IoU 1.000 with zero segmentation failures.** Eight of nine classified-EASY
fixtures are at ≥0.99. There is essentially no headroom for a second
segmentation path to win.

Every catastrophic result in the table sits in a class the classifier already
rejects. Those are **classification and source-contrast** outcomes, not
segmentation-quality outcomes — a better segmenter would not change any of
them, because the pipeline never asks it.

This also matches the real-corpus finding independently: the addressable
slice's failures were traced to a confidence-formula defect (P42-001), not to
mask quality.

Comparing on §32's own axes:

| | PATH A (deterministic) | PATH B (a local model) |
|---|---|---|
| quality on the addressable class | median IoU 1.000 | cannot exceed 1.000 |
| failure mode | fails closed, explainable | opaque; new failure surface |
| runtime | 2-20 ms/image | 10²-10³ ms/image typical CPU |
| memory | negligible | 10²-10³ MB typical |
| dependency burden | none | ONNX runtime + 40-180 MB weights |
| determinism | exact, byte-reproducible | implementation/thread dependent |
| downstream eligibility | unchanged | unchanged (no headroom) |

Adding a model would cost dependency weight, runtime, memory, and
determinism to buy quality that is already saturated.

### Honest limits of this conclusion

- **MEDIUM has n=1** in the classified grouping. That is thin, and it is
  stated rather than padded — fabricating more MEDIUM-classified fixtures by
  fishing for parameters that land in that class would be exactly the
  fixture-tuning §40 warns against.
- These are **synthetic** fixtures. Real imagery has no ground truth, so
  PATH A's real-corpus mask quality is `NO_REFERENCE` and this benchmark
  cannot speak to it.
- The conclusion is scoped to the **addressable class**. It says nothing
  about HARD, where a model plainly would be needed — and where §15/§53
  forbid going in this phase.

## 5. PATH B: built, governed, not installed

`localSegmentationModel.ts` exists so that *evaluating* a model and
*shipping* one are separate, auditable events. It is a loading point, not a
model.

§29 enforcement — a model is **refused**, not warned about, unless it
declares all of: exact model, version, code license, **weights license**
(routinely different from and more restrictive than the code license),
provenance URL, repository URL, weights sha256, runtime, and verified
commercial-use implications. A blank or missing license field is treated as
**UNVERIFIED**, never as permissive — §29 says explicitly not to claim
permissive licensing without verification. Weights are hashed at load and
refused on mismatch.

§30 enforcement is **structural, not promissory**:

- No download code exists in the module, so a runtime model download cannot
  occur.
- No network client exists in the module, so no third-party segmentation API
  can be called. `EXTERNAL SEGMENTATION CALLS: 0` is a property of the code.
- Installation requires an explicit operator action (an env-pointed manifest)
  — a checkout can never silently acquire a model.

Candidate families considered conceptually (U²-Net / rembg-class, BiRefNet,
RMBG): **no license, provenance, or checksum claim is made about any of
them.** None was downloaded, evaluated, or verified, so asserting anything
about their terms would be exactly the unverified claim §29 prohibits. The
governed loader is where such a claim would have to be substantiated.

## 6. Hybrid routing (§33)

Authorized but **not built**. A deterministic shot/source router already
exists in effect — `classifyExtractionGate` sends HARD away before extraction
— and adding a second segmentation path to route *to* would be routing to a
path that measurement says wins nothing. `fallbackInvoked` / `fallbackReason`
attribution (§34) is likewise unnecessary while there is exactly one path;
when a second is justified, the `SegmentationPath` interface and the
benchmark are already in place to evaluate and attribute it.

## 7. Regression protection

`phase42Diagnostics.test.ts` pins:

- median IoU ≥ 0.99 and zero segmentation failures on the addressable
  population, so if a future change erodes PATH A, this decision's basis
  fails loudly rather than silently;
- the loader reports "not installed" explicitly rather than skipping PATH B
  silently;
- an incomplete or missing model manifest is refused.
