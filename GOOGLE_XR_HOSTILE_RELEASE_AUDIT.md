# K Scan AI — Google XR Hostile Release Audit

**Audit date:** 2026-08-22
**Auditor role:** Independent hostile takeover at end of software-build phase
**Native candidate:** `kscan-google-xr-physical-device-candidate-v1` → branch `feature/google-xr-live-integration-closure-v1`
**Mobile companion:** `kscan-google-xr-mobile-companion-candidate-v1` → branch `feature/google-xr-mobile-companion-candidate-v1`

---

## Executive Summary (one page)

**FINAL VERDICT: PASS WITH CONDITIONS** — Google XR hostile audit complete; no open repairable P0–P3 software blockers; named hardware/authority conditions remain.

| Metric | Value |
|---|---|
| P0 | 0 |
| P1 | 0 |
| P2 | 1 (fixed) |
| P3 | 2 (1 fixed, 1 external-dependency/authority-gated) |
| P4–P10 | 7 (reported) |
| P0–P3 fixed | 2 of 3 (the third is a source/deploy-drift item requiring owner authority, not a code fix) |
| P0–P3 remaining (software) | 0 |
| Native candidate SHA (post-fix) | `3c647a1e8db34d3b89e93085378b10a6653099c5` (pushed; local == origin) |
| Companion candidate SHA | `20f8a43fc55fc25c64ced54c9aefc1a7c75c9252` (unchanged; no defects requiring repair) |
| Candidate APK SHA-256 (post-fix) | `a01c592e3dbaa75c2d4cc02ff5cbb88ddd87dd4e8e1c2a503427d65baae839e7` |
| Package version decision | **No `androidx.xr.*` packages are used or required.** The candidate is a phone-companion result-only APK; native XR/Projected capture is an explicit, documented deferral. |
| Staging status | K Scan AI Staging (`yzqjvdfgefveprobvvyw`) — LIVE, 8-probe security matrix passed |
| Emulator status | Sustained clean launch on API 37 (16 KB-page Pixel image), ReleaseSafetyGuard passing, no crash/ANR. Installs + reaches topResumedActivity on the official Android XR image, but did NOT sustain foreground there (constrained host). |
| Physical hardware status | **NOT RUN — no compatible Google XR display/audio glasses available in this environment** |

**Top 3 remaining risks**
1. **Phone-companion architecture, not native XR** — capture, privacy, and analysis run on the phone; the glasses build is a result-only HUD. No `androidx.xr.*`/Jetpack Projected/Glimmer integration exists (documented TODO). Real glasses camera/display behavior is unproven.
2. **Backend source/deploy drift** — three `verify_jwt:false` wearable Edge Functions (`wearable-scan`, `wearable-save`, `wearable-open-on-phone`) are LIVE on staging with **no source in any repo and no git history**. They are session-gated and SSRF-safe, and the current client does not call them, but they are unreproducible from source (XR-DRIFT-01, P3, owner authority required).
3. **Physical hardware unproven** — emulator/live-staging evidence cannot substitute for real optics, camera, thermal, radio, and display behavior.

**Recommendation: GO TO CONTROLLED HARDWARE QA** for the phone-companion result-only scope, **with the explicit understanding that this candidate is not a native Android XR (Projected) app** and that XR-DRIFT-01 should be dispositioned by the owner before/at hardware bring-up.

---

## Source Authorities

The task's named branches (`...-physical-device-candidate-v1`) are **not** the current tips. Actual authority, verified via `git`:

| Repo | Current branch | HEAD | Sync |
|---|---|---|---|
| `kscan-google-xr-physical-device-candidate-v1` | `feature/google-xr-live-integration-closure-v1` | `3c647a1e` (post-fix) | local == origin |
| `kscan-google-xr-mobile-companion-candidate-v1` | `feature/google-xr-mobile-companion-candidate-v1` | `20f8a43f` | local == origin |

Both remotes are `github.com/kscanaiapp/kscan-app.git`. The historical canonical repo (`kscan-google-glasses-canonical`, Phase A SHA `105c2218…`) is ancestor/reference only and was not used as a working base; `105c2218` is present in this repo's history as the Phase-A phone-bridge commit.

