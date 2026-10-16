# Overnight campaign state (VTO + Elise, Build 35)

**Read this first if you are resuming.** Then independently verify every SHA, PR
state and CI result below against GitHub before acting. Nothing here is a
standing fact; it is what was proven at the time stamped below.

Last updated: 2026-10-16 (session 1, checkpoint 3).

## Standing restrictions (unchanged)

No EAS builds, APK/IPA/AAB, TestFlight or Play action. No Production operator,
paid-provider, pricing or subscription change. No migration replay. No force
push to shared branches. Live Camera VTO stays off and is not advertised.
Shared-contract PRs are implemented and tested by the agent but **not merged**
by it; they wait for owner review whatever CI says.

## Authority (verified 2026-10-16)

| Line | Branch | SHA |
|---|---|---|
| Mobile | `integration/build35-v1-convergence` | `c7c6f8e651c5ef49d39a4086c7e5f047c2149d9a` |
| Backend | `rebuild/backend-authority-v2` | `c74c99c1ee74d71486347e27a744ad0dd22c8e1a` |

Exact-source CI on the mobile tip `c7c6f8e6` (check-runs recorded on that
commit): 18 success, 10 skipped, 0 failed, 0 pending.

## Done and merged (by this campaign)

| PR | What | Merge SHA |
|---|---|---|
| #605 | settle_vto_generation_v2 GRANT signature fix (migration was un-installable) | `a62f5dd5` |
| #606 | vto-e2e duplicate-suppression control expects `request_in_flight` | `ccc9d676` |
| #607 | Pin Supabase CLI in Production activation workflow | `441c1102` |
| #608 | Bounded `entry_point` attribution (home_studio, elise, visual_search, closet, product_card) | `75384a61` |
| #609 | Pin Supabase CLI in vto-e2e (three steps) + infrastructure follow-up ledger | `c74c99c1` |
| #610 | Permanent Try-On Studio on Home | `c413daa7` |
| #614 | Elise ELISE-010 (composer under keyboard) and ELISE-011 (mouth transitions), recovered from Codex's uncommitted worktree | `c7c6f8e6` |

Deployed and verified (do not redo): migration `20261016001500` and
`vto-generate` in Staging (v20) and Production (v14); Production Photo VTO
operator `enabled:true`, provider `ailabtools_tryon_clothes_pro`, `live` block
absent, Watchlist and account-deletion config unchanged. Staging operator is
also ON. Staging transaction, concurrency and one bounded paid-provider
certification passed (run 38855818527).

Note on #610: it narrowed one structural test (the "no standalone VTO
destination" file-name guard) to exactly `app/try-on-studio.tsx`. A second
VTO-named route still fails it (negative control run). It was merged before the
shared-contract rule existed; flagged so the owner can re-review that one test
change if desired.

## Open PRs (all heads verified at time of writing)

| PR | Head | CI | Status |
|---|---|---|---|
| #611 `feat/vto-launch-identity-pin` | `795d55f0` | 17 pass, 0 fail | **Shared VTO launcher contract: QUEUED FOR OWNER REVIEW. Do not merge.** Carries ledger E-003 and E-004. |
| #615 `fix/elise-offer-kplus-label` (draft) | `6cc78979` | 17 pass, 2 pending | **K+ presentation: QUEUED FOR OWNER REVIEW.** Elise offer states "TRY IT ON · K+" to a Free customer before the tap, matching the product control. Updates two tests that pinned "a Free customer sees the same offer". |
| #616 `fix/vto-studio-live-probe-gating` | `404456e5` | running | Own Studio hook, not a shared contract; may be merged by the agent when exact-head CI is green. |
| #617 `feat/live-vto-native-selective-port` (draft) | `6ecff957` | running (incl. the ported iOS workflow) | **Native module + bundled model + governance change: NOT FOR MERGE; owner review.** |
| #613 `docs/overnight-campaign-state` | this file | green before rebase | Docs only. |

Local-only, never delete: `snapshot/codex-elise-composer-viewport-20261016`
(`1960da5d`, in the shared bare repo): a verbatim copy of Codex's uncommitted
Elise work. The Codex worktree `C:/src/elise-composer-viewport` was never
altered.

## Evidence so far

- **Canonical runner** (`node scripts/run-all-tests.js`, real `npm ci`
  dependency tree) on the Elise branch at base `c413daa`: EXIT 0, 603 test
  files, 10,960 pass, 0 fail, 99 skipped (environment skips: Apple-only and
  shell-specific controls). A first run showed one failure
  (`mirrorIosVisionParity`) that was a shallow-clone artifact: the test runs
  `git show 662effd7...:app.json`, a commit absent from a depth-limited clone.
  With the commit present it passes 20/20.
- `tsc --noEmit`: exit 0 on the Elise branch, the Live port, the K+ label
  branch and the probe-gating branch.
- Elise/avatar/speech/keyboard/Home-welcome suites: 1,506/1,506, 0 skipped.
- K+, VTO and Elise suites (K+ label branch): 2,506 tests, 0 fail, 36 skipped.
- VTO and analytics suites after the Live port: 1,301 tests, 0 fail, 5 skipped.
- **Android native (current source):** Kotlin module compiled; JUnit XML shows
  87 tests, 0 failures, 0 errors, 0 skipped, equal to the 87 `@Test`
  annotations. No app APK was assembled.
