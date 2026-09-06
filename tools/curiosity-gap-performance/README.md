# Curiosity Gap Performance Lab (V1)

**BENCHMARK STATUS: INTERNAL ENGINEERING ANALYSIS ONLY. SIMULATED TTFAR IS NOT A MEASUREMENT OF REAL-WORLD K SCAN SPEED.**

Structural performance authority for the K Scan Scanner. Answers what controls
**TTFAR — Time To First Actionable Result** — using source proof, already-committed
evidence, and an explicitly-labelled model. It generates no traffic and spends nothing.

## Quickstart

```bash
# L0 contract: verify source bindings + artifacts. Exits non-zero on drift.
node tools/curiosity-gap-performance/runLab.js contract

# L1S structural model: both architectures, all bands, all sweeps.
node tools/curiosity-gap-performance/runLab.js model

# Real fixture geometry, read from JPEG headers (PROVEN).
node tools/curiosity-gap-performance/runLab.js fixtures

# The three lab-only experiments.
node tools/curiosity-gap-performance/runLab.js experiments

# Write an immutable baseline (refuses to overwrite).
node tools/curiosity-gap-performance/runLab.js baseline baseline-v2

# Compare two baselines (refuses incompatible ones).
node tools/curiosity-gap-performance/runLab.js compare \
  tools/curiosity-gap-performance/baseline/baseline-v1.json \
  tools/curiosity-gap-performance/baseline/baseline-v2.json

# Independent validator. Exits non-zero on failure.
node tools/curiosity-gap-performance/validateReport.js

# Tests (already discovered by the governed suite — see CI below).
node --test __tests__/curiosityGapPerformance/labGraph.test.js \
            __tests__/curiosityGapPerformance/labContract.test.js \
            __tests__/curiosityGapPerformance/labNetworkScenario.test.js
```

## Purpose

The Scanner can return excellent products and still fail the customer if nothing
useful appears quickly enough. Two questions differ:

- **Total completion** — how long does the whole workflow take?
- **Customer usefulness** — how long until the first result they can actually see
  *and act on*?

The second matters more, and in K Scan the two are genuinely different paths.
This lab computes both, separately, every time.

## TTFAR definition

**t=0** is `runAnalysis` (`hooks/useKScan.js:390`), the "Analyze Scan" press — not
the shutter. The shutter only calls `takePictureAsync` and returns a URI; the user
can still retake. Compression, digesting and upload all happen inside `runAnalysis`
and are therefore *on* the critical path. Choosing the shutter would fold an
unbounded human review pause into TTFAR.

**Actionable** means, per the shipped card, exactly two fields: `productUrl` (https,
passing `isSafeCommerceUrl`) and `title`. Not price, not retailer, not image — the
shipped purchase row renders no product image at all.

Full grounding: `authority/ttfar-definition.json`, `authority/actionable-result-schema.json`.

## Evidence classes

Every finding carries exactly one:

| Class | Meaning | Provenance |
|---|---|---|
| **PROVEN** | demonstrable from source at the bound SHA | required: `file:line` |
| **OBSERVED** | derived from evidence already committed before this lane started; no new traffic | required: exact locator |
| **MODELED** | a synthetic assumption the model consumes. **Not a measurement.** | required: rationale + a sweep |

`lib/evidence.js` combines pessimistically: any MODELED input makes the derived
value MODELED. That is the mechanism that stops assumptions being laundered into
measurements, and it is why a critical path with one modelled stage reports as
MODELED overall.

## Running the model

Two scenarios, because `BACKEND_COMMERCE_FUNNEL_V127_ENABLED` selects between two
structurally different architectures rather than tuning one:

- `scenarios/scan-funnel-on.json` — commerce deferred. Identification paints first;
  the first actionable commerce result costs a **second round trip**.
- `scenarios/scan-funnel-off.json` — commerce inline. TTFAR and completion
  **coincide**: nothing is actionable until everything is.

Each stage declares its dependencies, evidence class, timeout, retry policy and a
source locator. Concurrency is implicit in the DAG: siblings that share a dependency
and not each other run in parallel by construction.

## Scenario configuration

Add a stage with `{ id, deps, evidence_class, blocks_first_result, duration, source }`.
`duration.kind` is one of:

