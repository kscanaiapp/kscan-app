# Build 4 Phase 1 — Certified baseline readiness, blockers, and execution-path repairs

**Verdict: BUILD 4 PHASE 1 BLOCKED — REVIEW AND CREDENTIAL GATES REMAIN**

Updated 2026-07-29 after the owner's F-1 decision. The capture-preparation gate is
now **CLOSED**; the review and credential gates remain open.

No provider call was made. Actual spend: **$0.00**. No baseline accuracy figure is
reported below, because none was measured and none may be inferred.

Two independent owner gates are unmet. A third defect (F-1) would have invalidated
the measurement even if they had been met; it has now been resolved under owner
authorization and is closed.

---

## 1. Starting state — independently verified

| Item | Expected | Observed | Result |
|---|---|---|---|
| Research branch | `research/scanner-accuracy-v2-evals` | same | PASS |
| Research SHA | `4c398e4fb7ae9b34caa7971859f22aa70c63703f` | same | PASS |
| Upstream parity | `0/0` | `0 0` | PASS |
| Tracked + untracked clean | clean | clean at entry | PASS |
| Foundation tests | 139/139 | 139/139 | PASS |
| Tracking guard | green | 0 untracked, hazard reported | PASS |
| Dataset version | `0.3.0` | `0.3.0` | PASS |
| Classification | LICENSED-WEB-IMAGE PILOT BENCHMARK | same | PASS |
| Cases / images | 41 / 56 | 41 / 56 | PASS |
| Split | 33 dev / 8 holdout | 33 / 8, disjoint, none unassigned | PASS |
| Aggregate SHA-256 | `ddc939dca91d202c3d0ee306b9421e1d71f1348c1fb8f035097ae91d2972c3db` | reproduced | PASS |
| Governed image hashes | 56/56 | 56/56 | PASS |
| Images in Git | 0 | 0 | PASS |
| Certified adapter source | `f5f4ed2eda4984db0658c3209fece223acd33188` | same, detached, clean | PASS |
| Certified bundle SHA-256 | `28737e0c96047fa014c526886b32b3e5191283a9ed7441641da4d3b0ce632589` | reproduced | PASS |
| Certified closure | 39/39 files, 0 mismatches | 39 tree / 31 bundle, 0 mismatches | PASS |
| Containment: master | `08f0d0ef5aa387eac20945b64e161feaab6c04aa` | same | PASS |
| Containment: iOS | `70c5b7c68872110b522458a9fddf405c3cf82bab` | same | PASS |
| Containment: Android | `37b7141431f8b33029918ce15d28d2ba422eae38` | recorded; `cert/android-phase-2b4-cross-path-v2` = `b9b0926` | PASS (read-only) |
| Review state | all 41 `draft` | all 41 `draft` | as expected — **blocking** |

`KSCAN_EVAL_STORAGE_ROOT` must point at `KScan-eval-storage-private/tier-a`, not
its parent. Pointed one level high, the resolver reports all 56 images missing;
pointed correctly, all 56 hashes verify. The resolver fails closed either way, so
an in-repo file cannot masquerade as governed data.

Build 3 was read only. Neither Build 3 worktree was modified.

---

## 2. Certified execution route — derived, not assumed

Read from the certified v140 source, not from the adapter's defaults (the two were
then confirmed to agree).

| Property | Value | Source |
|---|---|---|
| Provider | Google Gemini | `scan-identify/index.ts` |
| Endpoint | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `GEMINI_API_BASE` |
| Credential transport | `?key=` query parameter from `GEMINI_API_KEY` | `buildGeminiUrl` |
| Primary model | `gemini-3.6-flash` | `llmModelRouting.ts::SCANNER_PRIMARY_MODEL` |
| Fallback model | `gemini-3.5-flash-lite` | `llmModelRouting.ts::SCANNER_FALLBACK_MODEL` |
| Max attempts per call | 2 | `SCANNER_MAX_ATTEMPTS` |
| Model allowlist | exactly those two; env vars cannot widen it | `APPROVED_MODELS` |
| Request shape | `contents[0].parts = [ {text: prompt}, {inline_data: {mime_type, data}} ]` | image mode |
| Images per request | **one** | single `imageBase64` field |
| `generationConfig` | `temperature` 0 or 0.2, `maxOutputTokens` 2048, `responseMimeType: application/json` | — |
| Timeout | 14 000 ms default | `DEFAULT_GEMINI_TIMEOUT_MS` |
| Baseline intent | `identify_for_style` | adapter; commerce skipped by production's own gate |

