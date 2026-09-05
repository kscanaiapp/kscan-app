# VTO Phase 4.2 — Large-Corpus Catalog Characterization

Phase 4.2 §7/§8/§25/§49. Method and measurements for the real-catalog run.
The conclusions drawn from these numbers live in
`vto-phase4-2-addressability.md`; this document is the instrument and the
raw distributions.

Machine-readable:
`evidence/vto-phase4-2/catalog-characterization-summary.json`,
`catalog-characterization.jsonl`, `catalog-characterization-query-log.json`.

## 1. Method

§8 permits characterization to be cheaper than full pipeline execution, and
this runner takes that option: it decodes each authoritative image candidate
and measures it (shot class, source preflight, HARD tractability) **without**
running extraction, canonicalization, anchors, geometry, QA, or bundling.
The full pipeline is run separately by `addressableSliceCli`.

Corpus assembly:

- Path: `product-search-deals` on App Staging only. Provider cap
  `MAX_LIMIT = 20`; scale comes from **offset paging**, not from changing
  what is asked for. The 21 stratified queries are byte-identical to the
  Phase 4.1 Gate E run so the two corpora stay comparable.
- Every stratum is paged **unconditionally** — never stopping early once a
  running total is reached, which silently starves whichever strata are
  queried last (the specific bug that spoiled a Phase 4.1 draw). Strata are
  then interleaved **round-robin**, so any trim falls evenly.
- Pacing 180 ms between requests. On HTTP 429: bounded exponential backoff,
  then the stratum is abandoned. Never a harder retry, never key or host
  rotation (§7 forbids evasion).
- A transient corpus cache (image URLs) is written **outside the repository**
  and gitignored, so re-analysis never re-spends provider quota. No URL
  reaches committed evidence.

Transience: bytes are fetched, decoded in memory, measured, and dropped.
Nothing is written to disk for any real product.

## 2. Corpus obtained

```
unique products characterized     490
target requested                 1500
provider requests issued           47
  HTTP 200                         28
  HTTP 429                         19
raw provider records seen         560
records skipped (no photos)         0
strata queried                     21
assemble wall-clock             45.7 s
characterize wall-clock         40.3 s  (concurrency 8)
```

**The run stopped at 490 because of the provider rate limit, not by
choice.** After ~28 successful requests every further request returned 429,
and the limit had not recovered on repeated checks later in the session.
This is a shortfall against §7's ≥1,000 target and is reported as one — an
external quota constraint, not an engineering outcome.

Paging itself works well: one query reached offset 200 before exhausting
(~196 unique products available on a single query), so the ceiling here is
quota, not catalog depth.

Visual stratum coverage of the 490:
`{plain, logo, patterned, dark, light, softknit, structured}` — the deeper
paging concentrated the draw in the strata that were reachable before the
limit hit, which is disclosed rather than smoothed over.

## 3. Images per product

```
total authoritative images        490
distribution                      { "1": 490 }
mean / median / p95 / max         1 / 1 / 1 / 1
products with >1 image            0  (0.0%)
image host distribution
  encrypted-tbn0.gstatic.com      105
  encrypted-tbn1.gstatic.com      142
  encrypted-tbn2.gstatic.com      127
  encrypted-tbn3.gstatic.com      116
```

Every image is served from Google's thumbnail cache. No retailer CDN, no PDP
imagery.

## 4. Decode reliability

```
attempted        490
decoded          490   (100.0%)
failed             0
formats          { webp: 490 }
```

WebP decode via `@jsquash/webp` is confirmed reliable at 490/490, on a second
independent corpus draw after Phase 4.1's 220/220 (§66 carry-forward intact).

## 5. Shot-class distribution

```
HERO (== only) IMAGE
  HARD          435   88.8%
  EASY           31    6.3%
  MEDIUM         18    3.7%
  UNSUPPORTED     6    1.2%
```

## 6. Source preflight distributions (§25)

All 490 decoded images. Every quantity is a measurement; nothing here gates.

