# Phase 2A Image Identification Loop Audit

Audit date: 2026-07-27  
Scope: Android and iOS Scanner/Elise fashion-image paths, production Edge Functions, commerce, persistence, multi-image behavior, and metadata governance.  
Evidence type: source tracing, deterministic contract tests, Git history, and read-only Supabase deployment inspection. No production writes or deployments were made. The reported tan jacket and grey Nike sneaker images were not provided, so neither incident was reproduced and no visual-accuracy claim is made.

## Executive result

The active paths are mapped and the production backend is identified. Current path consistency is not achieved: Android Elise gallery uses `scan-identify`, iOS production Elise direct attachments use `stylechat-generate`, the iOS visual-context gallery path does not transmit image evidence, Android supports up to five Scanner images while iOS Scanner supports one, and persisted Recent Scans flatten rich identification fields.

Four confirmed blockers were repaired without changing prompts, models, thresholds, commerce ordering, schemas, flags, dependencies, versions, or production infrastructure:

1. iOS Scanner falsely attested that face/plate privacy filtering had run.
2. Legacy Elise intake on both platforms made the same false attestation.
3. Legacy Elise intake read nonexistent top-level `metadata`/`result`, causing completed `scan-identify` responses to enter the “I couldn’t identify this item” fallback.
4. Cloud saved-scan mapping persisted device-local `file://` image and thumbnail paths.

No unresolved false privacy attestation or cloud write of a new device-local image path remains in the audited paths. Phase 2B is nevertheless not a clean frame yet because the iOS branch contains deployable Edge Function source that differs from production, the iOS visual-context upload can present an image locally without sending image evidence, and rich structured identification is still not reconstructable after save/reopen.

## 1. Repository and deployment baseline

### Git tips verified after `git fetch origin --prune`

| Branch | Actual remote tip | Recorded/expected | Result |
|---|---|---|---|
| `integration/android-v27-closet-release-candidate` | `37b7141431f8b33029918ce15d28d2ba422eae38` | same | match |
| `fix/android-scanner-gallery-upload-audit` | `a015d7ed6f45c5819cbad5861fb17a146b5e240d` | same | match |
| `integration/ios-v18-release-candidate` | `435e4bae1df0c6d50c22cdad42a80eb5d460ff69` | same | match |
| `fix/ios-scanner-gallery-upload-audit` | `f3014cf12af9cf7e30cd24ab7d246cb0a40f4b10` | same | match |

### Isolated worktrees

| Platform | Worktree | Audit branch | Starting SHA | Started clean |
|---|---|---|---|---|
| Android | `C:\src\KScan-android-identification-loop-audit` | `audit/android-identification-loop-v2` | `a015d7ed6f45c5819cbad5861fb17a146b5e240d` | yes |
| iOS | `C:\src\KScan-ios-identification-loop-audit` | `audit/ios-identification-loop-v2` | `f3014cf12af9cf7e30cd24ab7d246cb0a40f4b10` | yes |

### Production source ownership

The production project is Supabase project `wyyuqfdxucjksghsmhry`, named **KScan App Production**, region `us-east-2`, state `ACTIVE_HEALTHY`. Both production EAS profiles reference this project. The Android tree also has `supabase/config.toml` linked to it; the iOS tree has no equivalent config file. A second project, `yzqjvdfgefveprobvvyw` (**K Scan Privacy Controls**), contains a stale `stylechat-generate` v47 but no `scan-identify`; it is not referenced by the audited production clients.

| Function | Production function ID | Version/state | Updated UTC | Deployed bundle hash | Git content relationship | Canonical |
|---|---|---|---|---|---|---|
| `scan-identify` | `90373b68-99db-44f3-a063-171f8827a548` | v139 / ACTIVE / `verify_jwt=false` | 2026-07-25 17:25:00.715 | `4d73293328dd64319073ce7eb6218aad4a4510472db888b4e536c653a7d5dcf2` | all 29 deployed files content-match Android baseline `a015d7e`; local entry SHA-256 `C8D2E97E529D987BCC22AF96FED83FF1B7FA1A44A5471FD88DA64E1E0D680C7B` | identified |
| `stylechat-generate` | `e8461816-9d68-4373-a14f-9bda983a5891` | v82 / ACTIVE / `verify_jwt=true` | 2026-07-25 17:27:13.281 | `9117a553b4fde68afb12bc20cecacfdac6378e6984fe11a92e8c9d45b24c0095` | all 33 deployed files content-match Android baseline `a015d7e`; local entry SHA-256 `371FC411E659A849AE03B137D22DDF317272B622EC434730D66E63F3E6DA2944` | identified |

The deployed service does not expose a Git commit field. The relationship above is a complete deployed-file content comparison, not an inference from timestamps. The iOS branch does **not** match production: its `scan-identify/index.ts` SHA-256 is `4164FA012BF0C5C0BD563F9D87935FCC0BCDA3A82ED8DF2702EE4118B88546AC`; its `stylechat-generate/index.ts` SHA-256 is `E19F9EE40EBF1D14956A1753C720309F3F12721FED4E909028A8CC001F3268F9`; it also lacks `_shared/llmModelRouting.ts` and differs in `stylechat-generate/modelRouting.ts`.

There is one repository path for each function per branch, but two divergent branch copies can be deployed manually. Deployment documentation permits `supabase functions deploy ...` from a linked checkout, and no CI hash gate restricts it to the canonical tree. Canonical source is therefore identified but not protected from future drift.

Canonical-source checklist:

