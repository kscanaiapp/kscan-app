# Setup — K Scan Google Glasses

## Prerequisites

- Android Studio (latest stable)
- Android SDK (API 34+ recommended for mock mode)
- Node.js 18+ (for phone-bridge tests and shared contracts)
- Git

## Clone and configure

1. Ensure this workspace is a sibling to the main K Scan mobile app repo:
   ```text
   C:\Users\jsmit\KScan              (main mobile app)
   C:\Users\jsmit\kscan-google-glasses  (this workspace)
   ```
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

## Android Studio setup

1. Open **`android-xr/`** as the Gradle project root in Android Studio.
2. Create **`android-xr/local.properties`** (gitignored):
   ```properties
   sdk.dir=C\:\\Users\\YOUR_USER\\AppData\\Local\\Android\\Sdk
   ```
3. Sync Gradle. Default configuration targets a normal phone/emulator for mock UI testing.
4. **Jetpack Projected / Android XR** APIs are stubbed with explicit TODOs — do not expect full XR behavior on a generic emulator yet.

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

## local.properties guidance

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
