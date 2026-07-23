# 11 — Root Cause (Phase 8 conclusion)

## Statement — **PROVEN (source-level)**
The iOS v15 image-upload failure was caused by a **client-side privacy "fail-closed" cluster**
introduced on **2026-07-17** (commit **`2c8feeb`**, with `b3c56d8`/`038e96c`/`4b9a092`), first
shipped in build 14 and carried into build 15. It replaced the working v13 behavior
("locally compressed/metadata-stripped image may be sent to `scan-identify`") with a guard that
demanded **on-device face + license-plate pixel-masking proof the client never produces** — an
**unsatisfiable** condition — and additionally made the shared sanitizer **throw
unconditionally**. As a result, no image bytes could leave the device for any new local intake.

## Last successful boundary
`compressForUpload` completes (data URI produced). Everything downstream is blocked at v15.

## First failed boundary
`sanitizeImageBeforeUpload` (throws) / `identifyScanImage` proof gate (returns `failed`) —
**pre-dispatch**. The `scan-identify` Edge Function is never reached.

## Broken invariant
> A locally prepared image (resized, re-compressed, EXIF/metadata-stripped) is eligible for
> remote fashion analysis via `scan-identify`.

The 2026-07-17 series silently upgraded the privacy contract to require **pixel masking**
(face/plate) that was never implemented, turning the invariant unsatisfiable.

## First bad commit
`2c8feeb fix(elise): fail closed and isolate scanner return`.

## Contributing commits
`b3c56d8` (born-fail-closed `privacyImageUpload.ts`), `038e96c` (UI gallery disable),
`4b9a092` (fail-closed messaging).

## Affected
- **Flows:** Scanner camera, Scanner gallery, multi-image, multi-item/selected-item, Elise
  camera+gallery attachment, StyleChat intake, saved-scan media (new local intake). Stored-image
  reuse (Recent Scan / saved-product / Dressing/Shared Room) largely unaffected.
- **Formats:** all (unconditional). **Sessions:** all (fresh/restored/switch).
- **Platforms:** iOS (physically confirmed) + Android (source-level; not shipped).
- **Backend:** not involved (H8).

## Confidence
Source-level mechanism: **PROVEN.** Physical-binary → SHA mapping for v13: **STRONGLY
SUPPORTED** (no EAS log in hand, but runtime-consistency excludes the gated tree).
