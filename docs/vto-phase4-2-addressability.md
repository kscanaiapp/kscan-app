# VTO Phase 4.2 — Catalog Addressability

Phase 4.2 §1/§2/§9-§14/§60-§62. This is the document the phase existed to
produce: **how much of the real K Scan catalog can become a reliable Live2D
garment asset when you look at the PRODUCT rather than only the currently
selected hero image?**

Machine-readable evidence:
`evidence/vto-phase4-2/catalog-characterization-summary.json`,
`evidence/vto-phase4-2/catalog-characterization.jsonl`.

---

## 1. The answer, up front

**Product-level addressability equals hero-image addressability, exactly,
because every product in the real Commerce feed carries exactly one
authoritative image.**

```
TOTAL PRODUCTS CHARACTERIZED     490
TOTAL AUTHORITATIVE IMAGES       490
IMAGES / PRODUCT DISTRIBUTION    { "1": 490 }     (mean 1.0, max 1)
PRODUCTS WITH >1 IMAGE           0  (0.0%)

HERO-ONLY ADDRESSABLE            49 / 490  = 10.0%
PRODUCT-LEVEL ADDRESSABLE        49 / 490  = 10.0%
ADDRESSABILITY GAIN FROM
MULTI-IMAGE RESCUE               +0.0 points

PRODUCTS WITH ONLY HARD IMAGERY  435 / 490 = 88.8%
```

§1 framed the strategic reframe as "shot class is an image property, not a
product property", and it is right — but the premise it implies (that
products carry several images, of which only one was being examined) does not
hold for this source. The gap Phase 4.1 left was real and worth closing: its
cohort runner passed `product_photos[0]` and therefore *was* hero-only by
construction. Closing it produced a definite answer rather than a gain.

## 2. Why there is nothing to rescue

Verified at three independent levels:

1. **Provider level.** The RapidAPI `/deals` response carries
   `product_photos` as an array, and that array had length 1 for **490/490**
   products (and for every product in every ad-hoc probe).
2. **Edge-function level.** `product-search-deals` is a pure passthrough
   (`return json(payload)`) — it is not truncating anything.
3. **App-contract level.** K Scan's own commerce types carry a **scalar**
   image, not a list: `services/productSearchDeals.ts:26`
   `imageUrl: string | null`; `commerce-watch-refresh` writes a single
   `p_display_image_url`; `search-vinted-secondhand` returns
   `imageUrl?: string`.

The imagery is also not retailer PDP photography. All 490 images resolve to
`encrypted-tbn{0,1,2,3}.gstatic.com` — Google's **thumbnail cache**. That
single fact explains the whole shape of the corpus: one image per product,
100% WebP, a hard resolution ceiling (max short side 659px), and
predominantly model-worn editorial crops.

## 3. A contract-level ceiling worth the owner's attention (§61)

`supabase/functions/search-vinted-secondhand/index.ts` contains this, in
`imageFrom()`:

```ts
const images = raw.images ?? raw.photos;
if (Array.isArray(images)) {
  for (const image of images) {
    const fromObject = firstNestedString(image, ['url', 'full_size_url', 'src']);
    if (fromObject) return fromObject;   // <- returns the FIRST, discards the rest
```

That upstream **does** return photo arrays, and K Scan's own edge function
collapses them to one URL before the app ever sees them. So the
one-image-per-product ceiling is not purely a provider limitation: for at
least one already-integrated source it is imposed by K Scan's own contract.

This is reported, not acted on. Changing that function is a Commerce
redesign and a staging mutation, both out of scope (§51/§53/§58). It is
recorded here because §61 asks for the strategic recommendation, and because
a future lane that wants multi-image rescue to have *any* material must start
here rather than with segmentation.

## 4. Natural feed vs engineering corpus (§9)

**Natural Commerce distribution** — what K Scan actually receives, measured
over 490 products with no selection applied beyond the standard stratified
garment queries:

```
HERO SHOT CLASS
  HARD          435   88.8%
  EASY           31    6.3%
  MEDIUM         18    3.7%
  UNSUPPORTED     6    1.2%

DECODE
  attempted     490
  decoded       490   (100.0%)
  format        { webp: 490 }
  failures        0
```

**Addressable engineering corpus** — the 49 products carrying an
EASY/MEDIUM image. These are a *subset selected because they are candidates*,
and are never used to restate the natural distribution.

The two must not be conflated, and are reported separately throughout.

## 5. Corpus scale, and where it stopped (§7)

§7 asked for ≥1,000 unique products, ideally several thousand. **The run
reached 490 and was stopped by the provider's rate limit, not by choice.**

```
provider requests issued        47
  HTTP 200                      28
  HTTP 429 (rate limited)       19
unique products obtained       490
```

The limit is real and hard: after ~28 successful requests the upstream
returns 429 for every subsequent request, and it had not recovered after
repeated checks across the session. §7 forbids evading provider limits, so
the runner honours it — bounded exponential backoff, then the stratum is
abandoned. No key rotation, no host rotation, no ignoring 429s.

**This is an honest shortfall against §7's target and is reported as one.**
It is an external quota constraint, not an engineering result. Two things
mitigate it:

