# 02 — Repository Baseline (Phase 0)

All commands read-only. Captured 2026-07-23.

| Field | Value |
|---|---|
| Origin remote | `https://github.com/kscanaiapp/kscan-app.git` |
| Git dir (owner) | `C:/Users/jsmit/KScan/.git` |
| Working worktree | `C:/src/KScan-ios-v15-image-upload-regression` |
| Starting branch | `fix/ios-v15-image-upload-regression` |
| Starting HEAD | `b1ac92cafc1bcbfe2d1baef9d98a1010d731db8b` |
| Starting-branch remote parity | up to date with `origin/fix/ios-v15-image-upload-regression` |
| Worktree state at start | clean (no staged/unstaged/untracked) |
| Stashes | none |
| **Repair branch created** | `fix/ios-image-upload-hostile-audit` |
| **Branch point** | `b1ac92c` (recorded) |

## Topology note
The workspace `C:/Users/jsmit/KScan/.git` owns ~30 linked worktrees (verified via
`git worktree list`). `C:/src/KScan` is a **separate clone** (independent object store) and
is not authoritative for this task. The task worktree is isolated and was already clean, so
no unrelated in-flight work was absorbed.

## App identity (at HEAD)
| Field | Value |
|---|---|
| App version | `1.0.1` |
| Expo SDK | `54.0.0` |
| iOS `buildNumber` | `16` |
| Android `versionCode` | `23` |

## Safety disposition
- No unrelated dirty changes existed; nothing to preserve/separate.
- Dedicated branch created only **after** authoritative baseline verification (Phase 1–2).
- Branch `fix/ios-image-upload-hostile-audit` carries the verified repair (ancestor `79f1106`)
  plus this audit's reports.
