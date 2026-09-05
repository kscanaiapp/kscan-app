# VTO Phase 4.2 — Source Authority

Phase 4.2 §3/§4. Every value here was verified against `origin`
(github.com/kscanaiapp/kscan-app) at session start. Nothing was trusted from
memory, including values that turned out to be correct.

## 1. Verified authority

| Item | Verified value |
|---|---|
| Integration authority branch | `integration/backend-kplus-complimentary-staging-v1` |
| Integration SHA at Phase 4.2 start | `4365cebfccfd59843dd3f0a7418c07cb8e9ff843` |
| PR #302 state | **MERGED** 2026-09-05T17:32:30Z |
| PR #302 merge SHA | `4365cebfccfd59843dd3f0a7418c07cb8e9ff843` |
| PR #302 head (pre-merge) | `449033694f46e3cda58bf2a6343b5e74ee84b858` |
| PR #301 (Phase 4 foundation) | MERGED, merge commit `265fe3624bb34fd951b4efe5979fa712a4fce2be` |
| Phase 4.2 branch | `feature/vto-phase4-2-catalog-addressability` |
| Phase 4.2 PR | [#303](https://github.com/kscanaiapp/kscan-app/pull/303) (draft) |
| Contract version | `KSGARMENT_SCHEMA_VERSION` (garmentContract.ts) |
| Pipeline version | `PIPELINE_VERSION = 0.1.0` (manifestBuilder.ts) |

## 2. The precondition, and how it was cleared

§4 required Phase 4.2 to start from integration **containing** the approved
Phase 4.1 repairs, and forbade merging #302 autonomously.

At session start that precondition was **NOT met**, and the lane declared
`PHASE 4.2 PRECONDITION HOLD`. It was not a formality:

```
git merge-base --is-ancestor 4490336 origin/integration/...  -> NOT ANCESTOR
git merge-base --is-ancestor 4490336 origin/master           -> NOT ANCESTOR
```

Two verified facts made a build on the pre-merge integration SHA
(`265fe362`) produce *false measurements* rather than merely violate policy:

1. **Integration could not decode the corpus.** Its `codec.ts` declared
   `ImageFormat = 'png' | 'jpeg'` and threw `SOURCE_INVALID` otherwise, while
   100% of the real corpus is WebP. A large-corpus characterization run from
   there would have decoded ~0 products *and reported the decoder gap as a
   source-quality result*.
2. **The large-corpus tool did not exist there.**
   `src/gateECohortCli.ts` — the authorized real-Commerce cohort assembler —
   returned `ABSENT-ON-INTEGRATION`. So did the batch `runIsolated()`
   SystemError isolation (§66) and the malformed-confidence fail-closed guard
   (§24): a lane cannot "preserve" guarantees its base lacks.

The project owner then explicitly directed: *"Merge #302 first, then rerun
the Phase 4.2 prompt unchanged from the new integration SHA."* #302 was
marked ready for review and merged (`--merge`, matching the repository's
convention for #301). The precondition was then re-verified, not assumed:

```
git merge-base --is-ancestor 4490336 origin/integration/... -> YES
codec.ts: export type ImageFormat = 'png' | 'jpeg' | 'webp'  ✓
src/gateECohortCli.ts                                        PRESENT ✓
```

Merging #302 landed Phase 4.1's **repairs**. It is not, and was not treated
as, Gate E acceptance: #302's own verdict remains `RECOMMENDED HOLD — human
fidelity review required`, and **Gate E remains PENDING**.

## 3. Alternatives rejected before the owner ruled

- **Branch from #302's head** — rejected. §4 defines the precondition as
  *integration* authority, and standing project guidance is that a lane never
  branches from another lane's unmerged branch; the Phase 4.2 PR would have
  carried #302's 40 files as undifferentiated diff, leaving the hostile audit
  unable to separate 4.1 work from 4.2 work (§64).
- **Merge #302 autonomously** — rejected. §4 forbids it.
- **Re-implement WebP decode and the cohort CLI on integration** — rejected.
  Duplicating approved-but-unmerged work guarantees a conflicting second
  implementation of `codec.ts` and `batch.ts`, and is a cross-boundary change.

## 4. Commerce path authority

The only Commerce path exercised is `product-search-deals` on App Staging
(`yzqjvdfgefveprobvvyw`), ACTIVE, version 61 — already deployed, already
authorized, unchanged by this lane. Verified from its deployed source:

- It is a **pure passthrough** (`return json(payload)`); it does not filter,
  reshape, or truncate `product_photos`. Whatever the upstream returns is
  what the pipeline sees.
- Upstream is RapidAPI `real-time-product-search`, `/deals` endpoint.
- `MAX_LIMIT = 20` per request; `offset` is supported and paging works
  (verified: a single query paged to offset 200 before exhausting).

No scraping, no PDP browsing, no invented alternate URLs, no new retailer
integration, no widened API scope. `search-vinted-secondhand` is deployed but
was **not** invoked: it is Apify-billed (§7 cautions against excessive
provider expense) and secondhand user photography is a materially different
population that would contaminate the natural-feed measurement (§9). Its
source code was read — which costs nothing — and that reading produced a
first-class strategic finding recorded in the addressability document.

## 5. Boundaries held

```
PRODUCTION MUTATION      NO
STAGING MUTATION         NO
LIVE ENABLED             NO
EXTERNAL CV CALLS        0
GENERATIVE COMPLETION    0
RETAILER IMAGE BYTES RETAINED   0
PROVIDER LIMITS          respected (bounded backoff on 429, never evaded)
```

Staging was read from only, through a function that performs zero database
access. No derived asset was written to disk for any real product
(`persist: false` throughout). No product title, store name, or raw image URL
appears in any committed evidence file.