- 490 products is 2.2× the Phase 4.1 baseline, and its addressable slice
  (49 products) is **4.9× larger** than Phase 4.1's (10) — because offset
  paging reaches deeper into result sets where more flat-lay and studio
  photography lives. Phase 4.1's single-page-per-stratum draw measured 4.5%
  addressable; the deeper draw measures 10.0%.
- The runner now writes a transient corpus cache, so a future quota window
  extends the corpus rather than re-spending quota to re-measure it.

## 6. Multi-image rescue (§13)

```
PRODUCTS WITH >1 IMAGE                    0
HERO HARD + ADDRESSABLE ALTERNATE         0
HERO REJECTED + ALTERNATE ELIGIBLE        0
PRODUCTS RESCUED BY ALTERNATE IMAGE       0
CATALOG COVERAGE BEFORE RESCUE           10.0%
CATALOG COVERAGE AFTER RESCUE            10.0%
```

Zero is a property of the **source**, not of the code. The rescue path is
implemented, wired, and unit-tested end-to-end:

- `gateECohortCli` now passes every `product_photos` entry (§12).
- `batch.processVariant` loads all candidates; `selectBestSourceImage` ranks
  them by shot class, then classifier confidence, then resolution.
- `variantConsistency.ts` gates any substitution on colourway agreement.
- `phase42AdversarialHarness.test.ts` runs a two-image product end-to-end
  through `runBatch` and proves rescue fires for a same-colour alternate and
  is refused for a different-colour one.

It will fire the moment a source supplies an addressable alternate.

## 7. HARD subdivision (§15-§19)

Measurement only. **No HARD image is LIVE2D_ELIGIBLE in Phase 4.2**, and
`hardTractability.ts` is structurally incapable of changing that — it is a
pure function of `SourcePreflight`, imported by no gate, returning only a
label. `phase42Diagnostics.test.ts` pins this.

```
TOTAL HARD IMAGES        435
  HARD_TRACTABLE           8    1.8%
  HARD_INTRACTABLE       423   97.2%
  HARD_UNKNOWN             4    0.9%
```

Every signal is an ESTIMATE and every result carries its own `limitations`
array (§16): the skin-tone signal is a coarse RGB heuristic that under-reports
darker skin tones and over-reports warm garments and wooden backgrounds;
there is no pose or frontality estimation anywhere in this pipeline; layering
is inferred from region count and cannot distinguish a second garment from a
prop or a shadow. These labels are unvalidated against human judgement
(§38: `NO_REFERENCE`).

### §62 — would model-worn R&D unlock a material fraction of the catalog?

**On this evidence: no.** Only **1.8%** of HARD imagery (8 of 435 images,
1.6% of all products) looks tractable even under generous estimated criteria.
97.2% is intractable for reasons a better segmenter does not address — busy
backgrounds, fragmented subjects, multiple significant regions, frames the
subject is cropped by.

The recommendation §62 asks for is therefore **source diversification, not a
model-worn research lane**. Chasing 1.8% of a bucket via the hardest open
problem in the space is poor value next to obtaining photography that is
addressable to begin with. If a research lane is opened anyway it should be
quarantined and justified on grounds other than this catalog's economics.

## 8. The natural catalog ceiling (§60)

```
CURRENT HERO-ONLY COVERAGE                       10.0%   (49/490, measured)
PRODUCT-LEVEL BEST-IMAGE COVERAGE                10.0%   (identical — one image per product)
PROJECTED COVERAGE IF THE EASY/MEDIUM
PIPELINE WERE PERFECT                            10.0%
```

The third number is the important one. **A flawless Easy/Medium pipeline
cannot exceed 10.0% of this catalog**, because 88.8% of products offer only
HARD imagery and Phase 4 has no HARD path by design. Every remaining unit of
engineering effort inside the addressable class competes for the gap between
today's success rate *within* those 49 products and 10.0% — not for the other
90%.

That reframes the program's economics: **the binding constraint on Live2D
coverage is source photography, not segmentation quality.**

## 9. Strategic hybrid recommendation (§61)

The evidence matches §61's stated condition — Easy/Medium works well on the
sources it can address, while most products have no addressable image. The
recommendation:

```
ADDRESSABLE PRODUCT (~10%)   -> LIVE
HARD-ONLY PRODUCT  (~89%)    -> AI PHOTO / other governed path
```

Not implemented here: §61 explicitly says do not implement customer routing
unless it already exists in current contracts, and it does not.

Ranked by expected coverage gain per unit of effort:

1. **Stop discarding photo arrays that already arrive.** The Vinted
   collapse in §3 is a contract change, not a research problem.
2. **Diversify the image source.** The present feed is a thumbnail cache,
   capped at 659px and predominantly model-worn. A source with flat-lay or
   ghost-mannequin photography moves the 10.0% ceiling; nothing inside the
   pipeline can.
3. **Owner-authored corpus (§41).** The `OWNER_AUTHORED_GARMENT_CORPUS` slot
   is supported as a separate evidence class and was not supplied during this
   lane. It is not fabricated, and the build did not depend on it.
4. **Model-worn extraction R&D.** Lowest priority, per §7 above.
