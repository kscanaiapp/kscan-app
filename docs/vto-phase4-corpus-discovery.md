# VTO Phase 4 — Corpus Discovery

Full inventory of what image/asset evidence and infrastructure already exists
in this repository, gathered before writing any new pipeline code, per task
section 7. Nothing described here was rebuilt if it already existed.

## 1. Existing image-processing infrastructure (integration branch)

No general-purpose server/Node-side image decode or manipulation library
exists anywhere in this monorepo — `grep`-confirmed zero occurrences of
`sharp`, `jimp`, `canvas`, `pngjs`, `jpeg-js` in `package.json`/
`package-lock.json`. What does exist, all client-side (React Native) and
none reusable from a Node batch script:

- `services/imageUtils.js#compressForUpload` — resizes a **person** photo via
  `expo-image-manipulator` (native module, requires an RN runtime) to 896px,
  JPEG q0.65. Scanner/Elise path, not commerce/garment images.
- `services/privacyImageUpload.ts#prepareImageForPrivacyUpload` — the VTO
  **person**-photo re-encode/EXIF-strip path (1024px, q0.8). Explicitly not
  used for garment images.
- `services/privacyImageSanitizer.js` — documented no-op passthrough, not a
  real sanitizer.
- No image hashing utility exists (an available-but-unused primitive is
  `expo-crypto`, also RN-only).
- No remote-media caching/proxy/CDN layer exists for commerce images.

**Server-side (Deno Edge Functions) SSRF guard** —
`supabase/functions/_shared/net/safeRemoteMedia.ts`:
`assertSafeRemoteMediaUrl(value)` / `resolveSafeRemoteMedia(value, deps)`
(https-only, rejects embedded credentials/non-public hosts/private-IP
obfuscations, re-validates every redirect hop, enforces
`image/{jpeg,png,webp,avif}` + 10MB cap). This is the one piece of
"safe remote media" infrastructure that already exists and is authoritative
— it runs server-side only (Deno), not in the RN app or in any Node
tooling. Phase 4's own fetch path (see `src/sourceFetch.ts`) reuses this
function's **exact validation rules**, re-implemented for a plain Node
`fetch`/`https` context (Deno's `Deno.*` APIs aren't available in Node),
with a code comment citing the source file and line so the two never
silently drift apart. It is not modified.

**Conclusion**: there is nothing to reuse for decoding image *bytes* into
pixels — every existing "image" utility in this app either shells out to a
native RN module or is a client-side privacy/re-encode step for **person**
photos. A garment-asset pipeline that must run as a local Node batch job
needs its own pixel-decode path; see §4.

## 2. Existing VTO/garment fixtures — what they actually are

Two committed images looked promising by name and turned out **not** to be
usable garment photography:

- `scripts/vto-e2e/fixtures/garment.png` (300×300, `garment.fixture.json`
  records its sha256/size) — visually inspected: it is a **synthetic
  gradient/noise test pattern** (magenta/blue/green diagonal bands with
  random noise), used only to prove the VTO E2E harness can push image bytes
  through the pipeline. It depicts no garment shape at all and is unusable
  for shot classification, segmentation, or fidelity evaluation.
