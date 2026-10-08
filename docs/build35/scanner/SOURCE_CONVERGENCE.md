# Build 35 Scanner result convergence

Certification: **SOURCE_VERIFIED** only. The PR remains a draft. No merge,
deployment, provider dispatch, device certification or release activation was
performed by this lane.

## Source authority and recovery

- Integration base: `8f25fb7e219dc0d400e26e76fd6474c454fea661`.
- Refreshed integration before changes and again before preparing the PR;
  the authoritative integration head remained this SHA.
- Mature donor inspected: `2824bbb775e83bbb12c2bb859da4f271040658f5`.
- Existing partial restoration reused:
  `origin/repair/build35-restore-multi-image-results-v1` at
  `b9b0f3cd32453b293499b1bea8fbf9e9a37fdabb`.
- Repair branch: `codex/build35-scanner-results-certification`.

The partial repair branch already contained the navigator, screen queue state,
current-adapter sequential queue, bounded item provenance and multi-item room
component. Its app result renderer never supplied that state to the restored
components: review, progressive results and bulk actions were unreachable.
The current integration had restored input/detection foundation but deliberately
held aggregate persistence for multi-photo scans, preventing wrong-image saves.
Recovery reuses that mature work and wires it to today's contracts. It does not
revert `useKScan`, Scanner V2, the persistence model or actor authority.

## Repairs

| ID | Priority | Root cause | Source result and regression proof |
|---|---|---|---|
| B35-SCAN-001 | P2 | Restored input/detection lacked reachable deliberate result queue and navigator. | Explicit garment selection now starts a sequential queue for multiple garments from one photo and 2–5 photo batches. The existing one-photo/one-garment path remains. Executed queue tests prove selection order, deduplication, source-evidence correlation and bounded existing adapter use. |
| B35-SCAN-002 | P2 | Partial restoration used current display-independent analysis/actions and lacked original actor continuity for queue results. | Active garment binds image, result, commerce, report target, Elise and room snapshot. Detection captures actor authority; late queue responses after cancellation or actor change cannot become items or dispatch siblings. A real source mutation removing actor checks is caught. |
| B35-SCAN-003 | P2 | Per-item save and Save All were unwired; generic aggregate persistence would violate image-2 provenance. | Each save uses its item's original URI, analysis, actor request and screen generation. Synchronous save locks and saved-ID refs prevent duplicate writes. Real library tests prove distinct media bytes and reopen provenance; a source mutation rebinding image 2 to image 1 is caught. Aggregate multi-photo saving remains held. |
| B35-SCAN-004 | P3 | Add All was unwired and the partial donor swallowed original single-item errors. | Bulk room action preserves each item's own media/result, processes sequentially under actor scope, retains successful siblings and reports accurate partial counts. Existing specific single-item errors remain. Executed room component tests cover media identity, partial success and actor changes. |
| B35-SCAN-005 | P3 | Quota/partial detail recovery had no reachable result control. | Quota returns only remaining IDs and resumes explicitly without replaying complete siblings. Failed detail retains genuine detection as PARTIAL and provides an explicit retry action. Review/processing controls and ready-only bulk counts are tested through the real navigator. |
| B35-SCAN-007 | P3 | Recovered donor review CTA background reintroduced known translucent pinned-bar content bleed. | Failed exact-head Project checks identified the regression. Restored opaque RGB background; original opacity test and its pre-repair negative control pass. |
| B35-SCAN-008 | P1 | `app/scan/index.tsx` directly exported Scanner; AuthGate retains Stack and an authenticated A→B transition can settle without route replacement. Completed local Scanner photos/results had no display reset boundary. | Scanner route now subscribes to AuthSession and keys its complete local session by canonical actor ID and epoch. Real route tests prove A→B and batched same-account sign-out/sign-in reset result state; unchanged epoch keeps the existing scan. A source mutation removing the key demonstrates the leak. |
| B35-SCAN-009 | P2 | A provider/detail failure with no optional detection attributes produces FAILED rather than PARTIAL. After a sibling became ready, failed chips were disabled and recovery was unreachable. | Result navigator now exposes explicit failed-item retry, using only failed selected IDs. Executed queue regression proves b-fails/a-ready/b-retry dispatch order without reprocessing a. Missing/mismatched original evidence still rejects before dispatch. |

