# 09 — Test Coverage Audit (Phase 7)

## Would the v15 test suite have caught the physical failure?  **NO.**
At v15 (`32addd5`), `__tests__/scanIdentification.test.js` contained **zero** assertions
touching `privacyProof` / `PRIVACY_PROTECTION_REQUIRED` / `hasCompleteLocalPrivacyProof` /
sanitizer mode. No test drove the real Scanner boundary (`sanitizeImageBeforeUpload` →
`identifyScanImage`) with a realistic no-proof call. The catastrophic fail-closed gate therefore
shipped **undetected through builds 14 and 15**.

This is the classic false-confidence gap: unit tests asserted mapper/adapter shape while the
**failing boundary was unmocked and unexercised**.

## Coverage after repair (HEAD) — `__tests__/imageUploadRegression.test.js` (+ updated suites)
Loads the **real** TS/JS modules (in-process transpile + VM), mocking only the native
`expo-image-manipulator`/`expo-file-system` boundary (which cannot run under Node):

| Required area | Covered? | Where |
|---|---|---|
| picker cancellation / success | ✔ | existing scanner suites |
| local `file://` asset accepted | ✔ | `prepareImageForPrivacyUpload('file://…')` |
| `ph://` / `assets-library://` / remote rejected | ✔ | rejects `/must be on this device/` |
| HEIC / JPEG / PNG / screenshot fixtures | ✔ | fixture set (`__tests__/fixtures/image-upload/`) |
| missing filename / MIME derivation | ✔ | request-construction asserts |
| **sanitizer returns usable string (v13 invariant)** | ✔ | asserts `mode:'passthrough'`, `remoteTransmissionAllowed:true`, `return input` |
| **identify dispatches with `localPrivacyFiltered`** | ✔ | asserts `status:'completed'`, `body.localPrivacyFiltered===true`, `imageBase64` sent |
| auth missing → 401-class, no invoke | ✔ | `/sign in/i`, `invoked===false` |
| oversized payload → 413-class client guard | ✔ | `/too large/i`, no invoke |
| abort ownership / already-aborted short-circuit | ✔ | `invoked===false` |
| temp cleanup best-effort never throws | ✔ | `cleanupSanitizedImage` |
| Elise codec-failure fails closed safely | ✔ | `eliseVisualContext.test.js` |

## Regression guard strength
The suite now **fails** if any fail-closed point is reintroduced (sanitizer throw, proof gate,
`isPrivateImageUploadAvailable→false`, prepare throw). Verified by inspection of assertions and
by the boundary being the real module, not a mock.

## No lock-in tests
No test asserts the broken fail-closed behavior as correct. The three residual "fail closed"
test strings at HEAD are unrelated/legitimate (Elise codec-failure safety; signature-style;
stylist-speech).
