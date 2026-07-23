# 04 — Commit and Ancestry Map (Phase 2)

## Linear first-parent chain (v13 → repair), newest at top
```
b1ac92c docs(audit): record merged SHA and EAS build 16 ID        <- branch base (HEAD of fix/…-regression)
79f1106 fix(ios): restore image upload after v15 privacy fail-closed regression  <- PRIOR REPAIR (bn16)
32addd5 fix(shared-room): include uploaded inspirations in shared previews       <- v15 tip (bn15)
5617c4f fix(ios): add recoverable photo-library settings flow
04eb9b9 fix(dressing-room): refresh signed images on focus and foreground
28f7760 fix(shared-room): re-resolve images after authoritative preview refresh
06ecb21 fix(supabase): restore saved scan commerce migration parity
5146ad1 chore(ios): prepare build 15                                             <- bn15 bump
54785a5 fix(ios): declare audio asset runtime dependency                        <- v14 tip (bn14)
76f4237 test(scanner): align mock loader with outfit detection bridge
9c87f48 fix(scanner): integrate multi-item image handoff repair
a426d4c fix(dressing-room): validate inspiration upload size and sanitize storage errors
7b7ac56 fix(dressing-room): preserve successful inspiration uploads on room-link failure
d80b767 chore(ios): prepare next test build                                      <- bn14 bump
5a825f7 test(elise): align header and draft-preservation assertions (bn13 label, GATED)
...      (Elise visual-context + privacy series)
4b9a092 fix(scan): surface privacy fail-closed reason
038e96c fix(scan): disable gallery intake without pixel masking
2c8feeb fix(elise): fail closed and isolate scanner return          <- ***FIRST BAD COMMIT***
...
b3c56d8 feat(elise): add session-scoped visual context state and privacy prep   <- privacyImageUpload.ts born fail-closed
...
13ef03d fix(release): align Apple readiness checks (bn13, PRE-GATE)  <- ~true v13 source (GOOD)
```

## Ancestry facts (verified)
- `13ef03d` is an ancestor of `2c8feeb`; `2c8feeb` is **not** in `13ef03d` → gate entered **after** the build-13 config commit.
- `2c8feeb` ∈ v14 (`54785a5`), ∈ v15 (`32addd5`), ∉ true-v13 (`13ef03d`).
- `merge-base(13ef03d, 32addd5)` = `13ef03d` → clean linear descent (no side-branch/merge concealment on the regression path).
- `79f1106` (repair) is an ancestor of the branch HEAD.

## Upload-pipeline-focused change surface (v13→v15)
| Area | Files |
|---|---|
| Scanner intake/analysis | `hooks/useKScan.js`, `services/imageUtils.js` (unchanged core), `components/scan-room/*` |
| Client identify adapter | `services/scanIdentification.ts`, `types/scanIdentification.ts` |
| **Privacy fail-closed cluster (regression)** | `services/privacyImageSanitizer.js`, `services/privacyImageUpload.ts`, `services/scanIdentification.ts` |
| Elise attachments | `hooks/useEliseVisualContext.ts`, `components/style-chat/StyleChatPhotoIntake.tsx` |
| Shared/Dressing rooms | `app/(public)/rooms/[token].tsx`, `app/dressing-rooms/[id].tsx`, `services/sharedRoomImageResolver.ts` |
| Backend | `supabase/functions/scan-identify/index.ts` (+408, feature-additive; no privacy enforcement) |

The large `13ef03d..32addd5` diff (502 files) is dominated by **accepted feature work**
(Elise visual context, Dressing/Shared Rooms, backend intelligence) that must be **preserved**.
The regression itself is surgical — the 2026-07-17 privacy series.
