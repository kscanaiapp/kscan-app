# 13 — Repair Report (Phase 9)

## Approach
Restore the **proven v13 upload invariant** with the **smallest safe change**, while
**preserving** every accepted post-v13 feature (Elise visual context, multi-item detection,
Dressing/Shared Rooms, backend intelligence). The repair is confined to the three fail-closed
points; it does **not** copy the v13 tree over v15 and does not touch backend behavior.

## Provenance of the code change
The code repair is commit **`79f1106`**, present at this branch's base (`b1ac92c`) and inherited
by `fix/ios-image-upload-hostile-audit`. This audit **independently re-derived the same root
cause from evidence** (not from the prior commit message) and **verified** the repair resolves
it completely and correctly. No further source change was required; per "smallest safe change,"
none was made — re-implementing verified-correct code would only add regression risk.

## Changes (restored invariants)
| Defect | File | Old (bad) | Restored |
|---|---|---|---|
| KS-UPL-001 | `services/privacyImageSanitizer.js` | throws; `mode:'blocked'`; `remoteTransmissionAllowed:false` | `return input`; `mode:'passthrough'`; `remoteTransmissionAllowed:true`; neutral message |
| KS-UPL-002 | `services/scanIdentification.ts` | `hasCompleteLocalPrivacyProof` gate → `failed()` | gate removed; option `privacyProof`→`localPrivacyFiltered?: boolean`; body sends `localPrivacyFiltered ?? true` |
| KS-UPL-003 | `services/privacyImageUpload.ts` | `isPrivateImageUploadAvailable()=false`; prepare throws | availability `true`; prepare re-encodes (ImageManipulator, w≤1024 JPEG q0.82, metadata strip); **honest** `policy` (`faceMaskApplied:false`, `plateMaskApplied:false`) |
| KS-UPL-004 | scan-room components | button disabled via availability | auto-enabled (reads availability) |
| KS-UPL-005 | `__tests__/imageUploadRegression.test.js` + fixtures | (no boundary test) | real-boundary regression harness |

## Constraints honored
- No auth weakening (sign-in guard intact); no provenance change; no validation bypass
  (401/413 client guards intact); cancellation/abort preserved; temp cleanup best-effort;
  no iOS-only assumption in shared/Android paths; **no backend edit**; no unrelated refactor.

## Rollback
`git revert 79f1106` (or restore the three service files to their v15 blobs) fully reverts the
repair. See 19.

## Delta introduced by THIS audit branch vs base `b1ac92c`
Documentation only (this `docs/audits/ios-image-upload-hostile-audit-20260723/` report set).
Zero source/test code delta beyond the verified inherited repair.
