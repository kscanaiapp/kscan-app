# Android Pre-Build Repair Ledger — Build 35

**Candidate:** `integration/build35-v1-convergence @ f2f94e8bb9ca758d45f0d7db6e3206c3d0903bf4`  
**Date:** 2026-10-09

## Summary

No confirmed Android-specific source defect requiring repair was found during this campaign.

```
ANDROID_P0_FOUND=0
ANDROID_P0_REPAIRED=0
ANDROID_P0_OPEN=0
ANDROID_P1_FOUND=0
ANDROID_P1_REPAIRED=0
ANDROID_P1_OPEN=0
ANDROID_P2_FOUND=0
ANDROID_P2_REPAIRED=0
ANDROID_P2_OPEN=0
ANDROID_P3_FOUND=0
ANDROID_P3_REPAIRED=0
ANDROID_P3_OPEN=0
ANDROID_P4_TO_P10_FOUND=0 confirmed defects
ANDROID_P4_TO_P10_REPAIRED=0
ANDROID_REPAIR_PRS_CREATED=0
ANDROID_REPAIR_PRS_MERGED=0
SHARED_DEFECTS_REPAIRED_BY_THIS_AGENT=0
```

## Historical Android repairs reconciled

The current candidate descends from `release/kscan-pre-freeze-v1 @ e97de30eab67691b91f9d68ffbb5ef2635aa0741` and is 230 commits ahead / 0 behind it.

The following previously governed Android protections remain represented in source and focused regression coverage:

- ordinary production removes `POST_NOTIFICATIONS` and `RECORD_AUDIO`
- Voice/push capability manifests remain independent and build-selector controlled
- `RECEIVE_BOOT_COMPLETED` remains suppressed
- fine location and legacy/broad storage remain suppressed
- unused foreground-service permissions/services remain suppressed
- transitive cropper activity remains non-exported
- Android Photo Picker/storage-permission repair remains covered
- Scanner permanent-denial Settings recovery and permission-refresh behavior remain covered
- VTO and Private Dressing Room bottom-inset repairs remain covered
- notification actor isolation, activation gating and boot containment remain covered
- terminal-deletion local parity remains covered
- launcher branding/native parity remains covered

Evidence: named Android suite run, 412/412 pass.

## Non-defect observations / post-build items

These are not classified as source defects in this campaign:

| Item | Classification | Disposition |
| --- | --- | --- |
| Predictive-back callback opt-out remains in native manifest | Runtime compatibility observation | Verify on Android 15/16 after build; no speculative source change. |
| Final EAS remote Android versionCode not readable from available source connectors | External versioning dependency | Source uses remote + autoIncrement. Verify final versionCode after build and against Play before upload. |
| Final merged manifest / transitive permissions | Artifact evidence | Inspect built AAB; not a pre-build source defect. |
| 16 KB native-library alignment | Artifact/native-library evidence | Validate final AAB/Play-generated APKs after build. |
| Firebase resources in a push-capable artifact | Artifact/config evidence | Ordinary production push is OFF; verify only if later capability changes or post-build artifact includes Firebase. |

## Campaign-only audit infrastructure

Two source-only audit workflows were created on the isolated audit branch `audit/build35-android-prebuild-config-20261009`. They are not product changes and are not part of the release candidate:

- Gradle configuration probe: `:app:help` only; no assemble/bundle/signing.
- Focused Android and held-surface test runners.

No APK, AAB, EAS build or production artifact was produced by this campaign.