Because the certified path accepts one image per request, a multi-image case costs
N provider calls and must still be scored as **one** case.

**Note for a future phase, not acted on here:** the credential travels as a URL
query parameter. That is the certified production design and was not changed, but
any evaluation logging must never record a request URL.

---

## 3. Call plan and verified cost

Pricing was re-retrieved immediately before the readiness gate rather than carried
forward from Phase 0.

- **Source:** `https://ai.google.dev/gemini-api/docs/pricing` (official, paid tier)
- **Retrieved:** 2026-07-29
- **Record:** `evals/scanner-accuracy/pricing/gemini-pricing.2026-07-29.json`

| Model | Input / 1M | Output / 1M |
|---|---|---|
| `gemini-3.6-flash` | $1.50 | $7.50 |
| `gemini-3.5-flash-lite` | $0.30 | $2.50 |

Call plan, one call per image:

| Split | Cases | Provider calls | Max attempts (×2) |
|---|---|---|---|
| Development | 33 | 47 | 94 |
| Holdout | 8 | 9 | 18 |
| **Total** | **41** | **56** | **112** |

112 maximum attempts is within the 200-call ceiling.

Worst-case cost, using 1 032 image tokens + a generous 1 500 text tokens in, and
the certified 2 048-token output cap:

| Scenario | Cost |
|---|---|
| Expected (all primary succeed, ~600 output tokens) | **≈ $0.47** |
| Worst case (every call exhausts both attempts, max output) | **≈ $1.40** |
| Hard bound at the 200-attempt ceiling | **≈ $3.83** |

All are under the $10.00 authorization. **Cost is not the binding constraint.**

Image token counts are **estimated**. A free `countTokens` pre-flight must replace
the estimate before any paid run.

---

## 4. Blocker 1 — dataset review incomplete

All 41 cases carry `reviewStatus: draft`. `labels/reviewer-assignment.json` reads
`status: UNSTAFFED` with primary, secondary and adjudicator all `assigned: false`.
`phase0e-owner-decisions.md` §3 is unchecked.

The runner enforces this rather than trusting it. A development dry run refuses
all 33 development cases on `review_status`, with zero calls and $0.00.

The holdout requirement is the harder half and cannot be satisfied by this agent:

- §5 requires **two independent, blind reviews** of all 8 holdout cases.
- Clarification 2 forbids an agent that materially participated in curation from
  self-designating as an independent holdout reviewer without explicit owner
  authorization. This agent produced the Phase 0H curation records
  (`decidedBy: "build-lead visual review"`), so it is the curator.
- One person may not hold both reviewer roles under any option.

There is therefore no path to a valid holdout ground truth without owner action.
No label was changed, and no review status was overridden.

`PHASE 1 BLOCKED — DATASET REVIEW INCOMPLETE`

---

## 5. Blocker 2 — execution credential and spend authorization missing

`phase0e-owner-decisions.md` §4 has all five items unchecked: dedicated
evaluation credential, call ceiling, dollar ceiling, expiry, revocation owner.
No evaluation credential exists in the environment, and none is configured in the
research worktree.

Production credentials exist elsewhere in the project and were **not** used, read,
or copied. §15 forbids them and §6 requires a dedicated evaluation-only credential
with a named revocation owner and a maximum 30-day lifetime.

