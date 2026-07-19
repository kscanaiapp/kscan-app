# Audit Metadata

Audit:
01_GOOGLE_XR_OVERVIEW

Phase:
Phase 4 — Google XR Glasses + Final Consolidation

Workspace:
C:\Users\jsmit\kscan-google-glasses-canonical

Production / public URL:
None (native prototype; no distribution)

Branch:
feature/glasses-xr-native-standalone (matches expectation)

HEAD:
497c583 (2026-06-28 "fix(glasses): update Library copy to Closet (#19)")

Audit Date:
2026-07-09

Auditor:
Claude Audit Orchestrator

Evidence Quality:
High (source-level; build validation environment-limited — see gap report)

Prior Phase Inputs Used:
Yes (Phases 1, 2, 3 handoffs)

---

# Prior Phase Inputs Used

## From Phase 1

Input consumed: mobile privacy pipeline (passthrough sanitizer, 896px/0.65 re-encode); Supabase JWT model; /api/analyze anti-pattern vs stylechat-generate reference; VoiceScan/mic rule (mic must not be requested); embedded kscan-google-glasses tree in mobile repo (KC-13).
How it was used: privacy-pipeline comparison; backend-boundary evaluation; permission audit; workspace-authority question.
Finding created from it: GX-01 (mic permission), GX-02 (sanitizer comparison), GX-06 (duplicate trees).
Open dependency: which glasses tree is authoritative (owner decision).

## From Phase 2

Input consumed: wearables messaging constraints ("browser-enabled prototypes" wording; no hardware/production claims).
How it was used: verified this repo makes no public claims (it has no public surface); flagged that llms.txt's "browser-enabled" wording is inaccurate for this NATIVE track if XR is ever marketed.
Finding created from it: messaging note passed to consolidation.
Open dependency: WS-01/02 copy fixes.

## From Phase 3

