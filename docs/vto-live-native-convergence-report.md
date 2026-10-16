# Live VTO native convergence report (Build 35 selective port)

Branch `feat/live-vto-native-selective-port`, based on the Build 35 integration
authority `c413daa`. **Not for merge without owner review.** Live Camera VTO
stays disabled and is not advertised by anything in this branch.

## 1. Provenance

The three native branches are one linear chain, so they are not independent
sources. `feature/live-vto-native-working-prototype` (`b3b7e9f`, 58 commits
ahead of the merge base `4365cebf`) contains `feature/live-vto-ios-native-catchup`
(+13) which contains `feature/live-vto-native-runtime-n1` (+6 further). All three
share merge base `4365cebf` and are 661 commits behind integration. The fourth,
`claude/kscan-live-vto-phase1-phase2-lcqyg9`, is older (merge base `a601adfa`,
1,694 behind) and was not used.

The prototype changes 196 files against its base. Only 8 of them were also
changed on integration.

## 2. What was ported, and what was deliberately not

Ported (integration had not touched any of these since the merge base, so the
prototype versions were taken whole):

| Area | Files |
|---|---|
| Native module | `modules/kscan-live-vto-native/**` (95 files incl. 2 copies of one bundled model) |
| Governed asset registry | `services/vto/vtoLiveGarmentRegistry.ts`, plus `vtoLiveGarment.ts`, `vtoLiveCameraPermission.ts`, `types/vtoLive.ts` |
| Model governance | `config/on-device-model-authority.json`, `scripts/check-on-device-model-authority.js`, `__tests__/onDeviceModelAuthority.test.js` |
| Tests | `vtoLiveGarmentRegistryParity`, `vtoLiveGarmentResolver`, `vtoLiveCapabilityRouter`, `kscanPiiNativeReleaseTargetScope` |
| iOS CI | `.github/workflows/live-vto-ios-native-catchup.yml` (SwiftPM tests + simulator `xcodebuild`; no deploy, no EAS) |
| Docs | the bridge contract and seven native-lane documents (historical evidence for their own source) |

Reconciled by hand (the 8 overlaps):

| File | Disposition |
|---|---|
| `.gitignore` | Skipped: the prototype's change is unrelated Phase 4.2 scratch entries. |
| both `AndroidManifest.xml` | Nothing to port: the prototype only removed literal `--` from XML comments (N1-ENV-003); integration already has zero such comments (checked), and its manifests were rewritten since. |
| `package.json`, `package-lock.json` | One `file:` dependency, mirrored on `kscan-voice-native`; lock validated with `npm ci --dry-run`. |
| `vtoPrivacyAndWiring.test.js` | Two allowlist entries for the registry, by hand. |
| `mirrorExtractionContainment.test.js` | The prototype's patch applied byte-exact (see section 5). |
| `docs/vto-live-integration-manifest.md` | Rows added for every new VTO-owned path. |

Not ported, on purpose: `app/dev-n1-diagnostic.tsx` (a development route; porting
it is a separate decision), the 30 historical evidence files, and the Phase 4 /
4.2 pipeline and documents (a different lane; none of it is needed by the Live
runtime). Historical evidence stays on the prototype branch.

One harness fix was needed: `vtoCustomerActivation.test.js` loads
`vtoLiveGarment.ts` with a strict import map and now has to supply the
registry. All 72 of its tests pass again.

## 3. Evidence, by tier, on CURRENT Build 35 source

Historical results on the Sept 6-7 sources are **not** repeated here as current
evidence.

| Tier | Android | iOS |
|---|---|---|
| Source present | Yes | Yes |
| Compile passed (current source) | **Yes**: Kotlin module compiled against the current dependency tree (Gradle 8.14.3, `compileDebugKotlin` and unit-test compile) | **Pending CI**: the ported workflow runs on the PR; no Swift or Xcode on this machine |
| Automated tests passed (current source) | **Yes**: JUnit XML shows 87 tests, 0 failures, 0 errors, 0 skipped, matching the 87 `@Test` annotations (not a false green) | **Pending CI** (`swift test`) |
| JavaScript contract and governance tests | **Yes**: 1,301 tests, 1,296 pass, 0 fail, 5 skipped (shell-specific CI controls and Apple-only checks that cannot run on Windows) | same |
| `tsc --noEmit` | Exit 0 | same |
| Physical device | **No.** Historical only: Samsung SM-S936U render screenshot; camera never delivered frames | **No** |
| Camera frames end to end | **HOLD**: historical `ETIMEDOUT -110` from the camera service; not retried | Not tested |

No app APK or IPA was assembled; none is authorized.

## 4. Compatibility matrix

| Capability | Android | iOS |
|---|---|---|
| Module registers as `KScanLiveVto` | Expo local module, autolinked (same shape as `kscan-voice-native`) | Expo local module, podspec present |
| JS bridge contract | Unchanged: `liveVtoNativeModule.ts` is byte-identical on both sides | same |
| Camera source | CameraX 1.6.2 (source present; frame delivery unverified on device) | AVFoundation (source present; unverified) |
| Pose perception | MediaPipe Tasks Vision 1.0.0 + bundled `pose_landmarker_lite.task` | same model, iOS copy |
| Privacy boundary | No frames, landmarks, masks or body geometry cross to JS or the network (contract in the bridge doc; privacy tests pass) | same |
| Fails closed without capability | Yes (JS adapter treats a missing or non-`capable` module as unavailable) | same |
| Harness cannot pass as native | Yes: the Studio and router require `provenance: 'native'` and exclude the harness | same |

## 5. Decisions this branch forces on the owner

1. **A bundled ML model enters the repository.** `pose_landmarker_lite.task`
   (Apache-2.0, 5,777,746 bytes, SHA-256 `59929e1d...690d574a`), one copy per
   platform. The prototype replaced the blanket "no model asset in the repository"
   test with a byte-bound, fail-closed allowlist (`on-device-model-authority`).
   The registry keeps `kscan-pii-native` model-free by name, forbids wildcards, and
   fails on an unlisted model or changed bytes. It is a governance change, so it
   needs your explicit approval.
2. **Merging the module changes the binary of every future build**, even with
   Live off: native module, CameraX and MediaPipe dependencies, and the model.
   Binary size and review-risk impact are not measured here (no build is
   authorized). Live remains off through the build flag and the remote switch.
3. **Whether to carry the development diagnostic route** for device testing.

## 6. Remaining device-only blockers

- Android: the front camera opens but no frames are delivered (`ETIMEDOUT -110`,
  `Camera2-FrameProcessorBase`, `cameraserver`) on a Samsung SM-S936U. A bisection
  across CameraX versions did not change it. Needs a device and logcat.
- iOS: no current-source device evidence; camera orientation is pinned to
  portrait only.
- Both: the renderer's P0 history (it never painted until a physical screenshot
  caught it) means geometry logs and replay tests cannot stand in for a
  device screenshot.

## 7. Recommendation for the next native phase

1. Let the iOS workflow on the draft PR report real current-source Swift and
   simulator-build results; treat that as the iOS compile tier.
2. Decide the model-governance and binary-impact questions above before any
   merge.
3. Do the one thing only a device can: reproduce the Android `-110` on a current
   source build with a device attached, with logcat, bounded to a single session.
4. Only then consider enabling the diagnostic route, and keep Live disabled and
   unadvertised until camera frames, rendering, garment assets and the privacy
   and permission tests have physical iOS and Android evidence.
