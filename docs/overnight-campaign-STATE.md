# Overnight campaign state (VTO + Elise, Build 35)

**Read this first if you are resuming.** Then independently verify every SHA, PR
state and CI result below against GitHub before acting. Nothing here is a
standing fact; it is what was proven at the time stamped below.

Last updated: 2026-10-16 (session 1, checkpoint 2).

## Standing restrictions (unchanged)

No EAS builds, APK/IPA/AAB, TestFlight or Play action. No Production operator,
paid-provider, pricing or subscription change. No migration replay. No force
push to shared branches. Live Camera VTO stays off and is not advertised.
Shared-contract PRs are implemented and tested by the agent but **not merged**
by it; they wait for owner review whatever CI says.

## Authority (verified 2026-10-16)

| Line | Branch | SHA |
|---|---|---|
| Mobile | `integration/build35-v1-convergence` | `c413daa783356ea8db44be816f0dc68da3889e61` |
| Backend | `rebuild/backend-authority-v2` | `c74c99c1ee74d71486347e27a744ad0dd22c8e1a` |

## Phase

Checkpoint 1 (VTO launch reliability): code done, one PR awaiting owner review.
Checkpoint 2 (K+/discovery, Live native, Elise recovery): in progress.

## Done and merged (by this campaign)

| PR | What | Merge SHA |
|---|---|---|
| #605 | settle_vto_generation_v2 GRANT signature fix (migration was un-installable) | `a62f5dd5` |
| #606 | vto-e2e duplicate-suppression control expects `request_in_flight` | `ccc9d676` |
| #607 | Pin Supabase CLI in Production activation workflow | `441c1102` |
| #608 | Bounded `entry_point` attribution (home_studio, elise, visual_search, closet, product_card) | `75384a61` |
| #609 | Pin Supabase CLI in vto-e2e (three steps) + infrastructure follow-up ledger | `c74c99c1` |
| #610 | Permanent Try-On Studio on Home | `c413daa7` |

Deployed and verified (do not redo): migration `20261016001500` and
`vto-generate` in Staging (v20) and Production (v14); Production Photo VTO
operator `enabled:true`, provider `ailabtools_tryon_clothes_pro`, `live` block
absent, Watchlist and account-deletion config unchanged. Staging operator is
also ON. Staging transaction, concurrency and one bounded paid-provider
certification passed (run 38855818527).

Note on #610: it narrowed one structural test (the "no standalone VTO
destination" file-name guard) to exactly `app/try-on-studio.tsx`. A second
VTO-named route still fails it (negative control run). It was merged before
the shared-contract rule below existed; flagged here so the owner can re-review
that one test change if desired.

## Open PRs and branches

| Item | Head | CI | Status |
|---|---|---|---|
| PR #611 `feat/vto-launch-identity-pin` | `0e84a814` | 17 pass, 0 fail | **Shared VTO launcher contract: QUEUED FOR OWNER REVIEW. Do not merge.** |
| `fix/elise-composer-and-mouth-transitions` (local, mobE worktree) | `c1b26f5` | not yet pushed | Recovered ELISE-010/011; being verified |
| `snapshot/codex-elise-composer-viewport-20261016` (local, shared repo) | `1960da5d` | n/a | Verbatim preservation of Codex's uncommitted work; never delete |
| `docs/overnight-campaign-state` | this file | n/a | This document |

## Elise recovery (Codex worktree)

`C:/src/elise-composer-viewport` (branch `codex/elise-composer-viewport-20261015`,
base `fc04deb7`) was left untouched. Its 8 modified files, 1 untracked test and
1 evidence PNG were preserved as `1960da5d` using a temporary index, so the
worktree state was never altered. The handoff patch (`pending-device-repairs.patch`)
matches the worktree line for line (107 changed lines each); the handoff
SHA256.json verifies for all four files. The patch applied cleanly to the
current authority and is committed as `c1b26f5`.

- **ELISE-010 (P2) composer under keyboard:** weather disclosure moved into the
  message-list footer. Source-verified. **DEVICE VALIDATION PENDING.** The
  layout test is arithmetic, not a device proof.
- **ELISE-011 (P3) mouth transitions:** engine returns `from`, renderer blends
  approved art with an opaque underlay, reversal re-anchored on the exact
  inverse easing, neutral on end/interruption/Reduce Motion, no new clock.
  `transitionMs` 160 is a candidate, not tuned. **DEVICE VALIDATION PENDING.**
  Animation tuning budget used: 0 of 3 cycles.

## Verification results so far

- VTO + analytics + owned-Closet suites (mobile): 805 tests, 800 pass, 1 fail
  (`premise: React Native forces edge-to-edge Modals`), identical on the
  untouched integration tip. Cause: this clone has no `react-native` installed.
