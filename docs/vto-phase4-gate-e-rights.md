# VTO Phase 4 — Gate E: Legal / Rights Pre-Flight

Task section 7. Access to an image is not authority to use it for automated
evaluation. This document records what authority could and could not be
established **from the project's own records**. It does not interpret law and
does not infer permission.

## Verdict

```
CLEARED sources:     0
RESTRICTED sources:  0
UNKNOWN sources:     all real retailer/commerce imagery

GATE E PRECONDITION HOLD — REAL PRODUCT EVALUATION AUTHORITY NOT ESTABLISHED
```

Per section 7, UNKNOWN means *do not assume permission* and *exclude from
Gate E until resolved*. With no source establishable as CLEARED, the
real-product evaluation does not proceed.

## Classification

| Source | Class | Basis |
|---|---|---|
| Google Shopping thumbnails via `product-search-deals` (RapidAPI) | **UNKNOWN** | No recorded terms review, licence, or attribution/redistribution analysis for RapidAPI or the `gstatic` thumbnail CDN. |
| Google Shopping results via Serper (production path) | **UNKNOWN** | Same. `serper.dev` is cited only as a vendor URL; no ToS page was ever reviewed or recorded. |
| Vinted secondhand listings via `search-vinted-secondhand` | **UNKNOWN** | No recorded authority. Additionally returns zero results, and its imagery is user-generated rather than retailer catalog photography. |
| In-repo `assets/qa_fixtures/*.jpg` | **AUTHORIZED FIXTURE** (not a retailer source) | Already committed to and authorized within this repository. Already exercised by the Phase 4 lane; **not** real-product evidence, and not re-used here. |
| Procedurally-drawn synthetic fixtures | **N/A — no rights question** | Derived from no photograph. |

## What was searched

A thorough repository sweep was performed for any written authority covering:
displaying commerce imagery, server-side fetching of image bytes, automated
processing / computer vision / derivative-asset generation, storage or
caching, and provider terms / attribution / redistribution constraints.

**Nothing on point was found.** Specifically absent from the repository:

- No `LICENSE`, `TERMS*`, `NOTICE`, `COPYRIGHT`, `legal/`, `privacy/`, or
  `compliance/` directory at root.
- `constants/legal.ts` carries version strings only, no substantive text. The
  app's actual Terms and Privacy Policy exist only as external links
  (`kscan.app/legal/terms`, `kscan.app/legal/privacy`) and are not in the
  repository.
- `docs/general-shopping-api-evaluation.md` section 7 lists 13 mandatory gates
  for adding a commerce provider — backend-only, feature flag, API key
  handling, timeouts, URL validation, dedupe, tests, telemetry. **Not one is a
  legal, ToS, licensing, attribution, or rights review.** Its Sources section
  cites the vendor docs and pricing pages; no terms-of-service page was
  reviewed.
- No comment anywhere in the commerce path (`shoppingProvider.ts`,
  `canonicalCommerce.ts`, `commerceResultCache.ts`,
  `product-search-deals/index.ts`) mentions image rights, licensing, ToS,
  attribution, or redistribution. Those headers cover secret hygiene, ranking
  neutrality, normalization, and PII-free cache keys.
- `supabase/functions/_shared/net/safeRemoteMedia.ts` is explicitly a
  **security** control with no rights dimension — its own header states it is
  retailer-neutral by design, with no allowlist of retailers, rejecting
  network topology rather than any brand.
- `docs/BUILD34_SCANNER_SCAN_RESULTS_DEEP_AUDIT.md` records that no provider
  is described as a partner anywhere and there is no affiliate relationship —
  so there is affirmatively no documented commercial arrangement that could
  carry an imagery licence.

## What the project's own records *do* say

Every relevant record is a **restriction or an open question**, never a grant:

- `docs/vto-phase4-corpus-request.md` — no new retailer API scope, no scraping
  of arbitrary sites; no committed copies of real retailer image bytes without
  separate, explicit redistribution authorization. Note its phrase
  "already-authorized commerce/search path" is asserted but never evidenced —
  no document defines what that authorization is or where it came from.
- `docs/vto-phase4-corpus-discovery.md` section 5 — the Phase 4 lane's own
  finding: it has no legitimate, already-authorized path to a live
  retailer/Commerce product-image feed. The entire Phase 4 pipeline was
  confined to synthetic and in-repo fixture sources *because* no such
  authority exists.
- `docs/app-staging-catalog-readiness-v1.md` — do not use unauthorized
  retailer product images; acceptable assets are K Scan-owned, Supabase
  Storage test assets, owner-approved placeholders, or approved synthetic
  URLs. This is the only flat prohibition in the repo, and it presupposes an
  "authorized" category it never defines.
- `docs/vto-foundation.md` — flags the question as explicitly open: a real
  provider needs a decision about what its terms permit us to send, and what a
  provider retains is a contract question, unanswered until one exists. It
  also records that the existing VTO path already sends the retailer's https
  garment image URL onward to a provider.

## Hotlinking vs. downloading

No document states that commerce images are displayed by URL reference only
and never downloaded. In practice the app displays by URL reference, but it
also **persists remote image URL values in Postgres** and re-serves them in
public room previews, and the VTO path already performs **server-side byte
fetching** of retailer garment images. No record analyses whether any of that
is permitted. This is noted as an observation about the existing product, not
a finding of this lane, and it is out of Gate E's scope to adjudicate.

## Disclosure: this lane's own fetch

The section 6 access probe is mandated to answer "CAN IMAGE BYTES BE
TEMPORARILY FETCHED?", which cannot be answered without attempting a fetch.
This lane fetched 99 images from the gstatic thumbnail CDN and read only each
file's format signature and dimension header before deleting the bytes.

Recorded plainly so the boundary is on the record:

- Establishing that WebP was **universal** rather than incidental required
  more than one sample; 99 is more than the strict minimum to prove
  fetchability, and that is a judgement this lane made rather than an
  authority it held.
- **No image was decoded, segmented, processed, or turned into a derivative
  asset.** The Phase 4 pipeline was never run against any of them. Format and
  dimension sniffing is metadata extraction, not the automated evaluation
  section 7 gates.
- **All 99 image files were deleted.** Only hashes, formats, dimensions, byte
  counts, and host names were retained — the derived-metadata class section 20
  permits. Product titles and store names were excluded from committed
  evidence.
- No bytes were transmitted anywhere. `EXTERNAL CV / GENERATIVE CALLS: 0`.

## What the owner needs to resolve

Gate E cannot be re-attempted on real products until at least one source is
established as CLEARED. That requires a decision this lane has no standing to
make:

1. **Which source, and under what terms?** A reviewed, recorded basis for
   Serper / RapidAPI / Google Shopping thumbnail imagery — or a different
   source entirely (for example a retailer feed or affiliate programme that
   grants image rights explicitly).
2. **What processing is permitted?** Fetching bytes, running computer vision,
   and generating a derivative garment asset are three separable permissions.
   Live VTO needs all three; nothing on record grants any.
3. **What may be stored, and for how long?** Derived masks, textures, and
   canonical assets may still contain protected retailer imagery. Section 20
   assumes transformation does not by itself clear rights.

If authority exists, it lives outside this repository — in the external
`kscan.app/legal/*` documents or in unrecorded agreements — and could not be
verified from the code or docs available here.
