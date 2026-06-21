# Phase 3 Beta Integration Plan

## Overview

Phase 3 extends the Phase 2 architecture with real integrations, but only behind explicit debug flags and with Justin's approval. No live backend, real Supabase, real voice, real BLE, or real Wi-Fi is enabled by default.

## Integration Roadmap

### 1. Backend Analyze Debug Mode

- Add a controlled debug flag (`enableDebugAnalyze=true`) that allows the real `RealAnalyzeClient` to run against a staging URL
- Backend URL is loaded from environment/config, never hardcoded in source
- Requires explicit opt-in; safe defaults still block real analyze
- Privacy gate (face masking) must still be approved before any real image upload
- Response schema validation remains strict
- Timeout and error mapping from Phase 2 is reused

### 2. Mobile App Deep-Link Integration

- The main mobile app repo must register `kscan://glasses/handoff/...` deep links
- Glasses app will emit intents/URI requests; phone app handles them
- Session handoff uses lightweight `SessionSnapshot` (no tokens, no secrets)
- Requires coordination with the main mobile app team
- Deep links are placeholder-only until the main app implements handlers

### 3. Supabase Session Handoff

- Replace `MockSupabaseSessionBridge` with real Supabase SDK integration when ready
- Session tokens must be fetched securely, never stored in source
- Use `SupabaseAuth` session sharing between phone and glasses (future design)
- Content sync (Closet, Dressing Rooms) will use Supabase realtime subscriptions
- Requires Supabase project setup and RLS policy review

### 4. Voice Push-to-Talk

- Integrate real microphone capture behind `VoiceActivationMode.PUSH_TO_TALK`
- Use on-device speech recognition (Android SpeechRecognizer or third-party on-device ASR)
- No always-on listening; user must explicitly press/tap to activate
- Parsed commands route through existing `VoiceCommandParser`
- Requires microphone permission in manifest; request at runtime

### 5. Real XR Emulator / Physical Glasses Testing

- Connect to Android XR emulator or physical Google glasses hardware
- Validate projected Activity rendering on real display surface
- Test D-pad/gesture input mapping on hardware
- Verify HUD state transitions (ready → preparing → privacy → analyzing → results)
- XR emulator setup is deferred until Google releases stable emulator tooling

### 6. Production ML Kit Face Masking

- Add ML Kit Face Detection dependency to `build.gradle.kts`
- Implement `FaceMasker.maskFaces()` with on-device detector
- Apply Gaussian blur or solid mask over bounding boxes with padding
- Re-encode JPEG via `ImageCompressor` after masking
- Fail closed: if detector is unavailable, block upload
- Do not use cloud face APIs; do not persist bounding boxes or embeddings
- Requires dependency version audit for Android XR SDK compatibility

### 7. Camera Capture Integration

- Implement `GlassesCameraController.captureStill()` using camera2 or XR camera APIs
- Fallback to `PhoneCameraFallback` when glasses have no camera
- Route captured image through `ScanOrchestrator` pipeline
- Requires camera permission and runtime permission handling
- Photo capture must respect privacy mask settings before any upload

### 8. Bluetooth / Wi-Fi Transport (If Needed)

- Evaluate whether phone-bridge communication truly needs BLE or Wi-Fi Direct
- Android intents and deep links may be sufficient for most handoff scenarios
- If custom transport is needed, implement behind `ConnectivityMode.BLE` or `WIFI_DIRECT`
- Use standard Android Bluetooth LE APIs (no custom protocol)
- Requires pairing flow design and security review
- **Recommendation:** defer until deep-link integration proves insufficient

## Phase 3 Safety Rules

- All real integrations require explicit debug flag opt-in
- Mock defaults remain the safe fallback
- No production credentials in source
- No real user data upload without privacy gate approval
- Face masking must be production-ready before any real analyze with user images
- No always-on voice or camera
- BLE/Wi-Fi only if deep links are insufficient

## Approval Gates

Each integration requires Justin's explicit approval before implementation:

1. ✅ Backend debug mode (staging URL + debug flag)
2. ✅ Mobile app deep-link coordination (main app repo work)
3. ✅ Supabase session integration (auth + RLS review)
4. ✅ Voice push-to-talk (microphone + ASR)
5. ✅ XR emulator/hardware testing (Google tooling release)
6. ✅ ML Kit face masking (dependency + privacy review)
7. ✅ Camera capture (camera2/XR APIs + permission handling)
8. ✅ Bluetooth/Wi-Fi transport (only if deep links insufficient)

## Next Actions

1. Create `BACKEND_DEBUG_MODE_PLAN.md` with detailed staging URL and debug flag design
2. Create `MAIN_APP_HANDOFF_TODO.md` with tasks for the main mobile app repo
3. Create `EXTENDED_AUTONOMOUS_BUILD_REPORT.md` summarizing Phase 2 + Phase 3 docs
