# VTO Phase 4 — Gate E: Findings

Section 47. Findings only — none of the improvement opportunities below were
repaired inside a certification dataset, because no certification dataset was
produced.

## P0–P3

### GATE-E-INT-001 — Eligibility gate fails OPEN on malformed confidence — P2 — REPAIRED PRE-FREEZE

**Location** `vto-phase4-pipeline/src/eligibility.ts`

**Root cause** `overallConfidence` combined the six component scores with
`Math.min`, and `resolveEligibility` then tested `confidence < THRESHOLD`.
`Math.min` returns `NaN` if any argument is `NaN` or non-numeric, and
`NaN < 0.5` evaluates to `false` — so the threshold test *passed* and the
function returned `live2d: true`. The gate failed open: an asset whose
confidence could not be computed at all was declared LIVE2D_ELIGIBLE.

`clamp01` did not protect against this — `Math.max(0, Math.min(1, NaN))` is
`NaN`, so the helper propagates the poison rather than clamping it.

**Evidence** Executed against the compiled pipeline. 8 of 11 malformed inputs
produced `live2d: true`:

| Input | Computed confidence | Result |
|---|---|---|
| `NaN` component | `NaN` | **ELIGIBLE** |
| `undefined` component | `NaN` | **ELIGIBLE** |
| component key absent | `NaN` | **ELIGIBLE** |
| non-numeric string `'abc'` | `NaN` | **ELIGIBLE** |
| numeric string `'0.9'` | `0.9` | **ELIGIBLE** (silent coercion) |
| all `+Infinity` | `Infinity` | **ELIGIBLE** |
| all `1.5` (out of range) | `1.5` | **ELIGIBLE** |
| `{}` — no components at all | `NaN` | **ELIGIBLE** |
| `null` component | `0` | correctly rejected |
| `-1` component | `-1` | correctly rejected |

**Reachability** Not currently reachable through normal operation. The six
components are constructed defensively in `pipeline.ts`:
`requiredAnchorAverage` divides by a fixed-length array of 4 rather than a
variable count, so there is no 0/0; image dimensions are validated before
`sourceQuality` is computed; `productFidelity` is a boolean 1/0. This is why
it is graded **P2 (latent)** rather than P0/P1, and why it did **not**
invalidate any baseline or trigger section 46.

Grading it low would still be wrong. This is the single gate that decides
whether a garment is fit to put on a customer, section 10 names these exact
inputs as must-test, and the failure direction is *open* — a future stage that
introduces a division by a variable count inherits a silent
wrong-asset-approved bug rather than a crash.

**Repair** The component list is now iterated by explicit key, and any value
that is not a finite number in `[0,1]` scores 0 — fail closed. Absent keys are
examined rather than skipped.

**Proof the repair changed nothing else** Pre-existing suite 58/58 before,
59/59 after with the new regression test. The full 27-record synthetic +
authorized-fixture corpus was re-run: all 27 per-item outcomes identical
(shot class, eligibility, rejection reason), headline rates unchanged at
33.3%/66.7%. For six finite in-range values the new implementation returns
exactly the previous `Math.min`.

---

### GATE-E-INT-002 — No per-item error isolation, no SYSTEM_ERROR state — P2 — OPEN, DEFERRED

**Location** `vto-phase4-pipeline/src/batch.ts`

**Root cause** Two coupled gaps.

1. `runWithConcurrency` awaits each task inside workers gathered by
   `Promise.all`. A single task that throws rejects the whole gather, so
   `runBatch` throws and returns **nothing** — results already computed for
   healthy products are discarded with it. Demonstrated: 4 tasks, 1 throwing,
   0 records produced for the 3 healthy products.
2. `BatchItemResult` has no `SYSTEM_ERROR` terminal state. Grepped: the token
   appears nowhere in `src/` or `__tests__/`. Every record must end
   eligible or rejected; there is no third outcome.

**Why it matters for Gate E specifically** Section 22 requires that every
cohort record terminate as `LIVE2D_ELIGIBLE`, `REJECTED:<reason>`, or
`SYSTEM_ERROR:<reason>`, with "No missing products. No silent drops." Section
23 requires system errors and catalog rejections to be reported separately,
and section 45 treats system errors as engineering defects rather than
economics. The current runner can satisfy none of that: on a 150–300 product
real run, one malformed image would abort the entire baseline and yield zero
evidence, and there is no vocabulary to record it correctly if it did not.

**Not repaired here, deliberately.** The fix adds a terminal state to the
result contract and changes the batch's failure semantics. Section 10 says not
to redesign the system during the integrity pass; this is Phase 4.1 design
work, not a certification repair.

**Proposed repair** Wrap each task so a thrown error is captured into a
`systemError: { code, message, stage }` field on `BatchItemResult` and the
batch continues; add `SYSTEM_ERROR` as an explicit terminal state alongside
eligible/rejected; report the three classes separately in the economics
report.

## P4–P10 (documented only)

- **P5 — `clamp01` is duplicated three times** (`pipeline.ts`,
  `anchors.ts`, `shotClassifier.ts`) with identical NaN-propagating bodies.
  A single shared, NaN-safe helper would remove the class of bug behind
  GATE-E-INT-001 rather than just its instance at the gate.
- **P6 — `docs/vto-phase4-corpus-discovery.md` cites `src/sourceFetch.ts`**,
  which does not exist in `vto-phase4-pipeline/src/`. The documented
  remote-fetch path with its SSRF-guard parity was never written. Harmless
  today (nothing fetches), but it means a future lane may believe safe remote
  fetching already exists when it does not.

## Economic bottlenecks

Not measurable. No real product was processed, so no bottleneck can be ranked
by observed frequency or cost. Reporting a ranked list here would be invention.

The one thing the access probe *does* establish economically is negative and
worth stating: **corpus breadth is not the constraint.** Stratified queries
returned real products across every visual characteristic Gate E asks for.
Supply is not the problem.

## Corpus limitations

The only imagery obtainable through authorized paths is Google Shopping
**thumbnails** (576×659-class, WebP), not retailer-hosted originals. Even with
a decoder, a thumbnail-derived garment asset is a different and probably worse
input than a retailer's own product photography. Any future Gate E should
establish whether higher-fidelity originals are obtainable before treating
thumbnail results as representative of achievable quality.

## Rights limitations

Covered in full in `docs/vto-phase4-gate-e-rights.md`. In short: no source is
CLEARED, the app's terms and privacy documents live outside the repository,
and the provider-integration checklist has no legal gate at all. This is the
binding constraint on the whole lane and it is not an engineering problem.

## Recommended next lane

**Phase 4.1**, sequenced so the cheap disqualifier runs first:

1. **RIGHTS / ACCESS RESOLUTION** (owner decision, blocking everything else).
   Establish at least one CLEARED source with recorded authority covering
   fetch, automated processing, derivative assets, and retention.
2. **PHASE 4.1 PIPELINE REPAIR** — add WebP decode (and probably AVIF, since
   the same CDNs serve it), and close GATE-E-INT-002 so a real run cannot be
   aborted by one bad product.
3. **CORPUS EXPANSION** — only once 1 and 2 are done, freeze a real cohort and
   run the baseline the frozen pipeline was built to measure.

Steps 2 and 3 are wasted effort until step 1 lands.
