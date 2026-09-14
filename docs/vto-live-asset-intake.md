# VTO LIVE ASSET INTAKE SPECIFICATION

**Status:** source-complete. Every stage below is an existing, committed tool
or gate — nothing in this document describes work that still has to be built.
**Owner action it unblocks:** turning rights-cleared garment imagery into Live
coverage without an engineering project per garment.

This is the answer to one question: *what does somebody have to hand us, and
what do they run, to make one more product Live-eligible?*

Today `CURRENT_GOVERNED_LIVE_ASSETS = 2`. Both are Phase-4 outputs from
synthetic sources. The bottleneck is **source material, not engineering** —
see §9.

---

## 1. Source rights requirement

**A garment image may enter this pipeline only if K Scan has the right to
process it AND to redistribute the derived texture inside a shipped mobile
binary.** A Live asset is not a transient render: `texture.png` and
`alpha.png` are compiled into the Android APK and the iOS app bundle.

| Allowed source type | Why |
| --- | --- |
| **Owned photography** — a garment K Scan photographed itself | Unambiguous. Preferred. |
| **Brand/retailer imagery under a written licence that permits redistribution in an app binary** | The licence must cover *derivative works* and *binary redistribution*, not just display. |
| **Synthetic / procedurally generated** | What both current assets are. Fine for fixtures and negative controls; not a customer garment. |

**Refused outright:**

- scraped retailer imagery,
- "found on the brand's site" imagery with no licence record,
- imagery whose rights status is *unknown* (unknown is not permission),
- any image a person cannot point at a licence or a shoot for.

`__tests__/vtoLivePilotNegativeControls.test.js` pins the governed asset count
and the rights record an addition needs, so a quiet append fails a test rather
than shipping.

## 2. Required image view

| Requirement | Value | Why |
| --- | --- | --- |
| **View** | Flat-lay or ghost-mannequin, garment facing the camera, front view | The pipeline's shot classifier marks a model-worn image `HARD` on skin-tone presence alone (`vto-phase4-pipeline/src/shotClassifier.ts` — `skin_tone_presence_suggests_model_worn`) and the extraction policy refuses HARD sources (`EXTRACTION_REFUSED_BY_POLICY`). A model shot is the single most common reason a submission fails. |
| **Garment state** | Whole garment in frame, uncropped, not folded, sleeves visible | `CROP_INCOMPLETE` |
| **Occlusion** | No hands, hangers across the garment, props, or overlapping items | `OCCLUSION_TOO_HIGH`, `MULTIPLE_GARMENTS`, `GARMENT_NOT_PRIMARY` |
| **One garment per image** | Exactly one | `MULTIPLE_GARMENTS` |

## 3. Background, alpha, format, dimensions, colour

| Requirement | Value |
| --- | --- |
| **Background** | Uniform and clearly separable from the garment (plain white/grey is ideal). The classifier's `EASY` path is literally `uniform_background_single_compact_foreground`. |
| **Alpha in the SOURCE** | Not required. The pipeline produces the mask; a pre-cut source with a clean alpha is accepted and helps. |
| **Alpha in the OUTPUT** | Required and produced by the pipeline as `alpha.png` alongside `texture.png`. |
| **Format** | PNG or JPEG, decodable by the pipeline's own decoder. |
| **Dimensions** | The *garment region's* short side after cropping is what matters, not the file's. `ADEQUATE_SHORT_SIDE_PX = 256`; below `QUESTIONABLE_SHORT_SIDE_PX = 128` is effectively unusable (`vto-phase4-pipeline/src/sourceAdequacy.ts`). Submit the largest original available — a garment occupying a small fraction of a large image is still a small texture. `SOURCE_TOO_SMALL` is a rejection code. |
| **Colour space** | sRGB. The pipeline does no colour management; a wide-gamut source will shift. |

## 4. Category and product mapping

| Field | Rule |
| --- | --- |
| **Garment category** | Must canonicalize (`services/vto/vtoEligibility.ts#toCanonicalVtoCategory`) to a token in `TEMPLATE_FAMILY_BY_CANONICAL` (`services/vto/vtoLiveGarment.ts`). **Today that is the single token `top`.** Outerwear, blazers, dresses and bottoms have no Live template family — they are not "not yet approved", they are not implemented in the native runtime. |
| **Template family** | `t-shirt` \| `simple-top` \| `sweater` (`LIVE_SUPPORTED_TEMPLATE_FAMILIES`). |
| **`productRef`** | The commerce `productRef` the asset addresses, **exact**. This is the only key the runtime matches on, and it matches by string equality — there is no nearest-match, same-category or same-colour substitution anywhere in the resolver. An asset whose `productRef` does not equal the product's is an asset for a different product. |

## 5. Run the factory

```
cd vto-phase4-pipeline
npm run pipeline:run
```

Inputs are product records with one or more image refs; outputs land in
`fixtures/vto-phase4/generated/<assetId>/` as `manifest.json`, `texture.png`,
`alpha.png`, with a batch report in `evidence/vto-phase4-assets/`.

## 6. Read the generated descriptor

