# 04 — Google Glasses Emulator Results

## Emulator identity

| Field | Value |
|-------|-------|
| AVD | `XR_Glasses` |
| Serial (ADB) | `emulator-5554` |
| Product | `gms_sdk_xr64_x86_64` |
| Model | `Android XR SDK built for x86_64` |
| API | 34 |
| ABI | x86_64 |
| Sibling phone | `emulator-5556` (`sdk_gphone16k_x86_64`) — **not** XR |

**Note:** ADB product props identify XR as `5554`. Studio device-list order can mislead.

## Install / launch

| Step | Result |
|------|--------|
| Clean/reinstall APK | Success (uninstall may report DELETE_FAILED if absent) |
| Package | `com.kscan.glasses` versionName `0.1.0-alpha` versionCode `1` |
| Cold launch | `Status: ok` (slow: ~47–94s first cold start) |
| Process | Survived Scan / Back / Escape / D-pad (pid stable) |
| Crash / ANR | No FATAL / AndroidRuntime in filtered app logcat |
| Screencap / UIAutomator | Unreliable / hang on XR surface stack |
| Early boots | Blocked while `system_server`/package service absent |

## Flows executed

| Flow | Status |
|------|--------|
| 1. Mock scan success (default debug mock pipeline) | Partial — Scan shortcut sent; process stayed alive; visual Results confirmation blocked by screencap hang |
| 2. Local-backend scan (emulator→10.0.2.2) | Not completed E2E on device (host backend smoke done separately) |
| 3–15. Error/permission/recreation matrix | Not fully exercised on device |

## Emulator→backend E2E (committed HEAD session)

| Step | Result |
|------|--------|
| Host backend mock + Bearer | Verified (HTTP + Phase3C Android client) |
| APK BuildConfig debug URL | `http://10.0.2.2:3002/...` via gitignored local.properties |
| Runtime token via tmp file | Provisioned in scripts; not committed |
| Fresh reinstall after XR cold restart | **Blocked** — `package`/`activity` services flapping |
| UI Results confirmation | Not obtained this session |

## Verdict

```
GOOGLE GLASSES EMULATOR VERIFIED (install + cold launch + key-input survival — prior stable window)
EMULATOR→10.0.2.2 UI E2E BLOCKED THIS SESSION (package service flap)
HOST CLIENT→BACKEND DEBUG PATH VERIFIED (Phase3C)
```

Not physical XR hardware. Visual/screenshot evidence and full functional matrix remain incomplete due to XR surface tooling instability.