- Canonical `scan-identify` source: IDENTIFIED.
- Canonical Elise visual source: IDENTIFIED (`stylechat-generate` v82 plus `scan-identify` for Scanner handoff/Android legacy intake).
- Deployed function version: IDENTIFIED.
- Deployed source relationship to Git: IDENTIFIED by full-bundle content equality; deployment commit metadata is absent.
- Permitted deployment path: NOT RESTRICTED; multiple branch checkouts remain technically deployable.

## 2. Verified path maps

### Android Scanner camera

`app/scan/index.tsx` → root `app.js` → `LiveScanCamera` → Expo `CameraView` (rear-facing) → `useKScan.capturePhoto()` → `takePictureAsync({ quality: 0.7 })` → camera `uri`/width/height/format result → `compressForUpload()` → ImageManipulator JPEG, width 896, quality 0.65, Base64 → Android `preparePrivacyAdaptedImage()` passthrough with `localPrivacyFiltered=false` → `identifyScanImage()` → Supabase `scan-identify`.

`skipProcessing` is not enabled, so Expo Camera’s orientation-adjustment pipeline remains active. `exif` and `base64` are not requested from the camera. The application does not explicitly read orientation or EXIF. It temporarily retains native dimensions in `photo`, but dimensions are not included in the identification request or governed metadata.

Android sends one detection request per source image with `multiItemDetection=true` and `requestMode=multi_item_detection`. For confirmed candidates it sends `requestMode=selected_item`, candidate bounds/identity, the exact prepared Base64 image, and the digest returned by detection. Selected-item calls are FIFO; completed items render progressively. The result is automatically persisted through `saveScan()` under a captured actor request.

### Android Scanner gallery

Scanner upload control → `useKScan.selectGalleryPhoto()`/`pickGalleryPhotos()` → `ImagePicker.launchImageLibraryAsync()` with images only, quality 1, no editing, production multi-select up to five, ordered selection → asset `type`/`uri` validation → `normalizeImageSelections()` → the same `compressForUpload()` and privacy adapter used by camera → the same `identifyScanImage()` schema and backend.

EXIF and picker Base64 are not requested. The Expo asset can expose width, height, filename, size, MIME, asset ID, and optional EXIF, but the active normalizer retains only URI, source, order, and an asset ID-derived local image ID. It does not transmit filename, asset ID, dimensions, MIME, or EXIF. `file://` and `content://` URIs are passed to ImageManipulator; no separate content-URI copy/normalizer exists. Screenshots and original photos use identical code. ImageManipulator creates a new JPEG derivative, so raw source EXIF is not in the transmitted Base64.

### Android Elise camera

No direct Elise camera action and no Elise-to-Scanner handoff exist on the audited Android branch. The production composer exposes “Upload a Photo,” which opens the gallery-only legacy intake.

### Android Elise gallery

`app/style-chat/[sessionId].tsx` → `StyleChatAttachmentBar` → `StyleChatPhotoIntake` → gallery picker (single image, quality 1) → passthrough sanitizer → ImageManipulator JPEG width 1024, quality 0.8, Base64 → `identifyScanImage()` legacy single-item request → shared `mapScanIdentifyToAnalysis()` → review → explicit Save & Attach → actor-bound local `saveScan()` → cloud `saved_scans` row → private media backing → stable saved-scan reference → later `stylechat-generate` message.

Before repair, the completed response was read as `identification.metadata`/`identification.result`; those fields do not exist on `ScanIdentifyResponse`. The exact condition for the displayed fallback was therefore any null response, any non-`completed` response, **or every normal completed response with no nonexistent top-level `metadata.category`**. The repair routes the normalized response through the same Scanner mapper and passes the mapped structured analysis into save. The downstream library still persists only a reduced attribute subset; that remaining loss is documented below.

The first `scan-identify` call invokes identification and commerce. The later `stylechat-generate` call resolves the saved-scan attachment and generates conversational styling. Thus this path calls both functions, in that order.

### iOS Scanner camera

The route, `CameraView`, capture options, 896/0.65 JPEG Base64 preprocessing, backend, and response mapper are materially the same as Android. iOS creates an explicit scan session and client digest during detection. It supports multiple garments in one image but only one source image. After repair, the sanitizer status produces `localPrivacyFiltered=false`, and omission in the request adapter also defaults to false.

### iOS Scanner gallery

The active picker is single-select (`allowsMultipleSelection=false`), images only, quality 1, no editing. It reads only `asset.uri` and `asset.type`, then uses the same Scanner preprocessing and request schema as the iOS camera path. EXIF is not requested. Screenshots and photos are not distinguished. The same backend and persistence side effects apply.

### iOS Elise camera — two active mechanisms

1. **Direct attachment:** production `EXPO_PUBLIC_ELISE_VISUAL_ATTACHMENTS_V1_ENABLED=true` makes `StyleChatAttachmentBar.handleTakePhoto()` call Expo ImagePicker camera directly (quality 1, no editing). `prepareEliseDirectImage()` performs one metadata-stripping 896/0.65 JPEG re-encode, then creates an actor-bound placeholder saved scan and private media. It deliberately skips `scan-identify`. On a visually grounded message, `stylechat-generate` may load up to two authorized private images and invoke Gemini multimodally. The client receives narrative text, optional advice metadata, and validated actions—not the Scanner taxonomy.
2. **Scanner handoff:** the Elise header scan action creates an actor/session/revision-bound intent and routes to `/scan?returnToSessionId=...`. Scanner performs its normal `scan-identify` flow. `app.js` appends sanitized structured visual context and returns to Elise without rerunning identification. Scanner’s normal automatic Recent Scan save still fires, so this mechanism has Scanner persistence side effects.