- Elise/avatar/speech suites on the recovered branch: 1,412 tests, 1,409 pass;
  the 3 failures (`stylistIdentity` load, 2 React-Native-premise tests) are
  byte-identical on the untouched integration tip and share the same cause.
  A real `npm ci` was started to clear that; the canonical runner and
  TypeScript check have **not yet been run**, so no release verdict exists.

## Outstanding defects and blockers

| ID | Sev | What | State |
|---|---|---|---|
| VTO-GARMENT-SWAP | P1 | Open sheet silently follows a changed `productRef` | Fixed in #611 (owner review pending) |
| ELISE-010 | P2 | Composer unreachable under keyboard with weather disclosure | Fixed in source, DEVICE VALIDATION PENDING |
| ELISE-011 | P3 | Abrupt mouth-image transitions | Fixed in source, DEVICE VALIDATION PENDING |
| VTO-KPLUS-ELISE-LABEL | P2 | Elise offer for a Free customer keeps the plain "TRY IT ON" label and plain accessibility label; only colour differs. The product control already says "Try It On is available with K+" before tapping | Found; fix prepared separately for owner review (K+ presentation) |
| VTO-RECENT-LOOKS | P7 | Saved try-ons are ordinary Dressing Room `inspiration_item`s with no VTO marker | Not built; needs owner decision (see below) |
| VTO-RESUME | P7 | A minimized try-on belongs to its launching entry; Studio cannot restore it | Not built; needs a restorable app-level session |
| LIVE-ANDROID-CAMERA | hold | Historical Samsung SM-S936U: front camera opens, no frames, `ETIMEDOUT -110` | Not retried this campaign; device needed |
| LIVE-IOS | hold | Swift unit + simulator build passed on Sept 6-7 sources only; no current-source or device evidence | Device and current-source build needed |
| N-08 | P3 | Foreign Closet id: backend covered by unit tests; client explicit foreign-id route test and live Staging negative control not yet written | Open |
| N-09 | P3 | Visual Search account-switch during resolution test | Open |

## Owner decisions required

1. **#611** (shared launcher identity pin): review and merge, or request changes.
2. **K+ pre-tap presentation for the Elise offer**: see the memo below.
3. **Recent Looks**: smallest safe extension is a bounded, additive, VTO-origin
   marker on the saved Dressing Room item (for example an optional
   `origin: 'vto_try_on'` plus the garment identity it was made for), written by
   the existing `AddScanToDressingRoomModal` save path and read by the Studio
   through the existing authorized Dressing Room read. This touches the shared
   Dressing Room persistence contract, so it needs your review and a decision on
   whether saved items from before the change are simply not listed.
4. **Resume**: needs an app-level restorable session (the launch host's state is
   per entry on purpose). Not recommended until Recent Looks is decided.
5. **Dressing Room resume attribution**: unattributed today; a sixth
   `entry_point` value only if you want it measured separately.

## K+ pre-tap decision memo

What exists today. Product and scan-result items already show a Free customer a
distinct K+ unlock control before any tap, labelled "Try It On is available with
K+" for assistive tech and styled differently. The Studio shows a K+ marker and a
plain note before any action. The Elise offer is the exception: its Free
variant changes colour only.

| Option | What the customer sees | Pros | Cons |
|---|---|---|---|
| 1. K+ visible before tapping (current product-card behaviour) | A K+ labelled action; tapping opens the shared K+ sheet | Honest, no surprise, already built and tested on product and scan surfaces | Free customers see a control they cannot use |
| 2. Upgrade shown only at the action | Same plain Try It On for everyone; tapping opens K+ | Cleaner surface | Conceals the requirement until intent is spent; conflicts with the pre-tap transparency requirement |
| 3. Introductory free use | A limited free try-on | Likely strongest conversion | New commercial policy, quota and cost exposure (each generation is a paid provider call); needs owner approval and a cost model |

Recommendation: keep option 1 everywhere, and fix the one outlier by giving the
Elise offer the same K+ wording the product control already uses (reusing the
existing copy, not new copy). Treat option 3 as a separate commercial decision
with a cost model; do not build it speculatively.

## Next executable actions

1. Finish `npm ci` in the mobE worktree; run TypeScript and the canonical test
   runner on `fix/elise-composer-and-mouth-transitions`; push; open a PR; wait
   for exact-head CI. Elise repairs are not shared-contract changes, so this PR
   may be merged by the agent once all required gates are green.
2. Prepare the Elise K+ label branch (do not merge).
3. Start the Live native selective port from the 87 purely new files of
   `feature/live-vto-native-working-prototype` (merge base `4365cebf`), then
   reconcile the 8 overlapping files by hand: `.gitignore`, both
   `AndroidManifest.xml`, `package.json`, `package-lock.json`, the integration
   manifest, `vtoPrivacyAndWiring.test.js`, `mirrorExtractionContainment.test.js`.
4. Client N-08 and N-09 tests.
5. Exact-source CI matrix and the morning handoff.