## Starting SHAs
- Native: `8f464b8bd31c81e2e513d8534b3f429f73b63f66`
- Companion: `20f8a43fc55fc25c64ced54c9aefc1a7c75c9252`

## Final SHAs
- Native: `3c647a1e8db34d3b89e93085378b10a6653099c5` (2 fix commits added and pushed)
- Companion: `20f8a43fc55fc25c64ced54c9aefc1a7c75c9252` (no change; no repairable defect found)

---

## Current Google Android XR Authority
Determination method: repository source + build-graph inspection. The candidate does **not** consume any first-party Android XR SDK, so the version-authority question resolves differently than a projected-glasses app would.

## Package Compatibility Matrix

| Package | K Scan version | Change? | Rationale |
|---|---|---|---|
| `androidx.xr.runtime` | **not used** | No | Phone-companion architecture; no XR runtime |
| `androidx.xr.projected` | **not used** | No | Projected entry points are explicit TODOs |
| `androidx.xr.arcore` | **not used** | No | No AR/world-tracking in scope |
| `androidx.xr.glimmer` | **not used** | No | No native XR display rendering |
| `androidx.xr.compose` | **not used** | No | Standard `androidx.compose` (BOM 2024.06.00), 600×600 surface |
| `androidx.xr.scenecore` | **not used** | No | No 3D scene graph in scope |

**Toolchain:** AGP 8.5.2, Kotlin 1.9.24, Gradle 8.7, compileSdk/targetSdk 34, minSdk 26, Compose compiler 1.5.14, `com.google.mlkit:face-detection:16.1.6`.

## AI-Glasses Version Decision (A11 hierarchy)
- **Rule 1 (form-factor pin):** The actual near-term form factor is a **phone-companion + result-only HUD**, not a standalone projected-glasses app. There is no glasses-pinned `androidx.xr.*` set to adopt for this candidate.
- **Rule 2 (no numeric-newest upgrades):** No `androidx.xr.*` dependency exists to bump.
- **Decision:** **Do not add `androidx.xr.*` to this candidate.** Adding Jetpack Projected/Glimmer now would be speculative feature work contradicted by the documented architecture and by §17 ("do not invent a hardware-camera path"). When native XR capture/display is scoped, re-run this decision against Google's then-current glasses-pinned set.
- **Deviation classification:** None — absence of `androidx.xr.*` is intentional and documented.

---

## Projected Architecture
Evidence: `docs/google/ARCHITECTURE.md`, `bridge/GoogleBridgeProvider.kt`, `runtime/AppRuntimeFactory.kt`. The candidate implements **PHONE → (HTTPS wearable-bridge) → GLASSES result-only HUD**, not PHONE → PROJECTED ACTIVITY → GLASSES. Capture/privacy/scan-identify run on the phone; the glasses render bounded results and issue Save/Open/Retry/Cancel. `RuntimeStatus` in candidate mode = `PHONE_COMPANION_RESULT_ONLY`. Matches documented intent; honestly labeled — not a hidden mismatch.

## Projected Activity
No `XR_PROJECTED`/`XR_PROJECTED_LAUNCHER` category is present or required. The single launcher activity (`MainActivity`, `exported=true`, `category.LAUNCHER`) is a standard Compose activity. No projected activity is required for the result-only scope, proven by the absence of any projected-context hardware access.

## Projected Context
`DeviceCapabilities.supportsProjectedContext` is hardcoded `false`. No code path creates a projected context or accesses camera/mic/display through one. **No phone-vs-projected context confusion exists because no projected hardware access is attempted.**