Input consumed: Meta mock/live gate pattern; fail-closed sanitizer reference implementation; session-bridge anti-patterns (MG-02/03); MG-01 (unaudited backend function) lesson.
How it was used: direct pattern comparison (below).
Finding created from it: GX-02 (port Meta's working masker), native-vs-web comparison in handoff.
Open dependency: none.

---

## What this repo is

The canonical native Android XR workspace for K Scan glasses: a standalone Kotlin app (package `com.kscan.glasses`) plus supporting Node/TypeScript packages (backend/ debug endpoint server, phone-bridge/ TS package, shared/, tests/). Expected branch, package name, and APK path all VERIFIED present: `android-xr/app/build/outputs/apk/debug/app-debug.apk` (9.1 MB debug APK, built 2026-06-28).

## Current architecture

Native Android app under android-xr/app: MainActivity + KScanApplication; Compose-style UI layer (ui/KScanGlassesApp, screens: Scan/Processing/Results/Library/Settings/Error; components: FocusableCard, ResultCard, StatusChip, VoiceHint); state via KScanViewModel/ScanSession; scan orchestration (ScanOrchestrator + Factory + State + ErrorMapper); bridge abstraction (GlassesBridgeProvider with GoogleBridgeProvider and MockBridgeProvider, CaptureSource/DeviceCapabilities/PermissionState models); analyze client family (AnalyzeClient interface, RealAnalyzeClient, MockAnalyzeClient, AnalyzeDryRunGate, DebugAnalyzeConfig, GlassesDebugEndpointClient, KscanHttpTransport); privacy package (PrivacyImageSanitizer, FaceMasker, ImageCompressor); sync package (SupabaseSessionBridge interface with MOCK-only implementations); voice package (interface-only controllers — explicitly "No real microphone. No SpeechRecognizer. No MediaRecorder."); safety/ReleaseSafetyGuard.

## Projected activity model / HUD state

Single exported launcher MainActivity; screens modeled for glasses-style focus navigation (FocusableCard, VoiceHint). Projected/Jetpack-XR camera APIs are explicitly TODO (GlassesCameraController: "Android XR / Jetpack Projected camera APIs (version-sensitive)"); PhoneCameraFallback exists as a stub path.

## Scan orchestrator

ScanOrchestrator sequences capture → sanitize → analyze with typed states and error mapping; factory wiring selects mock vs real clients via config — no bypass path found around the sanitizer in orchestration wiring (sanitize is a pipeline stage, and release builds physically lack INTERNET anyway).

## Privacy pipeline

- StrictPrivacyImageSanitizer: **fail-closed** — "No raw upload fallback exists. If face detection is unavailable, upload is blocked."
- FaceMasker: an intentional **NotImplemented production boundary** (sealed results Success/NoFaces/NotImplemented/Error; ML Kit on-device detection planned). Net effect today: strict mode blocks all uploads — safe by construction, nonfunctional by design until the detector lands.
- ImageCompressor present (resize/compress stage).
- Comparison: mobile = passthrough (weakest), Meta webapp = working MediaPipe masking (strongest), XR = fail-closed skeleton awaiting detector. XR should port Meta's proven approach (Phase 3 MG-05).

## Backend boundary / dry-run–live boundary

Defense in depth, best in the ecosystem:
1. **INTERNET permission exists ONLY in the debug manifest overlay** (src/debug/AndroidManifest.xml with explicit "must NEVER be added to src/main" comment) — release builds are network-incapable at the OS level.
2. ReleaseSafetyGuard throws at startup if a release build carries USE_MOCK_SANITIZER or USE_MOCK_BRIDGE.
3. AnalyzeDryRunGate evaluates config gates before any real call; DebugAnalyzeConfig comes from gitignored local Gradle properties, emits blank BuildConfig fields by default, redacts authToken in toString, and documents "Do not place credentials in BuildConfig" (hardened in commit bdbbc93 #18).
4. Supabase integration is mock-only (MockSupabaseContentSync, MockSupabaseSessionBridge) — no live Supabase path exists yet.

## Current APK/build health

Debug APK present (9,098,006 bytes, 2026-06-28) proving a recent successful local build. Gradle validation could not be run in this audit environment: the mounted gradlew has CRLF line endings (unexecutable without modification, which audit rules prohibit) and the sandbox JDK is 11 (AGP 8.x requires 17). Documented as Cannot Run.

## Branch / package / APK / manifest summary

Branch: feature/glasses-xr-native-standalone ✓ matches expectation. Package/applicationId: com.kscan.glasses ✓. APK path ✓. Main manifest: permissions CAMERA, **RECORD_AUDIO (unused — see GX-01)**, VIBRATE; allowBackup=false ✓; single exported launcher activity; no INTERNET in main ✓.

## Permission summary

CAMERA (future capture; pipeline TODO), RECORD_AUDIO (declared but NO code uses it — voice layer is interface/mock only), VIBRATE, INTERNET (debug builds only).

## Hardware / emulator status

No evidence of physical-glasses or XR-emulator validation in the repo (no device logs, no emulator configs beyond standard, camera APIs TODO). Hardware readiness is the dominant open front (readiness 1/5). The working tree's 189 modified files are CRLF-only mount artifacts (verified with --ignore-cr-at-eol sampling); build artifacts (.gradle/, build/) are properly gitignored.

# Comparison Against Prior Phases

Compared against Phase 1 mobile backend: XR targets a debug endpoint client + dry-run gates rather than calling /api/analyze directly — correctly avoids depending on the unauthenticated mobile endpoint (KC-01); its DebugAnalyzeConfig secrets discipline exceeds mobile's server-side env discipline; Supabase session handling is deliberately mock-only pending the mobile-account bridge (contrast: Meta webapp already ingests real JWTs, with flaws MG-02/03 to avoid).
Compared against Phase 2 website claims: the site makes no native-XR claims (glasses framed as "browser-enabled prototypes") — technically inaccurate wording for this native track but conservatively so; no overclaim exposure.
Compared against Phase 3 Meta webapp: XR's release gating (no-INTERNET-in-release + startup guard) is STRONGER than Meta's (env flags + deploy pinning); XR's sanitizer is fail-closed but not yet functional where Meta's works; XR avoids Meta's session-bridge flaws by not having a live session path at all yet.