### iOS Elise gallery — three active/latent mechanisms

1. **Direct composer attachment (production):** same 896/0.65 privacy re-encode and saved-scan attachment flow as direct camera; skips `scan-identify`, then uses `stylechat-generate` multimodal inspection when message intent triggers it.
2. **Header visual-context upload (active):** permits up to six gallery assets and re-encodes each at default 1024/0.82. It stores only local `sanitizedPreviewUri` plus placeholder context. `toServerSafeActiveContext()` intentionally removes local URIs, and this path creates no remote media backing. Therefore the image is visible in the client but image bytes are not available to `stylechat-generate`; the server receives only placeholder descriptive context. This is a P1 active-path failure.
3. **Legacy `StyleChatPhotoIntake` (production-disabled fallback):** now matches the repaired Android shared-mapper behavior and uses 896/0.65, but is not mounted while the production visual-attachments flag is true.

## 3. Processing comparison

| Step | Android Scanner camera | Android Scanner gallery | Android Elise gallery | iOS Scanner camera | iOS Scanner gallery | iOS Elise direct camera/gallery | iOS Elise context gallery |
|---|---|---|---|---|---|---|---|
| Native library | Expo Camera | Expo ImagePicker | Expo ImagePicker | Expo Camera | Expo ImagePicker | Expo ImagePicker | Expo ImagePicker |
| Source count | 1 capture; session can add gallery images | 1–5 | 1 | 1 | 1 | 1 per attachment | 1–6 |
| Native quality | 0.7 | 1 | 1 | 0.7 | 1 | 1 | 1 |
| EXIF requested/read | no/no | no/no | no/no | no/no | no/no | no/no | no/no |
| Orientation | Expo camera processing | delegated to picker/manipulator | delegated | Expo camera processing | delegated | delegated | delegated |
| Identification derivative | JPEG 896/0.65 Base64 | same | JPEG 1024/0.8 Base64 | JPEG 896/0.65 Base64 | same | JPEG URI 896/0.65 | JPEG URI 1024/0.82 |
| Metadata removal | re-encode | re-encode | re-encode | re-encode | re-encode | explicit privacy helper | explicit privacy helper |
| Face/plate masking | none/none | none/none | none/none | none/none | none/none | none/none | none/none |
| Truthful attestation after repair | false | false | false | false | false | policy says false | policy says false |
| Identification backend | `scan-identify` | same | `scan-identify` then chat | `scan-identify` | same | `stylechat-generate` only | no usable visual backend evidence |
| Body guard | 2 MiB Base64 | same | same | same | same | bounded private media server-side | n/a |
| Client timeout | 20 s/call; 52 s attempt | same | 20 s identify | 20 s/call; 32 s attempt | same | 30 s chat | 30 s chat |
| Retry | user retry; Gemini bounded fallback | same | user retry | same | same | attachment/chat retry | preparation retry |
| Duplicate/stale guard | op + generation + actor; URI duplicate | same | op ID + abort | op ID + abort + session/digest | same | op ID + actor + attachment state | queue revision + actor |
| Persistence re-encode | separate 1440/0.9 + 160/0.8 | same | same | same | same | prepared 896 image is also passed through local 1440/0.9 save, potentially upscaled; remote backing uses prepared image | none |

Camera and gallery are equivalent **within each Scanner platform**. Android and iOS request field sets are compatible, but Android has source-image batching and iOS does not. Android Elise uses a different 1024/0.8 derivative. iOS direct Elise matches Scanner’s dimensions/quality but bypasses its identification contract.

No path intentionally treats screenshots differently. No raw open-ended EXIF object is transmitted. Format is normalized to JPEG before remote image analysis. Explicit logo preservation/color-fidelity validation does not exist; 0.65 JPEG may affect small logos, but source inspection alone cannot establish a material visual loss. Real orientation, focus, noise, low-light, and logo visibility remain physical-device certification gates.

## 4. Current request contracts

| Field | Scanner camera/gallery | Android Elise gallery | iOS Elise direct camera/gallery | iOS Elise Scanner handoff | Backend accepted/persisted |
|---|---|---|---|---|---|
| Route/method | Supabase invoke `scan-identify`, POST | same, then `stylechat-generate` | `stylechat-generate`, POST | `scan-identify`, then `stylechat-generate` | both accept POST only |
| Authentication | client requires session; JWT attached | same | JWT and server attachment ownership resolution | same | `scan-identify` supports controlled anonymous mode but clients require session; StyleChat requires JWT |
| Image | raw JPEG Base64 in `imageBase64` | same | stable saved-scan reference; server loads private media | Base64 only during Scanner leg | `scan-identify` accepts one image string, max 2 MiB; StyleChat accepts references, not local URI |
| Image array | no backend array | no | max two media parts chosen server-side | no | none |
| Source | `camera` or `upload` | `upload` | saved scan source is camera/upload; attachment reference omits raw source | Scanner source | accepted/logged; source persists on saved scan |
| Actor | implicit JWT; local save uses actor request | same | actor request + JWT/RLS | same | no caller-selectable owner; server derives user |
| Metadata envelope | absent | absent | absent | absent | absent |
| Privacy | `localPrivacyFiltered=false` | false | separate honest policy locally; not the Scanner boolean | false | `scan-identify` accepts but currently does not consume/persist the boolean |
| Intent | multi-item detection/selected item | legacy single item | conversational attachment | detection/selected item, then chat | requestMode accepted by `scan-identify` |
| Correlation | iOS sends session/digest at detection; Android receives server values then reuses them | none | attachment IDs | session/digest | accepted and returned |
| Retry | no automatic client retry | no | retryable draft/chat | no | Gemini has bounded approved fallback; commerce cascades independently |

