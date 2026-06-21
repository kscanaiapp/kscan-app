# Build — K Scan Google Glasses

## Android (mock UI)

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

**Note:** `local.properties` must exist with `sdk.dir` before running Gradle commands.

## Phone bridge tests

```bash
cd phone-bridge
npm test
```

## Shared contract tests

```bash
npm test --prefix phone-bridge
```

## Build configuration

### Debug (default)

- `USE_MOCK_BRIDGE = true`
- `USE_MOCK_API = true`
- `USE_MOCK_SANITIZER = true`
- Safe for local development and emulator smoke tests

### Release (future)

- `USE_MOCK_BRIDGE = false`
- `USE_MOCK_API = false`
- `USE_MOCK_SANITIZER = false`
- Requires real ML Kit face detection and privacy sanitizer

## Known dependency risks

- **Android XR / Jetpack Projected:** APIs evolving; stubs may need version pins
- **ML Kit face detection:** not added in alpha to avoid version lock-in
- **Gradle AGP 8.5+ / Kotlin 1.9+:** verify with your Android Studio version
- **Compose BOM:** aligned to stable channel; XR-specific Compose extensions TBD

## Verified commands

- `:app:assembleDebug` succeeds on API 34 with mock bridge enabled.
- `npm test` in `phone-bridge/` runs bridge contract and sanitizer tests.

## Next implementation tasks

1. Wire `GoogleBridgeProvider` to Jetpack Projected lifecycle entry points when API level is confirmed
2. Implement ML Kit `FaceMasker` and production `PrivacyImageSanitizer` (strict mode)
3. Connect `phone-bridge` to K Scan RN app with Supabase realtime relay
4. Add instrumented tests for D-pad focus navigation and scan ViewModel
5. Implement `PhoneCameraFallback` via `CAPTURE_PHOTO` / `PHOTO_CAPTURED` bridge round-trip