- **iOS native:** pending the ported workflow on #617 (no Swift/Xcode locally).
- An earlier `npm`-less baseline made 3 Elise tests and ~100 VTO tests look like
  "baseline failures". They were missing-dependency failures, now cleared by a
  real install; they are not accepted as a pass.

## Elise

- ELISE-010 (P2) composer under keyboard and ELISE-011 (P3) mouth transitions:
  **FIXED, DEVICE VALIDATION PENDING** (merged in #614). The keyboard test is
  layout arithmetic, not a device proof. `transitionMs` 160 is a candidate, not a
  tuned value. Animation tuning budget used: 0 of 3 cycles.
- Bounded Elise verification pass: the two repairs were reviewed line by line
  (reversal inverse-easing verified analytically; chip/denied states preserved;
  `ThinkingIndicator` is an element so the footer is valid). Device-only items
  from the Codex handoff stay UNVERIFIED: navigation during active audio, audio
  focus and call interruption, Reduce Motion with audible speech, two physical
  devices, and APK38 predates these repairs.
- No additional confirmed P0-P3 defect has been found in Elise source.

## Outstanding defects and blockers

| ID | Sev | What | State |
|---|---|---|---|
| VTO-GARMENT-SWAP | P1 | Open sheet silently follows a changed `productRef` | Fixed in #611 (owner review pending) |
| VTO-KPLUS-ELISE-LABEL | P2 | Elise offer for a Free customer states K+ only by colour | Fixed in draft #615 (owner decision) |
| VTO-STUDIO-LIVE-PROBE | P3 | Studio probed native Live capability on every render | Fixed in #616 (CI running) |
| ELISE-010 / 011 | P2 / P3 | See above | Fixed in source, DEVICE VALIDATION PENDING |
| VTO-RECENT-LOOKS | P7 | Saved try-ons are ordinary Dressing Room `inspiration_item`s with no VTO marker | Not built; owner decision |
| VTO-RESUME | P7 | A minimized try-on belongs to its launching entry | Not built; needs a restorable app-level session |
| LIVE-ANDROID-CAMERA | hold | Samsung SM-S936U: camera opens, no frames, `ETIMEDOUT -110` | Not retried; device needed |
| LIVE-IOS | hold | Historical Swift/simulator evidence only | CI on #617 + device needed |
| N-08 | P3 | Foreign Closet id: backend covered by unit tests; client explicit foreign-id route test and live Staging negative control not written | Open |
| N-09 | P3 | Visual Search account-switch-during-resolution test | Open |
| CI-ENV | note | 36-99 environment skips per suite family | Documented, not counted as passes |

## Owner decisions required

1. **#611** (shared launcher identity pin): review and merge, or request changes.
2. **#615** K+ pre-tap presentation for the Elise offer; see the memo.
3. **#617** the native module: the bundled model and its governance registry, the
   binary-size impact, and whether to carry the diagnostic route.
4. **Recent Looks**: smallest safe extension is a bounded, additive, VTO-origin
   marker on the saved Dressing Room item (for example an optional
   `origin: 'vto_try_on'` plus the garment identity it was made for), written by
   the existing `AddScanToDressingRoomModal` save path and read by the Studio
   through the existing authorized Dressing Room read. This touches the shared
   Dressing Room persistence contract, so it needs your review and a decision on
   whether items saved before the change are simply not listed.
5. **Resume**: needs an app-level restorable session; not recommended until
   Recent Looks is decided.
6. **Dressing Room resume attribution**: unattributed today; a sixth
   `entry_point` value only if you want it measured separately.

## K+ pre-tap decision memo

What exists today. Product and scan-result items already show a Free customer a
distinct K+ control before any tap (text `TRY IT ON · K+`, accessibility label
"Try It On is available with K+"). The Studio shows a K+ marker and a plain note
before any action. The Elise offer was the exception (colour only); #615 aligns
it.

| Option | What the customer sees | Pros | Cons |
|---|---|---|---|
| 1. K+ visible before tapping | A K+ labelled action; tapping opens the shared K+ sheet | Honest, already built on product, scan and Studio surfaces | Free customers see a control they cannot use |
| 2. Upgrade shown only at the action | Same plain Try It On for everyone; tapping opens K+ | Cleaner surface | Conceals the requirement until intent is spent; conflicts with the pre-tap transparency requirement |
| 3. Introductory free use | A limited free try-on | Likely strongest conversion | New commercial policy, quota and cost exposure (each generation is a paid provider call); needs owner approval and a cost model |

Recommendation: option 1 everywhere (merge #615 so Elise matches), and treat
option 3 as a separate commercial decision with a cost model; do not build it
speculatively.

## Next executable actions

1. Wait for exact-head CI on #616; merge when green (own hook, not a shared contract).
2. Read the ported iOS workflow result on #617 and record it in the convergence
   report.
3. Client N-08 and N-09 tests (and the live Staging foreign-Closet negative
   control only with explicit scope, since it needs synthetic users).
4. Merge this document (#613) once green.
5. Morning handoff.
