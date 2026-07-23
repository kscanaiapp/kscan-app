# 06 — Upload Pipeline Trace (Phase 4)

Production path traced from user action to result, for each intake surface. Line references
are at branch HEAD unless noted.

## Scanner camera / gallery (shared) — `hooks/useKScan.js`
1. Permission (camera / library) via `expo-image-picker` / `expo-camera`.
2. Picker/camera → asset `uri` (`file://` on iOS capture; `ph://`→ picker copies to `file://`).
3. `setPhoto({uri, source:'camera'|'upload', scanSessionId})`.
4. `runAnalysis` → `compressForUpload(photo.uri)` (`services/imageUtils.js`): ImageManipulator
   resize w≤896, JPEG q0.65, **base64:true** → `data:image/jpeg;base64,…` (strips EXIF).
5. **`sanitizeImageBeforeUpload(compressed)`** (`services/privacyImageSanitizer.js`).
   - v13/HEAD: **passthrough** → returns the data URI unchanged.
   - v15: **throws** → pipeline dies here (regression).
6. `identifyScanImage(sanitized, {source, localPrivacyFiltered:true, signal})`
   (`services/scanIdentification.ts`): auth session hydration → request body
   `{imageBase64, source, localPrivacyFiltered, …optional multi-item fields}` → AbortController
   + timeout → `supabase.functions.invoke('scan-identify')`.
   - v15: returns `failed(PRIVACY_PROTECTION_REQUIRED_MESSAGE)` before invoke (regression gate).
7. `mapScanIdentifyToAnalysis` → `finishAnalysis` → state + navigation. Cleanup best-effort.

## Scanner multi-item / selected-item
`useKScan` second identify path (HEAD ~line 684) reuses `session.preparedImageUri`, sends
`requestMode`/`selectedCandidate`/`scanSessionId`. Same sanitize/identify boundary ⇒ same v15
failure, same HEAD fix.

## Elise gallery/camera attachment — `hooks/useEliseVisualContext.ts`
1. `isPrivateImageUploadAvailable()` gate (HEAD: **true**; v15: **false** → blocked).
2. `prepareImageForPrivacyUpload(rawUri)` (`services/privacyImageUpload.ts`): local-scheme
   check (`file://`/`content://`) → ImageManipulator re-encode w≤1024 JPEG q0.82 (metadata
   strip) → `{sanitizedUri, width, height, policy}`. v15: **threw unconditionally**.
3. Attachment stored in session-scoped visual context; consumed by StyleChat/Elise request.

## StyleChat intake — `components/style-chat/StyleChatPhotoIntake.tsx`
Uses shared `sanitizeImageBeforeUpload` + `identifyScanImage` → same boundary.

## saved-scan media — `services/savedScanMedia.ts`
Uses shared `sanitizeImageBeforeUpload` → same boundary for newly saved local media.

## Reuse flows (Recent Scan / saved-product / Dressing-Room / Shared-Room)
Operate on already-stored/remote image URLs and signed URLs (`sharedRoomImageResolver`,
signed-URL refresh). They do **not** pass through the local sanitizer/prepare gate, so stored
image reuse was largely unaffected by the fail-closed regression; only **new local intake** was
blocked.

## Shared vs divergent code
- **Shared** sanitize boundary: `sanitizeImageBeforeUpload` (Scanner, StyleChat, savedScanMedia).
- **Shared** availability + identify: `isPrivateImageUploadAvailable`, `identifyScanImage`.
- **Divergent** prep: Scanner uses `compressForUpload` (data URI, base64); Elise uses
  `prepareImageForPrivacyUpload` (file URI). Both re-encode via the same proven ImageManipulator
  API. No iOS/Android branch divergence in the privacy layer.
