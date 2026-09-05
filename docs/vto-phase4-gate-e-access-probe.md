# VTO Phase 4 — Gate E: Day-One Commerce Access Probe

Task section 6. Run before building any evaluation harness, to establish
whether this execution environment can actually obtain legitimate real
product data.

## Verdict

```
COMMERCE ACCESS: PASS  (mechanically)
USABLE REAL-PRODUCT CORPUS: NOT OBTAINABLE
```

The five access questions all answer YES. The corpus they yield is
nevertheless unusable by the frozen Phase 4 pipeline, for a reason that is a
property of the access path and not of the pipeline's garment logic. Both
halves of that sentence matter and neither should be reported without the
other.

## The five questions

| Question (section 6) | Answer | Evidence |
|---|---|---|
| Can product records be read? | **YES** | `product-search-deals` returned HTTP 200 with populated `data.products[]` for 10 stratified garment queries. |
| Can product image references be read? | **YES** | Every returned product carried a `product_photos[0]` https URL. 99/99. |
| Can image bytes be temporarily fetched? | **YES** | All 99 image URLs fetched successfully (0 fetch errors). |
| Are required credentials / read roles available? | **YES** | The staging anon/publishable key authenticates the edge function; the upstream provider key is a deployed function secret and never leaves the function. |
| Is network access available? | **YES** | Outbound HTTPS from this environment confirmed independently. |

## Path actually exercised

`supabase/functions/product-search-deals` — deployed on **App Staging**
(`yzqjvdfgefveprobvvyw`), status ACTIVE, version 61.

This function was chosen deliberately as the *least invasive* authorized
commerce path available:

- It performs **zero database access**. Grepped for `createClient`, `insert`,
  `from(`, `SUPABASE_*`, `SERVICE_ROLE` — no matches. It is a pure
  request/response proxy, so exercising it cannot mutate staging (section 56).
- It requires **no image input**, so it invokes no vision or generative model
  (section 21).
- It is text-query driven, so it needs no scraping, no new retailer
  integration, and no widened API scope (section 8).

## What the probe found

10 queries stratified across the visual characteristics section 16 asks for
(plain / logo / patterned / dark / light / soft knit / structured), 99
distinct products after de-duplication.

```
FORMAT DISTRIBUTION      { "WEBP": 99 }
IMAGE HOSTS              encrypted-tbn{0,1,2,3}.gstatic.com  (99/99)
SHORT-SIDE DIMENSION     min 194px | p50 632px | p95 659px | max 659px
DECODABLE BY PIPELINE    0 / 99   (0.0%)
```

Machine-readable: `evidence/vto-phase4-gate-e/access-probe-image-format-census.json`.

### The blocker is format, not size

The frozen Phase 4 pipeline declares exactly two image decoders in
`vto-phase4-pipeline/package.json`:

```
"pngjs": "7.0.0"      → PNG
"jpeg-js": "0.4.4"    → JPEG
```

There is no WebP decoder, and `vto-phase4-pipeline/src/sourceLoad.ts`
enforces `MIN_DIMENSION = 40`. The measured short sides (min 194px) clear
that minimum comfortably — **size is not the constraint**. Format is: every
image the authorized commerce path returns is WebP, which the pipeline
cannot open at all.

### The format is not negotiable

Content negotiation was tested explicitly against the CDN:

| Request `Accept:` | Response `Content-Type` |
|---|---|
| `image/jpeg` | `image/webp` |
| `image/png` | `image/webp` |
| `image/jpeg,image/png;q=0.9` | `image/webp` |
| `*/*` | `image/webp` |

`encrypted-tbn*.gstatic.com` ignores the `Accept` header and serves WebP
unconditionally. There is no supported-format variant of these URLs to
request.

### The production path has the same property

The production commerce provider is Serper
(`supabase/functions/scan-identify/shoppingProvider.ts`, `SERPER_URL =
https://google.serper.dev/shopping`), which returns Google Shopping results
and populates `imageUrl` from the same `encrypted-tbn*.gstatic.com` thumbnail
CDN. `normalizeImageUrl` applies no host or format constraint. Switching to
the production provider would not change the format outcome.

### Other commerce paths checked

- `search-vinted-secondhand` — deployed and reachable, returns HTTP 200 with
  `SECONDHAND_RESULTS_UNAVAILABLE` and zero items. No corpus.
- `nike-shoe-details`, `kickscrew-sneaker-description` — footwear only, which
  is outside Live VTO's supported category allow-list (`['top']`).
- `public.product_catalog` (staging) — the internal catalog table with
  `image_url` / `product_url` columns exists but holds **0 rows**.
- `public.user_commerce_watches` (staging) — holds **0 rows**. This is user
  personal data and would not have been an appropriate evaluation corpus even
  if populated.
- `public.scan_commerce_events` — telemetry only; its own migration header
  states "Do not store images, raw text, URLs, tokens, or PII." No image
  references are persisted anywhere by design.

A production read of `user_commerce_watches` was attempted and **denied by
this environment's permission classifier**. It was not retried or worked
around. Nothing in this lane's conclusions depends on it: production holds
real users' personal watchlist data, which is not a legitimate Gate E
evaluation corpus regardless of accessibility.

## Retention (section 19)

```
SOURCE IMAGES TEMPORARILY PROCESSED:  99
SOURCE IMAGES RETAINED:               0
SOURCE IMAGES DELETED:                99
DERIVED METADATA RETAINED:            YES
RETENTION AUTHORITY:                  none required — nothing retained
```

Image bytes were held only in a scratch directory long enough to read the
format signature and dimension header, then deleted. What remains is the
derived-metadata class section 20 permits: content hashes, formats,
dimensions, byte counts, host names, and aggregate distributions. Product
titles and store names were deliberately **excluded** from the committed
evidence because retailer-imagery rights are UNKNOWN
(`docs/vto-phase4-gate-e-rights.md`).

No image bytes were transmitted to any external service. No vision or
generative provider was called at any point in this lane.

```
EXTERNAL CV / GENERATIVE CALLS: 0
```

## Why this does not become a baseline

Running the frozen pipeline over this corpus would terminate all 99 records
at the decode stage. That is a `SYSTEM_ERROR`/source-invalid class outcome —
an artifact of the access path's image format — not a catalog rejection.
Reporting it as a 0% catalog success rate would measure the CDN, not the
pipeline, and section 49 forbids presenting it as either. The real-catalog
run is therefore stopped here, per section 6.

This is a **capability gap, not a pipeline defect**. Phase 4's garment logic
was never exercised against real imagery and remains unmeasured.