The backend accepts `appPlatform`/`appVersion`, but the audited image client adapter does not send them. It declares `localPrivacyFiltered` but does not use it in policy enforcement, response construction, or persistence.

## 5. Model, parsing, confidence, and response preservation

### Verified backend order

```text
POST/account gate → auth context → JSON/body/size validation → rate/quota gates
→ Gemini vision (14 s default cap; approved primary + one bounded fallback)
→ JSON extraction → schema sanitization → legacy/rich normalization
→ taxonomy quality normalization → deterministic quality/confidence gate
→ completed visual identification
→ [detection mode: stop, no commerce]
→ [selected/single item: live commerce, 3 s cap]
→ product_catalog retrieval + deterministic similarity score, 300 ms cap
→ response arrays + scrubbed telemetry/intelligence persistence
```

There is no separate OCR, logo specialist, moderation service, image embedding service, Pinecone, Milvus, or Llama before Gemini in the active image path. Gemini decides category/subtype and proposes visible brand evidence. The model emits one `confidence_score`; current schema has no independent classification, subtype, exact-product, or commerce confidence. The quality gate derives a quality band and can suppress weak brand/material from commerce, but it does not create the intended five independent confidences.

### Current structured field map

| Field | Model/backend schema | Parser/normalizer/client | Scanner transient | Saved/reopened | Android legacy Elise after repair | iOS direct Elise |
|---|---|---|---|---|---|---|
| category | yes (`item_type`, attributes category) | yes | yes | yes | yes | prose/placeholder only |
| subtype | yes | yes | yes | no | transient yes; reopen no | no shared field |
| brand + evidence | `brand_guess`, `visible_brand_text`, `logo_detected` | yes; client derives confidence | yes | no | transient yes; reopen no | no shared field |
| primary/secondary color | yes | yes | yes | primary flattened string; secondary not separable | same | no shared field |
| material/silhouette/pattern | yes | yes | yes | silhouette; material mapper currently writes null; pattern lost | transient then reduced | no shared field |
| fit/length/sleeve/neckline/closure | yes | yes | yes in identification; mapper exposes fit only | no | transient partially | no shared field |
| distinctive/visible attributes | yes | yes | yes | no | transient | no shared field |
| collar/pockets | no dedicated key; may appear in distinctive features | preserved only as feature text | possible | no | possible transient | prose only |
| exact product/model family/SKU | no dedicated fields | no | no | no | no | no |
| classification confidence | one global score | yes | yes | field exists but local save currently writes null | transient | no shared field |
| subtype/brand/exact/commerce confidence | no separate model fields; brand confidence derived client-side | brand only derived | brand only | no | transient brand only | no |
| alternatives | detected garments only | yes | yes | multi-scan grouping only, not full alternatives | no | no |
| commerce query | server metadata/logging | not in public typed response | no | no | no | no |
| purchase options | yes | yes | yes | yes | passed to save after repair, subject to library snapshot | not an identification output |
| unknown/technical reason | user-safe status/message; telemetry has richer codes | many causes collapse to `failed` | user-safe message | result only | fallback state | conversational error |

### Decision tree and symptom conditions

```text
provider/network/timeout/invalid JSON
  → normalized failed → neutral technical UI error
explicit non-fashion
  → non_fashion UI; commerce empty
completed but no usable attributes
  → backend/client failed
completed with attributes
  → structured normalization
  → multi-item detection: candidates only, commerce skipped
  → selected/single item: visual result remains completed
      → commerce success: purchase options populated
      → commerce timeout/error/no results: empty purchase options, visual result still completed
  → client title:
      high-confidence brand + color + category
      else optional style + color + category
      else color + category
      else category
      else raw observation / “Fashion Item”
```

“Grey Footwear” is not a literal fallback constant. It is the deterministic title produced when normalized color is Grey, category is Footwear, and there is no high-confidence brand or more specific usable title component. A Nike suggestion without visible text/logo is medium confidence unless commerce corroborates it, so Nike can be omitted. The personal sneaker was not reproduced; this condition explains how the reported generic title can arise, not why that image failed to supply stronger evidence.

The exact “I couldn’t identify this item” text belongs to legacy `StyleChatPhotoIntake`. Before repair it was reached by valid completed responses because the component inspected the wrong response shape. After repair it is limited to null, failed, non-fashion, mapper failure, or completed responses with no mapped category. iOS production direct attachments do not use this component.

Useful partial data can still be lost: multi-item garment sanitization requires several candidate fields, saved-scan persistence flattens rich output, and direct iOS Elise never creates the Scanner identification object. These are structural follow-ups, not proof about the original jacket.

## 6. Commerce flow and contamination

| Provider/system | Current role | Order | Input | Can change classification? | Runtime enabled evidence |
|---|---|---|---|---|---|
| Gemini Flash | visual classification and rich attributes | first semantic stage | JPEG Base64 | yes, it originates classification | deployed source active; exact model route is allowlisted |
| KicksCrew | sneaker/footwear commerce | first live provider for sneaker routes | weighted identification query | no | conditional on env/key; source present |
| Farfetch | general commerce; supplements sneakers | after KicksCrew or first non-sneaker | same | no | conditional on env/key; source present |
| Serper | shopping fallback | after insufficient KicksCrew/Farfetch | same/fallback query | no | conditional on env/key |
| Brave | fallback from shopping provider | after Serper path | query | no | conditional on env/key |
| Supabase `product_catalog` | catalog candidate source | after live commerce | canonical category | no | authenticated catalog client |
| deterministic similarity matcher | 0–100 metadata score; threshold 60 | after catalog fetch | category 30, brand 25, color 20, subtype 10, other 15 | no | source active; no embeddings/vector DB |

