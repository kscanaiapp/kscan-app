# Scanner Phase 7 — Forward-Port Discovery

Forward-ported 2026-08-12 onto the Build 29 integration candidate
`dc9e2f02293f2125b431ef883edb29a602420553`, on branch
`integration/build29-scanner-phase7-forward-port`.

## Why forward-port rather than merge

The legacy branches diverge from the Build 29 lineage at `e394261`
(**2026-07-16**) by ~760 files. Merging them would have restored the superseded
sequential-multiselect scanner architecture along with the Phase 7 intelligence.

The port turned out to be tractable for a reason worth recording: **Phase 7 is
almost entirely backend.** Every substantive change lives in
`supabase/functions/scan-identify/`, while the architecture that makes the legacy
branches unmergeable is a *client* concern. Every Phase 7 module depends only on
modules Build 29 already has:

| Phase 7 module needs | Present in Build 29 |
| --- | --- |
| `categorySubtypeConflict` (`scannerQualityGate.ts`) | yes — private; Phase 7.1 only adds `export` |
| `isGenericFashionLabel` (`qualityTuneNormalize.ts`) | yes |
| `normalizeCategory` (`_shared/scanHelpers.ts`) | yes |
| `assertQualityMetricsPrivacy` (`qualityTuneTelemetry.ts`) | yes |

No Phase 7 module imports a legacy-only file.

## Source

| Phase | Commit | Title |
| --- | --- | --- |
| 7.1 | `4625645` | confidence-gated identification recheck |
| 7.2 | `4dc0751` | fashion + brand visual evidence, single-pass |
| 7.0 prep | `6aaeaba`…`718352c` | `clothing_type` middle taxonomy tier |

`scanner/phase7-fashion-brand-evidence` @ `4dc0751` contains `4625645`, so it is
the superset and the authoritative reference.

## Classification

### PORT_REQUIRED — ported

| Item | Notes |
| --- | --- |
| `identificationRecheckGate.ts` | Deterministic, pure, provider-free CLEAR / REVIEW_REQUIRED gate. |
| `identificationRecheck.ts` | The single bounded second look. |
| `identificationRecheckReconcile.ts` | Per-tier deterministic reconciliation. |
| `identificationRecheckConfig.ts` | Thresholds carried **verbatim**, not reinvented. |
| `identificationRecheckTelemetry.ts` | Measurement contract. |
| `brandEvidence.ts` | Phase 7.2 brand evidence tier gate. |
| `fashionDiscriminatorPacks.ts` | One compact pack per level-1 family. |
| `clothing_type` taxonomy tier | **Prerequisite, not optional** — the gate reasons over the taxonomy triple, so without it the brand-evidence suite fails on a two-tier identity. |
| `scannerQualityGate.ts` export | Export-only. The predicate already existed and is reused rather than copied, so the gate and the recheck cannot drift on what a coherent identity is. |
| `scripts/identification-recheck-accuracy.js`, `scripts/scanner-prompt-budget.js` | Evaluation and cost tooling. |

### ALREADY_PRESENT

`hasBrandEvidenceForCommerce` — the brand-evidence commerce gate was already in
Build 29's `scan-identify` and was **not** duplicated. Phase 7.2's
`brandEvidence.ts` is a different thing: it decides the *evidence tier* of a
brand claim before any projection, where the existing gate decides whether a
brand is good enough to drive commerce.

### LEGACY_ARCHITECTURE_ONLY — deliberately not ported

| Item | Why |
| --- | --- |
| `multiItemSelectionContract.ts` | Sequential-multiselect selection contract. |
| `productMatchBridge.ts`, `supabase/functions/product-match/*`, `contracts/product-match-v1.schema.json` | Legacy product-match function, absent from this lineage. |
| `existingItemCandidates.ts`, `scanJourneyContract.ts`, `phase7PipelineSurvivability.test.ts` | Legacy scan-journey architecture. |
| "Checkpoint 3: selection contract + product-match bridge" block in the legacy `index.ts` | Dropped at conflict resolution. |
| `inspect:similarity` npm script | `scripts/similarity-inspector.js` does not exist on this lineage. |

