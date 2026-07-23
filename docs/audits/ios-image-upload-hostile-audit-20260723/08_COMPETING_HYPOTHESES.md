# 08 — Competing Hypotheses (Phase 6)

| ID | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | URI normalization (`ph://`/iCloud/limited-library) broke | **DISPROVEN** as root cause | Picker copies to `file://`; `compressForUpload`/`prepareImageForPrivacyUpload` handle `file://`+`content://`. Failure occurs *after* URI resolution, at the sanitizer throw. |
| H2 | Temporary-file lifecycle (early delete / cleanup race) | **DISPROVEN** as root cause | Pipeline dies at sanitize *before* any temp/request; cleanup is best-effort and never throws (tested). |
| H3 | Authentication timing / stale token | **DISPROVEN** | Gate fails before auth matters; identify's sign-in guard is unchanged v13→v15. |
| H4 | Async request ownership (abort/unmount) | **DISPROVEN** as root cause | Request never constructed; abort tests pass; no dispatch to cancel. |
| H5 | Metadata/format (HEIC/PNG/screenshot/EXIF) | **DISPROVEN** as root cause | Gate is unconditional across all formats; HEIC/JPEG/PNG/screenshot fixtures pass in harness. |
| H6 | Dependency/native drift (`expo-image-manipulator`, SDK) | **DISPROVEN** | `expo-image-manipulator@14.0.8` still exports `manipulateAsync`/`SaveFormat`; repair uses the **same API** as proven-good `compressForUpload`. No permission-string/Info.plist regression tied to failure. |
| H7 | Request-contract drift (endpoint/headers/fields) | **DISPROVEN** as root cause | Contract additions (multi-item, scanSessionId) are optional; core `{imageBase64,source}` unchanged. Failure is pre-dispatch. |
| H8 | Backend participation (`scan-identify`) | **DISPROVEN** | `localPrivacyFiltered` is parsed but **never enforced** in the Edge Function (single reference, a type field). Backend never receives a v15 request anyway. No privacy fail-close server-side. **No backend change needed or permitted.** |
| H9 | Navigation/state (premature clear, focus reset) | **DISPROVEN** as root cause | Failure is a thrown guard, not a state/nav race; deterministic 100% failure, not intermittent. |
| **H-ROOT** | **Client privacy fail-closed cluster introduced 2026-07-17 (`2c8feeb` + `b3c56d8`/`038e96c`/`4b9a092`)** | **PROVEN (source)** | Sanitizer passthrough→throw; unsatisfiable `hasCompleteLocalPrivacyProof` gate; `isPrivateImageUploadAvailable→false`; prepare throw. All absent in v13, present in v14/v15. Deterministically blocks all local intake pre-dispatch. |

## Why not intermittent / format-specific / session-specific
The guards are unconditional and synchronous → deterministic total failure for **all** new
local image intake, independent of format, size, session, or network. Matches "upload failed"
with no partial success.