`PHASE 1 BLOCKED — EXECUTION CREDENTIAL OR SPEND AUTHORIZATION MISSING`

---

## 6. Finding F-1 — the harness would not have measured the production Scanner

This is the most consequential Phase 1 finding, and it is independent of both
owner gates. Had the review and credential gates been open, the run would have
completed and produced a number that was wrong in **both** directions.

The production client does not upload camera originals. `services/imageUtils.js`
resizes to `SCANNER_IMAGE_MAX_WIDTH = 896` px and re-encodes JPEG at
`SCANNER_IMAGE_JPEG_QUALITY = 0.65`, typically 120–320 KB. The Edge Function then
rejects anything above `MAX_IMAGE_BASE64_BYTES = 2 MB` of base64 **before** calling
the provider, returning `status: 'failed'`.

The frozen corpus holds full-resolution Wikimedia originals, and the harness had
no preparation stage at all. Measured against the certified ceiling:

| Measure | Value |
|---|---|
| Governed images | 56 |
| Images **over** the certified 2 MB base64 ceiling | **25 (45%)** |
| — of which development | 21 |
| — of which holdout | 4 |
| Cases with ≥1 oversized image | **17 of 41 (41%)** |
| Largest payload | 13.56 MB base64 |

Two distinct errors, neither visible in the result payload:

1. **Over the ceiling — under-reports accuracy.** 17 of 41 cases return `failed`
   from the size guard having made **zero** provider calls. Scored naively that is
   indistinguishable from a model failure, so a transport rejection is attributed
   to the Scanner.
2. **Under the ceiling but unprepared — over-reports accuracy.** The remaining 31
   images would be sent at full resolution, giving the model more detail and fewer
   compression artefacts than production ever supplies.

Per Clarification 6 this is exactly the case to be distinguished before blocking on
low accuracy: it is **infrastructure failure, not Scanner performance**.

### Resolution — owner-authorized route (a), implemented

The owner authorized a Node JPEG codec and a **governed runtime preparation
stage**, with the ruling that *the dataset is the source corpus and preparation
belongs to the execution pipeline*. No dataset patch version was created.

Implemented in `lib/imagePreparation.js` and `prepare-derivatives.js`:

| Requirement | Implementation |
|---|---|
| Codec | `sharp` 0.35.3 / libvips 8.18.3, **devDependency**, not imported by app code |
| Resize | 896 px, policy `certified_client_width_896` (default) |
| JPEG quality | 0.65 client scale → 65 encoder scale, 4:2:0, non-progressive |
| Orientation | EXIF baked into pixels then stripped — no viewer-dependent rotation can change what the model sees |
| Derivatives | exactly one per source image, content-addressed by source hash |
| Storage | outside every Git worktree, enforced by walking up for `.git` |
| Provenance | source hash, derivative hash, source and derivative dimensions, full transform parameters, codec versions — per image, in `preparation-manifest.json` |
| Frozen originals | opened read-only; freeze re-verifies at 56/56 with the aggregate unchanged |

**Result: 56/56 images now fit the certified ceiling. 0 over.**

| Measure | Before | After |
|---|---|---|
| Images over the 2 MB ceiling | 25 of 56 | **0 of 56** |
| Cases with ≥1 oversized image | 17 of 41 | **0 of 41** |
| Largest payload (base64) | 13.56 MB | **299 KB** |
| Mean payload (base64) | — | 94 KB |

**All prepared payloads remain below the certified ceiling and overlap the
documented production payload range.** The prepared range is 25 KB–299 KB with a
94 KB mean; the certified client documents a typical output of 120–320 KB. These
overlap, they are not the same band — a substantial share of prepared payloads sit
below 120 KB. **No complete band parity is claimed.** 5 sources are narrower than
896 px and are upscaled, because `resize: { width: 896 }` upscales and the point is
to send what production sends.

### Two divergences, stated rather than smoothed over

