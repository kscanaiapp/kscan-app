# Secure Image Ingestion Inventory — Phase 1

- **Date**: 2026-08-03
- **Repository**: kscanaiapp/kscan-app
- **Branch**: security/secure-image-ingestion-gate
- **Base**: `ios/full-submission-readiness-v2` @ `cd418c7` (PR #45 merged — public ingress/perimeter hardening)
- **Scope**: binary image content only. General API-surface exposure is already covered by `docs/security/public-ingress-inventory.md` / `docs/security/supabase-exposure-audit.md`; this document extends that program to image-specific content safety (format validation, malware, quarantine), which the prior passes explicitly did not cover.

## Headline correction to the Zero-Knowledge premise

The strategic brief for this work assumes faces and license plates are already masked on-device before any image leaves the device. **That is not true on this branch, on any platform, on any active path.**

- `services/privacyImageSanitizer.js` is the only masking code in the app. It is a hard-coded passthrough: `SANITIZER_STATUS = { faceDetectionAvailable: false, faceBlurApplied: false, mode: 'passthrough' }`, and `sanitizeImageBeforeUpload()` returns its input unchanged with a comment "v1 is intentionally pass-through." It cannot fail, cannot block, and never masks anything — fail-open by construction, not fail-closed.
- It is called from exactly **one** of the four active upload paths (Camera Scan → `/api/analyze`). The other two live upload paths (Dressing Room "Add Scan", Style Library/Inspiration upload) never call it at all — they rely solely on advisory UI copy ("avoid faces, bystanders...") with zero technical enforcement.
- A separate, more sophisticated fail-closed design (`isImageDispatchAllowed`, `services/privacy/**`, native face/plate detection) referenced in prior session notes **does not exist in this repository** — it does not exist on this branch, and repo-wide search found no trace of it on any ref reachable from here. Older internal notes describing it are stale.
- The only place a stricter design exists is `kscan-google-glasses/docs/PRIVACY_PIPELINE.md`, describing an **aspirational** fail-closed pipeline for an unrelated, unwired smart-glasses sub-package (`kscan-google-glasses/`, own `package.json`, never imported by the shipping app). It documents intent, not shipping behavior.

**Consequence for this design**: the Ingestion Gate cannot be built as a second layer behind a working ZK mask — it is, today, the *only* layer. It must not assume upstream masking has occurred, and nothing in Phases 3–10 should be gated on `sanitizeImageBeforeUpload` having done anything.

## Ingress inventory

### 1. Camera Scan → Render `/api/analyze`

| | |
|---|---|
| Caller | `app.js:421-425` (`CameraView`) → `hooks/useKScan.js:77-190` |
| Pipeline | `compressForUpload` (`services/imageUtils.js:20-74`, resize ≤896px, JPEG q0.65) → `sanitizeImageBeforeUpload` (no-op, see above) → `analyzeImage` (`services/api.js:126-160`) |
| Endpoint | `POST https://kscan-app-1.onrender.com/api/analyze` (Render, `server.js:1438`) |
| Auth | **None** — fully anonymous, no API key/app-attestation (`server.js:1438-1662` full route read) |
| Account-state enforcement | None |
| Transport | `fetch` JSON body, `{ image: base64DataUri }` |
| Max request size | Express `express.json({ limit: '15mb' })` (`server.js:1203`), post-buffer; app-level `MAX_BASE64_BYTES = 20MB` check (`server.js:1418`) is redundant/looser and runs after Express has already buffered the body |
| Formats accepted | Client MIME string only, from `data:image/xxx;base64,` prefix; allowlist `{jpeg,png,webp,heic}` (`server.js:1416`) — **never derived from actual bytes**. Bare base64 (no prefix) defaults to `'image/jpeg'` unconditionally (`server.js:1263`), which short-circuits the MIME check entirely |
| PII masking before transit | No-op passthrough only (see above) |
| Bytes enter Storage | No — memory only, no `fs`/temp-file writes anywhere in `server.js` |
| Bytes logged | No — logs length/typeof only (`server.js:1440-1466`), never raw content |
| Downstream provider | Google Gemini (`generativelanguage.googleapis.com`, 20s timeout) and/or OpenRouter (11s timeout, retry ≤3s) depending on `USE_OPENROUTER` |
| Current timeout | Gemini 20000ms; OpenRouter 11000ms + capped retry; soft server budget 14500ms (warning only, not enforced) |
| Retention/deletion | N/A — never persisted |
| Malware/content validation | **None** — no magic-byte, decode, or dimension check anywhere before the provider call |
| Bypass paths | Bare-base64 payload bypasses the MIME allowlist entirely (see above); no `trust proxy` set, so the per-IP rate limiter's IP attribution behind Render's proxy is unverified from source |

Also present, structurally identical but **unreachable**: dormant `app/api/analyze+api.js` (Expo Router `+api` route) — no Vercel/web hosting target exists anywhere in the repo, confirmed unreachable. Strictly weaker than `server.js` (no rate limit, no size limit, no MIME check at all) — must never be deployed without the same gate applied to `/api/analyze`.

### 2. Dressing Room "Add Scan" (live result or reopened saved scan) → Supabase Storage

| | |
|---|---|
| Caller | `components/AddScanToDressingRoomModal.tsx:76-93`, from `app.js:682-694` and `app/library.tsx:428-444` |
| Pipeline | `uploadLocalScanImage` (`services/styleObjects.ts:134-179`): resize 1440px/q0.86 via `expo-image-manipulator` → `base64ToArrayBuffer` → `supabase.storage.from('style-library-images').upload(...)` |
| Auth | Supabase authenticated client SDK (user's own JWT) |
| Account-state enforcement | Owner-path RLS only (`{userId}/scans/...`); no account-state (banned/frozen) check found in this path |
| Transport | Raw binary `ArrayBuffer` PUT to Storage bucket |
| Max request size | Bucket-level cap 5MB (`supabase/migrations/202605200002_style_library_images_storage.sql:10`); no client-side pre-check |
| Formats accepted | Bucket MIME allowlist `image/jpeg,image/png,image/webp` (same migration, line 11) — enforced against the **client-declared** `Content-Type`, not sniffed content |
| PII masking before transit | **None called at all** — `sanitizeImageBeforeUpload` is never imported in `styleObjects.ts`. Advisory UI text only |
| Bytes enter Storage | **Yes, directly, with no interposed scan step** — this is the architecturally significant gap: uploaded bytes are immediately live/usable the instant the PUT succeeds |
| Bytes logged | Not found logged |
| Downstream provider | None directly from this path; object later readable by anything with owner-path RLS access (Style Library display, `get_public_room_preview` for shared rooms) |
| Current timeout | Supabase SDK default |
| Retention/deletion | Standard object lifecycle; no scan/quarantine state |
| Malware/content validation | **None** |
| Bypass paths | `Platform.OS !== 'ios'` is a **client-only UI gate** (`app.js:205`, `library.tsx:209-210`) — the underlying storage RLS and upload function are not platform-aware, so this is not a real security boundary, only a feature-visibility one |

### 3. Style Library / Dressing Room "Inspiration" upload (photo-library import) → Supabase Storage

| | |
|---|---|
| Caller | `app/library.tsx:246-265`, `app/dressing-rooms/[id].tsx:565-585` via `expo-image-picker` `launchImageLibraryAsync` |
| Pipeline | `uploadAndSaveInspiration(ToDressingRoom)` (`services/styleObjects.ts:874-983`): resize 2048px/q0.82 → same Storage upload as above |
| Auth / transport / bucket | Same as path 2 |
| Max request size | Bucket 5MB vs. a separate DB-level check permitting declared `file_size_bytes` up to **10MB** in `inspiration_items` (`supabase/migrations/20260607222310_inspiration_uploads.sql:13-14`) — a validation-drift gap between layers; picker itself requests `quality: 1` (no compression at selection time) |
| PII masking before transit | **None called** — same gap as path 2 |
| Bytes enter Storage | Yes, direct, no scan step |
| Malware/content validation | None |
| Bypass paths | Same client-only iOS UI gate as path 2 — not a real boundary |

### 4. Try-On Clothes Pro (avatar/try-on) — present, hardened, but **dead code**

| | |
|---|---|
| Client caller | `services/tryOnClothesPro.ts:64-109` — **confirmed unimported anywhere** under `app/`, `components/`, `hooks/`, `contexts/` |
| Endpoint | `supabase/functions/tryon-clothes-pro/index.ts` — JSON invoke, fields `person_image`/`top_garment`/`bottom_garment` (base64 or URL strings, untyped) |
| Auth | Supabase Edge Function default (JWT verified) |
| Max request size | `MAX_REQUEST_BODY_BYTES = 10MB`, enforced streaming via `_shared/security/validation.ts:24-61` (aborts mid-stream over limit — this is the one path in the repo with a genuine pre-buffer size cap) |
| Formats accepted | `validImageField` only checks "non-empty string, not literal `'undefined'`" (`index.ts:57-60`) — no magic-byte/MIME/decode check |
| PII masking | N/A, no live caller |
| Bytes enter Storage | No — forwarded to RapidAPI (`try-on-clothes-pro.p.rapidapi.com`, form-urlencoded), never stored |
| Downstream provider | RapidAPI, 20s timeout, retry ≤2 attempts |
| Deployment status | **Held / undeployed** — absent from `security/scripts/staging-deployment-allowlist.js`; function's own header comment confirms no live caller |
| Relevance | This is the one code shape built for both a URL-based image import ("remote URL sent for backend to fetch") and provider-image-reuse (garment images could be prior try-on outputs) — inert today, but the template most likely to need `CLEAN`-verdict gating if ever wired up |

### 5. `scan-identify` (referenced pervasively in prior session history) — **not present on this base branch**

Repo search confirms `supabase/functions/` on this branch contains no `scan-identify` directory. Existing docs corroborate: `docs/security/provider-edge-authentication.md:28` states plainly that `scan-identify` "is not on the verified security base branch... not yet hardened." This function exists on a separate Android/scanner-lineage branch family not merged into `ios/full-submission-readiness-v2`. **This inventory treats it as out of scope for this branch** — if/when that lineage merges here, it must pass through this same Ingestion Gate before being considered covered; it is explicitly called out as a known gap in Phase 12's CI gate (route-classification check) so it cannot silently ship uncovered.

### 6. Product-image references (URL-only, not re-uploaded)

`services/styleObjects.ts:202-245` (`buildProductMatchSnapshot`) and `services/nikeShoeDetails.ts`, `services/productSearchDeals.ts`, `services/secondhand.js` store/display retailer product images **by URL reference only** — no byte re-upload, no server-side fetch of the URL by K Scan. Not an ingress site; noted so future work doesn't assume otherwise.

### 7. Public Shared Room (`app/(public)/rooms/[token].tsx`)

Read-only fetch to `www.kscan.app/api/rooms/{token}` (external site, out of repo scope); renders served image URLs only, `allowImport: false`. Not an ingress site. `get_public_room_preview` RPC does return `imageStorageBucket`/`imageStoragePath` metadata to `anon` callers holding a valid share token (`supabase/migrations/202605240003_...sql:100-119,169-179`) — object bytes stay owner-RLS-protected, but this is noted as a metadata-exposure fact relevant to Phase 9 (a share-token holder must never be treated as equivalent to the image's owner for verdict purposes).

### 8. Style Chat — confirmed text-only

`services/style-chat/buildStyleChatContext.ts:5` — explicit contract: "Must never include raw images, biometrics, body-type inference." No image-attach UI exists anywhere under `components/style-chat/*` or `app/style-chat/*`. **No "TextScan image attachment" feature exists under that name on this branch** — the brief's reference to it does not correspond to current code; flagged rather than fabricated.

### 9. Smart-glasses ("glasses-originated images") — unimplemented stub, isolated sub-package

`kscan-google-glasses/` and `phone-bridge/` are a separate, unwired sub-package (own `package.json`, never imported by the shipping app). `phone-bridge/src/PhotoCaptureRelay.ts:1-6` (`captureForGlasses()`) **throws `'PhotoCaptureRelay not implemented'`** — a literal stub. `SupabaseSessionRelay.publish` is a no-op with a comment "never include auth tokens or image data in logs." No live ingress today. Recorded so the Gate's design (format/size/scan/verdict as a shared reusable module, not endpoint-specific) is the correct shape to absorb this path later without rework.

### 10. Signed upload URLs — not used anywhere

Repo-wide search: zero hits for `createSignedUploadUrl`/`uploadToSignedUrl`. All client Storage writes use the authenticated SDK's direct `.upload()` call under the user's own JWT, gated by bucket MIME/size config and owner-path RLS — not by a signed-URL flow. `createSignedUrl` (download-only, bounded TTL) is used for read access (`services/styleObjects.ts:181-187,834-838`). This shapes Phase 4: the "preferred stored-upload model" quarantine architecture must be retrofitted onto direct-SDK-upload call sites, not onto a signed-URL exchange that doesn't exist.

## Cross-cutting findings

- **No image-processing library exists server-side.** No `sharp`, `libvips`, or `jimp` anywhere in `package.json` or non-`node_modules` code. Client-side `expo-image-manipulator`/`expo-image-picker` run on-device only. Phase 6 (decode/re-encode) will be the first introduction of a server-side image library into this stack.
- **No malware/AV scanning exists anywhere** — zero references to ClamAV/clamd/virus/malware in code, `render.yaml`, `Procfile`, or docs.
- **No SSRF-style arbitrary-URL image fetch exists** — every server-side `fetch()` in the repo targets a hardcoded provider/Supabase host; no code fetches a client-supplied URL as an image today. Noted as a constraint to preserve (Phase 3's "safe decoder probe" must not introduce this).
- **`_shared/security/validation.ts` and `_shared/security/logging.ts`** (used by the 6 hardened Edge Functions) provide size-bounded reads, schema validation, and privacy-safe logging, but contain **zero** magic-byte/MIME-sniffing/decode utilities. The Ingestion Gate is new capability, not an extension of an existing image-validation module — there isn't one.
- **Naming collisions checked**: no existing bucket/table/script uses "quarantine," "ingestion-gate," or "clean-image" naming. `style-library-images` and `investor-docs` are the only two Storage buckets today; new quarantine/clean buckets are free to name without collision.
- **Size-cap drift already exists** between `style-library-images` (5MB, storage-engine-enforced) and `inspiration_items.file_size_bytes` (10MB, DB-check-enforced) — the Gate's policy manifest (Phase 2) must be the single source of truth these both defer to, closing this drift rather than adding a third value.

## Summary table

| Ingress path | Auth | Format check | Malware scan | Storage quarantine | Provider submission |
|---|---|---|---|---|---|
| Camera Scan → `/api/analyze` | None (anon) | Client-asserted MIME only | None | N/A (memory-only) | Gemini / OpenRouter |
| Dressing Room "Add Scan" → Storage | User JWT | Client-declared Content-Type only | None | **None — direct to live bucket** | None directly |
| Inspiration upload → Storage | User JWT | Client-declared Content-Type only | None | **None — direct to live bucket** | None directly |
| `tryon-clothes-pro` (held) | User JWT | "Non-empty string" only | None | N/A (no storage write) | RapidAPI (dormant) |
| `scan-identify` | — | — | — | — | Not present on this branch |
| Dormant `app/api/analyze+api.js` | None | None (weaker than `/api/analyze`) | None | N/A | Gemini (unreachable) |

Every active path that accepts image content today has **zero server-side content validation and zero malware scanning**. This is the baseline Phases 2–10 must close.
