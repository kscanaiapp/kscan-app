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
| B35-SCAN-005 | P3 | Quota/partial detail recovery had no reachable result control. | Quota returns only remaining IDs and resumes explicitly without replaying complete siblings. (That held only for a synthetic response; the production transport could not deliver it until B35-SCAN-010.) Failed detail retains genuine detection as PARTIAL and provides an explicit retry action. Review/processing controls and ready-only bulk counts are tested through the real navigator. |
| B35-SCAN-007 | P3 | Recovered donor review CTA background reintroduced known translucent pinned-bar content bleed. | Failed exact-head Project checks identified the regression. Restored opaque RGB background; original opacity test and its pre-repair negative control pass. |
| B35-SCAN-008 | P1 | `app/scan/index.tsx` directly exported Scanner; AuthGate retains Stack and an authenticated A→B transition can settle without route replacement. Completed local Scanner photos/results had no display reset boundary. | Scanner route now subscribes to AuthSession and keys its complete local session by canonical actor ID and epoch. Real route tests prove A→B and batched same-account sign-out/sign-in reset result state; unchanged epoch keeps the existing scan. A source mutation removing the key demonstrates the leak. |
| B35-SCAN-009 | P2 | A provider/detail failure with no optional detection attributes produces FAILED rather than PARTIAL. After a sibling became ready, failed chips were disabled and recovery was unreachable. | Result navigator now exposes explicit failed-item retry, using only failed selected IDs. Executed queue regression proves b-fails/a-ready/b-retry dispatch order without reprocessing a. Missing/mismatched original evidence still rejects before dispatch. |
| B35-SCAN-010 | P2 | The edge function answers a spent daily quota with HTTP 200 `{status:'rate_limited'}`. `normalizeScanIdentifyResponse` mapped it to a neutral `failed`, so the queue's `halted:'quota'` branch could never fire with the production transport (it was only reachable with a synthetic response). Items hit by the limit became PARTIAL/NOT ANALYZED with no stated reason and the remaining items were still dispatched. | Normaliser keeps the response `failed` for every existing consumer but flags `rateLimited` with the daily-limit copy; the queue pauses on the flag, keeps finished items, spends no further call and resumes only the remaining ids. Reproduced first through the real transport (failing), now passing; reverting either the normaliser flag or the hook check turns 2-4 tests red. Client-only; no edge or Supabase change. |
| B35-SCAN-011 | P3 | The same library asset picked twice arrives as a second cache file with the same `assetId`. URI de-duplication missed it, producing two images with one id (colliding scan sessions and candidate ids, a second paid detection). | A repeated `assetId` is a duplicate photo (`services/multiImageScan.ts`). Reproduced first; reverting the check turns the defect test and its negative control red. |
| B35-SCAN-012 | P3 | The one-selected-item auto-save is documented as "once completely analyzed" but fired for a PARTIAL item (detail call failed), pinning a degraded Recent Scan that a later successful retry could never update. | Auto-save skips `detailStatus === 'partial'`; an explicit Save Item or a successful retry still saves. Reproduced first against the extracted `app.js` effect; reverting turns two tests red. |
| B35-SCAN-013 | P3 | Multi-image detection silently dropped photos that failed, had no fashion items, produced no garments, or fell beyond the five-item bound, and blamed "unclear images" when every photo failed for a network, timeout or quota reason. | The real user-safe cause is rethrown when nothing usable returned; otherwise a bounded `detectionNotice` (1-based photo numbers and counts only) is attached to the merged analysis and rendered by the existing review surface. A photo with no garments no longer becomes the base of the merged analysis. Reproduced first (4 failing tests); reverting either half turns tests red. |

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

## Phase F: 20-point multi-image matrix (1, 2 and 5 photos)

