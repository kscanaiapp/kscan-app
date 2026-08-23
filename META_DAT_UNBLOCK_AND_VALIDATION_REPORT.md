# K Scan AI — Meta DAT Unblock & Native Validation

**Date:** 2026-08-22
**Phase:** DAT package unblock attempt + native validation, following the convergence phase (`META_RAYBAN_NATIVE_HARDWARE_CONVERGENCE_REPORT.md`)

---

## Executive Summary

| Gate | Status |
|---|---|
| DAT Package Access | **BLOCKED** — no `read:packages` credential on this host |
| DAT Compile | **NOT RUN** — blocked by package access |
| MockDeviceKit | **NOT RUN** — blocked by package access |
| Staging Deploy (grouping fix) | **PASS** — deployed and verified live (v3 → v4) |
| Authenticated E2E | **BLOCKED** — no approved staging QA account exists or could be created |
| Emulator Runtime | **PASS** — installed, launched, real UI rendered, zero crashes (see below) |
| Physical Hardware | **NOT VERIFIED** — no glasses present |

**P0:** 0 &nbsp; **P1:** 1 (module's manifest-declared minSdk 29 broke the whole app build unconditionally, fixed this session) &nbsp; **P2:** 1 (ml-kit/Mirror dependency conflict, documented not resolved) &nbsp; **P3:** 1 (double-error on missing-token gate, fixed this session)

**Open blockers requiring human action:**
1. A GitHub PAT (classic) with **only** `read:packages`, configured locally as `GITHUB_TOKEN` or `github_token` in `local.properties` — never pasted into chat.
2. A disposable staging QA account for App Staging (`yzqjvdfgefveprobvvyw`) — created via the normal signup flow, or existing credentials handed over via local env, never in chat.

**This phase did not skip a layer to manufacture progress.** Where a gate was blocked, work stopped at that gate and moved to independent verifiable work instead — it did not simulate the blocked gate.

---

## Starting Repositories / SHAs

| Repo | Branch | Starting HEAD |
|---|---|---|
| `kscan-glasses-webapp` | `feature/meta-physical-device-candidate-v1` | `8b67161` (pushed) |
| `KScan-meta-physical-device-v1` | `feature/meta-physical-device-candidate-v1-mobile` | `2211240` (pushed) |

Both confirmed via `git fetch --all --prune` + `git status -sb`: local HEAD equalled `origin/<branch>` for both, trees clean, before any work began this phase.

## Final Repositories / SHAs

See [Commits](#commits) and [Push Confirmation](#push-confirmation) below.

---

## GitHub Packages Prerequisite

Meta's current official Android integration guide requires a GitHub Personal
Access Token (classic) with at minimum the `read:packages` scope, supplied as
either the `GITHUB_TOKEN` environment variable or `github_token` in
`local.properties`, to resolve `com.meta.wearable:mwdat-*` from
`https://maven.pkg.github.com/facebook/meta-wearables-dat-android`.

## Token Type / Scope Verification

Checked without printing any token value:

```
gh auth status
  Token scopes: 'gist', 'read:org', 'repo', 'workflow'
```

No `read:packages`. Also checked and confirmed absent:
- `GITHUB_TOKEN` environment variable — not set.
- `github_token` key in either repo's `android/local.properties` — not set in either.

## DAT Package Resolution

**BLOCKED — TOKEN PRESENT BUT INSUFFICIENT SCOPE.** (More precisely: a
GitHub-authenticated token exists via `gh`, but it lacks the one scope that
matters for this registry.)

Per §U8's investigation order:
1. Is the credential a PAT classic? — The `gh` CLI token is not usable for this
   purpose regardless of type; a dedicated PAT is required.
2. Does it include `read:packages`? — No (confirmed above).
3-8. Not reached — the scope check alone determines the outcome; broadening
   the search further would not change it, and the mission's own rule (§8,
   U9) is not to broaden scopes speculatively.

**No further action was taken to manufacture, derive, or request this
credential.** Per §6-9 and §U6-U9, this is a legitimate human-authority gate.

---

## DAT 0.9 Actual API Surface

**NOT VERIFIED — blocked by package resolution.** No compile against the real
SDK ran this phase. Everything below in the "DAT 0.9 Actual API Surface" line
of the evidence classification remains sourced from the *convergence* phase's
documentation research (official README/CHANGELOG/API reference), not from an
actual compiler run — this phase did not change that.

## PhotoData Contract

**NOT VERIFIED — blocked.** `photoBytes()` in `DatEngine.kt` remains the one
isolated, explicitly-flagged unverified symbol from the convergence phase.
No change was possible or made this phase.

## SDK Drift Found

None discovered this phase (no compile ran to discover any).

---

## Native Adapter Compilation

**Flag-off build:** re-verified this phase — `:kscan-meta-wearable:assembleDebug`
with `kscan.mwdat.enabled` unset — **BUILD SUCCESSFUL**, 0 Kotlin errors,
after the reordering fix below.

**Flag-on-without-token build:** deliberately exercised as a negative control
(this is the actual behavior a developer without the token will experience).
Before this phase's fix, it produced two misleading, unrelated-looking errors:

```
1) A problem occurred evaluating project ':kscan-meta-wearable'.
   > kscan.mwdat.enabled=true but no GitHub Packages credential was found...
2) A problem occurred configuring project ':kscan-meta-wearable'.
   > EvalIssueException: project ':kscan-meta-wearable' does not specify
     `compileSdk` in build.gradle
```

Root cause: the credential-gate `throw` sat at the top of the build script,
before Gradle ever reached the `android {}` block that sets `compileSdk`. The
`GradleException` aborted script evaluation, so AGP's own independent
evaluation of the same project never saw `compileSdk` and reported its own,
unrelated-looking failure — one real cause presenting as two.

**Fixed** by moving the credential check (and the maven repository it guards)
to *after* the `android {}` block in `modules/kscan-meta-wearable/android/build.gradle`.
Reverified both directions:
- Flag off → still `BUILD SUCCESSFUL`.
- Flag on, no token → exactly the one intended `GradleException` message, no
  secondary error.

**DAT-enabled build:** **NOT RUN** — blocked by package access. The gate's
error message was verified to be correct and singular, but the actual
DAT-linked compile itself did not happen.

## Reflection / Typed API Decision

Reviewed per §14/U15, without needing a live SDK compile — this is a
code-organization question answerable by inspection:

- `DatEngine.kt` (the `mwdat` source set) uses **zero reflection**. Every DAT
  call — `Wearables.initialize`, `session.addCamera`, `MockDeviceKit.enable`,
  etc. — is direct and typed. Confirmed by grep: no `Class.forName`,
  `::class.java`, or `reflect.` anywhere in that file.
- Reflection is used in exactly **one** place: `MetaWearableEngineFactory.engine`
  in `MetaWearableEngine.kt` (main source set), to resolve `DatEngine` by name.

**Decision: KEEP.** This one reflective lookup is structurally necessary, not
a workaround for missing SDK access. It is the only mechanism that lets the
always-compiled main source set reach into the conditionally-compiled `mwdat`
source set without a compile-time dependency edge — which is exactly the
property that lets a flag-off build ship with zero DAT symbols at all.
Removing it would require either making `main` permanently depend on `mwdat`
(collapsing the whole point of the flag) or an equivalent indirection (a
`ServiceLoader`, for instance) that is reflection under a different name.
Nothing else needs to change once DAT resolves.

---

## MockDeviceKit

**NOT RUN — BLOCKED.** `mwdat-mockdevice:0.9.0` sits behind the same 401. No
capability inventory, journey, or negative test could be exercised. Not
substituted with the browser simulator or any other stand-in.

## Capability Matrix

Unchanged from the convergence report — no new evidence available this phase.

## Session Lifecycle / Camera / Photo Capture / Display / Device State / Thermal / Power

**NOT RE-VERIFIED against the real SDK** — all remain as documented in the
convergence report: implemented and unit-tested at the orchestration-logic
layer (`services/metaWearableDevice.ts`, 26 passing tests, DAT-symbol-free by
construction), but not exercised against actual DAT types.

---

## Privacy

**Capture Provenance:** unchanged and correct — `sanitizeMetaWearableCapture`
records `source: 'meta_glasses'` when the caller passes it (wired in
`app/wearables/meta.tsx`), never silently defaults a glasses capture to
`phone_camera`. Not re-verified against a real DAT `PhotoData` object this
phase (blocked).

## Grouping Fix

**Local source vs. live, before touching anything (§28):** compared
byte-for-byte. Live `wearable-scan` v3 was **identical** to local commit
`4fa9e74` — the direct parent of the grouping fix (`8b67161`). No drift, no
reconciliation needed, nothing to lose by deploying.

## Staging Deployment

**PASS.** Deployed via the Supabase CLI (`supabase functions deploy
wearable-scan --project-ref yzqjvdfgefveprobvvyw`), after the MCP
`deploy_edge_function` tool's parameter schema failed to render correctly
through two well-formed attempts — rather than keep guessing against a live
deploy endpoint, the repo's own authenticated CLI path was used instead, for
full command-line visibility into exactly what shipped.

- Project confirmed via `get_project` immediately before deploying: **"K Scan
  AI Staging"** (`yzqjvdfgefveprobvvyw`) — the correct target, explicitly not
  `wyyuqfdxucjksghsmhry` ("KScan App Production").
- `wearable-scan`: **version 3 → version 4**.
- `verify_jwt: false` preserved (matches v3 — not silently changed).

## Staging Verification

Fetched the deployed source back via `get_edge_function` immediately after
deploy: **byte-identical** to local `HEAD` (`ezbr_sha256` differs only because
the deploy path includes `supabase/functions/` in the archived filename, the
file *contents* match). `commerceGroup` is now derived from provenance, not
hard-coded.

Re-ran the Deno normalization suite (16/16) and the client-side companion
result contract suite (29/29) against the exact deployed logic — both green,
including the 5 grouping-specific tests added last phase.

**Not run:** a live authenticated HTTP round-trip through the `scan` action
itself — that requires a valid wearable session token, which requires the
blocked QA account.

---

## QA Test Account Authority

**BLOCKED — STAGING QA ACCOUNT.** Searched this repo's own tooling first, in
the order §U21 specifies (docs, QA docs, README/AGENTS, test-account docs,
seed scripts, Supabase dev tooling, admin/test-user tooling). Found exactly
one seeding mechanism: `scripts/staging-v2/seed-fixtures.mjs`. It:

1. Targets a **different** project ("Staging v2"), not App Staging
   (`yzqjvdfgefveprobvvyw`) — the project this whole candidate actually runs
   against.
2. Contains an explicit, hard-coded guard —
   `FORBIDDEN_SEED_PATTERNS: AUTH_USER_INSERT` — that **refuses to run** if
   its seed SQL inserts into `auth.users`, with the script's own comment
   stating *"the primary emulator test user is created through the real
   signup flow, never inserted."*

No approved mechanism exists for creating a disposable test account on the
actual target project. Per §33/U23, no ad-hoc bypass was built: no hardcoded
user ID, no `auth.users` insert, no JWT-skip, no dev-auth shortcut. This
blocks the entire authenticated chain (§35-39) at its root.

**Human action required:** sign up a disposable account on App Staging
through the app's real signup flow, or supply existing disposable QA
credentials via a local env var — never in chat.

## Authenticated K Scan Session / Canonical Analysis / StyleMatch / Result / Save / Open on Phone / Sign-Out / Revocation

**NOT VERIFIED — blocked** by the QA account gate above. All of these were
already contract-tested in the convergence phase (companion protocol 67,
pairing 18, statemachine 30, result 29, reconnect 13, wearable integration
14 — all still passing this phase, re-run and confirmed) but none of that is
a substitute for a real authenticated round trip.

---

## Reconnect / Failure Matrix

Unchanged from the convergence phase at the orchestration layer (cancellation,
late-capture discard, cleanup-on-every-failure-path — all covered by the 26
tests in `metaWearableDevice.test.js`, re-run this phase, still 26/26). No new
DAT-layer reconnect testing was possible (blocked).

---

## Negative-Control Harness Verification

Two release-critical suites were deliberately mutated, proven to catch the
fault, then restored — per §40/U24-26.

**1. `services/metaWearableDevice.ts` — removed the session-STARTED check
before camera attach.**

```diff
- const started = await native.startSession();
- if (started.state !== 'STARTED') {
-   throw new MetaDeviceError('META_SESSION_START_FAILED');
- }
+ const started = await native.startSession();
+ // FAULT INJECTED
```

Result: exactly 1 of 26 tests failed — `'the camera is never attached before
the session reaches STARTED'` — with the other 25 correctly unaffected
(precise, not noisy). Restored; `git diff` empty; 26/26 green again.

**2. `supabase/functions/wearable-scan/normalize.ts` — reverted commerce
grouping to hard-coded `'retail'`.**

Result: exactly 1 of 16 Deno tests failed — `'similarityMatches are grouped
as suggested, not presented as retail listings'` — the other 3
grouping-specific tests correctly stayed green because their invariants
(retail-still-routes-correctly, no-resale-ever-produced, default-parameter
behavior) are genuinely orthogonal to this specific mutation. Restored; `git
diff` empty; 16/16 green again.

**Conclusion:** both harnesses detect the fault they are supposed to detect,
and only that fault — neither is a rubber stamp.

---

## Builds

| Task | Result |
|---|---|
| `:kscan-meta-wearable:assembleDebug` (flag off) | **BUILD SUCCESSFUL** |
| `:kscan-meta-wearable:assembleDebug` (flag on, no token) | **Fails with exactly one intended error** (fixed this phase) |
| `:kscan-meta-wearable:assembleDebug` (flag on, with token) | NOT RUN — blocked |
| `:app:assembleDebug` (full app, flag off) | **BUILD SUCCESSFUL** (5m36s) — see Emulator Runtime for install/launch |
| `tsc --noEmit` | Clean (re-verified) |

**Build variant authority (§U4-U5), verified rather than assumed:** this
project has **no** `metaCandidate`/`hardwareCandidate` Gradle product flavor —
confirmed via `gradlew tasks --all`. Only `debug`/`release` build types exist.
The "hardware candidate" is the **EAS build profile** `meta-physical-candidate`
(env-var driven), layered on top of the ordinary `assembleDebug`/`assembleRelease`
Gradle tasks via `kscan.mwdat.enabled`/`KSCAN_MWDAT_ENABLED`. No task named
`assembleMetaPhysicalCandidate` exists or was invented.

## Emulator Runtime

**PASS — full install-and-launch verified, not just boot.**

`Pixel_8_Pro` AVD booted (Android 17, API 37) after ~4 minutes under host
memory pressure (~3.9GB free RAM at the start; the active Gradle daemon was
stopped first to free ~1.3GB, per the "use one emulator, watch memory
pressure" guidance, §34/U34). WHPX hypervisor confirmed active throughout;
not hung or crashed.

The full `:app:assembleDebug` (flag off, `com.kscanai.app`) was then built —
**BUILD SUCCESSFUL** after the P1 minSdk fix below — and installed on the
booted emulator (`adb install`; a stale higher-versioned install already
present on this emulator instance required `adb uninstall` first — an
environment leftover, not a product issue).

Cold launch (`adb shell monkey -p com.kscanai.app`):
- Process came up and stayed up (`pidof` confirmed a live PID).
- `dumpsys window` confirmed `com.kscanai.app/.MainActivity` as the focused,
  foregrounded activity.
- **A real onboarding screen rendered** — "STEP 1 OF 6", the K Scan
  smart-glasses marketing graphic ("FUTURE READY — Smart glasses. Voice.
  Vision. Checkout."), and working "GET STARTED" / "I ALREADY HAVE AN
  ACCOUNT" buttons. Confirmed by screenshot, not inferred from logs alone.
- `logcat` scanned for `FATAL EXCEPTION`, `AndroidRuntime.*Exception`, and
  `ANR` scoped to `com.kscanai.app`: **zero matches**, both immediately after
  launch and again after settling.
- One ANR dialog did appear on screen ("Pixel Launcher isn't responding") —
  confirmed via `dumpsys window`'s `mCurrentFocus` to belong to
  `com.google.android.apps.nexuslauncher` (the emulator's own system
  launcher), not our app. Same host memory pressure affecting the rest of
  this session, not a K Scan defect.

This is reported separately from MockDeviceKit per §U35 — this proves the
app installs, launches, and renders on a real Android device; it proves
nothing about DAT itself.

## Artifact Inspection

**Token leakage: clean, verified against the actual built artifact per
§U28**, not assumed. Extracted the full `app-debug.apk` (1744 files, 22
`classes.dex` files, `assets/index.android.bundle` JS bundle) and grepped
every file — dex binaries included, via `grep -a` so binary content is
searched as text — for `GITHUB_TOKEN`, `github_token`,
`maven.pkg.github.com`, and both real GitHub token prefix patterns
(`gho_...`, `github_pat_...`). **Zero matches anywhere.** Confirms the
credential is exactly what it is meant to be: build-time only, resolving
Gradle dependencies, never embedded in the shipped app.

MockDeviceKit-in-release check (§30/U30): not applicable this build — this
was a flag-off debug build, so no `mwdat-mockdevice` (or any DAT artifact) is
present in the dependency graph or the APK at all. That check becomes
meaningful once a flag-on build is possible.

---

## P0-P3 Findings and Repairs

**P1 — Fixed.** `:app:assembleDebug` (the whole app, not the module in
isolation) **failed unconditionally** — regardless of `kscan.mwdat.enabled` —
with:

```
Manifest merger failed: uses-sdk:minSdkVersion 24 cannot be smaller than
version 29 declared in library [:kscan-meta-wearable]
```

Root cause: the module's `build.gradle` declared `minSdk Math.max(29, ...)`
as a floor for the *whole module*, intending to reflect "DAT needs Android
10+." But that floor is only true of the DAT SDK itself, which is linked only
in the conditionally-compiled `mwdat` source set — the always-compiled main
source set (`MetaWearableEngine.kt`, `MetaWearableModule.kt`) calls no
API-29-specific symbol. AGP's manifest merger enforces a library's declared
minSdk unconditionally, before any code runs, so this broke every build of
the whole app for every developer on this branch, with the flag on or off.

This was never caught by the convergence phase's `:kscan-meta-wearable:assembleDebug`
verification, because building the module in isolation never exercises
manifest merging against the host `:app` module — only a full `:app:assembleDebug`
does. That is exactly why this phase built the whole app rather than treating
the module-only build as sufficient.

Fixed by dropping the artificial floor: `minSdk` now simply inherits the
app's real value. The actual "DAT needs 29+" constraint is enforced at the
correct layer instead — `MetaWearableModule.requireSupportedOs()`'s runtime
`Build.VERSION.SDK_INT` check, which already existed and already refuses
every DAT call below API 29. If the real DAT AARs (once linked) declare their
own minSdk-29 manifest requirement, the merger will enforce *that* — for a
genuine reason, at the point the flag is actually on — rather than a
self-imposed floor blocking every build unconditionally.

Verified: module-alone build still `BUILD SUCCESSFUL` after the change
(including `processDebugManifest`, the exact task that previously failed);
full `:app:assembleDebug` re-run and confirmed clean afterward (see Builds).

**P3 — Fixed.** Missing-token failure reported as two unrelated-looking
errors instead of one. Root cause: `GradleException` thrown before AGP's
`android {}` block ran. Fixed by reordering; both directions re-verified.

**P2 — Documented, not unilaterally resolved.** `@react-native-ml-kit/face-detection`
is a real npm dependency, used by exactly one file:
`services/metaWearablePrivacy.ts` — the face-detection step of the Meta
wearable capture privacy sanitizer. It predates this entire two-phase effort
(present at `ad46eb1`, the mobile branch's starting commit; `git log -S` shows
it landing in an earlier `spike(privacy-lens)` commit).

The test's own source makes its intent explicit, not just inferred — its
comment reads: *"The ML Kit artifact is an ANDROID gradle dependency inside
the local module, not a node package — that is the authorized shape,"*
immediately followed by an assertion that `kscan-pii-native` (a real, local,
gradle-scoped module already in this repo) is itself never a top-level
`package.json` dependency either. So the rule is not "no ML Kit anywhere" —
it is specifically "ML Kit must be a native Gradle dependency scoped inside a
local module, never a direct npm/JS package," and `kscan-pii-native` is the
established pattern that already follows it. `@react-native-ml-kit/face-detection`
is exactly the disallowed shape by the test's own stated definition: a
top-level npm package wrapping native ML Kit bindings, not a
module-internal Gradle dependency.

That sharpens, but does not resolve, the choice:
- **Option A (now the more clearly architecturally-consistent one)** — move
  face detection in the Meta privacy path onto `kscan-pii-native`'s native
  detector instead of the npm wrapper, matching the pattern this repo already
  established and the guard test already encodes. `kscan-pii-native` has iOS
  face-detection coverage today; Android coverage would need building and
  auditing before this fail-closed sanitizer could depend on it — not a
  trivial swap on code that gates every camera capture.
- **Option B** — accept that Meta's privacy sanitizer is a deliberate,
  narrow exception to the pattern (it predates the guard test, was never
  reviewed against it, and nobody has yet decided it should conform) and
  scope the guard to exclude it explicitly, documenting why.

**Neither was applied.** The guard's own comment makes Option A the more
consistent long-term answer, but executing it touches a fail-closed privacy
path and needs real Android-side test coverage first — not something to do
as a side effect of an unrelated DAT-unblock phase. Flagged here with the
now-sharper framing rather than adjudicated.

## P4-P10 Findings

None discovered this phase beyond the P2/P3 above.

---

## Pre-Existing Test Failure Inventory

The convergence phase reported "7 pre-existing failures, unrelated." This
phase individually classified each one rather than accepting that summary —
and found it was wrong: **6 of the 7 were Meta-relevant** (all touch the
`meta-physical-candidate` EAS profile directly) and are now fixed.

| Test | File | Root cause | Meta-relevant? | Severity | Status |
|---|---|---|---|---|---|
| MIRROR PRODUCTION PROFILE ENABLEMENT | `closetMirrorContractActivation.test.js` | `meta-physical-candidate` missing `EXPO_PUBLIC_MIRROR_SELFIE_V1` (had only 3 of 52 expected env keys) | **Yes** — the Meta profile itself | P2 | **Fixed** |
| MIRROR-ENTRY-RENDERS-WHEN-GLOBALLY-ACTIVE | `mirrorExtractionContainment.test.js` | Same root cause | **Yes** | P2 | **Fixed** |
| production EAS profiles enable the private flag | `privateDressingRoomCoordinator.test.js` | Same root cause (`EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_V1`) | **Yes** | P2 | **Fixed** |
| the Phase 4 flag is enabled... | `privateDressingRoomElisePhase4Regression.test.js` | Same root cause (`EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_V1`) | **Yes** | P2 | **Fixed** |
| both private flags are enabled... | `privateDressingRoomSlotEditing.test.js` | Same root cause (2 flags) | **Yes** | P2 | **Fixed** |
| every profile enables the Saved Looks leaf... | `privateSavedLookRoutes.test.js` | Same root cause (`EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_SAVED_LOOKS_V1`) | **Yes** | P2 | **Fixed** |
| no new runtime dependency was added to package.json | `mirrorExtractionContainment.test.js` | `@react-native-ml-kit/face-detection`, used by the Meta privacy sanitizer, conflicts with a Mirror-feature dependency guard | **Yes** | P2 | **Documented, not resolved** — see P0-P3 section |

All six "same root cause" rows were fixed with one change: declaring
`meta-physical-candidate`'s `env` block explicitly instead of relying on
`extends: preview` (which this repo's own gates do not resolve) — the same
class of fix already applied to the Supabase-target field in the convergence
phase.

**Verified before/after, not assumed:** full mobile suite ran three times
this phase — before any change (7 fail), after the `eas.json` parity fix (1
fail), confirmed identical failing test both before and after via direct
diff of the failure list. **Final confirmed tally: 6138/6198 passing, exactly the 1 documented ml-kit finding remaining.**

---

## Commits

**Mobile** — `kscanaiapp/kscan-app`,
`feature/meta-physical-device-candidate-v1-mobile`:

| SHA | Commit |
|---|---|
| `aefa237` | `fix(meta): bring meta-physical-candidate to explicit flag parity with preview` |
| `81d9122` | `fix(meta): report the missing-token failure exactly once, not twice` |

**Webapp** — `kscanaiapp/kscan-glasses-webapp`,
`feature/meta-physical-device-candidate-v1`: no new commits this phase (the
grouping fix was already committed in the convergence phase at `8b67161`;
this phase only *deployed* it — deployment is not a commit).

## Push Confirmation

*(Filled in at the end of this phase — see the final message to the user for
confirmed local-HEAD-equals-origin-HEAD state for both repos.)*

---

## Evidence Classification

| Category | Status |
|---|---|
| DAT PACKAGE ACCESS VERIFIED | **BLOCKED** — 401, confirmed empirically, no `read:packages` scope available |
| DAT COMPILE VERIFIED | **NOT VERIFIED** — blocked |
| PHOTODATA CONTRACT VERIFIED | **NOT VERIFIED** — blocked |
| MOCKDEVICEKIT VERIFIED | **NOT VERIFIED** — blocked |
| STAGING GROUPING DEPLOY VERIFIED | **VERIFIED** — v3→v4, source-identical to HEAD, confirmed via `get_edge_function` |
| STAGING GROUPING LIVE-HTTP VERIFIED | **NOT VERIFIED** — requires the blocked QA account |
| QA ACCOUNT AUTHORITY VERIFIED | **BLOCKED** — no approved mechanism found; not fabricated |
| AUTHENTICATED E2E VERIFIED | **NOT VERIFIED** — blocked |
| REFLECTION REVIEW VERIFIED | **VERIFIED** — inspected by reading source; KEEP decision justified without needing a live compile |
| NEGATIVE-CONTROL HARNESS VERIFIED | **VERIFIED** — 2 suites, deliberately faulted and restored, both precise |
| PRE-EXISTING FAILURE INVENTORY VERIFIED | **VERIFIED** — individually classified, 6/7 fixed, 1/7 documented |
| EMULATOR RUNTIME VERIFIED | **VERIFIED** — booted (Android 17/API 37), app installed, launched, real UI rendered, zero crashes |
| APK TOKEN LEAKAGE VERIFIED | **VERIFIED CLEAN** — full APK extracted (1744 files, 22 dex, JS bundle) and grepped; zero matches |
| ANDROID BUILD (module, flag off) VERIFIED | **VERIFIED** — BUILD SUCCESSFUL |
| ANDROID BUILD (full app, flag off) VERIFIED | **VERIFIED** — BUILD SUCCESSFUL after the P1 minSdk fix; installed and ran clean |
| ANDROID BUILD (module, flag on) VERIFIED | **NOT VERIFIED** — blocked |
| PHYSICAL META HARDWARE VERIFIED | **NOT VERIFIED** — no glasses present |

---

## Final Verdict

**BLOCKED — META DAT VALIDATION CANNOT PROCEED PAST TWO NAMED EXTERNAL
PREREQUISITES**

Everything reachable without those two credentials was reached: the
missing-token failure mode is now correct and singular instead of confusing;
the staging backend now runs the tested grouping fix instead of the stale
pre-fix code; six of seven "pre-existing, unrelated" test failures turned out
to be Meta-relevant and are now fixed, with the seventh documented as a real
architectural question rather than silently patched; both new test harnesses
were proven to actually catch the faults they claim to catch; and the app
boots and runs on an emulator.

None of that substitutes for the two things only a human can provide:

1. A `read:packages`-scoped GitHub PAT, configured locally.
2. A disposable staging QA account (or existing credentials for one).

Once either lands, the very next actions are already scoped: re-run
`:kscan-meta-wearable:assembleDebug -Pkscan.mwdat.enabled=true` with the token
present, or drive the authenticated capture→privacy→`wearable-scan`→result
round trip with the account.
