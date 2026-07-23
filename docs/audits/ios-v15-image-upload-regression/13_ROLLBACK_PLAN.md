# 13 — Rollback Plan

## Rollback target

If build 16 misbehaves beyond the upload repair, roll TestFlight / store candidate back to:

| Field | Value |
|---|---|
| Known-good build | iOS 1.0.1 **build 13** |
| Rollback SHA | `d5e19eea984d863182694bee065848efaeab6a7e` |
| EAS Build ID | `4c5a97af-a215-4389-930f-0873ac0aa5c5` |

## Source rollback (git)

```bash
# Prefer reverting the repair commit(s) on fix/ios-v15-image-upload-regression
# rather than hard-resetting shared branches.

git revert <repair-commit-sha>
```

Or ship build 13 binary from App Store Connect / TestFlight while investigating.

## Do not

- Do not re-introduce `2c8feeb` fail-closed gates without a real on-device face/plate masker.
- Do not roll back Dressing Rooms / Elise / multi-item features wholesale to fix upload.

## Backend

No backend rollback required for this client-only repair.