## Validation

The targeted acceptance command is recorded in `TARGETED_VALIDATION.md`.
It executes 19 existing/new test files across Scanner contracts, queue, result
actions, media persistence, Recent Scan reopening, commerce, reporting, actor
isolation and iOS Modal nesting. Provider collaborators are simulated in these
tests; this is not authenticated real-provider evidence.

TypeScript `tsc --noEmit` and `git diff --check` passed. The React best-practices
skill was applied to all changed TSX components: hooks stay unconditional,
candidate controls use checkbox roles and source-image labels, processing
freezes selection, async saves have actor/generation guards, repeated actions
use synchronous refs, and bulk accessibility counts include only ready items.
The primitive session identity keeps benign analysis-object enrichment from
resetting completed queue state. No shared K+ component, release profile,
Supabase policy/schema, entitlement authority or provider budget was changed.

Required exact-head Linux/full-suite/security/native/export CI is owned by the
integration lane. It must pass before this draft PR can merge. This document
does not assert `CI_VERIFIED` or `UNEXPECTED_NEW_FAILURES=0` for the full suite.

Initial PR #526 head `799a2177d6872c0494db487056480885f8debc0a` failed Linux
Project checks (`37809112969`, job `113421047098`) with 3 unexpected identities:
the translucent CTA defect above and two stale source fixtures requiring
`analysis={analysis}`/unconditional aggregate retry despite intentional active
item projection. The fixtures now assert that projection explicitly, including
an executed commerce projection test preserving pending/error/success for the
single-item path and preventing aggregate retry/status leakage into batch items.
The failure baseline was not modified. Follow-up validation passed 44 tests;
new exact-head Linux CI remains required after the follow-up patch is published.

Independent patch review then identified the retained-route actor display and
failed-sibling recovery gaps above. After their focused repairs, the expanded
follow-up command passed 59 tests, including route-key mutation detection and
recoverable failed-item retry without ready-sibling replay. Account display
isolation is now based on an explicit source reset boundary; it is not inferred
from existing route navigation or asynchronous write checks alone.

## Runtime holds and required evidence

- `STAGING_VERIFIED=NO`: this source has not been deployed/exercised in Staging.
- `IOS_DEVICE_VERIFIED=NO`, `ANDROID_DEVICE_VERIFIED=NO`: physical-device
  evidence for gallery 1/2/5 inputs, selection order, cancellation, per-item
  media reopening, Save All, Add All and actor transitions remains required.
- `TESTSPRITE_MOBILE=UNVERIFIED_BECAUSE_UNDEPLOYED`: CLI `0.5.0` and credentials
  passed preflight. No worktree project config or project env ID was present.
  The account project inventory contains only the existing Staging backend API
  project (`135d7e41-d894-4a28-848a-7d4f75e6dc90`); it cannot verify the local
  mobile result UI. No unrelated/backend-only run is represented as client
  verification.
- Native gallery ordering, permissions and concurrent interaction behavior need
  signed iOS/Android artifact testing. Source tests do not replace that proof.

No paid provider budget was consumed. Production was not modified.

## Nonblocking register

| ID | Priority | Feature/location | Environment/type | Evidence and impact | Expected / observed | Suggested fix, scope, disposition |
|---|---|---|---|---|---|---|
| B35-SCAN-006 | P4 | Scanner result → `components/AddScanToDressingRoomModal.tsx`, `saveAllToRoom` partial-success path | Shared / recovery UX | Executed component test reports 1 of 2 saved; the sheet enters success state with a truthful count. A user must retry the failed item separately from its per-item action. | Bulk partial success should ideally offer retry of failed siblings; the current mature surface reports partial count and preserves successful siblings without a bulk retry control. | Track failed snapshots and add a user-triggered retry of only those items with actor/session binding; medium scope, Build 36, documented/deferred. No successful item should be dispatched again. |

The P4 item does not block the restored explicit per-item retry/add paths.