Evidence level: **SOURCE_VERIFIED** with executed tests only. The real
`hooks/useKScan.js`, the real transport/normaliser/adapter/mapper and the real
`services/library.js` (over an in-memory filesystem) are executed; only device
edges and the Supabase `scan-identify` invoke (which returns RAW edge payloads)
are simulated (`__tests__/helpers/scannerHookHarness.js`). Nothing below is a
statement about real providers, real devices or Staging.

Status codes: `EXEC` = covered by an executed test; `PIN` = static source pin
only; `REPAIRED` = a gap found and repaired in this phase (test written first and
observed failing); `OPEN` = gap recorded, not fixed; `DEVICE` = only a physical
device can prove it. File prefixes: `HM` = `multiImageScannerHookMatrix`,
`BO` = `multiImageScannerBatchOrchestration`, `CT` = `multiImageScannerControls`,
`NV` = `multiItemResultNavigator`, `SQ` = `multiImageSelectedQueue`,
`PS` = `multiImageResultPersistence`, `RA` = `recentScanAccountIsolation`,
`AR` = `addScanToDressingRoomModalFlow`, `RR` = `scannerRouteActorReset` (all
`__tests__/*.test.js`).

| # | Point | Status | Evidence (file: test) |
|---|---|---|---|
| 1 | Ordered selection | EXEC; native order DEVICE | HM: "1: 1/2/5 selected photo(s) keep picker order and dispatch nothing before the explicit analyze tap"; CT: "1/2: the review shows every selected photo in order with its position label"; `multiImageScan`: "normalizes one, two, and five selected images in stable order" |
| 2 | Add / remove photos | EXEC | HM: "2: adding photos appends in order within the remaining limit; removing re-indexes; removing all returns to idle", "2: a sixth photo is refused explicitly and never truncates silently"; CT: "2: Add image is offered below five photos and withdrawn at five", "2: each Remove control removes exactly its own photo by id" |
| 3 | Duplicate photos | EXEC + REPAIRED (B35-SCAN-011) | HM: "3: the same photo URI chosen twice is selected once and analysed once", "DEFECT B35-SCAN-011 ..."; `multiImageScan`: "suppresses duplicate images and keeps first-seen ordering" |
| 4 | Invalid / unsupported images | EXEC (P4 deferral below) | HM: "4: a video-only or malformed selection is rejected before any provider call", "4: a video mixed into a photo selection is dropped...", "4: an image that cannot be prepared fails the batch closed with ZERO provider calls and is recoverable by removing it" |
| 5 | Mixed fashion / non-fashion | EXEC + REPAIRED (B35-SCAN-013) | HM: "5: a non-fashion photo among fashion photos yields only the fashion candidates...", "5: when every photo is non-fashion the result is the graceful non-fashion state", "DEFECT B35-SCAN-013: photos that failed, had no fashion items, or were cut by the five-item bound are named..." |
| 6 | Several garments per photo | EXEC | HM: "6: one photo with several garments produces one candidate per garment, all bound to that photo", "6: the global five-item bound keeps stable image/garment order and never invents candidates"; BO: "1/2/5 end to end: 1 photo with 2 garments ..." |
| 7 | Independent image processing | EXEC | HM: "7: every photo is its own request, in flight together, and the result order follows the photos, not completion order", "9: a detection failure for one photo keeps the other photos usable" |
| 8 | Selected-item evidence binding | EXEC | HM: "8/13: each selected garment is analysed against ITS OWN photo bytes, digest, session and server candidate id, even when server ids repeat"; SQ: "wrong source binding is rejected before any selected-item dispatch", "NEGATIVE CONTROL: rebinding a result to the first image breaks per-item media proof" |
| 9 | Partial backend failure | EXEC + REPAIRED (B35-SCAN-012/013) | HM: "9: a selected-item provider failure leaves that item PARTIAL ...", "9: a detection failure ..."; BO: "9: a failed sibling is retried alone; ready siblings are never replayed, even when every id is passed", "9: retrying a PARTIAL item replaces it in place ..."; NV: "failed siblings remain non-savable but expose an explicit retry ..." |
| 10 | Rate limit + explicit resume | REPAIRED (B35-SCAN-010) | HM: "DEFECT B35-SCAN-010: a real edge rate_limited payload halts the queue ...", "DEFECT B35-SCAN-013: detection that hits the daily limit says so ..."; BO: "10: a spent daily quota pauses the queue, keeps finished items, states the reason and resumes only the remainder"; NV: "quota resume and partial retry require separate explicit user presses" |
| 11 | Cancellation during processing | EXEC (P4: no user cancel control) | HM: "11: leaving the screen during detection aborts every in-flight request ...", "11: leaving the screen mid-queue stops the remaining dispatches ...", "11: dismiss and retake are refused while the queue is running ..."; BO: "11: a new scan session during processing makes every late result inert", "11: leaving the screen mid-queue stops dispatch; nothing is published afterwards"; SQ: "cancellation ignores late results and stops remaining dispatches" |
| 12 | Rapid repeated taps | EXEC | HM: "12: a double tap on Analyze spends exactly one detection batch", "12: a second queue started while one is running is refused ...", "12: a double tap on Add image opens the picker once"; BO: "12: a double tap on Find Matches runs one queue ...", NEGATIVE CONTROL (screen lock); SQ: "rapid repeat calls spend only one active queue" |
| 13 | Source-image switching | EXEC (projection); rendering DEVICE | BO: "13: the displayed analysis, photo and source follow the active item and fall back to the first ready item"; HM: "8/13 ..." |
| 14 | Per-item Recent Scan persistence | EXEC + REPAIRED (B35-SCAN-012) | BO: "14/15/16: Save All writes one Recent Scan per item from the REAL hook output ...", "DEFECT B35-SCAN-012 ...", "1/2/5 end to end: ..."; PS: all 6; RA: "multi-image item saves and reopening retain each source media and bounded provenance" |
| 15 | Reopening saved scans | EXEC (storage); visual DEVICE | BO "14/15/16 ..." and "1/2/5 end to end" reopen through the real `loadLibrary`; RA (reopen test); `recentScanReopenNetworkIsolation` (zero calls on reopen) |
| 16 | Save All | EXEC | BO: "14/15/16 ...", "16: Save All after an account switch writes nothing for the new account"; PS: "Save All calls the real per-item callback with correct media, snapshot and original actor", "actor switch in Save All ...", "save failures retain successful siblings ..." |
| 17 | Add All to Dressing Room | EXEC (P4 bulk retry) | AR: "multi-image Add All preserves item media and results in explicit order", "... reports partial success ...", "... stops before the next item after actor changes"; BO: "17: Add All hands the sheet every other ready item with its OWN photo, analysis and id, in batch order" |
| 18 | Elise handoff | EXEC (per item); Elise-launched multi-photo OPEN | BO: "18: Ask Elise hands off the ACTIVE item's own photo and analysis, and refuses after an account switch" (extracted real closure). See B35-SCAN-016 for the Elise-launched return path |
| 19 | Account switching during processing | EXEC + REPAIRED earlier (B35-SCAN-008) | RR (3 tests incl. negative control); HM: "19: an account switch during selected-item processing ...", "19: an account switch during detection publishes no result for the new account"; BO: "19: an account switch mid-queue publishes nothing ..."; SQ: "actor switch during one request rejects its result ..." |
| 20 | Offline / network interruption | EXEC + REPAIRED (B35-SCAN-013); real timing DEVICE | HM: "DEFECT B35-SCAN-013: detection with no connection reports the real cause, keeps the selection and succeeds on retry", "20: connection loss during the queue never hangs it ..."; BO: "20: losing the connection mid-queue leaves retryable items, a released lock and no spinner" |

