# Live VTO — Fixture Consent Log

Section 31 requires every piece of controlled human footage used as a Live
VTO fixture to carry: explicit test-purpose consent, a fixture ID, a date,
permitted use, and a storage location, logged here before the footage is
used.

## Status: empty

**No real human footage exists in this program as of this document's last
update.** This cloud sandbox session had no camera, no physical device,
and no consenting human subject available to it — see
`fixtures/people/README.md` and `docs/vto-phase1-status.md`. Every golden
sequence built so far (`fixtures/sequences/`) is synthetic BodyFrame data,
which this log does not cover (Section 31's consent requirement is scoped
to real human footage; synthetic landmark generation involves no person).

## Real product-asset candidate records (bounded discovery, 2026-09-04)

A bounded search of the repository for real product imagery usable as
`.ksgarment` source material. **This section makes no legal or licensing
determination** — it records what was found and what state its provenance is
in. Only the program owner can move a row out of "OWNER AUTHORIZATION
REQUIRED".

**Where I looked.** The repository's actual tree, not an assumed one. Of the
conventional fixture locations (`fixtures/`, `__fixtures__/`, `test-data/`,
`mocks/`, `__mocks__/`, `examples/`, `public/`, `static/`, `seed/`,
`.storybook/`, `stories/`, `samples/`), **only `assets/` exists.** I also
searched every `*.json`/`*.ts`/`*.tsx`/`*.js` file for the structured image
fields `image`, `imageUrl`, `image_url`, `productImage`, `thumbnail`,
`thumbnailUrl`, `photo`, `photoUrl`; outside the two directories below the
only hit is `app.json`'s splash icon.

### Group 1 — `assets/qa_fixtures/` (8 JPEGs)

Purpose in source: closet-intake **category-classification** QA
(`constants/qaFixtures.js`, `scripts/qa-fixtures.js`,
`security/release/run-closet-intake-live-probe.js`). They exist to test
whether the classifier says "top" vs "footwear" vs "non-fashion" — not to
serve as garment artwork. `constants/qaFixtures.js` exports an empty list
outside `__DEV__`, so they are dev-only by construction.

| FIXTURE_ID | SOURCE LOCATION | PRODUCT / CATEGORY | SHOT CLASS | IMAGE LOCATION | PROVENANCE FOUND IN REPO | AUTHORIZATION STATUS |
|---|---|---|---|---|---|---|
| `qa-top` | `constants/qaFixtures.js` id `top` | White hoodie, third-party wordmark on chest | **Model-worn**, full torso, identifiable face, studio white | `assets/qa_fixtures/top.jpg` (960×960) | None. No attribution, no licence, no NOTICE file anywhere in repo | **REJECT — UNKNOWN PROVENANCE** |
| `qa-outerwear` | id `outerwear` | Leather jacket | **Model-worn**, cropped (head cut), editorial monochrome | `assets/qa_fixtures/outerwear.jpg` (836×1012) | None | **REJECT — UNKNOWN PROVENANCE** |
| `qa-dress` | id `dress_or_one_piece` | Dress | Not inspected — out of target category | `assets/qa_fixtures/dress.jpg` (423×503) | EXIF `Picasa 3.0` only | **REJECT — UNKNOWN PROVENANCE** |
| `qa-bottom-skirt` | id `bottom_skirt` | Skirt | Not inspected — out of target category | `assets/qa_fixtures/bottom_skirt.jpg` (960×1280) | JPEG comment: `File source: https://commons.wikimedia.org/wiki/File:M_skirt.JPG`. A source URL, **not a licence** — Commons hosts several incompatible licences | **OWNER AUTHORIZATION REQUIRED** |
| `qa-bottom-jeans` | id `bottom_jeans` | Jeans | Not inspected — out of target category | `assets/qa_fixtures/bottom_jeans.jpg` (564×628) | EXIF `Adobe Photoshop 7.0`, dated 2002 | **REJECT — UNKNOWN PROVENANCE** |
| `qa-footwear` | id `footwear` | Footwear | Not inspected — out of target category | `assets/qa_fixtures/footwear.jpg` (960×640) | Only an embedded ICC profile string (`Copyright 1999 Adobe Systems`), which describes the colour profile, **not the photograph** | **REJECT — UNKNOWN PROVENANCE** |
| `qa-accessory` | id `accessory` | Accessory | Not inspected — out of target category | `assets/qa_fixtures/accessory.jpg` (960×640) | None | **REJECT — UNKNOWN PROVENANCE** |
| `qa-non-fashion` | id `non_fashion_control` | Non-fashion control | Not applicable | `assets/qa_fixtures/non_fashion.jpg` (525×394) | None | Not a garment candidate |