The router caps requested results at ten, prioritizes KicksCrew then Farfetch then Serper/Brave, deduplicates by normalized URL, applies category/attribute agreement filtering, and may run a broader fallback query if valid coverage is low. Generic category/color input necessarily creates broad queries and is the main code-established entry point for unrelated products. Missing/weak brand is intentionally excluded from commerce when evidence is insufficient.

Commerce runs only after visual parsing/normalization. Its timeout/error returns empty arrays and cannot turn a completed visual response into unknown, replace category/subtype, or delete the identification. The client mapper keeps visual identification separately recoverable. One display-only coupling remains: `deriveBrandConfidence()` can promote a commerce-only brand when the same brand appears across three distinct provider/retailer results, affecting the title without mutating the underlying identification. This is a P2 trust/presentation issue for Phase 2E.

## 7. Multi-image and multi-angle behavior

Android Scanner accepts up to five ordered camera/gallery source images. It prepares each once and sends one parallel detection request per image. Responses are flattened in source order and garment order, capped at five candidates. URI equality prevents the same selected asset from being added twice; candidate fingerprinting removes duplicate candidates only within the same source/bounds/category/subtype. There is no content-hash duplicate check and no cross-angle fusion.

After selection, commerce runs once per selected candidate, sequentially. The same garment shown from two angles can therefore become two items and receive two commerce calls. A logo close-up is an independent image/candidate, not supplemental brand evidence. Conflicts are not fused or surfaced as an item-level conflict.

iOS Scanner supports one source image and multiple garments within it. iOS Elise visual context can hold six ordered entries, but uploaded image bytes are not delivered by that path. Direct attachments are separate saved-scan items, and StyleChat multimodal inspection selects at most two; it is not identification fusion.

Recommended future evidence contract (proposal only):

```ts
type FashionImageEvidence = {
  imageId: string;
  source: "scanner_camera" | "scanner_gallery" | "elise_camera" | "elise_gallery";
  angleHint?: "front" | "back" | "side" | "detail" | "logo" | "label" | "unknown";
  sequenceIndex: number;
  metadata: GovernedImageMetadata;
};
```

The shared core should validate and score each image, remove content duplicates, retain per-image observations, fuse compatible evidence, flag conflicts/different items, and run commerce once per fused item.

## 8. Metadata inventory and governance

### Actual current fields

| Field | Camera available | Gallery available | Read/retained | Sent to identification/chat | Persisted | Risk | Current purpose |
|---|---|---|---|---|---|---|---|
| pixel content | yes | yes | re-encoded derivatives | yes | local/private media | high when backgrounds contain people/plates/text | core visual function |
| local URI/path | yes | yes | local operation/persistence | not in model body; dev-only Android compression log truncates URI | local only after repair; legacy cloud rows may still contain it | high | device file access |
| width/height | camera result; derivative | picker + derivative | camera temporary; privacy helper result | no | no | governed value | resizing/possible diagnostics |
| format/MIME | camera format; gallery MIME | yes | source mostly ignored; output forced JPEG | implicit JPEG | no | governed value | validation/normalization |
| file size | not exposed by Camera result | optional picker field | not read | no | no | governed value | potential size bucket |
| filename | no | optional | not read | no | no | possible PII | none |
| asset ID | no | optional | Android uses only to derive local image ID/order | no | Android multi-scan derived ID may persist, not raw asset ID | identifier risk | local ordering |
| EXIF/orientation/GPS/make/model/lens/software/owner | available only if requested/native source contains it | EXIF available only if requested | not requested/read | raw EXIF no; re-encode strips it | no open-ended EXIF | high for GPS/owner/device | none |
| source camera/upload | yes | yes | yes | `camera`/`upload` | scan source | governed | routing/audit |
| client timestamp | generated | generated | request only | yes | not in scan row | operational | request context |
| scan session/digest | generated/derived | generated/derived | yes | yes on relevant requests | multi-scan group metadata and scrubbed operational events | governed/operational | correlation/dedup boundary |
| app platform/version | technically available | same | not supplied by image adapter | backend fields are null | telemetry may store null | operational | intended reliability |
| face/plate mask status | sanitizer knows false | false | yes after repair | false boolean or local policy | no unified envelope | high-risk truth claim | privacy truthfulness |
| consent | app state may exist elsewhere | same | not coupled to image request | no | no metadata-specific record | governance-critical | absent |

The transmitted analysis derivative and locally persisted 1440/0.9 copy are separate re-encodes. Raw EXIF is stripped before remote model transmission, but approved values are also destroyed before any governed allowlist can extract them. That is a P2 future-governance limitation, not permission to start broad collection.

Face and plate masking do not currently occur. The repaired code states that truth. Unmasked scene pixels are still sent for the user-requested visual service; any future masking/retention claim requires product/privacy approval and physical validation. No Zero-Knowledge claim is supportable.

### Proposed governed envelope (not implemented)

