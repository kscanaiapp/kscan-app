# 12 — Defect Register (Phase 9)

| ID | Sev | Status | Component / evidence | Root cause | Repair | Files | Tests | Disposition |
|---|---|---|---|---|---|---|---|---|
| **KS-UPL-001** | **Blocker** | Repaired (verified) | `services/privacyImageSanitizer.js` — `sanitizeImageBeforeUpload` threw unconditionally (`mode:'blocked'`) from `2c8feeb` | Fail-closed sanitizer blocks Scanner/StyleChat/savedScanMedia pre-dispatch | Restore `passthrough`/`return input`, `remoteTransmissionAllowed:true`, neutral message | `services/privacyImageSanitizer.js` | `imageUploadRegression.test.js` ("sanitizer returns usable string") | Closed |
| **KS-UPL-002** | **Blocker** | Repaired (verified) | `services/scanIdentification.ts` — `hasCompleteLocalPrivacyProof` demanded unsatisfiable face/plate mask proof (`2c8feeb`) | 100% identify failures pre-invoke | Remove gate; `privacyProof`→`localPrivacyFiltered` attestation | `services/scanIdentification.ts`, `types/scanIdentification.ts` | `imageUploadRegression.test.js` (identify completes; 401/413 guards), `scanIdentification.test.js` | Closed |
| **KS-UPL-003** | **P0** | Repaired (verified) | `services/privacyImageUpload.ts` — `isPrivateImageUploadAvailable()=false`, `prepareImageForPrivacyUpload` threw (`b3c56d8`) | Elise attachment blocked; Scanner Upload buttons disabled | Availability→true; prepare re-encodes via ImageManipulator (metadata strip) with honest policy | `services/privacyImageUpload.ts` | `imageUploadRegression.test.js`, `eliseVisualContext.test.js` | Closed |
| **KS-UPL-004** | **P0** | Resolved indirectly | `components/scan-room/ScanLanding.tsx`, `LiveScanCamera.tsx` — Upload buttons gated on availability (`038e96c`) | Gallery intake unreachable from UI | No component edit needed — buttons read `isPrivateImageUploadAvailable()`, flipped true by KS-UPL-003 | (none) | render-time behavior via KS-UPL-003 | Closed |
| **KS-UPL-005** | **P3** | Repaired (verified) | Test coverage gap — v15 suite never exercised the privacy boundary | Regression shipped through builds 14+15 undetected | Add real-boundary regression harness | `__tests__/imageUploadRegression.test.js` (+fixtures) | self | Closed |

## Out-of-scope, documented (NOT implemented)
| ID | Sev | Note |
|---|---|---|
| KS-DOC-006 | P6 | **Privacy-claim consistency:** the removed code aspired to "Zero-Knowledge" face/plate masking that was never functional. Any UI/marketing/privacy-policy copy asserting on-device *masking* should be reconciled with the actual posture (compression + EXIF/metadata strip, no pixel masking). This is a copy/legal reconciliation, not an upload defect; the repair's `policy` object is already honest (`faceMaskApplied:false`, `plateMaskApplied:false`). Flagged for product/legal; **not changed** here. |
| KS-DOC-007 | P8 | `prepareImageForPrivacyUpload` resizes to width 1024 which may upscale small inputs (wasteful, harmless). Optional future guard. Not changed. |

All confirmed **in-scope** defects (KS-UPL-001..005) are **Closed**. No in-scope defect remains open.
