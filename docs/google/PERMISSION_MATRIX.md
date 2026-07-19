# Permission Matrix — K Scan Glasses (Android XR)

Scope: `android-xr/app` on branch `build/google-xr-native-safety-emulator-candidate`.
Last verified: 2026-07-18 (static source scan + manifest audit).

## Matrix

| Permission | Status | Build | Feature it would serve | Rationale |
|---|---|---|---|---|
| `android.permission.RECORD_AUDIO` | **Removed** | none | Voice commands | Voice is interface/mock only in this build: `VoiceCommandController` parses injected transcripts; there is no microphone capture, no `SpeechRecognizer`, no audio-record code path. Audit ref: GX-01. |
| `android.permission.CAMERA` | **Removed** | none | Glasses capture | `GlassesCameraController.captureStill()` is an explicit TODO stub returning `UnsupportedOperationException`; `PhoneCameraFallback` routes capture through the companion bridge (the phone app holds its own camera permission). No CameraX/camera2 dependency, no runtime prompt. Re-add in the camera phase together with a runtime permission flow. |
| `android.permission.VIBRATE` | **Removed** | none | Haptics | No `Vibrator`/`VibrationEffect` usage anywhere in main sources. |
| `android.permission.INTERNET` | **Debug overlay only** | debug | Debug-backend smoke test | Declared solely in `src/debug/AndroidManifest.xml` for local emulator/LAN testing against the debug analyze endpoint. Never merged into release. |

## Rules

- The **main manifest declares zero permissions**. Release builds ship with none.
- New permissions are added only with: (1) a real code path that requires them,
  (2) a runtime request flow where the permission is dangerous, (3) an update
  to this matrix.
- The debug `INTERNET` overlay must never be promoted into `src/main`.
- Enforcement: `tests/permission-surface.test.ts` statically asserts the main
  manifest stays clean and the debug overlay contains `INTERNET` and nothing else.

## Verification commands

```bash
grep -rn "uses-permission" android-xr/app/src/main/AndroidManifest.xml   # expect: no matches
grep -rn "uses-permission" android-xr/app/src/debug/AndroidManifest.xml  # expect: INTERNET only
```
