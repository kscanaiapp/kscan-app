# 07 — Hostile Static Diff Findings (Phase 5)

Comparison anchored on the **first bad commit `2c8feeb`** (2026-07-17), which introduced the
regression, with v13 (`13ef03d`) as the good reference.

| # | File / function | Old behavior (v13/good) | New behavior (v15/bad) | Invariant broken | Consequence | Severity | Disposition |
|---|---|---|---|---|---|---|---|
| D1 | `services/privacyImageSanitizer.js` `sanitizeImageBeforeUpload` / `SANITIZER_STATUS` | `mode:'passthrough'`, `remoteTransmissionAllowed:true`, `return input` | `mode:'blocked'`, throws `PrivacySanitizerUnavailableError` unconditionally | "prepared image may be transmitted" | Scanner camera+gallery, StyleChat, savedScanMedia all throw pre-dispatch | **Blocker** | Repaired (79f1106) |
| D2 | `services/scanIdentification.ts` `identifyScanImage` + `hasCompleteLocalPrivacyProof` | no proof gate; sends `imageBase64`/`source` | requires `privacyProof.faceMaskApplied && plateMaskApplied` (client never produces) → `failed()` before invoke | "identify dispatches a prepared image" | 100% identify failures even if sanitizer bypassed | **Blocker** | Repaired (79f1106) |
| D3 | `services/privacyImageUpload.ts` `isPrivateImageUploadAvailable` / `prepareImageForPrivacyUpload` | (file introduced `b3c56d8` already fail-closed) | returns `false`; prepare throws `PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE` | "Elise local intake available" | Elise attachment blocked; Scanner "Upload" buttons disabled | **P0** | Repaired (79f1106) |
| D4 | `components/scan-room/ScanLanding.tsx`, `LiveScanCamera.tsx` (`038e96c`) | Upload button enabled | button keyed on `isPrivateImageUploadAvailable()` → "Upload Unavailable", disabled | Scanner UI upload affordance | Gallery intake unreachable from UI | **P0** (resolved indirectly) | Fixed via D3 flip (no component edit needed) |

## Repair diff summary (79f1106) — verified against v13 intent
- D1: restored `passthrough`/`return input` + neutral message → **matches v13**.
- D2: removed the gate; `privacyProof` → `localPrivacyFiltered` attestation; still sends
  `localPrivacyFiltered:true` (backend ignores it — see H8) → **matches v13 dispatch**.
- D3: `isPrivateImageUploadAvailable()→true`; `prepareImageForPrivacyUpload` now **re-encodes**
  via ImageManipulator (metadata strip) with an **honest** policy object (explicitly
  `faceMaskApplied:false`, `plateMaskApplied:false`) — no false masking claim.
- D4: auto-resolved because the buttons read `isPrivateImageUploadAvailable()` at render.

## Additive (accepted, non-regression) changes in window — PRESERVED
`scanIdentification.ts` multi-item detection + correlation logging; `useKScan.js` multi-item /
selected-item; `scan-identify/index.ts` multi-item garments + response schemas; Dressing/Shared
Room signed-image refresh; `photoLibraryAccess` recoverable settings flow. All retained.

## No hostile red flags found in the repair
- No auth weakening, no provenance removal, no validation bypass, no global cancellation disable,
  no indefinite temp-file retention, no iOS assumption pushed into Android.