Verified absent from the ported wiring: `index.ts` references none of these
symbols.

## Behaviour matrix

| Feature | Legacy | Build 29 before | Final | Port method |
| --- | --- | --- | --- | --- |
| Identification recheck | Confidence-gated, one call | none | identical, on the parallel-multiimage pipeline | modules copied, `index.ts` wiring hand-integrated |
| Recheck trigger | 5 SUFFICIENT + 2 CORROBORATING reason codes | — | unchanged | verbatim |
| Thresholds | 0.55 / 0.7 / 0.8 | — | unchanged | verbatim — **not reinvented** |
| Brand evidence tier | `brandEvidence.ts` | commerce gate only | both, distinct roles | module copied |
| `clothing_type` tier | present | absent | present | per-file 3-way port, legacy files skipped |
| Discriminator packs | one per level-1 family, recheck only | — | unchanged | verbatim |
| Prompt cost | 13740 → 11680 chars | 13740 | **11677 measured** | prompt rewrite ported; pinned by `scannerPromptBudget.test.js` |
| Multi-image model | sequential-multiselect | parallel-multiimage | **parallel-multiimage preserved** | not touched |

## Final recheck design

- **Ships dark.** `SCAN_IDENTIFICATION_RECHECK_ENABLED` defaults **false**. With
  the flag off the scanner is byte-identical to the frozen Build 29 candidate,
  *including log output* — the telemetry line is emitted only when the flag is on.
- **Bounded by construction.** One call site, no loop, no retry, no model
  escalation, no recursion. `RECHECK_MAX_PROVIDER_CALLS = 1`;
  `identificationProviderCalls` is hard-set to 2 (primary + recheck).
- **Timeout 6 s** default (1.5–12 s bounds), deliberately tighter than the primary
  call because it sits in front of the user's result.
- **Fails open.** A failed, timed-out, truncated or malformed recheck leaves the
  primary identification exactly as it was.
- **Eligible modes only**: `legacy_single_item`, `selected_item`. Detection
  resolves no single garment; text mode has no image to look at again.

## Privacy

The recheck is handed the **same in-memory `imageBase64`** the primary pass used.
It performs no `fetch`, no `createClient`, no storage read and no signed-URL
resolution — asserted structurally in
`phase7Build29Integration.test.ts`. There is therefore no path by which it could
obtain an original, unmasked image: it never obtains an image from anywhere.

Measurement is content-blind by the same `assertQualityMetricsPrivacy` walker the
existing quality-tune telemetry uses, so there is one scrubber rather than two
that could drift. Provider prose, emails and image bytes are proven not to reach
the metrics; a malformed answer becomes the bounded code `malformed_output`,
never a transcript.

## Duplicate-scan and observability

The recheck runs entirely in memory between the intelligence gate and
`completedResponse`, with **zero persistence calls in that region**. It is part
of the same logical scan transaction: no second scan record, no second Closet
save, no second commerce event, and one telemetry line per scan rather than two.

`scan-identify` remains wrapped by `observeEdgeRequest`, so a recheck is
diagnosable under the same `X-KScan-Request-ID` and `traceparent` as the scan
that triggered it.

## Measurement outputs

`identificationRecheckTelemetry.ts` emits one structured line per eligible scan —
including scans that did **not** escalate, because a gate is only measurable
against its own denominator. Fields cover gate decision and reason codes,
per-tier identity movement and outcomes, discriminator pack usage, recheck status
and bounded failure reason, per-stage latency, and full provider token
accounting. `scripts/identification-recheck-accuracy.js` computes agreement and
correction rates from paired fixture results; it requires a results file and
fabricates nothing.
