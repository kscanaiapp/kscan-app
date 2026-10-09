# Build 35 authority ledger

Recorded 2026-10-08 ET. Every SHA below was read from the live remote during this campaign (`git fetch`, `gh pr view`), not copied from a handoff. Ancestry was checked with `git merge-base --is-ancestor`.

## Authorities

| Role | Branch | Handoff SHA | SHA at start of this session | Current SHA |
|---|---|---|---|---|
| Mobile integration | `integration/build35-v1-convergence` | `509924ae…` | `509924ae68bdf15fab071c664044f87aee33f88e` | `b791ce0f4027c61bedd384db6bce6415eeca9919` |
| Canonical backend | `rebuild/backend-authority-v2` | `5f54104c…` | `5f54104c90254926d2f621b157041e132d413b48` | `5f54104c90254926d2f621b157041e132d413b48` (unchanged; test-only PRs #529/#530 open) |
| Staging Supabase | `yzqjvdfgefveprobvvyw` | n/a | n/a | n/a |
| Production Supabase | `wyyuqfdxucjksghsmhry` | n/a | n/a | read-only inspection only |

Application identifiers: iOS `com.kscanai.app`, Android `com.kscanai.app` (checked by `scripts/check-build35-release-profile.js`).

## Merge order actually executed on the mobile line

| Order | PR | Merge commit | Head merged (pinned with `--match-head-commit`) |
|---|---|---|---|
| 1 | #527 ZAP baseline health target | `00d85492` | `88a52ba3` |
| 2 | #525 release holds + Stylist Speech gate | `7afc67d6` | (refreshed on #527; includes the production-profile guard commit `69fc2155`) |
| 3 | #526 Scanner selected-item results | `509924ae` | (merged by the owner session) |
| 4 | #520 Premium Value | `059d1bdf` | `cfa1c2ba` |
| 5 | #521 Contextual Elise VTO | `b791ce0f` | `7a1c5f37` |

Backend line (merged before this session started): #524 `a838a709`, #523 `a9054c0a`, #528 `5f54104c`. PRs #513 and #517 were closed because their content was carried into #521 and #520.

## Release and platform branches (ancestry to the Build 35 integration line)

| Branch | SHA | Date | Ancestor of Build 35? | Commits not in Build 35 | Patch-unique commits |
|---|---|---|---|---|---|
| `release/kscan-pre-freeze-v1` (Build 34 final line) | `e97de30e` | 2026-09-30 | **yes** | 0 | 0 |
| `integration/ios-v18-release-candidate` | `435e4bae` | 2026-07-26 | **yes** | 0 | 0 |
| `integration/android-v27-closet-release-candidate` | `37b71414` | 2026-07-26 | no | 98 | 91 |
| `master` | `1a97d30a` | 2026-09-30 | no | 116 | 70 (Render/email/scan-identify route work dated 2026-06..07) |
| `staging/production-parity` | `2bb44552` | 2026-08-30 | no | 193 | 143 |
| `ios/full-submission-readiness-v2` | `9aa196bf` | 2026-08-03 | no | 59 | 53 |

The Build 34 final pre-freeze line is fully contained in Build 35, so none of its platform fixes is lost. The four non-ancestor lines predate it (June to August); whether their patch-unique commits are superseded was **not** audited here and is an open owner confirmation (see the binary certification report, G01 note).

## Exact-head verification standard used
A PR was merged only when its head was `CLEAN`, no check was failed, pending, cancelled or unexpectedly skipped, and the Linux regression accounting read `unexpected: 0` for that head. Merges were head-pinned. After each merge the integration tip's own push CI was read.
