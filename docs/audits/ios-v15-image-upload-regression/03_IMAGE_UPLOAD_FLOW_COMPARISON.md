# 03 — Image Upload Flow Comparison (v13 vs v15)

## Pipeline stages

| Stage | v13 | v15 (broken) | After repair |
|---|---|---|---|
| Permissions | Camera + photo library | Same + settings recovery (v15) | Preserved |
| Image picker | `expo-image-picker` | Same | Same |
| URI normalization | Local `file://` / `content://` expected after picker | Same; cloud `ph://` rejected in Elise prep | Same |
| Image preparation | `compressForUpload` → `sanitizeImageBeforeUpload` (passthrough) | Sanitizer **throws** | Passthrough restored |
| Gallery availability | Enabled | `isPrivateImageUploadAvailable() === false` | `true` + metadata re-encode |
| Compression / resize | `imageUtils.compressForUpload` (~896 / q0.65 JPEG) | Same | Same |
| Temp files | Manipulator cache derivatives | Same, but prep never succeeds for gallery | Cleanup restored via working prep |
| Filename / MIME | JPEG data URI / base64 | Same | Same |
| Request creation | `identifyScanImage` | Blocked by unsatisfiable `privacyProof` | Gate removed; `localPrivacyFiltered` attested |
| Authorization | Supabase session via `functions.invoke` | Same (never reached) | Reached again |
| Response / navigation | Result mapping | Error status with privacy copy | Restored |
| Elise attachment | N/A / later paths | Uses hard-disabled `privacyImageUpload` | Metadata-stripped re-encode |

## Shared ownership

Scanner (`hooks/useKScan.js`) and Elise (`hooks/useEliseVisualContext.ts`) both depend on the privacy modules. Fail-closed changes therefore break **camera, gallery, and Elise attachments** on both iOS and Android (shared JS).