Two of these additionally carry **person likeness** (an identifiable face in
`top.jpg`) and a **third-party brand mark**. Those are separate concerns from
image copyright and each would need its own clearance; neither is recorded
anywhere in the repository.

### Group 2 — `assets/catalog-images/` (6 PNGs)

| FIXTURE_ID | SOURCE LOCATION | PRODUCT / CATEGORY | SHOT CLASS | IMAGE LOCATION | PROVENANCE FOUND IN REPO | AUTHORIZATION STATUS |
|---|---|---|---|---|---|---|
| `catalog-tops` … `catalog-accessories` (6) | `data/catalog.json` `imageUrl` | Category **placeholders**, not products | **Not photography** — flat vector-style line art on a dark card, captioned "K-SCAN DEMO CATALOG" | `assets/catalog-images/{tops,bottoms,dresses,outerwear,footwear,accessories}.png`, 600×800 | Self-identifying as K Scan demo artwork | **EXPLICITLY AUTHORIZED IN SOURCE** (K Scan's own artwork) — but see below |

These six are the only images in the repository that are unambiguously K
Scan's to use, **and they are unusable as real-asset evidence.** `data/catalog.json`
has 60 products sharing exactly these 6 files, 10 products per image: they are
category tiles, not per-product photography. They have no fabric, no texture,
no photographic shading, and no real garment geometry. Running the
`.ksgarment` pipeline against a line-art icon would produce a clean-looking
result that proves nothing about real catalog assets — which is precisely the
"manufacture viability evidence" the authorization for this pass forbids.

### Live/dev data sources — deliberately not queried

The authorization permits optional read-only discovery in a clearly-identified
**development/test** data source. I did not do this, for a reason rather than
an omission: from this session I cannot reliably distinguish a development
Supabase project from the production one, the standing program constraints
forbid touching production, and — decisively — any image found that way
"still requires owner authorization before it becomes VTO viability
evidence." It therefore could not change the gate outcome below, so the
risk bought nothing.

### Result

**Authorized, real, apparel product images available for `.ksgarment` work: 0.**

The hard corpus gate (≈3 required) is not met. `GATE B: HOLD — OWNER FIXTURE
CORPUS REQUIRED`. No synthetic products were generated, no retailer was
scraped, no public web imagery was downloaded, and no retailer API was called
to manufacture a corpus.

## Log format

When real footage is captured, add one row per fixture before it is used
by any test, pipeline, or review package:

| Fixture ID | Date | Subject consent obtained | Permitted use | Storage location | Notes |
|---|---|---|---|---|---|
| _(none yet)_ | | | | | |

- **Fixture ID** — matches the `sequenceId`/fixture filename used
  elsewhere in the repo (e.g. `fixtures/sequences/manifests/<id>.json`).
- **Subject consent obtained** — who obtained it, how (written/verbal +
  reference), and confirmation it names Live VTO R&D use specifically.
- **Permitted use** — e.g. "internal engineering evaluation only, not for
  ML training beyond this program, not for external publication."
- **Storage location** — exact path or system; footage must stay out of
  the `kscan-app` production repository regardless (Section 31: "never
  bundled into production").

## Rules this log exists to enforce (Section 31)

- Fixtures are isolated-development-only; never bundled into production.
- Never used for unrelated ML training without separate authorization.
- No scraping public pose datasets without a commercial-licensing review.
- Synthetic augmentation (lighting/noise/compression/background variation)
  may supplement real footage; it does not replace real body diversity as
  a fixture source.
