# Live VTO Phase 3-B — Native Build Handoff

Amendment Section 1 / 4 / 7 deliverable: the build capability probe, the
Hard Build Gate outcome, and what a session with real compilation access
needs to pick this up.

## 1. Build capability probe — this session, freshly measured

```
LOCAL_ANDROID_COMPILE:   NO
LOCAL_IOS_COMPILE:       NO
EAS_PROJECT_LINKED:      YES
EAS_AUTHENTICATED:       NO
ANDROID_EAS_BUILD_CAPABLE: NO
IOS_EAS_BUILD_CAPABLE:     NO
```

### Local Android — NO

```
ANDROID_HOME / ANDROID_SDK_ROOT:  unset
adb / emulator / sdkmanager / avdmanager:  none found
gradle:  FOUND (/opt/gradle/bin/gradle)
java:    FOUND (OpenJDK 21.0.10)
/dev/kvm:  absent
dl.google.com (Android SDK / Maven host):  HTTP 403 from this session's
  egress proxy (`curl -sS https://dl.google.com/` -> "CONNECT tunnel failed,
  response 403") — confirmed fresh this session, identical to Phase 1-2's
  own finding in docs/vto-native-device-handoff.md §0.
```

No Android SDK is installed, and even if one could be installed, `/dev/kvm`
is absent (no hardware-accelerated virtualization) and the one host that
would supply SDK components/AVD system images is blocked at the network
layer. Gradle and a JDK exist, but there is no Android project for them to
build without an SDK.

### Local iOS — NO (structural)

```
uname:  Linux vm 6.18.44-fc-v24 ... x86_64 GNU/Linux
xcodebuild / xcrun / swift:  none found
```

Xcode requires macOS. This is a property of the container OS, not a
missing install step — no amount of session time changes it.

### EAS Build — NO, on two independent grounds

```
app.json eas.projectId:  a075728d-bd77-446f-843d-0f63fd54cc2e  (present —
  the real production K Scan project IS linked)
eas-cli:  not installed, not cached (`npx eas-cli --version` refused to
  auto-install without an explicit yes flag)
~/.expo:  does not exist (no cached login session)
EXPO_TOKEN / EAS_*:  no such environment variable is set
api.expo.dev, expo.dev:  BOTH HTTP 403 from this session's egress proxy
  (identical "CONNECT tunnel failed, response 403" as dl.google.com) —
  newly checked this session; Phase 1-2 never tested Expo/EAS host
  reachability specifically, only dl.google.com.
