# 15 — Integration Test Report (Phase 11)

Integration coverage is exercised via the deterministic harnesses that wire the real client
adapter, privacy services, Elise visual-context hook, scan-identify edge-contract, and
shared-room resolvers together (native boundaries stubbed).

## Commands
```
node --test __tests__/imageUploadRegression.test.js __tests__/eliseVisualContext.test.js \
            __tests__/scanIdentification.test.js __tests__/scanIdentifyEdgeContract.test.js \
            __tests__/sharedRoomMixedImageContract.test.js
```
All included in the full-suite run (1616/1616 pass).

## Scenario coverage
| Scenario | Status | Evidence |
|---|---|---|
| Scanner gallery upload path (prepare→identify) | PASS | imageUploadRegression |
| Scanner camera path (sanitize passthrough→identify) | PASS | imageUploadRegression + scanIdentification |
| Scanner multi-item / selected-item request contract | PASS | scanIdentification, scanIdentifyEdgeContract |
| Elise gallery/camera attachment (availability→prepare) | PASS | eliseVisualContext |
| Elise codec-failure fails closed safely | PASS | eliseVisualContext |
| Recent Scan / Dressing Room / Shared Room reuse | PASS | sharedRoomMixedImageContract, sharedRoom* suites |
| fresh login / restored session / sign-in required | PASS | scanIdentification (no-session → fail before invoke) |
| 401 (missing auth) | PASS | identify short-circuits, no invoke |
| 413 (oversized image) client guard | PASS | identify rejects `/too large/i` |
| HEIC / JPEG / PNG / screenshot | PASS | fixtures |
| cancellation / abort during request | PASS | abort-ownership tests |
| edge-function request/response contract | PASS | scanIdentifyEdgeContract |

## Unverifiable without a physical binary (explicitly noted)
- Real device `ph://`→`file://` materialization and iCloud-backed asset download.
- Real `expo-image-manipulator` native re-encode output bytes.
- End-to-end network round-trip to the deployed `scan-identify` function.
These require a device build (prohibited) and are deferred to the future consolidated QA build.
The source-level boundary and contract are fully covered.

## Verdict: **PASS** (source/harness level; device-level deferred as noted)