1. **`maximum dimension: 896` vs what production does.** The certified client pins
   **width** to 896 and lets height scale, so a 3:4 portrait is 896×1195 in
   production — its long edge exceeds 896. A literal max-dimension cap would send
   672×896, which is smaller than production. Both policies are implemented;
   the default is `certified_client_width_896`, the exact production mirror.
   `max_dimension_896` is available and recorded in the manifest when used. 16 of
   56 images are portrait, so the distinction is not academic.
2. **No byte-level parity.** libvips is not `expo-image-manipulator`. Pixel
   dimensions, chroma subsampling and quality band match; entropy-coded bytes do
   not, and no parity is asserted anywhere. Byte determinism holds for a fixed
   codec version and is **not** guaranteed across libvips upgrades, so the codec
   versions are recorded in every preparation record and in the run identity.

The preparation manifest hash is part of the run identity, so a resume across a
changed preparation is refused: different bytes reached the provider, and the two
halves are not comparable.

**F-1 gate status: CLOSED.** A dry run of the development split now reports
`review_status` as the only blocking finding; the payload-ceiling findings are
gone.

---

## 7. Findings

| ID | Severity | Surface | Evidence | Baseline impact | Action | Status |
|---|---|---|---|---|---|---|
| F-1 | P0 | `run-baseline.js` preflight; frozen corpus vs certified payload contract | 25/56 images over the 2 MB base64 ceiling; 17/41 cases affected; certified guard returns `failed` before any provider call | Would invalidate the baseline in both directions: 41% of cases scored as Scanner failures without reaching the model, and the rest measured on inputs production never sends | Owner-authorized governed runtime preparation stage: `sharp` devDependency, `lib/imagePreparation.js`, `prepare-derivatives.js`. 56/56 now fit; largest payload 299 KB. Frozen v0.3.0 unchanged, no patch version | FIXED |
| F-2 | P0 | `run-baseline.js`, `lib/runnerState.js` | Runner enforced `--max-calls` only; no cost model, no dollar ceiling, no per-attempt projection. `costUsd: '0.00'` was a hardcoded literal | A call ceiling does not bound spend; the $10.00 authorization was unenforceable | Added `lib/costLedger.js` with verified-pricing validation, pre-attempt projection, cumulative tracking, and `--max-usd` | FIXED |
| F-3 | P0 | `run-baseline.js` | Runner never imported `datasetSplit`; `selectCases` had no split awareness. A dry run selected all 41 cases including all 8 holdout | Would execute and score the holdout alongside development, destroying the only unbiased check | Added `--split` (required for `--execute`), split partitioning, and a holdout-seal gate in `lib/runIdentity.js` | FIXED |
| F-4 | P1 | `run-baseline.js`, `lib/runnerState.js` | No run identifier existed. Resume compared `datasetVersion` only — the field least likely to differ | A resume could graft results from a different adapter, ceiling, split or preparation mode into one report that looked complete | Added `buildRunId` and 10-field resume identity matching | FIXED |
| F-5 | P1 | `run-baseline.js` | `budget.consume(plan.plannedCallCount)` ran once per case **before** the executor; retries and fallbacks were uncounted; `executedCallCount` reported planned calls | The certified 2-attempt route can double real provider usage invisibly; required separate counts were unproducible | Added `lib/providerAccounting.js`; ceiling now gates provider **attempts** pre-attempt, with separate counters | FIXED |
| F-6 | P2 | `run-baseline.js` | One run-level `stamp` was written as `completedAt` on every case; no latency captured | §13 latency distribution was unreportable | Per-case start/complete/latency plus a p50/p95 distribution | FIXED |
| F-7 | P3 | `__tests__/phase0dAdapter.test.js` | A negative assertion depended on ambient `KSCAN_CERT_V140_ROOT` being unset, so the suite failed when invoked with the cert root set | Prevented running the complete battery in one command | Env cleared for that assertion only | FIXED |

Nothing in the certified adapter or production Scanner was modified.

---

## 8. Results

