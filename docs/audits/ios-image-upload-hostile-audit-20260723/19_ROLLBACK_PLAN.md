# 19 — Rollback Plan

## Scope of change to roll back
- **Code:** the fail-closed reversal in commit `79f1106` (three service files + tests/fixtures),
  inherited at branch base `b1ac92c`.
- **This audit's branch adds documentation only** (`docs/audits/ios-image-upload-hostile-audit-20260723/`).

## Rollback options (no build/deploy involved)
1. **Full revert of the repair:**
   ```
   git revert 79f1106
   ```
   Returns sanitizer to throw, restores the identify proof gate and `isPrivateImageUploadAvailable=false`.
   ⚠ This re-introduces the total upload failure — only for emergency investigation, never ship.
2. **Discard this audit branch entirely:**
   ```
   git branch -D fix/ios-image-upload-hostile-audit
   ```
   Leaves `fix/ios-v15-image-upload-regression` untouched.
3. **Per-file restore** to v15 blobs (surgical):
   ```
   git checkout 32addd5 -- services/privacyImageSanitizer.js services/scanIdentification.ts
   git checkout 32addd5 -- services/privacyImageUpload.ts   # if present at 32addd5
   ```

## Forward-fix preference
Because the repair restores the **proven-good** v13 invariant and is fully test-guarded,
roll-forward (fix a specific follow-up) is preferred over rollback. Rollback of `79f1106`
should never reach a shipped build.

## Safety
- No DB migration, secret, env, or Edge Function change is part of this repair → nothing to
  reverse on the backend.
- No build/OTA/TestFlight artifact was produced by this task → no distribution to recall.