| Metric | min | median | p75 | p95 | max | mean |
|---|---|---|---|---|---|---|
| shortSidePx | 183 | 603 | 659 | 659 | 659 | 547.3 |
| backgroundUniformity | 0 | 79.4 | 110.6 | 135.3 | 182.9 | 75.0 |
| totalComponentCount | 1 | 16 | 78 | 328 | 4487 | 97.6 |
| significantComponentCount | 0 | 1 | 1 | 3 | 15 | 1.29 |
| garmentOccupancy | 0.0004 | 0.661 | 0.800 | 0.945 | 1.0 | 0.656 |
| borderContactEdges | 0 | 2 | 2 | 3 | 4 | 1.56 |
| paddingTotalFraction | 0 | 0.278 | 0.369 | 0.474 | 0.653 | 0.258 |
| paddingAsymmetry | 0 | 0.148 | 0.191 | 0.247 | 0.493 | 0.136 |
| contrast | 5.2 | 67.4 | 89.2 | 105.0 | 116.5 | 67.6 |
| sharpnessProxy | 0.0016 | 0.013 | 0.018 | 0.030 | 0.131 | 0.015 |
| skinRatioProxy | 0 | 0.229 | 0.380 | 0.850 | 1.0 | 0.273 |

Four of these carry real consequences:

**`totalComponentCount` (median 16, p75 78, p95 328, max 4487) vs
`significantComponentCount` (median 1, p95 3).** This is the corpus-wide
evidence behind defect **P42-001**. Real lossy-compressed photographs shatter
into dozens-to-thousands of tiny foreground components while containing a
single meaningful one. Any formula keyed on the raw count is measuring
compression noise, not scene complexity.

**`skinRatioProxy` median 0.229.** Half the corpus has ≥23% of its foreground
reading as skin — consistent with the 88.8% HARD classification, and the
single best one-number summary of why this source is hard.

**`paddingTotalFraction` median 0.278, `paddingAsymmetry` median 0.148
(§27).** A quarter of a typical image is uniform-background margin, and that
margin is routinely asymmetric. Padding is currently handled *implicitly* and
correctly: the segmenter crops to the winning component's bounding box, so
margin is excluded rather than absorbed. `phase42AdversarialHarness.test.ts`
pins that a 100×100 garment on a 600×600 canvas does not absorb padding into
the mask. **No new padding threshold was introduced.** §26 requires a
threshold be justified by observed evidence, and the observed evidence is that
padding is not currently causing failures — so normalizing it would be an
unjustified change with its own risk of trimming real garment pixels (§35).
The distributions are recorded so a future lane can revisit with cause.

**`shortSidePx` min 183, median 603.** Resolution is not the binding
constraint; Phase 4.1 already recorded ADEQUATE source adequacy for all ten
of its addressable cases.

## 7. Ingest-scale model (§49)

Measured, at concurrency 8 on this machine:

```
characterization      82.2 ms / product wall-clock (fetch + decode + preflight
                      + shot class + tractability, 8 workers)
                      ~658 ms / product single-worker equivalent
corpus assembly       ~1.0-1.7 s per provider request (20 products/request)
```

Projected wall-clock for characterization at the measured concurrency:

| SKUs | characterization wall-clock | single-worker equivalent |
|---|---|---|
| 1,000 | ~1.4 min | ~11 min |
| 10,000 | ~14 min | ~1.8 h |
| 100,000 | ~2.3 h | ~18 h |

Two caveats that dominate these numbers:

1. **Provider quota, not compute, is the binding constraint.** 100,000 SKUs
   needs ≥5,000 provider requests at 20/request; the measured limit is ~28
   requests before a 429 that had not cleared within the session. Compute
   time is close to irrelevant next to that.
2. **No infrastructure pricing is asserted.** §49 forbids inventing prices,
   and no actual per-request or per-CPU-hour cost for this provider or host
   was available to this lane.

## 8. Boundaries

```
scraping                        NO
retailer integrations added      0
alternate URLs invented          0
PDP browsing                    NO
production mutation             NO
staging mutation                NO
external CV calls                0
generative calls                 0
source bytes retained            0
```
