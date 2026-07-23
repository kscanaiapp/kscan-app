# 07 — Integration Test Report

## Scope

Client-side integration of the repaired upload pipeline via stubbed Supabase invoke + Scanner duplicate-guard orchestration. Physical-device and live backend scenarios remain a separate gate.

## Scenarios

| Scenario | Result | Evidence |
|---|---|---|
| Scanner gallery upload (client path) | PASS | `useKScanDuplicateGuard` gallery selection → preview; upload availability restored |
| Scanner camera upload (client path) | PASS | sanitizer passthrough + identify invoke stub |
| Multi-image upload (Elise collection) | PASS | Elise visual collection / picker multi-select unit contracts |
| Multi-item upload | PASS | `multiItemDetection` body contract |
| Selected-item flow | PASS | session/digest/candidate body preservation |
| Elise gallery attachment | PASS | `prepareImageForPrivacyUpload` re-enabled |
| Elise camera attachment | PASS | scanner-return / collection wiring intact |
| Recent Scan reuse | BLOCKED (physical) | Requires device QA |
| Dressing Room continuity | BLOCKED (physical) | Requires device QA |
| Fresh login / restored session / account switch | PARTIAL | unit: missing session fails closed before invoke |
| 401 | PASS (client) | no-session path |
| Invalid / oversized image | PASS (client) | URI reject + size guard |
| HEIC / PNG / screenshot / orientation | PARTIAL | fixture presence + local URI prep; real HEIC decode needs device |
| iCloud-optimized asset | BLOCKED (physical) | Required on real iPhone |

## Device / build

- Device: not run in this audit pass (Windows agent host)
- Build under test: source branch `fix/ios-v15-image-upload-regression`, buildNumber **16** (pending EAS)

## Verdict

**INTEGRATION TESTING: PASS WITH PHYSICAL GATE** — client integration contracts green; live iOS/backend scenarios remain open.