- `assets/catalog-images/tops.png` — visually inspected: a **placeholder
  demo-catalog icon** (line-art t-shirt outline, "TOPS / K-SCAN DEMO
  CATALOG" caption on a dark card). Not a product photo.

**`kscan-live-vto` research workspace (PR #291/#295, read-only reference)**:
its own `fixtures/real-products/README.md` records an **authorization for 7
named files** (`tee-flatlay-001.jpg`, `tee-flatlay-002.jpg`,
`top-ghost-001.jpg`, `top-ghost-002.jpg`, `tee-studio-001.jpg`,
`sweater-studio-001.jpg`, `tee-logo-001.jpg`) but **zero bytes have ever
been delivered** (`0/7`). Its `packages/asset-pipeline` has no image-ingestion
code at all: `shotClass.ts` is a hard-coded stub that always returns
`{ shotClass: 'D_MODEL_WORN', confidence: 0 }` regardless of input;
`qc.ts` only aggregates confidence numbers supplied from elsewhere; every
`.ksgarment` in that workspace's `evidence/`/`fixtures/` was produced by
**procedural drawing code** (`generateSyntheticGarment`), not derived from a
photograph. That workspace's own `evidence/README.md` states outright:
"Does not support ... real retailer-asset viability." So Phase 4 is
building the very first real image→garment-asset stage in this program —
there is no existing capability to duplicate (task section 7).

That workspace also carries a closed, written policy directly relevant to
Phase 4's format choice: **"No JPEG decoder will be implemented. No
image-decoding dependency will be added"** (`fixtures/real-products/
README.md`), enforced mechanically by `tests/privacy/
dependencyBoundary.test.js`'s empty external-dependency allow-list. That
policy governs `kscan-live-vto/`'s own packages; Phase 4's pipeline lives in
a new, separate, sibling isolated workspace (not inside `kscan-live-vto/`,
since that directory does not exist at all on the integration branch this
lane is built from — see `docs/vto-phase4-source-authority.md`), so the
policy does not bind it mechanically. This lane makes its own, separately
justified dependency decision — see §4.

## 3. Real, usable, already-authorized fashion photography found in-repo

`assets/qa_fixtures/*.jpg` — eight images used by the **scan-identify QA
suite** (`__tests__/qaFixturesProductionGate.test.js`, `scripts/
qa-fixtures.js`) to validate category identification, one per K Scan
taxonomy category. These are real photographs, already committed to this
repository and already authorized for use as fixtures within it. Visually
inspected (all real photographs, not illustrations):

| File | Depicts | Category | Phase 4 read on it |
|---|---|---|---|
| `top.jpg` | Model wearing a white hoodie, front-facing, plain light background, visible chest logo ("COQ") | top | **HARD** (model-worn by definition) but clean/near-frontal — the one real fixture in Live's supported category |
| `outerwear.jpg` | Extreme close crop, monochrome editorial, leather jacket shoulder/collar, model's jaw only | outerwear | HARD, severe crop — expected `CROP_INCOMPLETE`/`OCCLUSION_TOO_HIGH` reject |
| `dress.jpg` | Full-length model in a strapless wedding dress, dim interior background | dress | HARD, outside Live's category allow-list |
| `bottom_jeans.jpg` | Model wearing jeans + sneakers, cropped at neck, flat grey background | bottom | HARD (model-worn), outside category allow-list |
| `accessory.jpg` | Flat-lay bag/sunglasses/book on a dock, no garment at all | accessory | Expected `UNSUPPORTED_CATEGORY` / no primary garment |
| `footwear.jpg` | Close crop of a shoe on a foot, beach background | footwear | Expected `UNSUPPORTED_CATEGORY` |
| `non_fashion.jpg` | A coffee mug | non_fashion | Expected `UNSUPPORTED_CATEGORY` / `GARMENT_NOT_PRIMARY`, used by the existing suite specifically to test category rejection |
| `bottom_skirt.jpg` | A person in a private/candid setting | bottom | **Deliberately excluded from this lane's corpus.** The image raises content-appropriateness concerns unrelated to Phase 4 (subject, setting, framing) that are outside this lane's scope to adjudicate. It was not processed, copied, or referenced beyond this listing; flagged here only so the exclusion — not the image — is on the record. No Phase 4 code path reads this file. |

All seven usable files are treated as evidence class **AUTHORIZED
FIXTURE**: real photographs, already present and already authorized in this
exact repository, read here only (never modified, never copied elsewhere,
never uploaded anywhere). This is different from **READ-ONLY REAL PRODUCT**
(a live retailer/Commerce image fetched fresh through the app's own
legitimate access) — no such access was exercised this session; see
`docs/vto-phase4-corpus-request.md` and Gate E in the final report.

Because Live VTO's own category allow-list (`DEFAULT_LIVE_VTO_SUPPORTED_
CATEGORIES = ['top']`, per the source-authority doc) is narrow, six of these
seven real photos are expected-rejection cases by category alone — which is
itself useful, honest evidence that the pipeline's fail-closed rejection
path works correctly against real photography, even though it yields very
little "successful automation" evidence. Only `top.jpg` exercises the
accept-or-correct path against a real photo.

## 4. Format/dependency decision for Phase 4's own pipeline

Given §1 (no reusable decode capability exists) and §2 (the neighboring
research workspace's zero-dependency policy does not bind this branch and,
if it did, would exclude `top.jpg`/`outerwear.jpg`/etc. outright since they
are JPEG), this lane makes one explicit, recorded dependency decision
(task section 17/18) rather than hand-rolling a JPEG decoder (DCT + Huffman
+ chroma upsampling — high implementation-risk for a single session where
pixel-level correctness feeds directly into the product-fidelity metrics
this program must not fabricate) or silently dropping every real fixture:

```
NAME:                 pngjs
VERSION:              7.0.0
LICENSE:              MIT
SOURCE:               https://registry.npmjs.org/pngjs
EXECUTION ENVIRONMENT: local Node.js (>=20), this lane's own isolated
                       package only
NETWORK REQUIRED:      NO (decode/encode is fully local; only installation
                       required a registry fetch, already completed)
MODEL FILE:            N/A (deterministic codec, not a model)

NAME:                 jpeg-js
VERSION:              0.4.4
LICENSE:              BSD-3-Clause
SOURCE:               https://registry.npmjs.org/jpeg-js
EXECUTION ENVIRONMENT: local Node.js (>=20), this lane's own isolated
                       package only
NETWORK REQUIRED:      NO
MODEL FILE:            N/A
```

Both are pure-JavaScript, no native compilation, no telemetry, no network
calls at runtime, and are added **only** to this lane's own new isolated
package (`vto-phase4-assets/package.json`) — the app's root `package.json`,
`kscan-live-vto/`'s workspace, and every other package in this repository
are untouched. This is a decode-only dependency (turning bytes into pixels),
not an ML/vision model and not a paid external CV provider — it does not
touch task section 17's "no paid external CV provider" prohibition, which is
about hosted inference services.

## 5. Two corpus concepts — where Phase 4 lands

- **A. Committed regression corpus**: this lane adds a small number of
  **procedurally generated, synthetic** PNG source images (flat garment
  shapes with programmatically drawn logos/patterns/colors — the same
  technique `kscan-live-vto/packages/static-renderer` already uses for its
  own synthetic garments, re-implemented here since that package isn't
  reachable from this branch) under `vto-phase4-assets/fixtures/synthetic/`.
  These are safe to commit and redistribute — nothing in them is derived
  from any real photograph or retailer asset.
- **B. Read-only real product evaluation**: not exercised this session. This
  lane has no legitimate, already-authorized path to a live retailer/Commerce
  product-image feed (the existing app fetches such images only from inside
  authenticated client sessions against real search providers, which this
  offline batch lane does not have standing to invoke — doing so would mean
  "broadening retailer API access," explicitly disallowed). The `assets/
  qa_fixtures/*.jpg` photos in §3 are the closest available substitute and
  are evidence-tagged **AUTHORIZED FIXTURE**, not **READ-ONLY REAL PRODUCT**.

See `docs/vto-phase4-corpus-request.md` for what a future session with
legitimate real-catalog access should gather, and the final report's Gate E
section for why this results in an engineering PASS with an economics HOLD.