The manifest is the verdict. The fields that decide everything:

| Field | Accept when |
| --- | --- |
| `eligibility.live2d` | `true`. Produced by `resolveEligibility` — `false` whenever a rejection exists or overall confidence `< ELIGIBILITY_CONFIDENCE_THRESHOLD (0.5)`. |
| `eligibility.reason` | `null`. Any other value names the rejection code. |
| `qa.passed` | `true`. |
| `shotClassification.shotClass` | `EASY` or `MEDIUM`. `HARD`/`UNSUPPORTED` means the source has to be reshot, not retried. |
| `productIdentity.productRef` | Exactly the commerce `productRef`. |
| `productIdentity.category` | The canonical token. |
| `ksgarment.version` | `1.0` (`KSGARMENT_SCHEMA_VERSION`). A mismatch fails resolution closed. |
| `source.sha256` | Recorded. This is the provenance handle the rights record is filed against. |
| `evidenceClass` | `SYNTHETIC`, `AUTHORIZED_FIXTURE`, `READ_ONLY_REAL_PRODUCT` or `COMMITTED_REAL_PRODUCT_FIXTURE`. A customer garment is the last of these and must carry its rights record. |

A rejected manifest is a **result**, not a failure of the tooling. The
correction path (`vto-phase4-pipeline/src/correction.ts`, `SHOT_CLASS_OVERRIDE`)
exists for borderline MEDIUM cases and logs every override to
`evidence/vto-phase4-assets/corrections.jsonl`.

## 7. Bundle for both platforms

Copy the accepted asset directory **verbatim and byte-identically** to both:

```
modules/kscan-live-vto-native/android/src/main/assets/<assetKey>/
modules/kscan-live-vto-native/ios/Assets/<assetKey>/
    manifest.json
    texture.png
    alpha.png
```

`<assetKey>` is a plain directory name — never a path, never absolute, never
containing `..`. It is the only string the native loader uses to choose a
folder, and it is never caller-supplied.

## 8. Register, then prove

1. **Allowlist** — add `<assetKey>` to `LIVE_VTO_ASSET_KEY_ALLOWLIST`
   (`services/vto/vtoLiveGarmentRegistry.ts`).
2. **Registry entry** — add a `LiveVtoGovernedAssetEntry` with the fields
   copied from the real manifest: `assetKey`, `assetId`, `assetVersion`,
   `ksgarmentSchemaVersion`, `productRef`, `canonicalCategory`,
   `templateFamily`, `eligible`, `ineligibleReason`, `qaPassed`,
   `sourceSha256`.
3. **Parity test** — `node --test __tests__/vtoLiveGarmentRegistryParity.test.js`.
   It reads the real files off disk on **both** platforms, re-hashes them, and
   asserts every declared field and the cross-platform byte parity. An asset
   added without this passing has not been added.
4. **Coverage** — add the product to `__tests__/vtoCoverageCorpus.json` and run
   `node --test __tests__/vtoCoverageReport.test.js`. `LIVE_FIXTURE_ELIGIBILITY`
   is asserted against `LIVE_VTO_GOVERNED_ASSETS.length`, so registry and
   corpus cannot drift apart.
5. **Negative controls** — `node --test __tests__/vtoLivePilotNegativeControls.test.js`,
   which pins the governed asset count deliberately.
6. **Visual review** — a person looks at `texture.png` over `alpha.png` and at
   the rendered result on a device, and signs off. **No automated gate replaces
   this.** The pipeline's QA measures self-consistency (fill ratio, compactness,
   colour delta against a known fill) — for a real product photo most QA
   dimensions report `NO_REFERENCE`, because no independent ground truth for
   that garment's logo, pattern or colour exists. The machine can say the asset
   is well-formed. Only a person can say it looks like the garment.

## 9. What is actually blocking expansion

```
LIVE_ASSET_EXPANSION_BLOCKED_BY_SOURCE_MATERIAL = YES
```

Not the pipeline, not the registry, not the runtime, and not this lane.

No rights-cleared garment imagery exists in this repository or in approved
project inputs. Every governed asset today derives from a synthetic source.
Gate E's measurement on a real catalogue found **3 of 220** real products
LIVE2D-eligible, and the dominant rejections were source-shape problems
(model-worn, occluded, too small) — which is a photography brief, not an
algorithm gap.

**What the owner can supply to unlock Live garments, in order of value:**

1. **A small set of owned flat-lay photographs** — 10–20 tops (t-shirt /
   simple-top / sweater), plain background, front view, unoccluded, garment
   short side ≥ 512px, sRGB, mapped to real commerce `productRef` values.
   This is the single highest-value unblock and needs no licence negotiation.
2. **A written brand/retailer licence** covering derivative works and binary
   redistribution, plus the source files it covers.
3. **A native-runtime decision** on a second template family, if Live coverage
   beyond tops is wanted. That is engineering, not procurement, and is out of
   scope here — the category vocabulary is narrow because the runtime
   implements one family, not because policy narrowed it.

Steps 1–8 above are mechanical. Step 0 — the source material — is the project.
