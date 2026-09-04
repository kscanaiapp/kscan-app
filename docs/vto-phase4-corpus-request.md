# VTO Phase 4 — Corpus Request (for the next session with real catalog access)

This lane had no legitimate path to real retailer/Commerce product imagery
(see `docs/vto-phase4-corpus-discovery.md` §5). Gate E (catalog economics)
cannot be answered on synthetic and QA-stock evidence alone. This document
specifies what a future session — one with authorized, read-only access to
real product images the app already legitimately receives — should gather,
without claiming any particular sample size is already statistically
sufficient (task section 9 forbids that).

## Target representation

A matrix, not a flat count — Gate E needs per-cell distributions, not one
aggregate success rate:

| | Easy | Medium | Hard |
|---|---|---|---|
| plain garment | | | |
| logo/text garment | | | |
| patterned garment | | | |
| dark garment | | | |
| light garment | | | |
| soft knit | | | |
| structured top | | | |
| multiple-image product (same product, several retailer offers) | | | |
| variant product (retailer-declared color/style variant) | | | |

Every cell should be filled with **real, provenance-recorded** images, not
synthetic stand-ins — synthetic and AUTHORIZED FIXTURE evidence already
exists from this session (see the final report) and must not be mixed into
the same distribution as real-product evidence (task section 46).

## Minimum starting point, not a target

This lane recommends starting with **3-5 real products per cell** (roughly
30-45 products total) as a first real-evidence pass — enough to see whether
a cell is obviously easy, obviously hopeless, or genuinely mixed — and then
**expanding specifically where the first pass shows high variance** (e.g. if
3 "Easy plain garment" products succeed automatically and 2 fail for
unrelated reasons, that cell needs more products before its success rate
means anything; if all 5 succeed or all 5 fail, that cell's signal is
already fairly clear and effort is better spent on a noisier cell). Do not
treat 3-5 per cell as adequate for a final Gate E PASS — it is only adequate
to decide where to expand next.

## Constraints carried forward from this session

- Provenance required for every image: which product, which retailer/offer,
  the exact URL or reference used, and a content hash.
- No new retailer API scope, no scraping of arbitrary sites — only images
  the app's existing, already-authorized commerce/search path legitimately
  surfaces.
- No committed copies of real retailer image bytes without separate,
  explicit redistribution authorization — numeric results, hashes, and
  manifests are the evidence; the images themselves may need to stay
  read-only/ephemeral per task section 8.
- PNG or JPEG only (this lane's pipeline decodes both — see corpus discovery
  §4); reject anything else with `SOURCE_INVALID` rather than adding a third
  decoder ad hoc.

## Category scope

Live VTO's own category allow-list is `['top']` today
(`DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES`, `services/vto/vtoLiveGarment.ts`),
narrowing further to three template families (`t-shirt`, `simple-top`,
`sweater`, `LIVE_SUPPORTED_TEMPLATE_FAMILIES`). A real-corpus pass gets the
most decision-relevant evidence by concentrating on **top-category products
across those three families**, not by expanding category coverage — task
section 44 is explicit that supported categories should not be expanded
merely to grow sample size.
