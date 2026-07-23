# 08 — Root Cause

## Last successful step (v15 broken runtime)

User reaches Scanner / Elise and can open or attempt gallery/camera intake. For gallery, the Upload control is often already labelled **Upload Unavailable**.

## First failed step

1. **Gallery UI:** `isPrivateImageUploadAvailable()` returns `false` → button disabled (`038e96c` reinforcement of `2c8feeb`).
2. **Any analysis path that reaches prep:** `sanitizeImageBeforeUpload(compressed)` throws `PrivacySanitizerUnavailableError`.
3. **If prep were bypassed:** `identifyScanImage` returns failed via `hasCompleteLocalPrivacyProof` before `functions.invoke`.

## Introducing commit

`2c8feeb` — `fix(elise): fail closed and isolate scanner return`  
(Present in v14 and v15; absent from v13.)

## Broken invariant

`sanitizeImageBeforeUpload` / gallery preparation must return a usable local image string so `identifyScanImage` can invoke `scan-identify`. v15 replaced that invariant with an unsatisfiable pixel-masking requirement.

## Classification

**Primary:** Preparation + Request construction (privacy fail-closed)  
**Secondary:** UI disable of gallery intake  
**Not primary:** Picker URI, temp-file race, auth token attach, backend rejection

## Affected image sources

Camera, Photo Library, Multi-image (Elise), Elise attachments. Recent Scan reuse may still show local thumbnails but new analysis is blocked by the same gates.

## Affected platforms

iOS and Android (shared RN/TS path). No iOS-only fork caused the break.

## Evidence

- `git show 2c8feeb --stat`
- `git show v13:services/privacyImageSanitizer.js` vs `git show v15:…`
- EAS build list mapping build 13/14/15 → SHAs
- Unit harness proving restored invoke path after repair
