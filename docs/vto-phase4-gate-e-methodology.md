# VTO Phase 4 — Gate E: Methodology

What this lane did, in the order it did it, and where it stopped.

## Order of operations

Gate E is deliberately sequenced so that cheap disqualifying checks run before
expensive harness construction (section 6: "Do not spend the lane building an
evaluation harness before answering these questions").

1. **Source authority** (section 4) — verify PR #301 against GitHub directly.
2. **Commerce access probe** (section 6) — can real product data actually be
   obtained here?
3. **Rights pre-flight** (section 7) — is there authority to evaluate it?
4. **Pipeline integrity attack** (section 10) — bounded hostile pass.
5. **Pipeline freeze** (section 11).
6. **Cohort freeze** (section 14) — *not reached*.
7. **Pass one automatic baseline** (section 22) — *not reached*.

Steps 1–5 completed. Steps 6–7 were stopped by two independent preconditions,
either of which alone is disqualifying.

## Step 1 — Source authority

`gh pr view 301` against the live repository. PR #301 is MERGED into
`integration/backend-kplus-complimentary-staging-v1`, merge commit
`265fe3624bb34fd951b4efe5979fa712a4fce2be`, which `git rev-parse` confirms is
the current head of that branch. Precondition satisfied; work proceeded on a
detached worktree at that exact commit.

## Step 2 — Commerce access probe

Method: inspect every commerce surface the repository exposes, then exercise
the least invasive one that could yield real products.

Surfaces inspected: `product-search-deals`, `search-vinted-secondhand`,
`nike-shoe-details`, `kickscrew-sneaker-description`, the Serper path inside
`scan-identify`, and the persisted tables `product_catalog`,
`user_commerce_watches`, `scan_commerce_events`.

`product-search-deals` was selected because it is the only path that is
simultaneously: deployed and ACTIVE, text-query driven (needs no image, so no
vision model is invoked), and free of any database access (grep-verified), so
exercising it cannot mutate staging.

10 queries stratified across section 16's visual characteristics; 99 distinct
products; each image fetched once, format signature and dimension header read,
bytes deleted. Bounded retries were not needed — zero fetch failures.

Full result: `docs/vto-phase4-gate-e-access-probe.md`.

## Step 3 — Rights pre-flight

Method: repository-wide sweep for any written authority governing display,
server-side fetching, automated processing, storage, or redistribution of
third-party commerce imagery — including root licence/terms files, legal and
privacy directories, provider-integration checklists, and code comments in the
commerce path.

Every retailer/commerce source classified **UNKNOWN**. Section 7 requires
UNKNOWN sources to be excluded and, with no CLEARED source, a precondition
hold. Full result: `docs/vto-phase4-gate-e-rights.md`.

## Step 4 — Pipeline integrity attack

Bounded hostile pass against the surfaces Gate E depends on, testing each
question section 10 lists. Executed directly against the compiled pipeline
rather than reasoned about from source.

| Section 10 question | Result |
|---|---|
| Can any incomplete result become `LIVE2D_ELIGIBLE`? | **YES — defect GATE-E-INT-001** |
| Can a missing confidence component accidentally pass? | **YES — same defect** |
| Can malformed confidence values pass? | **YES — same defect** |
| Can `NaN`/infinity/negative/string/null/undefined pass? | **YES for NaN, Infinity, numeric string, non-numeric string, out-of-range; NO for null and negative** |
| Can a rejected asset retain eligible state? | No — rejection takes precedence unconditionally |
| Can an eligible asset contain a rejection reason? | No — eligible returns `reason: null` |
| Does every terminal path terminate exactly once? | Yes for per-item paths; **but see GATE-E-INT-002** for the batch level |
| Can a product silently disappear from results? | **YES at batch level — defect GATE-E-INT-002** |
| Can multi-image processing produce duplicate assets? | No — same product+variant merges to one task |
| Can repeated evaluation break idempotency? | No — determinism covered by existing tests |
| Can stale-source detection be bypassed? | Not reachable — no remote fetch path exists in the pipeline |
| Can product/variant identity cross between products? | No — `assetId` derives from productRef + variantId + source hash + versions |
| Can unsupported categories earn eligibility? | No — category rejection precedes eligibility |

Both defects were found **before** freeze, so section 10's repair authority
applied. One was repaired, one deliberately deferred — see
`docs/vto-phase4-gate-e-freeze.md` and `docs/vto-phase4-gate-e-findings.md`.

## Step 5 — Pipeline freeze

Recorded in `docs/vto-phase4-gate-e-freeze.md`.

## Steps 6–7 — Not reached

No cohort was frozen and no baseline was run. Two independent preconditions
each block it:

- **Rights** — no source is CLEARED, so no real product may be evaluated.
- **Capability** — 100% of the imagery the authorized path returns is WebP,
  which the frozen pipeline cannot decode.

The rights hold binds first in sequence: section 7 gates processing before
section 22 runs. But the capability blocker is not merely downstream of it —
it would independently prevent a meaningful baseline even if rights were
cleared tomorrow. Both are reported because resolving only one leaves Gate E
still blocked.

## Anti-gaming statement (section 49)

Nothing was excluded after observing results, because no results were
observed. Specifically:

- No Hard products were removed after the fact — no cohort exists.
- No retailer was dropped after seeing its performance.
- No failures were removed from a denominator — no denominators were formed.
- No correction-required asset is counted as an automatic success.
- **Synthetic fixtures are not counted as real products.** The Phase 4 lane's
  existing 27-record synthetic + authorized-fixture evidence remains labelled
  as such, is not mixed into any real-product distribution, and is not
  presented as a Gate E result.
- No thresholds were tuned; the sample was not changed mid-run.
- Crashes are not classified as unsupported products.
- The universal decode failure is reported as a **capability/access-path
  limitation**, not as a catalog rejection rate — reporting it as "0% catalog
  success" would measure the CDN's image format, not the pipeline.
- No agent time is presented as human labour.

## Environment

```
EXECUTION HOST      local Windows 11 developer workstation
NODE                v24.14.0
GPU USED            no
WORKER CONCURRENCY  n/a — no batch was run
```

Compute economics were not calculated. No real SKU was processed, so there is
no per-SKU wall-clock to measure, and no authoritative cloud pricing basis
exists for this workstation.

```
COMPUTE COST / SKU: NOT CALCULATED — NO AUTHORITATIVE PRICING BASIS
```
