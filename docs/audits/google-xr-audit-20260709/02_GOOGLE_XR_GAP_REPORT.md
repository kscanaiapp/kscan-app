# Audit Metadata

Audit:
02_GOOGLE_XR_GAP_REPORT

Phase:
Phase 4 — Google XR Glasses + Final Consolidation

Workspace:
C:\Users\jsmit\kscan-google-glasses-canonical

Production / public URL:
None

Branch:
feature/glasses-xr-native-standalone

HEAD:
497c583

Audit Date:
2026-07-09

Auditor:
Claude Audit Orchestrator

Evidence Quality:
High (source); Medium (build — environment-limited)

Prior Phase Inputs Used:
Yes

---

# Prior Phase Inputs Used

## From Phase 1

Input consumed: mic rule; privacy pipeline baseline; KC-13 duplicate tree.
How it was used: permission audit; sanitizer comparison; authority question.
Finding created from it: GX-01, GX-02, GX-06.
Open dependency: tree authority decision.

## From Phase 2

Input consumed: wearables messaging constraints.
How it was used: confirmed no public claims exist for this repo.
Finding created from it: consolidation note (llms.txt "browser-enabled" wording vs native track).
Open dependency: none.

## From Phase 3

Input consumed: working MediaPipe masker; gate patterns; MG-01 lesson.
How it was used: GX-02 port recommendation; backend-target audit (all XR targets are in-repo — passes the MG-01 test).
Finding created from it: GX-02.
Open dependency: none.

---

## Findings

ID: GX-01
Severity: P1
Area: Permissions / privacy surface
Finding: `android.permission.RECORD_AUDIO` is declared in the MAIN manifest while no code uses a microphone — the entire voice package is interface/mock-only and explicitly documents "No real microphone. No SpeechRecognizer. No MediaRecorder." This contradicts the standing product rule (VoiceScan remains Coming Soon; no mic permission) that the mobile app carefully honors (Android blockedPermissions + no iOS mic string).
Evidence: android-xr/app/src/main/AndroidManifest.xml (uses-permission RECORD_AUDIO); voice/VoiceInputController.kt:6.
Phase 1 dependency: mic rule + mobile's correct posture.
Phase 2 dependency: website makes no voice claims — a mic-requesting glasses build would outrun public messaging.
Phase 3 dependency: Meta webapp has no mic surface (consistent).
Why it matters: An unused dangerous permission is a store/Play-review flag, a privacy-label contaminant, and a trust inconsistency across the ecosystem.
Recommended fix: Remove RECORD_AUDIO from src/main; reintroduce via a debug overlay or a future voice feature branch when real voice ships.
Estimated effort: minutes (+ rebuild).
Release blocker: Yes for any distributed build.
Cross-cutting risk: Yes (permission-truth consistency).

ID: GX-02
Severity: P2
Area: Privacy sanitizer / face masking boundary
Finding: FaceMasker is a NotImplemented production boundary; StrictPrivacyImageSanitizer correctly fails closed, so production-path uploads are entirely blocked until an on-device detector is implemented. Safe, but the ecosystem now has three sanitizer states: mobile passthrough (uploads unmasked), Meta working masker, XR blocked-until-implemented. The Meta webapp's MediaPipe fail-closed implementation (Phase 3 MG-05) is the proven blueprint; ML Kit is the stated XR plan.
Evidence: privacy/FaceMasker.kt:6–35; privacy/PrivacyImageSanitizer.kt:26–49.
Phase 1 dependency: KC-06 (mobile passthrough).
Phase 3 dependency: MG-05 (reference implementation).
Why it matters: Privacy behavior should converge before any cross-surface marketing; XR cannot progress past dry-run stages without the detector.
Recommended fix: Implement FaceMasker with ML Kit mirroring Meta's semantics (mask-with-margin, NoFaces pass, fail-closed, no metadata retention); add parity tests.
Estimated effort: 3–5 days.
Release blocker: No (blocked state is safe); blocks roadmap progression.
Cross-cutting risk: Yes.

