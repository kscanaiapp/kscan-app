# 12 — Physical iOS QA

## Status

**OPEN GATE** — not executed on a real iPhone in this audit pass.

## Required matrix (build 16)

Device: physical iPhone  
iOS version: record at test time  
Build: 1.0.1 (16)

| Case | Formats / notes | Pass/Fail |
|---|---|---|
| Camera | JPEG | |
| Gallery | JPEG, HEIC, PNG, screenshot | |
| Multi-image | 01/02/03 fixtures + real library | |
| Multi-item | multi-item-outfit | |
| Selected-item | after multi-item detection | |
| Elise attachment | gallery + camera | |
| Recent Scan reuse | open prior scan → continue | |
| Save / Dressing Rooms | Save All + room add | |
| Background / resume | mid-analysis interrupt | |
| Fresh login | new session then upload | |
| Restored session | kill/relaunch then upload | |
| Large image | large-jpeg | |
| Portrait / landscape HEIC | | |
| iCloud-optimized photo | must download/resolve locally | |

## Prior evidence

- v13 build 13: upload worked (physical)
- v15 build 15: upload broken (physical)
- v14 build 14: expired; source-level BAD

## Sign-off

Tester: ____________  
Date: ____________  
Verdict: ____________
