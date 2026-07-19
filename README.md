# K Scan AI for Google / Android XR Smart Glasses

> **This is the active K Scan Google Glasses / Android XR workspace.**
>
> It is a sibling to the main K Scan mobile app repo:
> `C:\Users\jsmit\KScan`
>
> It mirrors the Meta glasses separation pattern:
> `C:\Users\jsmit\kscan-glasses-webapp`
>
> **Do not edit the mobile app repo from this workspace.**
> **Do not copy mobile app secrets into this workspace.**
> The Google Glasses app should integrate with K Scan through backend APIs and shared data contracts, not direct imports from the mobile repo.

Visual fashion discovery for Google / Android XR smart glasses, integrated with the existing **K Scan** phone app and backend.

**Positioning:** See it. Say it. Get it. Shop in seconds — on glasses, with phone-hosted projection and bridge where appropriate.

## Project overview

This repository is the alpha scaffold for **K Scan Google Glasses**:

- **Android XR / Jetpack Projected** glasses UI (600×600 safe viewport, Compose)
- **Phone bridge** TypeScript module for session relay, photo capture, and rich cards on phone
- **Provider-based bridge layer** (`GoogleBridgeProvider`, `MockBridgeProvider`, future `MetaBridgeProvider`)
- **Privacy-first upload pipeline** (sanitize before `/api/analyze`)
- **Mock mode** for development without physical XR hardware

The glasses implementation is **phone-hosted / projected** where platform APIs require it — not a standalone hardcoded glasses-only runtime.

## Setup

1. Clone this repository (when published): `kscan-google-glasses`
2. Copy environment placeholders:
   ```bash
   cp .env.example .env
   ```
3. Set debug-only backend analyze placeholders in `.env`:
   - `KSCAN_DEBUG_ANALYZE_URL=` (leave blank for mock-only builds)
   - `KSCAN_DEBUG_ANALYZE_AUTH_TOKEN=`
   - `KSCAN_DEBUG_ANALYZE_DRY_RUN=false`
4. For phone bridge development:
   ```bash
   cd phone-bridge && npm install
   ```

## Environment variables

| Variable | Description |
|----------|-------------|
| `KSCAN_DEBUG_ANALYZE_URL` | Debug-only backend analyze URL (blank = dry-run blocked) |
| `KSCAN_DEBUG_ANALYZE_AUTH_TOKEN` | Debug-only bearer token (blank = no Authorization header) |
| `KSCAN_DEBUG_ANALYZE_DRY_RUN` | `true` to allow backend analyze dry-run wiring |
| `SUPABASE_URL` | Supabase project URL (phone bridge relay — placeholder) |
| `SUPABASE_ANON_KEY` | Supabase anon key (placeholder only in repo) |
| `KSCAN_BRIDGE_MODE` | `mock` \| `phone` \| `google` |
| `KSCAN_USE_MOCK_BRIDGE` | Android: use mock bridge provider |
| `KSCAN_USE_MOCK_API` | Android: skip real network, return mock analyze response |
| `KSCAN_USE_MOCK_SANITIZER` | Android: mock privacy sanitizer success |

See `.env.example` — **never commit `.env` or real keys**.

## Android Studio setup

1. Open **`android-xr/`** as the Gradle project root in Android Studio.
2. Create **`android-xr/local.properties`** (gitignored):
   ```properties
   sdk.dir=C\:\\Users\\YOUR_USER\\AppData\\Local\\Android\\Sdk
   ```
3. Sync Gradle. Default configuration targets a normal phone/emulator for mock UI testing.
4. **Jetpack Projected / Android XR** APIs are stubbed with explicit TODOs — do not expect full XR behavior on a generic emulator yet.

### local.properties guidance

- Required for local builds; never commit.
- On Windows, escape backslashes as shown above.
- CI should inject `sdk.dir` or use `ANDROID_HOME`.

## Mock mode

Enable mock mode for local development without glasses:

- Android: `BuildConfig.USE_MOCK_BRIDGE = true` (default in debug)
- Toggle **display glasses** vs **audio-only** in Settings (runtime capability mock)
- D-pad / keyboard: Arrow keys or WASD (move focus), Enter/Space (Select), Backspace/Esc (Back), `C` (Scan shortcut)
- Mock image capture returns a bundled placeholder (no camera required)
- Mock API client returns top-3 sample products when `USE_MOCK_API=true`

## Phone bridge integration

The `phone-bridge/` package exposes `KScanGoogleGlassesBridge` for the existing K Scan React Native app:

```typescript
const bridge = new KScanGoogleGlassesBridge({
  supabase,
  backendUrl: process.env.KSCAN_BACKEND_URL,
  onScanResult: (result) => {},
  onDeviceState: (state) => {},
  onError: (error) => {},
});

await bridge.start();
```

See `phone-bridge/README.md` and `docs/BRIDGE_CONTRACT.md`.

## Wake word / voice notes

This alpha **does not** claim always-on wake-word support. Third-party always-listening wake words depend on:

- Platform microphone policies and Android XR projected context APIs (version-sensitive)
- OEM restrictions on background audio
- Google Assistant / phone-side intent fallbacks

Supported alpha approach:

- **Push-to-talk** or **gesture-to-talk** on glasses
- **Scan shortcut** (button / D-pad)
- **Phone-side voice** relay via bridge when glasses microphone is unavailable

Voice phrases parsed when transcript is available: see `VoiceCommandController.kt`.

## Build / run commands

### Android (mock UI)

```bash
cd android-xr
./gradlew :app:assembleDebug
./gradlew :app:installDebug
```

Windows:

```powershell
cd android-xr
.\gradlew.bat :app:assembleDebug
```

### Phone bridge tests

```bash
cd phone-bridge
npm test
```

### Shared contract tests

```bash
npm test --prefix phone-bridge
```

## Testing instructions

See `docs/TEST_PLAN.md` for mock, emulator, device, and privacy test matrices.

Quick smoke:

1. Launch app on emulator → Settings → confirm mock capabilities
2. Scan screen → Select or `S` → Processing → Results (top 3)
3. Voice hint shows parsed commands in mock mode
4. Save / Open on Phone emit bridge messages (logged in debug, no secrets)

## Platform assumptions & TODOs

| Area | Status |
|------|--------|
| Jetpack Projected / Android XR display | TODO — version-sensitive stubs |
| Glasses camera capture | TODO — `GlassesCameraController` stub |
| Phone camera fallback | TODO — bridge `CAPTURE_PHOTO` |
| ML Kit face detection | TODO — `FaceMasker` mock only |
| Supabase realtime relay | TODO — `SupabaseSyncClient` stub |
| Bluetooth / Wi-Fi transfer | TODO — TypeScript session managers |
| Meta Ray-Ban bridge | Future — `MetaBridgeProvider` slot |

## Documentation

- [docs/google/ARCHITECTURE.md](docs/google/ARCHITECTURE.md)
- [docs/google/SETUP.md](docs/google/SETUP.md)
- [docs/google/BUILD.md](docs/google/BUILD.md)
- [docs/google/TEST.md](docs/google/TEST.md)
- [docs/google/MOBILE_APP_BOUNDARY.md](docs/google/MOBILE_APP_BOUNDARY.md)
- [docs/BRIDGE_CONTRACT.md](docs/BRIDGE_CONTRACT.md)
- [docs/PRIVACY_PIPELINE.md](docs/PRIVACY_PIPELINE.md)
- [docs/BUILD_READINESS.md](docs/BUILD_READINESS.md)
- [docs/TEST_PLAN.md](docs/TEST_PLAN.md)

## License

Proprietary — K Scan AI. All rights reserved.