ID: GX-03
Severity: P2
Area: Camera pipeline / hardware validation gap
Finding: Real capture does not exist: GlassesCameraController is a TODO for Android XR / Jetpack Projected camera APIs; capture flows through bridge providers (Google/Mock) and a PhoneCameraFallback stub. No physical-device or XR-emulator validation evidence exists in the repo.
Evidence: camera/GlassesCameraController.kt:5; bridge/*.
Why it matters: Hardware validation is the production-readiness blocker for the wearable track (not a code defect — per audit rules, treated as readiness blocker, not failure).
Recommended fix: Emulator-first validation plan; pin the Jetpack XR API level; document device matrix.
Estimated effort: hardware-gated.
Release blocker: Yes for wearable beta (readiness), No for repo health.
Cross-cutting risk: Yes (final verdict).

ID: GX-04
Severity: P3
Area: Build reproducibility
Finding: Build validation could not run in this audit environment: gradlew arrives CRLF-mangled through the mount (unexecutable without modifying it — prohibited), and sandbox JDK is 11 vs AGP-required 17. The committed debug APK (2026-06-28) evidences a recent successful build on the owner's machine. No CI workflow exists in the repo to make builds environment-independent.
Evidence: bash gradlew --version → CRLF errors; java -version → 11; APK timestamp.
Recommended fix: Add a CI build (JDK 17, gradle wrapper validation), enforce LF for gradlew via .gitattributes.
Estimated effort: 0.5 day.
Release blocker: No.
Cross-cutting risk: No.

ID: GX-05
Severity: P3
Area: Test infrastructure
Finding: Root TS tests (`node --import tsx --test tests/*.test.ts`) and phone-bridge tests cannot run — no node_modules installed and dependency installation is not authorized for this audit. Android unit tests not runnable per GX-04. Test health therefore unverified in all three suites (unlike Phases 1–3 where suites ran).
Evidence: absent node_modules; package.json scripts.
Recommended fix: CI for all three suites.
Estimated effort: with GX-04.
Release blocker: No.
Cross-cutting risk: No.

ID: GX-06
Severity: P2
Area: Workspace authority / duplication
Finding: Three glasses trees exist: (1) this canonical repo; (2) a full kscan-google-glasses/ tree committed INSIDE the mobile repo at HEAD (Phase 1 KC-13); (3) C:\Users\jsmit\kscan-google-glasses containing DO_NOT_USE_DEGRADED_WORKSPACE.md (correctly self-labeled). Authority is implied by naming only; divergence between (1) and (2) is not tracked anywhere.
Evidence: Phase 1 HEAD listing; workspace listings.
Why it matters: Fixes (e.g., GX-01) applied to one tree can silently miss the other.
Recommended fix: Declare canonical in both READMEs; delete or archive the embedded copy from the mobile repo after reconciliation.
Estimated effort: hours.
Release blocker: No.
Cross-cutting risk: Yes.

## Required checklist coverage

AndroidManifest correctness: PASS except GX-01; allowBackup=false ✓; single exported launcher ✓.
Permissions: CAMERA (future), RECORD_AUDIO (GX-01), VIBRATE; INTERNET debug-only ✓ (exemplary).
Camera pipeline: TODO (GX-03). Projected activity structure: single-activity + Compose screens; projected APIs pending (GX-03).
Native lifecycle: ReleaseSafetyGuard.verify() at startup; ViewModel/state separation present.
Scan orchestrator bypasses: none found; sanitize is an ordered pipeline stage; release lacks INTERNET regardless.
Backend client construction: factory + config-gated Real/Mock split; debug endpoint client isolated ✓.
Mock/live gates: BuildConfig flags + DryRunGate + debug-only INTERNET ✓ (strongest in ecosystem).
Release safety guard: present, throws on mock sanitizer/bridge in release ✓.
Privacy sanitizer: fail-closed strict mode ✓; detector NotImplemented (GX-02).
Face masking boundary: typed sealed results, documented semantics ✓.
Image resize/compression: ImageCompressor present.
Base64/data URL handling: models pass base64 + mimeType through sanitizer stages; no raw-upload fallback ✓.
Logging safety: DebugAnalyzeConfig redacts authToken in toString; "never logged" documented; no token logging found in grep.
Secret exposure: none — blank BuildConfig defaults from gitignored local properties; hardening commit #18 ✓.
Hardware validation gap: GX-03. XR emulator gap: GX-03.
APK distribution: local debug only (9.1 MB, debug-signed by definition); no OBB/split need at this size; no release signing configured (appropriate — nothing should be released).

# False Positives / Already Handled

- "Secrets in BuildConfig": explicitly hardened (commit bdbbc93 #18) — blank defaults, gitignored local properties, redacted toString, documented threat model ✓.
- "Release build could hit live backend": impossible twice over — no INTERNET permission in release + ReleaseSafetyGuard ✓.
- "Mock sanitizer could ship": ReleaseSafetyGuard throws ✓.
- 189 modified files in git status: CRLF-only mount artifacts (verified via --ignore-cr-at-eol sampling), not real divergence; build artifacts properly gitignored.
- Voice package existing at all: it is interface/mock scaffolding with explicit no-mic documentation — the problem is only the stale manifest permission (GX-01), not hidden recording code.
- MG-01-style unaudited backend targets: NOT present here — all analyze targets are in-repo (debug endpoint + dry-run gates) ✓.