**None.** Development and holdout aggregates are both empty because no case was
executed. Reporting any accuracy, brand, abstention, consistency or latency figure
here would be fabrication.

Required suppressions, which hold regardless:

- `exactProductPrecision = not_measured`
- `incorrectExactMatchRate = not_measured`
- MC-1 stands: `exactProduct` is hardcoded `null` at the certified source, so
  exact-product performance is structurally unmeasurable.
- `confidence.subtype/modelFamily/exactProduct` are null and are reported as
  unavailable, never as zero.
- `conflicts` is always `[]`; conflict detection must not be described as
  comprehensive.

---

## 9. Phase 2 prioritisation

**Deferred.** Phase 2 priorities were to be derived from observed failure
clusters. With zero executed cases there are no observed failures, and a ranked
list built from expectation rather than evidence would be exactly the
self-confirming artefact the holdout exists to prevent.

The one evidence-backed item is F-1's unresolved half: production-equivalent
capture preparation. It is a **Phase 1 prerequisite**, not a Phase 2 improvement.

---

## 10. Limitations

Every statement above is subject to these, and they must be carried into any later
report:

- This is a **licensed-web-image pilot**, not a smart-glasses benchmark.
- The corpus is **41 cases / 56 images**; the holdout is **8 cases**.
- Positive-brand findings would be **exploratory**: 13 cases rest on 8 distinct
  objects and 5 brands, and 6 of the 13 are views of two Vignon dresses. No
  brand-accuracy rate may be computed from this corpus.
- **Exact product is not measured** (MC-1).
- Real-world glasses capture conditions remain **untested**.
- Results apply only to the certified baseline and frozen dataset **v0.3.0**.
- Ground-truth confidence is currently **undetermined**: no reviewer is staffed,
  so neither inter-reviewer agreement nor intra-rater consistency exists.
- Image token counts are **estimated**; a `countTokens` pre-flight is required.
- Prepared payloads reproduce the certified client's pixel dimensions, chroma
  subsampling and quality band, **not** its exact bytes. libvips is not
  `expo-image-manipulator` and no byte-level parity is claimed.
- Byte determinism of preparation holds for a fixed codec version only. The
  recorded versions are `sharp` 0.35.3 / libvips 8.18.3.

---

## 11. What the owner must decide to unblock

| # | Decision | Blocks |
|---|---|---|
| 1 | Assign a qualified reviewer for the 33 development cases | development execution |
| 2 | Assign **two independent** holdout reviewers plus an adjudicator; this agent is the curator and may not self-designate | holdout execution |
| 3 | Provide a dedicated evaluation-only Gemini credential with expiry ≤ 30 days and a named revocation owner | all paid execution |
| 4 | Confirm the 200-attempt and $10.00 ceilings | all paid execution |
| ~~5~~ | ~~Choose the F-1 route~~ — **RESOLVED**: route (a), governed runtime preparation stage, implemented and verified | ~~any valid measurement~~ |

Items 1-4 were already open at Phase 0 close and remain the only blockers. Item 5
was raised and resolved within Phase 1.

---

## 12. Boundary proof

No dataset expansion. No image added or removed — prepared derivatives are pipeline
output stored outside every Git worktree, not corpus members, and the source corpus
is opened read-only. No frozen label changed — and no
model output was ever observed, so the "changed after seeing results" risk did not
arise. The 33/8 split is unchanged. Dataset version `0.3.0` was not modified in
place and **no patch version was created to resize images**; the aggregate hash
reproduces and all 56 image hashes verify after all repairs and after preparing
every derivative. Draft review was not bypassed. No holdout label was exposed. No certified
adapter source change. No production Scanner, prompt, model, routing or threshold
change. No deployment, no EAS build, no store submission. No production credential
and no production endpoint contacted. No Build 3 change. No version or build-number
change. No migration. No force push. No `git add .` — every path was staged
explicitly with `git add -f` because `.git/info/exclude` hides `tools/`. No Phase 2
implementation.