## Permissions
- `src/main`: **empty permission surface**. `src/candidate`: `INTERNET` only. `src/debug`: `INTERNET` + cleartext config + `MockScenarioReceiver` (debug-only, `exported=false`, double-gated).
- Packaged **candidate** manifest verified: `INTERNET`, `ACCESS_NETWORK_STATE`, AndroidX `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. **No CAMERA/RECORD_AUDIO.** `MockScenarioReceiver`/cleartext config **absent** (grep count 0). Exported components: `MainActivity` (launcher) + AndroidX `ProfileInstallReceiver` only. No glasses-camera permission is claimed off a phone CAMERA permission (none requested).

## Device Capabilities
`DeviceCapabilities` distinguishes visual/projected/audio-only, defaulting to `false`; capability is not inferred from device name. Currently compile-time constants (no live negotiation) — consistent with result-only scope (see XR-CAP-07).

## Display / Displayless Behavior
HUD renders on a 600×600 Compose viewport (defensible display path) and can push rich cards to phone (`open_on_phone`). Audio-only glasses have a `VoiceInputController`/`SpeechFeedback` seam not wired to hardware. The browser simulator is **not** counted as hardware display support. Native-XR display path = N/A (no Glimmer); phone-HUD path = source+emulator verified.

## Camera / Capture
`camera/GlassesCameraController.kt` is an explicit TODO stub. Real capture is **phone-owned** (companion `capture.request` → phone `/scan`). Classification: PHONE CAMERA (companion) for the candidate; XR GLASSES CAMERA = not implemented; no fixture presented as hardware-camera proof.

---

## Mobile Companion
`WearableCompanionHost` polls `phone.poll` per active session; `services/wearables/bridge.ts` invokes only `wearable-bridge`; sign-out revokes server-side; duplicate guard uses the glasses' stable `actionId`, not the volatile `requestId` — correct. 71/71 companion wearable/scan assertions pass. UX finding: a paired device's `capture.request` auto-navigates the phone to `/scan` (XR-UX-02).

## Pairing
`pair.create` (unauth) → `pair.approve` (requires user JWT) → `pair.poll` issues a session token and marks pairing `consumed`. `pair.approve` without user JWT → **401 AUTH_REQUIRED** (live-verified). Challenge codes/pairing secrets are SHA-256 hashed; per-user throttle (`MAX_PAIR_ATTEMPTS_PER_WINDOW=10`).

## K Scan Wearable Sessions
Session ≠ device connection. READY requires both a real `RealKScanPhoneBridgeProvider` and a live session. Token stored as SHA-256 hash; 32–128 char bound enforced.

## Session TTL
`SESSION_TTL_MS=15min`, `PAIR_TTL_MS=2min`; client and server agree. Expiry surfaces two ways after the fix: (a) backend `session.poll` emits `session.revoked/EXPIRED`; (b) client `sendSession` now emits `SessionRevoked(EXPIRED)` (XR-STATE-01) so a locally-detected expiry cannot strand the HUD in READY.

## Sign-Out / Revocation
`phone.revoke`/`phone.revoke_all` set `revoked_at`+reason; junk/short tokens → **403 SESSION_INVALID** (live-verified). Revoked/expired sessions reject `phone.action`/`phone.send`/`session.send`.

## Privacy
Fail-closed at three layers:
- **Client** (`StrictPrivacyImageSanitizer`): ML Kit face masking → JPEG re-encode; `MaskingUnavailable`/`Blocked`/`Error` all **stop before upload**; no raw-fallback path. `ScanOrchestrator` runs on `Dispatchers.IO`, returns `Failure` on any sanitizer non-success, asserts `analyzeClient.callCount==0`.
- **No mock in release**: `PrivacyImageSanitizerFactory.create(MOCK, isDebugBuild=false)` throws; `ReleaseSafetyGuard.verify`/`verifyDependencies` throw on mock flag or mock instance.
- **Backend relay** (live-verified): a frame carrying an `image`/`base64`/token field → **400 FORBIDDEN_CONTENT**; oversized frame → **PAYLOAD_TOO_LARGE**. The bridge never relays raw imagery.

## Canonical scan-identify
Wearable scans route to `scan-identify` (image mode, `source='meta_wearable'`), the same gateway the mobile app uses. The retired `/api/analyze` REST route is documented as permanently retired in `services/api.js`, guarded by a legacy production-gate test. The native repo references `/api/analyze` only in `RealAnalyzeClient`/docs as the historical upstream contract. **No live P2 dependency on the retired route found.**

## Source / Deploy Drift
**Material finding (XR-DRIFT-01, P3).** Staging hosts four wearable functions; only `wearable-bridge` has committed source (matching the deployed content on all audited markers). `wearable-scan`, `wearable-save`, `wearable-open-on-phone` are **LIVE, `verify_jwt:false`, with no source in any local repo and no git history** (`git log --all --diff-filter=A` returns nothing). They are session-gated (junk token → 401) and SSRF-safe (`wearable-scan` rejects non-`data:image/jpeg` → 400 before any Gemini call). The current client calls **none** of them. Risk: unreproducible-from-source; cannot be safely redeployed/regression-audited. **Owner authority required** to commit source or retire them (§25 — do not mutate live functions to eliminate drift without established authority).

## Anonymous Access
`scan-identify` is `verify_jwt:false` but the wearable path reaches it **server-side** via `wearable-scan` using the service-role key, gated by a validated wearable session and an in-memory rate limit (`SCAN_RATE_LIMIT_MAX=10`/min/user). The candidate client does not call `scan-identify` anonymously. No unauthenticated Gemini-cost hole was reachable (junk session → 401 before any provider call; non-sanitized image → 400 before any fetch).

## StyleMatch
`normalizeWearableResult` maps scan-identify's real fields (`identification.visual_observation`, `identification.confidence_score`, `similarityMatches` else `recommendedProducts`) into a bounded result; zero matches → `primaryMatch=null` + empty alternatives (honest), never a fabricated product. Verified by companion integration tests (real-response mapping + non_fashion never fabricated).

## Result Mapping
Bounded/defensive: title ≤120, brand ≤80, retailer ≤80, summary ≤300; only `https://` thumbnails/hrefs pass; confidence clamped 0–100 or null. Absent/malformed fields degrade to null/empty, not crashes.

