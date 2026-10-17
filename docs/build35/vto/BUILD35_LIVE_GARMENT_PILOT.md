# Build 35 Live garment pilot

The owner authorized real-product asset ingestion in the Live completion sprint. This pilot uses the **AS Colour Staple Tee 5001, Black**, category `top`. Product availability and source were checked on 2026-10-16:

- Product: https://ascolour.com/staple-tee-5001/?Colour=Black
- Retailer product imagery download page: https://ascolour.com/downloads (publishes product images for download and links its brand guidelines).
- Exact source: https://cdn11.bigcommerce.com/s-hsi95a83fz/images/stencil/850w/products/182/10681/5001_STAPLE_TEE_BLACK__80682.1774216143.jpg?c=1
- Source SHA-256: `59003a90b1987d5e09b3c86d8f8e29ee0feb07670e73dcb8dc005da35137ce49`.

This records owner-authorized engineering use of the retailer's publicly provided product image. It does not claim a retailer partnership, an endorsement, an API integration, or additional distribution rights. Any later marketing use must follow the retailer's published conditions. No generated imagery replaces the product photograph.

The unmodified Phase 4 pipeline rejected the default extraction with `EXTRACTION_UNRELIABLE` (segmentation confidence 0.448). Its existing segmentation correction at threshold **50** removes disconnected JPEG/shadow speckles and passes eligibility at **0.567**, with QA passed, complete required anchors, valid geometry and an adequate 850 x 850 source. The QA and eligibility thresholds are unchanged. Texture and alpha were visually inspected; Android's production rasterizer generated a visible garment PNG. Fidelity QA has **NO_REFERENCE** for independent color/logo/pattern ground truth; a QA pass is not a fit or photorealism certificate.

Reproduce from `vto-phase4-pipeline`: `npm ci`, `npm run build`, then `node dist/src/build35PilotCli.js`. The check reads the pinned source, runs Phase 4 with the documented correction, and compares the output texture/alpha hashes to the bundled asset. It never overwrites the accepted bundle.

Asset `ascolour-5001-black-v1`, manifest assetId `524ab66a3f16bda5c3d7f9fe`, asset version `1`, schema `1.0`, template `simple-top`, is bundled on both platforms. Full manifest/texture/alpha hashes and QA are in `evidence/build35-live-completion/source-verification.json`. Android/iOS native loaders pin those bytes and the asset ID, and reject corrupt or unregistered files.

Scanner's `makeId(provider, productUrl)` identity remains unchanged. VTO adds only an advisory productUrl; the Live resolver matches the approved retailer URL **and** exact black product-image identity. It ignores known tracking parameters while preserving colour, path and host. Missing colour, duplicate colour, another variant, another image, or another retailer fails closed. The native descriptor keeps the selected commerce productRef. Unsupported products retain the ordinary Photo VTO path.

Coverage is one genuine top, plus two explicitly identified research fixtures. No five-product coverage claim is made. Expanding the pilot requires running additional legitimate source images through the same acceptance process, with variant-specific identity and integrity records.
