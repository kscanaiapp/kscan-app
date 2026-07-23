# 10 — Regression Range (Phase 8)

`git bisect` was **not** required — the boundary is deterministic and readable at source. No
EAS build was consumed for bisection (prohibited).

## Deterministic source criteria used
"Good" = `sanitizeImageBeforeUpload` returns input (no throw) **AND** `identifyScanImage` has no
`hasCompleteLocalPrivacyProof` gate. "Bad" = either fail-closed point present.

## Result
| Item | Commit | Date |
|---|---|---|
| Last known-good | `13ef03d` (and all commits before `b3c56d8`) | 2026-07-10 |
| Born-fail-closed helper introduced | `b3c56d8` (`privacyImageUpload.ts` = false/throw) | 2026-07-17 08:14 |
| **First known-bad (root)** | **`2c8feeb`** — sanitizer passthrough→throw **and** identify proof gate | 2026-07-17 08:18 |
| Reinforcing bad | `038e96c` (UI gallery disable), `4b9a092` (fail-closed reason) | 2026-07-17 08:21 |
| First **shipped** bad | build 14 (`d80b767` bn-bump) | 2026-07-17 08:40 |
| Also bad | build 15 (`5146ad1`/`32addd5`) | 2026-07-18 |
| Fixed | `79f1106` | 2026-07-23 |

## Smallest supported bad range
`13ef03d` (good) → `2c8feeb` (first bad). Within it, `2c8feeb` is the **single introducing
commit** for the two Blocker points; `b3c56d8` supplies the P0 Elise/UI availability flag.

## One defect or multiple?
**Multiple contributing defects, one root series.** Three independent fail-closed points
(D1 sanitizer, D2 identify gate, D3 availability/prepare), all authored in the same
2026-07-17 privacy series. Each independently blocks a subset of intake; together they produce
total upload failure. All three must be (and are) reversed.