```ts
type GovernedImageMetadata = {
  schemaVersion: "image-metadata-v1";
  source: {
    path: "scanner_camera" | "scanner_gallery" | "elise_camera" | "elise_gallery";
    platform: "android" | "ios" | "glasses" | "other";
  };
  asset: {
    width?: number;
    height?: number;
    orientation?: number;
    mimeType?: string;
    fileSizeBucket?: string;
    contentHash?: string;
  };
  captureContext?: {
    capturedAtBucket?: string;
    coarseRegion?: string;
    angleHint?: "front" | "back" | "side" | "detail" | "logo" | "unknown";
    sequenceIndex?: number;
  };
  privacy: {
    metadataPolicyVersion: string;
    localFaceMaskApplied: boolean;
    localPlateMaskApplied: boolean;
    exactLocationRemoved: boolean;
    rawExifTransmitted: boolean;
  };
  consent: {
    analyticsAllowed: boolean;
    personalizationAllowed: boolean;
    commercialInsightsAllowed: boolean;
  };
};
```

Safe candidates are source path, dimensions, MIME, size bucket, non-reversible content hash, coarse time bucket, angle/order, preprocessing latency, payload-size bucket, contract/model version, error category, and candidate count. Exact GPS, owner/filename, full paths, persistent asset/device IDs, serial/make/model, faces/plates/background text, and embedded thumbnails require removal or separately approved purpose/consent/retention/access controls. Coarse region and time require explicit consent and purpose. Retention/deletion must follow actor ownership and RLS; retailer-neutral analytics should remain separate from image content.

## 9. Persistence and actor ownership

Scanner captures an actor request before `saveScan()`. The library checks authority before media work, after media work, and inside the serialized commit. Android rejects ownerless new durable saves; iOS permits a deliberate signed-out local partition but never uploads it. Cloud writes derive `user_id` from the authenticated session and use RLS-compatible queries. StyleChat attachment resolution revalidates authenticated ownership server-side. Scanner handoff intent is actor/session/revision-bound. No cross-account path was found.

After repair, new cloud row payloads set `image_uri` and `thumbnail_uri` to null; actor-bound `storage_bucket`/`storage_path` represent remote media. Existing legacy rows are still readable and are not migrated by this audit.

The remaining structural loss is `library.saveScan()`: it reduces mapped analysis to category, silhouette, combined color, null material, empty style tags, and null confidence. Cloud `analysis_result` then persists that subset. Full subtype, brand evidence, secondary colors, pattern, construction details, and `scanResultObject` cannot be reconstructed after reopen. Purchase options are persisted separately and survive reopen. This loss affects Scanner and legacy Elise on both platforms and blocks clean-frame certification.

## 10. Defect matrix

| ID | Severity/category | Platform/path (active?) | Evidence/root cause | Disposition/commit/test | Phase 2B impact |
|---|---|---|---|---|---|
| IMG-001 | P0 metadata governance | iOS Scanner, active | passthrough sanitizer reported no masks, but hook sent `localPrivacyFiltered=true` | fixed: `4bd3a0c`; pre-test `86621e6`; 53-path/104-suite checks | removed |
| IMG-002 | P0 metadata governance | Android legacy Elise active; iOS fallback latent | hardcoded true after passthrough sanitizer | fixed both: Android `f306822` / test `9b28e50`; iOS `10ea569` / test `39d2205` | removed |
| IMG-003 | P0 request contract | iOS adapter, active/latent callers | omitted attestation defaulted true | fixed `4b00dd4`; pre-test `061e2d2` | removed |
| IMG-004 | P1 response/field preservation | Android Elise active; iOS fallback | reads nonexistent top-level metadata/result, so completed result becomes identify_failed | fixed shared mapper: Android `53d5930` / test `2682ba3`; iOS `0450855` / test `8ddb57d` | removed for legacy path |
| IMG-005 | P0 persistence/privacy | both Scanner and Elise cloud writes, active | mapper uploaded device-local image/thumbnail paths | fixed: Android `45872f7` / test `5168471`; iOS `ec410de` / test `498debd` | removed for new writes; legacy cleanup deferred |
| IMG-006 | P1 backend ownership/deployment/platform drift | iOS branch deployable, production runtime currently correct | iOS function source differs from all deployed bundle files noted above; no deploy gate | unresolved; not changed because synchronizing production-governing function trees is broader than the P0/local repair set. Next: backend owner sync canonical tree or make clients consume a dedicated backend package, add CI bundle hash check. Dependency: release/backend ownership. Risk: accidental stale redeploy | blocks clean frame |
| IMG-007 | P1 active pipeline | iOS Elise header gallery, active | local preview URI stripped from server-safe context; no remote backing/image part | unresolved; a safe fix requires choosing/merging visual-context and attachment architecture. Next: mobile + Elise owner route uploads through canonical attachment/evidence contract. Dependency: Phase 2B/2F contract. Risk: model appears image-aware without seeing bytes | blocks clean frame |
| IMG-008 | P1 persistence/field preservation | both Scanner + legacy Elise, active | library flattens rich identification before cloud/local reopen | unresolved; not changed because durable contract design belongs to Phase 2B/2C and must be versioned/backward compatible. Next: data/mobile owners persist versioned identification snapshot using existing actor/RLS path. Risk: reopened items lose identity | blocks clean frame |
| IMG-009 | P2 shared contract/platform divergence | Android/iOS Scanner + Elise, active | Android 5 source images, iOS 1; Elise uses different backends/contracts | deferred Phase 2B/2D/2F. Required owner: mobile/backend. Dependency: shared result/evidence contract. Risk: inconsistent results/side effects | does not prevent design, prevents current consistency |
| IMG-010 | P2 multi-image | Android Scanner, active | URI-only duplicates; no cross-angle fusion/conflict; commerce per candidate | deferred Phase 2D. Owner: identification/backend. Dependency: evidence IDs/fusion contract. Risk: duplicate items/calls | mapped prerequisite |
| IMG-011 | P2 confidence dependency | shared backend/client, active | one model confidence score; client-derived brand confidence also consumes commerce votes | deferred Phase 2C/2E. Owner: ML/backend/mobile. Risk: generic titles or commerce-influenced brand | not a Phase 2B architecture blocker if contract separates fields |
| IMG-012 | P2 metadata architecture | all image paths | no allowlisted metadata envelope/consent; re-encode destroys both risky and useful source metadata | deferred governed metadata phase. Owner: privacy/data/mobile. Dependency: policy/consent/retention approval. Risk: lost analytics or unsafe future ad hoc collection | build shared core with empty/allowlisted envelope only |
| IMG-013 | P2 image preprocessing | Android Elise and iOS context upload | 1024/0.8 or 1024/0.82 differs from Scanner 896/0.65; local iOS direct persistence may upscale 896 to 1440 | deferred Phase 2B/2F. Owner: mobile. Risk: input variance/generational loss | contract must specify derivative once |
| IMG-014 | P2 commerce coupling | Scanner title only | 3-retailer commerce consensus can promote a non-visual brand into display title | deferred Phase 2E. Owner: commerce/mobile. Risk: incorrect brand presentation; structured ID stays intact | no classification overwrite blocker |
| IMG-015 | P2 observability/test coverage | both branches | no cross-branch deployed-bundle parity gate; app platform/version omitted | deferred with IMG-006. Owner: backend/release. Risk: silent drift and weaker path attribution | blocks clean frame via IMG-006 |
| IMG-016 | P3 user-facing fallback | legacy Elise | multiple technical/contract failures share identify-failed manual UI | field-shape cause fixed; granular error copy deferred | no |
| IMG-017 | P4 physical certification | both | no authorized original fixtures or physical-camera run | Phase 2G. Owner: QA/mobile; needs authorized images/devices | no audit-mapping blocker |