Mutation proof: each repair (and the two control repairs) was reverted one at a
time in the real source tree and restored from git after each run; all 11
reversals turned the guarding tests red.

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
| B35-SCAN-014 | P2, **OWNER DECISION** (environment-dependent) | Scanner result: `app.js` batch result projection; `hooks/useKScan.js` `hydrateMultiItemCommerce`; `services/commerceHydration.ts` | Backend flag `BACKEND_COMMERCE_FUNNEL_V127_ENABLED` (source default off; `docs/BUILD34_SCANNER_SCAN_RESULTS_DEEP_AUDIT.md` records it ON in App Staging; not re-verified here, no environment access) | Probe run through the same harness during this phase (a scratch script, deliberately not committed as a test because it would pin the defect): with the funnel on, a selected-item response yields `analysis.commerceDeferred=true` plus `commerceEvidence` and no `purchaseOptions`; the batch path forces `commerceStatus` idle and never calls `fetchDeferredCommerce`, so a batch item shows no shopping matches and saves none. Separately, a funnel-on multi-image detection dispatches one MODE B request per detected candidate before any item is chosen, and those cards are hidden in batch mode (`multiItemCommerce` is forced to `[]`). | Each selected item should show and persist its own matches (parity with the single-item path) and review should do no commerce work. Observed: an empty shelf per batch item and unused detection-time provider calls. | Hydrate commerce per selected item (stale-generation and actor guarded, attached to the saved record) or project the already-hydrated per-candidate card into the active item, and stop detection-time hydration in batch sessions. Medium scope; it changes provider spend, so it needs an owner ruling. Not fixed in this phase. |
| B35-SCAN-015 | P4 | `app.js` `persistBatchItem` | Local persistence | A PARTIAL item saved explicitly is stored like a complete one; a later successful retry updates the screen but not the saved record (there is no update path). | The saved record should carry its partial state or be refreshed on retry. | Add a partial marker to `metadata.multiScan` and an owner-scoped update; small to medium; deferred. |
| B35-SCAN-016 | P4 / product decision | `app.js` Elise return effect (`returnToSessionId`) | Static source reading, not executed | The Scanner opened from Elise accepts several photos (the picker is shared); the return effect hands Elise only the merged aggregate analysis of the first photo that produced items. | Either restrict Elise-launched scans to one photo or hand off per item. | Product call. The per-item Ask Elise action on the batch result is correct and executed (matrix 18). |
| B35-SCAN-017 | P4 | `hooks/useKScan.js` `runAnalysis` multi-image preparation loop | Photo preparation | One image that cannot be compressed or sanitized fails the whole batch closed (zero provider calls, selection kept, recoverable by removing it), but a raw compress exception shows connection copy and does not name the photo. | Name the photo and let the rest proceed. | Per-image try/catch feeding the existing detection notice; small; deferred because fail-closed was an explicit earlier decision. |
| B35-SCAN-018 | P4 | `ScanResultV2` and `useKScan.dismissResult` | Queue UX | There is no user cancel control during the selected-item queue; dismiss and retake are refused until it ends (bounded by the 20 s per-request timeout, at most five items). Leaving the screen or switching account does cancel correctly (executed). | A Cancel action that aborts the active operation and keeps finished items. | Expose an abort of `activeAbortControllerRef`; small; deferred. |
| B35-SCAN-019 | P4 | `app.js` `runBatchQueue` | Defensive | If the hook ever answers `busy`, ids set to QUEUED stay QUEUED with no retry path. Unreachable today: the screen lock and the hook lock both refuse a second queue first (executed). | Leftover QUEUED/ANALYZING ids should become FAILED so the existing retry applies. | Normalise leftover states after a non-quota halt; small; deferred. |
| B35-SCAN-020 | P4 | `app.js` aggregate save effect | Persistence | One photo with several garments still writes the Build 32 aggregate record (all candidates, one correct photo) in addition to per-item saves. Provenance is correct; the library may show both. | Decide whether the aggregate record should remain once per-item saving exists. | Product call. No multi-photo aggregate is ever written (executed gate). |

The P4 items do not block the restored explicit per-item retry/add paths. B35-SCAN-014 is the only item that may need to block commerce parity and is an owner decision.