## Retail / Resale / Similar
`toWearableProduct` stamps `commerceGroup:'retail'`; grouping is bounded and does not infer resale from merchant name (the richer split lives in the canonical mapper; the wearable formatter presents a flat bounded shelf).

## Save
`phone.action` (save): requires live session + owner match; `actionId` single-purpose (reuse with different result/type → **ACTION_CONFLICT**); idempotent insert with lost-race recovery; persists to canonical `saved_scans` deduped by `metadata->>wearableResultId`. Client forwards the glasses' stable `actionId`. Verified by contract tests.

## Open on Phone
`open_on_phone` routes to `/wearable-result?resultId=<exact id>` — exact-target, not "most recent." Result cached under `RESULT_CACHE_PREFIX + resultId`.

## Idempotency
Stable `actionId = UUID.nameUUIDFromBytes("save|open:<resultId>")` (deterministic, valid UUID for the backend's strict regex). Backend enforces single-purpose ids + idempotent completion.

## Revisions
`phone.send` result.update enforces ownership + monotonic revision: `revision < existing → STALE_REVISION`; equal → idempotent no-write forward; higher → conditional update. No stale result overwrites a newer one.

## Cancel / Late Results
Client marks cancellation in AsyncStorage; late results for a cancelled scan are suppressed. ViewModel cancels the ack watchdog on leaving RESULTS so a late timeout cannot fire against a superseded state.

## Reconnect
Connection loss from any active state → RECONNECTING; restore → prior state or bounded error; revocation from any state → DISCONNECTED (clearContext). Provider tracks `reconnectCount`, dedups via cursor, and (post-fix) surfaces local expiry as revocation. No duplicate listeners after XR-STATE-02 (single retained ViewModel).

## Android Lifecycle
`configChanges="orientation|screenSize|screenLayout|keyboardHidden"` absorbs rotation. Recreation-triggering changes it does **not** absorb (uiMode/fontScale/density/locale, process death) previously rebuilt the ViewModel and duplicated collectors/state-machines against the app-scoped provider — **fixed** (XR-STATE-02).

## Performance / Memory
No thresholds hardcoded; measured on-device latencies require paired hardware (not captured — no glasses). Polling is a bounded 1s loop with cursor dedup; jobs scoped to a `SupervisorJob`, cancelled on `close()`. The pre-fix duplicate-collector path (now closed) was the main leak vector. Live backend probes returned well under 1s each. A5 latency-band capture is **deferred to hardware**.

---

## Security Findings
Live staging (`yzqjvdfgefveprobvvyw`, K Scan AI Staging) hostile matrix — all safe/deterministic:

| Probe | Result | HTTP |
|---|---|---|
| Unsupported operation | `UNSUPPORTED_OPERATION` | 400 |
| `pair.approve` without user JWT (publishable key only) | `AUTH_REQUIRED` | 401 |
| `session.poll` with junk token | `SESSION_INVALID` | 403 |
| Frame carrying `image` field (privacy relay) | `FORBIDDEN_CONTENT` | 400 |
| Oversized frame (>64 KB) | `PAYLOAD_TOO_LARGE` | 400 |
| `wearable-scan` junk session | `INVALID_SESSION` (no provider call) | 401 |
| `wearable-scan` missing token | `MISSING_TOKEN` | 400 |
| `wearable-scan` non-sanitized image URL | `INVALID_IMAGE` (SSRF blocked) | 400 |

Static secret scan of native source (`*.kt`,`*.xml`): **no** JWT/service-role/Gemini key/private-key material. `local.properties` (gitignored, untracked) holds only a **publishable** key + bridge URL — no secret. BuildConfig carries no credentials (`BuildConfigSecretPolicyTest` guards). The publishable key alone grants no protected access (proven by 401/403 above).

## P0 Findings
None.

## P1 Findings
None.

## P2 Findings

### XR-STATE-02 (P2, FIXED) — Duplicate collectors/state-machines on config-change recreation
- **File:** native `android-xr/app/src/main/java/com/kscan/glasses/MainActivity.kt`
- **Defect:** ViewModel constructed manually in every `onCreate`. The phone bridge is an app-scoped singleton, so any recreation `configChanges` does not absorb (uiMode/fontScale/density/locale, process death) attached a **second** set of provider-flow collectors and a **second** `ConnectedRuntimeStateMachine` to the same singleton bridge. Both machines then consumed provider events and executed effects against the shared provider → duplicated outbound frames (notably `capture.request`, which uses a fresh `requestId` and is **not** backend-idempotent) and leaked coroutines. Violates the "0 duplicate listeners / 0 duplicate action" contract (§36).
- **Evidence:** Source trace of `startConnectedMode` collectors + `viewModelScope` never cancelled (no `onCleared`; VM not registered with a ViewModelStore).
- **Fix:** Retain one instance via `viewModels{}` + factory; app-scoped provider intentionally not closed. Commit `3c647a1e`.
- **Re-test:** Compiles under debug + candidate (release-like); all 401 unit tests pass in all three variants; candidate APK installs+launches with no crash, ReleaseSafetyGuard passing.

## P3 Findings

### XR-STATE-01 (P3, FIXED) — Local session-expiry stranded the HUD in READY
- **File:** native `.../phonebridge/RealKScanPhoneBridgeProvider.kt` (`sendSession`)
- **Defect:** On locally-detected expiry/revocation, `sendSession` nulled the token and returned `Unavailable` **without emitting an event**. Nulling the token also stops session polling, so the backend's own `session.revoked` frame can no longer arrive. The state machine therefore stayed in READY (Scan offered) with only a transient "bridge unavailable" notice and **no path to DISCONNECTED/re-pair** — a user-visible-vs-system-state divergence in the ~1s window where an action beats the revocation poll (A1/A24).
- **Fix:** Emit `SessionRevoked(EXPIRED|USER_REVOKED)`, set status UNAVAILABLE, refresh diagnostics. Added regression test "locally-detected session expiry emits SessionRevoked EXPIRED and stops the session." Commit `241d908`.
- **Re-test:** New test passes; full 401-test suite green in all variants.

### XR-DRIFT-01 (P3, NOT a code fix — owner authority required)
See **Source / Deploy Drift**. Disposition: owner must commit source or retire `wearable-scan`/`wearable-save`/`wearable-open-on-phone`. Not repairable safely here (§25). No client impact today.

---

## P4–P10 Backlog

| ID | Pri | Repo/File | Defect | Evidence | Impact | Suggested Fix |
|---|---|---|---|---|---|---|
| XR-UX-02 | P4 | companion `components/wearables/WearableCompanionHost.tsx` | Paired glasses `capture.request` triggers `router.push('/scan')`, hijacking the phone UI | Source: `handleFrame` unconditionally navigates on `capture.request`/`action.retry` | Phone jumps to scanner mid-task; a paired device drives navigation with no confirmation | Gate auto-navigation behind foreground/consent, or a non-modal "glasses want to scan" affordance |
| XR-DOC-03 | P4 | native `docs/google/ARCHITECTURE.md` | Docs still show `POST /api/analyze` (Render) as the backend contract | Doc mermaid + prose | Misleads future work to the retired route | Update to scan-identify (image mode) |
| XR-REPRO-04 | P4 | native build/reports | "Reproducible candidate APK" claimed; three different SHAs observed (`25a9558e`/`554827a1`/`a01c592e`) | APK zips embed timestamps | "Reproducible" not literally true (expected APK non-determinism) | Document APKs as non-bit-reproducible, or add deterministic packaging + record exact command |
| XR-DOC-05 | P5 | native `.../privacy/FaceMasker.kt` | Docstring says masking "not implemented," but ML Kit masking **is** implemented (`isMaskingAvailable=true`) | Source: real detect+mask+re-encode | Stale comment contradicts behavior | Correct the docstring |
| XR-16K-06 | P5 | native APK / `com.google.mlkit:face-detection:16.1.6` | `PageSizeMismatchDialog` appeared on the 16 KB-page emulator | OS AppWarnings log; **but** APK is verifiably 16 KB-compliant (ML Kit `.so` ELF `p_align=0x4000`; zip data offsets 16 KB-aligned) | Investigated-and-cleared: artifact is compliant; dialog did not reflect a real misalignment | Monitor on real 16 KB hardware; keep ML Kit current ahead of the Nov-2026 requirement |
| XR-CAP-07 | P6 | native `bridge/DeviceCapabilities.kt` | Capabilities are compile-time constants; no live capability negotiation | Source constants | Fine for result-only scope; needs real negotiation before native XR display/audio branching | Add capability negotiation when native XR is scoped |
| XR-TEST-08 | P7 | companion `__tests__/wearableCandidateContract.test.js` | Security contract asserts against **repo** `wearable-bridge` only; blind to the sourceless deployed functions | Test reads committed source | Green suite doesn't detect XR-DRIFT-01 | Add a deploy-inventory check (list_edge_functions vs committed sources) to CI |

---

## Defects Repaired
1. **XR-STATE-01 (P3)** — session-expiry now surfaces as `SessionRevoked(EXPIRED)`; regression test added. (`241d908`)
2. **XR-STATE-02 (P2)** — ViewModel retained across recreation via `viewModels{}`; eliminates duplicate collectors/state-machines and duplicate outbound frames. (`3c647a1e`)

Both committed on `feature/google-xr-live-integration-closure-v1`, pushed; local == origin `3c647a1e`. No merge to master; no force-push. Worktree clean.

## Tests
Native (`android-xr`), **freshly executed with `--rerun-tasks`** (prior "UP-TO-DATE 400" was cached, not run):

| Variant | Suites | Tests | Fail | Err | Skip |
|---|---|---|---|---|---|
| `testDebugUnitTest` | 40 | 401 | 0 | 0 | 0 |
| `testCandidateUnitTest` | 40 | 401 | 0 | 0 | 0 |
| `testReleaseUnitTest` | 40 | 401 | 0 | 0 | 0 |

(+1 vs historical 400 = the XR-STATE-01 regression test.) `compileCandidateKotlin` succeeds → the `viewModels{}` fix builds under the release-like flavor.

**Harness integrity (A8/A9) — negative control performed:** inverted the fail-closed assertion in `ScanOrchestratorStrictPrivacyTest` ("strict sanitizer blocks before analyze when face masking is NotImplemented"). The suite **failed for the expected reason** (1 of 8), proving the test actually executes its protected assertion. Mutation reverted immediately; worktree confirmed clean; nothing committed.

Companion (`node --test`), wearable/scan-critical suites: **71 pass / 0 fail / 0 skip** (includes the "Google XR wearable candidate security contract" suite: hashed secrets, RLS+revoke on every wearable table, bounded frames, native fail-closed privacy, ownership+stale-revision rejection, single-purpose action ids, canonical saved_scans persistence, per-user pairing throttle).

## Live Staging Matrix
Environment: **K Scan AI Staging** — project ref `yzqjvdfgefveprobvvyw`, region us-west-1, base `https://yzqjvdfgefveprobvvyw.supabase.co/functions/v1/`. Auth: publishable key + (protected ops) user JWT. See Security Findings for the 8-probe table. All hostile probes were read-only or self-expiring (no writes to real user data; pairing rows self-expire in 120s; no valid session minted). Production (`wyyuqfdxucjksghsmhry`) was **not** touched.

## Emulator
- **API 37, 16 KB-page Pixel image (`sdk_gphone16k`):** candidate installs (`Success`), launches, process alive, `MainActivity` resumed and **sustained**, **no FATAL/ANR**, **ReleaseSafetyGuard did not trip** (release-like build passed startup safety verification). A `PageSizeMismatchDialog` appeared but the APK is verifiably 16 KB-compliant (XR-16K-06).
- **Official Android XR image (`android-xr-v3-playstore`, API 34, x86_64, 4 KB pages):** candidate installs (`Success`) and **reaches `topResumedActivity=com.kscan.glasses/.MainActivity`**, but did **not sustain foreground** — the XR home environment (`systemui.xrhomeenv`) reclaimed focus and a `BLASTSyncEngine` transition-commit warning appeared. This occurred on a resource-constrained host running two emulators simultaneously; **no ANR/FATAL trace attributable to `com.kscan.glasses` was recorded** (the `/data/anr` files predate the launch). Sustained XR-image runtime is therefore **NOT VERIFIED**; clean sustained launch was verified on the API 37 image.
- The emulator cannot prove: real optics/camera bytes, real display glanceability, thermal/battery/radio behavior, or on-device latency.

## Candidate APK
| Property | Value |
|---|---|
| File | `android-xr/app/build/outputs/apk/candidate/app-candidate.apk` |
| Build type | `candidate` (initWith release; debuggable=false; debug signing) |
| Package | `com.kscan.glasses` |
| Version | `0.1.0-alpha-physical-device-candidate-v1` (versionCode 1) |
| SHA-256 (post-fix) | `a01c592e3dbaa75c2d4cc02ff5cbb88ddd87dd4e8e1c2a503427d65baae839e7` |
| Mock flags | USE_MOCK_API/BRIDGE/SANITIZER=false; HARDWARE_CANDIDATE=true |
| Native libs | 4× `libface_detector_v2_jni.so` (ML Kit), STORED, 16 KB-aligned |
| Manifest (candidate) | INTERNET, ACCESS_NETWORK_STATE; MainActivity + AndroidX ProfileInstallReceiver exported; no mock receiver; no cleartext config |

APKs are not bit-reproducible (embedded timestamps) — see XR-REPRO-04.

## Build Work Performed After Audit
Beyond the mandatory P0–P3 repairs, **no additional feature build was undertaken.** The audit's clearly-bounded exposures (native XR camera/display, projected context, capability negotiation) all require product decisions and physical hardware and therefore fall under STOP conditions (§58) — building them would be speculative. The two repairs plus regression coverage are the complete post-audit change set.

## Remaining Hardware Gates
- **Physical Google XR glasses (display and audio variants)** — required to prove camera bytes, display glanceability (A4), audio-latency acknowledgement (A7), thermal/battery behavior, and A5 latency bands. NONE were available.
- **Native XR/Projected integration** — camera/display path is a documented TODO; a gate before any "native XR app" claim.
- **XR-DRIFT-01 disposition** — owner decision on the three sourceless live functions.
- **Sustained runtime on the XR image** — retest on a non-contended host or real hardware.

## Evidence Classification (method per A21/A22)

| Claim | Level | Method |
|---|---|---|
| SOURCE VERIFIED | SOURCE | Read all native/companion source + all four deployed edge functions |
| PACKAGE COMPATIBILITY VERIFIED | SOURCE/BUILD | Inspected `build.gradle.kts` + full dependency set; zero `androidx.xr.*` |
| PROJECTED ARCHITECTURE VERIFIED | SOURCE | `AppRuntimeFactory`, `GoogleBridgeProvider`, docs |
| PROJECTED CONTEXT VERIFIED (absent) | SOURCE | `supportsProjectedContext=false`; no projected hardware access |
| GLASSES PERMISSIONS VERIFIED | SOURCE/BUILD | Packaged candidate manifest: no CAMERA/RECORD_AUDIO |
| DEVICE CAPABILITY VERIFIED (static) | SOURCE | `DeviceCapabilities.kt` constants |
| CAMERA PATH VERIFIED (phone-owned; glasses stub) | SOURCE | `GlassesCameraController` TODO; companion capture.request → phone /scan |
| DISPLAY PATH | N/A (native XR) / SOURCE+EMULATOR (phone HUD) | 600×600 Compose; no Glimmer |
| MOBILE COMPANION VERIFIED | UNIT/INTEGRATION | 71 node:test assertions pass |
| PAIRING VERIFIED | LIVE STAGING | `pair.approve` w/o JWT → 401 |
| WEARABLE SESSION VERIFIED | SOURCE + LIVE | TTL agreement; junk token → 403 |
| SESSION REVOCATION VERIFIED | SOURCE + LIVE | revoke paths; expired/revoked rejected |
| PRIVACY VERIFIED | SOURCE + UNIT + LIVE | fail-closed sanitizer; FORBIDDEN_CONTENT at bridge |
| SCAN-IDENTIFY VERIFIED | SOURCE + LIVE (deployed fn read) | image mode, source stamping, service-role server-side |
| STYLEMATCH VERIFIED | INTEGRATION | real response → mapper → bounded wearable result test |
| RESULT CONTRACT VERIFIED | SOURCE + UNIT | bounded normalization |
| SAVE VERIFIED | SOURCE + UNIT + LIVE fn | canonical saved_scans persistence; actionId idempotency |
| OPEN ON PHONE VERIFIED | SOURCE | exact-target routing |
| IDEMPOTENCY VERIFIED | SOURCE + UNIT | stable UUID actionId; ACTION_CONFLICT |
| STALE REVISION VERIFIED | SOURCE + UNIT | STALE_REVISION guard |
| RECONNECT VERIFIED | SOURCE + UNIT | state-machine transitions; cursor dedup |
| ANDROID BUILD VERIFIED | BUILD | assembleCandidate + 3-variant unit tests |
| CANDIDATE APK VERIFIED | ARTIFACT | manifest + native-lib + SHA inspection |
| EMULATOR VERIFIED (API 37) / PARTIAL (XR image) | EMULATOR | sustained launch API 37; install + brief resume on XR image, not sustained |
| LIVE STAGING VERIFIED | LIVE STAGING | 8-probe hostile matrix |
| PHYSICAL GOOGLE XR HARDWARE | **NOT RUN** | No compatible display/audio glasses in this environment |

---

## Meta DAT Convergence Addendum — Disposition (separate hardware line)
The main audit (§5) states *"Do not use Meta DAT guidance for Google XR."* The Google XR candidate contains **zero** DAT dependencies, so the Meta addendum (M1–M30) does not apply to it. Run as a **separate** preflight against the actual Meta line (`kscan-android-dat-spike`, branch `main`):

- **M1/M2 — DAT preflight: BLOCKED — DAT PACKAGE ACCESS.** The spike's own README declares "STATUS: BLOCKED — Meta Android DAT dependency/API not yet available." `GITHUB_TOKEN` is **UNSET**; no `read:packages`; no `mwdat-*`/MockDeviceKit artifacts; no GitHub Packages Maven config.
- **M1/M2 — Physical: BLOCKED — PHYSICAL META DEVELOPMENT PREREQUISITE.** No Meta AI app / Developer Mode / compatible glasses in this environment.
- **M3–M28 — UNVERIFIED — authoritative installed SDK unavailable** (A12). With no resolved DAT SDK, DAT version (`mwdat-core 0.9.0`), 0.9 migration (`addStream→addCamera`), MockDeviceKit capability matrix, display/thermal/battery typed states, and DAT negative-controls cannot be exercised. These are prerequisite blocks, not code failures.

This is a distinct product line from the Google XR candidate under audit and does not affect the Google XR verdict.

---

## Final Verdict
**PASS WITH CONDITIONS — GOOGLE XR HOSTILE AUDIT COMPLETE; NO OPEN REPAIRABLE P0–P3 SOFTWARE DEFECTS; NAMED EXTERNAL/HARDWARE CONDITIONS REMAIN.**

Conditions:
1. Physical Google XR hardware QA — NOT RUN (no compatible glasses available).
2. XR-DRIFT-01 — owner disposition of three sourceless live wearable Edge Functions.
3. Native XR/Projected camera+display integration remains a documented, deliberate deferral; this candidate is a **phone-companion result-only** build, not a native Android XR app.
4. Sustained runtime on the official Android XR emulator image — retest on a non-contended host or real hardware.