```

Two independent, either-one-sufficient blockers: (1) no credentials exist
anywhere in this environment to authenticate `eas build` with, and
non-interactive login is not achievable without them; (2) even with valid
credentials, this session's network egress proxy blocks the Expo/EAS API
hosts outright, the same class of restriction that blocks the Android SDK
host. Per Section 1's own instruction ("Do not spend extended effort
repairing the local sandbox"), no further attempt was made to install
`eas-cli`, request credentials, or work around the network policy.

## 2. Hard Build Gate — FAILED

Per amendment Section 4: neither LOCAL TOOLCHAIN nor EAS BUILD can compile
either platform in this session. The gate is closed. This session did not
write native implementation code, did not attempt `eas build`, and did not
attempt to wire the `native/` scaffold into the real app's build graph
(`app.json`/root `package.json`/generated `ios/`/`android/` — all protected
paths this program has never touched and did not touch this session
either). The seven compiler-independent deliverables below are the full,
correctly-bounded scope for this pass.

## 3. What was built instead (compiler-independent, all tested)

New package `@kscan-live-vto/native-runtime-contract` (41 tests, all
passing):

| File | Deliverable # | Covers |
|---|---|---|
| `frameSource.ts` | 2 | `FrameSource` (CAMERA/NATIVE_REPLAY/EMULATOR_VIRTUAL_CAMERA), reconciled with Phase 1-2's `EMULATOR_CAMERA`/`SIMULATOR_CAMERA`/`NATIVE_REPLAY_FIXTURE`; `PerceptionProvenance` + `assertRealModelProvenanceIsEarned` |
| `capturePipeline.ts` | 1 (partial), 5 | `capturePersonFrame`/`capturePreview` commands, `assertCleanFrameForHandoff`, the 5-state native capture machine, its mapping onto `photoreal-bridge`'s `PhotorealIntentState`, the capture quality gate |
| `performanceEvent.ts` | 1 (partial) | `performanceChanged` event payload, the Section 15 structured performance-record schema + distribution summarizer, `AdaptiveQualityLevel` (manual-select only), the Section 30 error/fallback state contract |
| `crossRuntimeFixture.ts` | 3 | `CrossRuntimeGoldenFixture`, the required 7-scenario set built from existing P3-A fixtures, the evidence ledger shape |
| `bodyFrameMapping.ts` | 4 | MediaPipe Pose Landmarker 33-point topology, `mapMediaPipeLandmarksToBodyFrame` (pure math, no model execution) |
| `docs/vto-phase3b-native-renderer-conformance.md` | 6 | this document's sibling |
| this document | 7 | — |

**Deliberately NOT done this session**: no edit to any file under
`native/ios/` or `native/android/`. Those files remain exactly as Phase 1-2
left them (unbuilt scaffolding, TODO-stub command handlers). Editing them —
even small, mechanical mirroring additions matching their own established
"TS is the source of truth, Swift/Kotlin mirrors it" convention — was
considered and deliberately deferred: amendment Section 4 names seven
specific PERMITTED deliverables, all contract/specification/documentation;
`.swift`/`.kt` source edits are not literally one of them, and the safest
reading of a Hard-Build-Gate HOLD is to leave compiled-language source
untouched until a session that can actually verify a change compiles picks
it up. The deltas that WOULD be needed are listed in Section 5 below.

## 4. Isolation — re-verified, not assumed

`tools/validate-protected-paths.js` run against `origin/master` this
session: **PASS** (see the commit for the exact file count). Amendment
Section 19 asks to "verify — not merely assume" that
`components/vto/`, `services/vto/`, and `supabase/functions/vto-generate/`
are protected, "at minimum," with a synthetic-mutation test. That check
**already exists**: `tests/guardrail/protectedPathSemantics.test.js`
(Phase 1-2, unmodified) pins exactly these three real current-VTO paths —
`components/vto/TryItOnEntry.tsx`, `services/vto/vtoClient.ts`,
`supabase/functions/vto-generate/index.ts` — as `blocked` by
`classifyPath()`, alongside several deliberately-invented filenames proving
the guardrail works by path prefix rather than by file existence. Writing a
second, near-duplicate test asserting the same three prefixes would be test-
count padding, not verification (original Section 33: "Do not grow test
count merely for optics") — so this session re-ran the existing test
instead of adding one. Re-run this session: **still passing** (part of
`npm run test:guardrail`, 18/18, in the full workspace test run below).
This is a positive re-verification, not a discovered gap, matching the same
distinction `docs/source-authority.md` already drew for the prefix-vs-
existence semantics question.

## 5. Exact deltas for the first session with real compilation access

Once a macOS host (Xcode) or a working Android toolchain (SDK + `/dev/kvm`
or a physical device), or working EAS credentials + network access exist:

1. **Mirror the TS contract additions into Swift/Kotlin.** Add
   `capturePersonFrame`/`capturePreview` as new `AsyncFunction` cases in
   `LiveVTOModule.swift`/`.kt` (replacing or supplementing the existing
   generic `capture`), matching `capturePipeline.ts`'s exact command names.
   Add `performanceChanged` to each file's `Events(...)` list, matching
   `performanceEvent.ts`.
2. **Decide `CameraBufferConvention` for real** — `bodyFrameMapping.ts`'s
   `CameraBufferConvention` type names the exact open question
   (raw-vs-mirrored inference buffer); this cannot be resolved without a
   real front camera. First real capture must explicitly test "raise the
   wearer's left hand, confirm it appears at lower u" (Phase 1-2's own
   `docs/vto-native-device-handoff.md` §3 instruction) and record which
   convention the chosen camera pipeline actually uses.
3. **Wire the `LiveVTO` Expo module into a build graph without touching the
   production app.** Prefer `kscan-live-vto/apps/sandbox` (already
   scaffolded, already isolated, never added to the real `kscan-app`
   `package.json`/`app.json`) over the real app — give the sandbox its own
   minimal `app.json`/`eas.json` (net-new files under
   `kscan-live-vto/apps/sandbox/`, already covered by the guardrail's
   `ALWAYS_ALLOWED_PREFIXES: ["kscan-live-vto/"]`) rather than registering
   the module in the production project. This is the path that satisfies
   amendment Section 2's "prove compilation into a real Expo/EAS build
   graph" without the protected-path mutation that registering it in the
   real `kscan-app` app.json/package.json would require.
4. **Populate `MEDIATED_...` real values.** Every `PROVISIONAL — REVALIDATE
   ON REAL DEVICE OUTPUT` constant in this session's new package
   (`PROVISIONAL_CAPTURE_QUALITY_THRESHOLDS`) and in Phase 1-2's existing
   ones (`DEFAULT_GUIDANCE_THRESHOLDS`, `DEFAULT_DEVICE_CAPABILITY_THRESHOLDS`,
   `DEFAULT_MASK_STABILITY_CONFIG`) needs a real-device calibration pass —
   none of them should be treated as shippable defaults.
5. **Run the cross-runtime golden fixtures.** `crossRuntimeFixture.ts`'s
   `buildRequiredGoldenFixtures()` produces the 7 required scenarios today,
   in Node. Once `NativeReplayPerceptionProvider` actually compiles, feed
   the same fixtures through it and fill in each
   `CrossRuntimeEvidenceEntry.nativeResult` — every entry today is
   `createPendingEvidenceEntry(...)`, i.e. `nativeResult: null`.

## 6. Section 2/3 (iOS/Android build governance) — not reached

The amendment's EAS build governance (production-profile iOS compile,
governed Android build) presumes a passing Hard Build Gate. Since the gate
failed, none of that governance was exercised — no `eas build` command of
any kind was run, no EAS credentials were requested or used, and no
production build profile was invoked. This section exists only to record
that the gate check, not a decision to skip Section 2/3, is why.