Cross-platform presence summary:

| Finding | Android | iOS | shared backend | Elise | Scanner |
|---|---|---|---|---|---|
| false privacy attestation (pre-repair) | legacy Elise | Scanner + legacy Elise + adapter | accepted but ignored | yes | iOS |
| wrong legacy response shape (pre-repair) | yes active | yes latent | no | yes | no |
| cloud local-path write (pre-repair) | yes | yes | database target only | yes | yes |
| stale deployable function tree | no (matches live) | yes | production runtime currently correct | potential | potential |
| rich persistence loss | yes | yes | row accepts JSON but client flattens | yes | yes |
| visual-context upload has no bytes | no path | yes | StyleChat receives no image | yes | no |

## 11. Repaired-commit inventory

Android:

```text
9b28e50 test(elise): expose false privacy attestation
f306822 fix(elise): report truthful local privacy filtering
2682ba3 test(elise): expose completed-response field loss
53d5930 fix(elise): preserve structured identification
5168471 test(privacy): expose cloud local-path persistence
45872f7 fix(privacy): keep device paths out of cloud rows
f1bbc58 fix(elise): type privacy attestation contract
```

iOS:

```text
86621e6 test(scanner): expose false privacy attestation
4bd3a0c fix(scanner): report truthful local privacy filtering
39d2205 test(elise): expose false privacy attestation
10ea569 fix(elise): report truthful local privacy filtering
061e2d2 test(scanner): expose unsafe privacy default
4b00dd4 fix(scanner): default privacy attestation to false
8ddb57d test(elise): expose completed-response field loss
0450855 fix(elise): preserve structured identification
498debd test(privacy): expose cloud local-path persistence
ec410de fix(privacy): keep device paths out of cloud rows
2cacb9b fix(elise): type privacy attestation contract
```

Every regression was observed failing before its fix and passing after it. Rollback is the individual fix commit; no schema/data migration or deployment is involved.

Post-repair validation: Android `scripts/run-all-tests.js` passed 2,054/2,054; iOS passed 1,879/1,879. Focused privacy/Elise/cloud-media suites also passed. Repository-wide `tsc --noEmit` still exits non-zero on pre-existing rollback/Deno configuration and missing optional Expo/SVG package declarations; after the final repair it reports no errors in the changed audit files.

## 12. Explicit answers

