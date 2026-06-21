# Build Readiness — K Scan Google Glasses (Prompt 1)

## What was created

- Full repository scaffold per Prompt 1 specification
- Kotlin Android app shell with Jetpack Compose (600×600 viewport)
- Provider bridge layer: `GlassesBridgeProvider`, `MockBridgeProvider`, `GoogleBridgeProvider` (stubs)
- Mobile app bridge contracts: `MobileAppBridge`, `MockMobileAppBridge`, `MobileAppRoute`, `SessionSnapshot` (Phase 2)
- Analyze client boundary: `AnalyzeClient`, `MockAnalyzeClient`, `RealAnalyzeClient` (Phase 2)
- Beta config and safety gates: `BetaConfig`, `BetaSafetyGuard`, `SafeLog` (Phase 2)
- Scan orchestrator: `ScanOrchestrator`, `ScanOrchestratorState`, `ScanErrorMapper` (Phase 2)
- Voice/Connectivity/Supabase placeholders (Phase 2)
- Mock scan flow: capture → sanitize → analyze → results → TTS → phone message
- `KScanApiClient` with real backend contract (10s timeout)
- Privacy pipeline interfaces + mock sanitizer
- Phone-bridge TypeScript stubs + shared schema
- Documentation set (README, ARCHITECTURE, BRIDGE_CONTRACT, PRIVACY, TEST_PLAN)

## Mock / stub only

| Component | Status |
|-----------|--------|
| `GoogleBridgeProvider` | Stub — TODO Android XR / Projected APIs |
| `GlassesCameraController` | Stub |
| `PhoneCameraFallback` | Stub |
| `FaceMasker` / production sanitizer | TODO ML Kit |
| `SupabaseSyncClient` | Stub |
| `SupabaseSessionRelay` | Stub |
| Bluetooth / Wi-Fi sessions | Stub |
| Wake word / always-listening | Not implemented |
| Meta bridge | Interface slot only |
| Mobile app deep-link handoff | Placeholder contracts (Phase 2) |

## What works in mock mode

- Compose UI navigation (Scan, Processing, Results, Library, Settings, Error)
- D-pad / keyboard input mapping
- Mock photo capture
- Mock or real API analyze (config flag)
- Mock privacy sanitizer success path
- Voice command parsing (transcript injection in mock)
- Display vs audio-only capability toggle
- Top 3 result cards + spoken summary
- `sendToPhone` / `openOnPhone` bridge message emission (debug log)

## Known dependency risks

- **Android XR / Jetpack Projected:** APIs evolving; stubs may need version pins
- **ML Kit face detection:** not added in alpha to avoid version lock-in
- **Gradle AGP 8.5+ / Kotlin 1.9+:** verify with your Android Studio version
- **Compose BOM:** aligned to stable channel; XR-specific Compose extensions TBD

## Commands to run next

```powershell
cd c:\Users\jsmit\KScan\kscan-google-glasses\android-xr
# Create local.properties with sdk.dir if missing
.\gradlew.bat :app:assembleDebug
```

**Verified (Prompt 1):** `:app:assembleDebug` succeeds on API 34 with mock bridge enabled.

```powershell
cd c:\Users\jsmit\KScan\kscan-google-glasses
npm test

cd phone-bridge
npm test
```

## Next implementation tasks (Prompt 2 suggestions)

1. Wire `GoogleBridgeProvider` to Jetpack Projected lifecycle entry points when API level is confirmed
2. Implement ML Kit `FaceMasker` and production `PrivacyImageSanitizer` (strict mode)
3. Connect `phone-bridge` to K Scan RN app with Supabase realtime relay
4. Add instrumented tests for D-pad focus navigation and scan ViewModel
5. Implement `PhoneCameraFallback` via `CAPTURE_PHOTO` / `PHOTO_CAPTURED` bridge round-trip
