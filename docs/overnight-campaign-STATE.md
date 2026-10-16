# Overnight campaign state (VTO + Elise, Build 35)

**Read this first if you are resuming.** Then independently verify every SHA, PR
state and CI result below against GitHub before acting. Nothing here is a
standing fact; it is what was proven at the time stamped below.

Last updated: 2026-10-16 (session 1, checkpoint 5).

## Standing restrictions (unchanged)

No EAS builds, APK/IPA/AAB, TestFlight or Play action. No Production operator,
paid-provider, pricing or subscription change. No migration replay. No force
push to shared branches. Live Camera VTO stays off and is not advertised.
Shared-contract PRs are implemented and tested by the agent but not merged by
it; the owner decides.

## Authority (verified 2026-10-16)

| Line | Branch | SHA |
|---|---|---|
| Mobile | `integration/build35-v1-convergence` | `bf5214b57d7c7ef465de93c12b7491d56dc3987a` (functional source unchanged since `1d2ec4a7`; later commits are docs only) |
| Backend | `rebuild/backend-authority-v2` | `c74c99c1ee74d71486347e27a744ad0dd22c8e1a` |

## Exact-source verification of the mobile tip `1d2ec4a7`

| Check | Result |
|---|---|
| CI check-runs recorded on the tip | 28: 18 success, 10 skipped, 0 failed, 0 pending |
| Workflows on the tip | Build 35 iOS source certification (38885384027), Build 35 Release Profile Guard (38885383863), Dependency Reachability Gate (38885384139), K Scan Staging Security Gate (38885384148), Security Code and Dependencies (38885383940), Security Promotion Gate (38885383911), Security ZAP API Staging (38885383861), Security ZAP Baseline Staging (38885384012), VTO Backend E2E (38885383945): all completed/success |
| Canonical runner `node scripts/run-all-tests.js`, real `npm ci` tree, on the exact tip tree | EXIT 0; 11,125 tests, 11,026 pass, 0 fail, 99 skipped |
| `tsc --noEmit` on the exact tip tree | exit 0 |
| Skips | 99 environment skips (Apple-only checks and shell-specific CI controls that cannot run on this Windows machine). Skipped is not passed. |

Backend `c74c99c1`: seven required backend workflows were green on the backend
tip before this campaign's merges and #609's follow-up; not re-run this session
(no backend change since).

## Done and merged

By this campaign: #605, #606, #607, #608, #609, #610, #614, #616.
By the owner during this session: #611, #615, #617, #618.

| PR | What | Merge SHA |
|---|---|---|
| #605 | settle_vto_generation_v2 GRANT signature fix (migration was un-installable) | `a62f5dd5` |
| #606 | vto-e2e duplicate-suppression control expects `request_in_flight` | `ccc9d676` |
| #607 | Pin Supabase CLI in Production activation workflow | `441c1102` |
| #608 | Bounded `entry_point` attribution | `75384a61` |
| #609 | Pin Supabase CLI in vto-e2e + infrastructure follow-up ledger | `c74c99c1` |
| #610 | Permanent Try-On Studio on Home | `c413daa7` |
| #614 | Elise ELISE-010 / ELISE-011, recovered from Codex's uncommitted worktree | `c7c6f8e6` |
| #616 | Studio probes native Live capability only after the cheaper Live gates agree | `91381998` |
| #611 | Shared launcher pins the tapped garment (owner merged) | `ddba056a` |
| #615 | Elise offer states K+ to a Free customer before the tap (owner merged; option 1 chosen) | `d62d9dea` |
| #617 | Native Live module and governed offline model on Build 35 (owner merged) | `1d2ec4a7` |
| #618 | N-08 client foreign-Closet route test (owner merged) | `298b753a` |

Deployed and verified (do not redo): migration `20261016001500` and
`vto-generate` in Staging (v20) and Production (v14); Production Photo VTO
operator `enabled:true`, provider `ailabtools_tryon_clothes_pro`, `live` block
absent, Watchlist and account-deletion config unchanged. Staging operator is
also ON. Staging transaction, concurrency and one bounded paid-provider
certification passed (run 38855818527).