| kind | meaning |
|---|---|
| `zero` | a proven no-op (e.g. the passthrough sanitizer) |
| `fixed` | a PROVEN constant, e.g. a display floor |
| `param` | reads a declared parameter from the assumptions register |
| `upload` / `upload_small` / `download` | computed by the network model |
| `fanin` | a fan-out group; `sufficient_after_children` models early exit, `concurrent:false` models a serial fan-out |

A stage may declare `timeout_ms` (clamps and marks the outcome) and `retry`.

## Network sensitivity

Bandwidth and RTT are **always MODELED** and always swept — never a single assumed
condition. Payload bytes are exact arithmetic over a PROVEN transform. The reportable
output is a **threshold** ("below ~X Mbps, upload reaches Y% of the path"), never a
point estimate.

## Platform profiles

`platformProfiles/ios.json`, `platformProfiles/android.json`. Both are
**SOURCE-MAPPED, not DEVICE-MEASURED** — no device runtime was authorized. The
headline finding is that there are **zero `Platform.OS` branches** on the Scanner
client path, so the two platforms run identical JavaScript; the differences live in
the native encoders and are `PENDING_RUNTIME`.

## Source binding

`authority/source-bindings.json` holds a sha256 per bound production file plus one
`binding_hash` over the set. `contract` mode and the validator both treat drift as
**FAIL**, not a warning: a stale model that still runs green is worse than no model,
because it is trusted. A whole-file hash over-reports (a comment change trips it) —
that is the correct failure direction for an authority artifact.

## Baseline and compare

Baselines are **immutable**: `writeBaseline` refuses to overwrite. Comparison refuses
incompatible artifacts *before* comparing any number — comparing timings across
different TTFAR definitions produces a difference that means nothing. Compare reports
structural and modelled changes separately, always returns `quality_effect: UNKNOWN`,
and never declares production superiority.

## Progressive modelling

`EXP-3` may only run because §25 was answered first: the transport does **not**
support progressive delivery today, so its outputs are labelled
**SPECULATIVE ARCHITECTURE MODEL** and carry `REQUIRES_QUALITY_VALIDATION` and
`REQUIRES_UX_DECISION`.

## Limitations — read before quoting any number

1. **No live timing.** No provider was called, no device was run. Every client
   duration is `PENDING_RUNTIME`.
2. **`client_compress_ms` is the weakest assumption** and the one most worth
   measuring on a device. See the blocker ledger.
3. **Real post-compression bytes are unavailable.** No JPEG encoder is installed and
   §17 forbids adding one. Source geometry is PROVEN (read from real SOF markers);
   the quality-0.65 bytes-per-pixel coefficient is MODELED from the OBSERVED bpp
   range of the committed fixtures.
4. **The OBSERVED commerce outcome mix is stale.** The SCAN-006 weak-query repair
   landed between the measured SHA and this base, so more requests now reach
   providers than when the audit measured. The latency bands still apply; the mix
   does not.
5. **Production flag state is unknown.** Reading production secrets was out of
   envelope, so both architectures are modelled rather than one being asserted.
6. The model **cannot prove a parallelisation is correct.** A faster number here is
   a statement about structure, never about safety.

## Privacy

`lib/privacy.js` rejects user ids, emails, tokens, JWTs, signed URLs, image payloads,
transcripts and coordinates. **Unsafe input FAILS; it is never silently redacted** —
a silent redaction would let a pipeline keep shipping customer data into artifacts
committed to a public repository. The lab needs none of these inputs.

## Future runtime measurement

The event model (`trace_id`, `stage_id`, `parent_ids`, `start`, `duration`,
`result_available_at`, `blocks_first_result`, `evidence_class`, `source_binding`,
`platform_profile`, `provider`, `retry_count`, `timeout`, `outcome`) is shaped to
accept real observations later. When runtime data exists it enters as **OBSERVED**
and real percentiles become reportable. Until then, **simulator output must never be
labelled as a production percentile.**

`replay/` holds the interface only — see `replay/README.md`. Status:
**READY_NO_CORPUS**.

## CI

The tests live in `__tests__/curiosityGapPerformance/` and are therefore **already
discovered and executed** by the repo's own `node scripts/run-all-tests.js`, which
walks `__tests__` recursively. **No workflow file was added and no shared registry
was edited.** The intended standalone CI command, if a narrow job is ever wanted:

```bash
node tools/curiosity-gap-performance/runLab.js contract && \
node tools/curiosity-gap-performance/validateReport.js
```

Both are offline, need no secrets, deploy nothing and trigger no build.