1. **Do Scanner camera and gallery use the same preprocessing?** Yes within each platform: 896/0.65 JPEG Base64 and the same privacy adapter. Android and iOS are materially aligned for a single source image.
2. **Do Android and iOS Scanner use the same request schema?** Core fields are compatible. iOS supplies session/digest during detection; Android receives server-generated values and reuses them for selected-item. Android batches multiple source images client-side; iOS does not.
3. **Does Elise use the same backend as Scanner?** Android legacy gallery yes, then StyleChat. iOS direct production camera/gallery no; it uses StyleChat multimodal. iOS Scanner handoff yes. iOS header gallery sends no image evidence.
4. **Does Elise receive structured identification or only prose?** Android legacy and iOS Scanner handoff receive structured Scanner data. iOS direct gets narrative/advice/actions, not the Scanner taxonomy. Header upload gets placeholder context.
5. **Where are category/subtype/brand/color dropped?** Model sanitization may drop malformed optional fields; multi-item sanitization can drop incomplete candidates; legacy intake dropped everything before repair; `library.saveScan()` still flattens on persistence; iOS direct never creates these shared fields.
6. **What produced “I couldn’t identify this item”?** In legacy intake, null/non-completed/missing mapped category. Pre-repair, every standard completed response also met the missing-category condition because the component read nonexistent top-level metadata.
7. **What produces “Grey Footwear”?** The title builder’s color + category fallback when no high-confidence brand or specific component survives. This is a source-established condition, not a reproduction of the personal sneaker.
8. **Does commerce run before or after visual classification?** After classification, parsing, and normalization. Detection mode skips it; selected-item/single-item runs it.
9. **How are providers used?** Gemini classifies; KicksCrew is sneaker-first, Farfetch follows/supplies general results, Serper then Brave provide fallback shopping; `product_catalog` produces separate deterministic similarity results. Runtime provider keys/enablement are environment-dependent.
10. **Can commerce overwrite identification?** No underlying category/subtype/status overwrite was found, and empty commerce cannot invalidate identification. Commerce can influence the client display brand title.
11. **How are multiple images processed?** Android sends independent parallel detection calls, then independent selected-item calls; no fusion. iOS Scanner is single-source. Elise collections are not a fashion-identification fusion system.
12. **How is metadata handled?** Native optional metadata is mostly ignored; EXIF is not requested; images are JPEG re-encoded before model transmission; raw EXIF is not sent; source/correlation fields are sent; local paths remain local after repair; no governed envelope exists.
13. **What useful metadata could be retained safely?** Explicitly allowlisted source, dimensions, MIME, size/time buckets, non-reversible content hash, sequence/angle, processing duration, payload bucket, model/contract version, error class, candidate count—subject to purpose and retention.
14. **What requires consent/coarsening/removal?** Location/time context requires consent and bucketing; exact GPS, filenames/owner names, paths, persistent asset/device IDs, hardware identifiers, and unmasked incidental people/plates/text require removal or separately approved purpose/controls.
15. **Which backend controls production?** The production v139/v82 bundles content-equivalent to Android baseline `a015d7e` in project `wyyuqfdxucjksghsmhry`.
16. **What structural failures remain?** Stale deployable iOS backend copy, image-less iOS visual-context upload, lossy saved-scan identification persistence, multi-image/platform divergence, absent governed metadata envelope, and display-brand commerce coupling.
17. **Which were repaired?** Truthful privacy flags/defaults, legacy Elise response mapping, and device-local cloud path persistence.
18. **Does any known issue block shared V2?** Yes: deployment-source drift, image-less active Elise upload, and non-reconstructable persisted identification block clean-frame certification.
19. **Is canonical source protected from drift?** No. It is identified but lacks an enforced Git/deployment hash gate.
20. **Can a useful partial identification still be discarded?** Yes, at incomplete multi-item sanitization and save/reopen flattening; direct iOS Elise also never creates it.
21. **Can Scanner and Elise lose different fields?** Yes; current consistency fails.
22. **Can Android and iOS silently diverge again?** Yes; no cross-branch parity/deployment gate exists.
23. **Is metadata handling safe enough to build upon?** The immediate false claims and new cloud local-path writes are fixed, and raw EXIF is not transmitted. A new shared core must introduce an allowlisted envelope before collecting more metadata.
24. **Does actor ownership remain correct?** Yes for every traced active save, upload, handoff, and server attachment resolution path; no unsafe actor blocker was found.
25. **Is this a clean Phase 2B frame?** No, for IMG-006/007/008.

## 13. Implementation plan

- **Phase 2B — Canonical shared identification contract:** isolate backend source from client branches; add deployment manifest/hash gate; version one request/result contract and an initially minimal governed metadata envelope; make all visual paths deliver evidence to it.
- **Phase 2C — Taxonomy and useful partial results:** separate classification/subtype/brand/exact-product/commerce confidence; persist a versioned full identification snapshot; preserve partial candidates and unknown reasons.
- **Phase 2D — Multi-angle evidence fusion:** content dedup, per-image observations, angle hints, compatible fusion, conflict/different-item states, one commerce run per item.
- **Phase 2E — Commerce compatibility:** keep visual identity immutable; require evidence before a commerce brand reaches identity-facing UI; tune category/brand/subtype compatibility without minimum-fill contamination.
- **Phase 2F — Scanner/Elise integration:** route Android/iOS camera/gallery through the shared core; preserve client-specific side effects; replace/quarantine iOS image-less visual-context upload; do not force Elise to create Scanner records unless the user entered through Scanner.
- **Phase 2G — Physical/authorized certification:** validate orientation, focus, low light, logo detail, screenshots, real gallery originals, multi-angle behavior, and the two reported images if authorized.
- **Future — Logo specialist:** separate evidence service only after the shared contract can represent logo/brand hypotheses and confidence.
- **Future — Governed metadata/monetization:** policy, consent, retention, deletion, coarse transforms, access control, and retailer-neutral analytics before any new collection.

## 14. Physical-device matrix

| Platform/path | Scanner camera | Scanner gallery | Elise camera | Elise gallery | Multi-angle |
|---|---|---|---|---|---|
| Android | code-audited only | code-audited only | not supported | code-audited only | code-audited only |
| iOS | code-audited only | code-audited only | code-audited only (direct + Scanner handoff) | code-audited only (multiple paths) | code-audited only |

No emulator or physical-device run was used as camera evidence. Physical-device certification remains pending and does not change the mapping verdict.

IMAGE LOOP AUDIT: PASS
CURRENT SHARED-PATH CONSISTENCY: FAIL
PHASE 2B CLEAN FRAME: FAIL