Owner decisions evidenced by the merges: shared launcher identity pin approved
(#611); K+ pre-tap disclosure on the Elise offer approved, i.e. option 1
(#615); the native module, the bundled `pose_landmarker_lite.task` and the
on-device model authority registry approved onto the Build 35 line (#617).
These are inferred from the merges, not from a written statement; confirm if it
matters.

## Open

| Item | State |
|---|---|
| #619 `fix/vto-sheet-closes-on-actor-boundary` | N-09 follow-up to #611: an open try-on sheet (or its pill) now closes when the actor changes, instead of lingering with the previous actor's garment. Shared launcher contract: **implemented and tested, NOT merged by the agent; owner decides.** Head `8c2a5ce6`: 34 pass, 20 skipped, 0 fail, mergeable CLEAN; canonical runner 11,128 tests, 0 fail, 99 skipped; mutation check (removing the close effect fails N-09). First CI run failed on the logout guard (`ForActor` in a function name); fixed by renaming, guard untouched. Not device-validated. |
| #620 merged (`bf5214b5`) | `docs/vto-elise-device-validation-runbook.md`: the exact device checks still owed. Docs only. |
| Local, never delete | `snapshot/codex-elise-composer-viewport-20261016` (`1960da5d`): verbatim copy of Codex's uncommitted Elise work. The Codex worktree `C:/src/elise-composer-viewport` was never altered. |

## Native Live: evidence by tier (current Build 35 source)

| Tier | Android | iOS |
|---|---|---|
| Source present | Yes | Yes |
| Compile passed | Yes: Kotlin module compiled on the current dependency tree (Gradle 8.14.3) | Yes: ported workflow, run 38877762424: `expo prebuild` + `pod install` + `xcodebuild` simulator Debug, both jobs success (head `6ecff957`, pre-merge) |
| Automated tests passed | Yes: JUnit XML 87 tests, 0 fail, 0 error, 0 skip, equal to 87 `@Test` annotations | Yes: SwiftPM host tests (LiveVtoCore) success in the same run |
| Physical device | **No** (historical Samsung render screenshot only) | **No** |
| Camera frames | **HOLD**: historical `ETIMEDOUT -110`; not retried | Not tested |

The iOS workflow ran on the PR head before merge; it triggers on module-path PRs
and dispatch only, so it did not run on the merged tip. No app APK/IPA was built.
Live remains off by the build flag and the remote switch; the Studio and the
router never treat the development harness as native Live.

## Elise

- ELISE-010 (P2) composer under keyboard and ELISE-011 (P3) mouth transitions:
  **FIXED, DEVICE VALIDATION PENDING** (#614). The keyboard test is layout
  arithmetic, not a device proof. `transitionMs` 160 is a candidate, not tuned.
  Animation tuning budget used: 0 of 3 cycles.
- Bounded verification pass found no further confirmed P0-P3 defect in Elise
  source. Device-only items from the Codex handoff stay UNVERIFIED: navigation
  during active audio, audio focus and call interruption, Reduce Motion with
  audible speech, two physical devices. APK38 predates the repairs.
- Elise ledger: E-001..E-005 recorded (`docs/elise-vto-integration-ledger.md`).

## Outstanding defects and blockers

| ID | Sev | What | State |
|---|---|---|---|
| ELISE-010 / 011 | P2 / P3 | Composer under keyboard; mouth transitions | Fixed in source, DEVICE VALIDATION PENDING |
| LIVE-ANDROID-CAMERA | hold | Samsung SM-S936U: camera opens, no frames, `ETIMEDOUT -110` | Not retried; needs a device and logcat, one bounded session |
| LIVE-IOS-DEVICE | hold | No current-source device evidence | Device needed |
| VTO-RECENT-LOOKS | P7 | Saved try-ons are ordinary Dressing Room `inspiration_item`s with no VTO marker | Not built; owner decision |
| VTO-RESUME | P7 | A minimized try-on belongs to its launching entry | Not built; needs a restorable app-level session |
| N-08 live Staging control | P3 | Cross-account Closet access against the real backend | Unit-level covered (client and backend); a live control needs synthetic users and explicit scope |
| BINARY-IMPACT | note | The native module, CameraX/MediaPipe deps and a 5.78 MB model per platform are now on the Build 35 line | Size and review impact unmeasured (no build authorized) |
| PHOTO-QUALITY | note | Photo VTO certification proved a successful request and non-empty sanitized media, not a human-acceptable try-on | Needs an inspectable synthetic result or an authorized further call |

## Owner decisions still required

1. **Recent Looks**: smallest safe extension is a bounded, additive, VTO-origin
   marker on the saved Dressing Room item (for example an optional
   `origin: 'vto_try_on'` plus the garment identity it was made for), written by
   the existing `AddScanToDressingRoomModal` save path and read by the Studio
   through the existing authorized Dressing Room read. It touches the shared
   Dressing Room persistence contract, and you must decide whether items saved
   before the change are simply not listed.
2. **Resume**: needs an app-level restorable session; not recommended until
   Recent Looks is decided.
3. **Dressing Room resume attribution**: unattributed today; a sixth
   `entry_point` value only if you want it measured separately.
4. **Diagnostic route** for Live device testing (not ported).
5. **Next EAS build authorization**, when you are ready: device validation of
   ELISE-010/011, the Android camera hold, iOS device evidence and photo quality
   all need a new artifact built from the exact merged source.

## Build 35 decision

**SOURCE PARTIAL, FURTHER REPAIRS NOT IDENTIFIED BUT DEVICE EVIDENCE REQUIRED.**
On source: the tip is green on every required check, the canonical runner and
`tsc` pass on the exact tree, and no open P0-P3 source defect is known in the
VTO or Elise lanes. It is not whole-app release readiness (other lanes are
outside this campaign) and it is not device-certified: Live camera, the two
Elise repairs and Photo output quality have no device evidence.
