# Meta Physical Device QA Checklist

Operator checklist for the first real Ray-Ban session against the K Scan
Meta candidate. Each row states whether MockDeviceKit already proved the
*software lifecycle* for that step — physical hardware is still required to
prove the *hardware behavior* (optics, audio, actual wear comfort, real
Bluetooth link quality). Do not treat a Mock-verified row as equivalent to a
hardware pass; read the "Hardware still proves" column.

As of this document's last update, **MockDeviceKit has not yet been run**
(blocked on GitHub Packages access — see `META_DAT_UNBLOCK_AND_VALIDATION_REPORT.md`).
Every "Mock verified" cell below is therefore aspirational, not actual, until
that gate clears and the MockDeviceKit journey (§20 of the unblock mission)
is actually executed. Update this file's checkmarks only from a real run.

## Prerequisites

- [ ] Meta AI app installed on the test phone
- [ ] Developer Mode enabled (Wearables Developer Center)
- [ ] `KSCAN_MWDAT_ENABLED=true` (or `-Pkscan.mwdat.enabled=true`) build installed
- [ ] `GITHUB_TOKEN`/`github_token` was present at build time (not needed at runtime — see Token Hygiene note below)
- [ ] Physical Meta glasses charged, paired to the test phone at the OS Bluetooth level
- [ ] App build number / commit SHA recorded for this session

## Registration

| Step | Mock verified? | Hardware still proves |
|---|---|---|
| `Wearables.startRegistration` launches the flow | Not yet run | Real Meta AI app UI, real account |
| `registrationState` reaches `REGISTERED` | Not yet run | Real server round-trip |
| Registration failure paths (network, cancel) | Not yet run | Real network conditions |

## Device Discovery

| Step | Mock verified? | Hardware still proves |
|---|---|---|
| `Wearables.devices` reports the paired glasses | Not yet run | Real BLE/Wi-Fi discovery timing |
| `LinkState` transitions CONNECTING → CONNECTED | Not yet run | Real link quality, range limits |
| Device disappears on power-off | Not yet run | Real power behavior |

## Session

| Step | Mock verified? | Hardware still proves |
|---|---|---|
| `createSession` / `startSession` reach `STARTED` | Not yet run | Real session negotiation timing |
| A stopped session is never reused (app-side + native-side) | **Unit-tested at the JS layer** (`metaWearableDevice.test.js`) | Real terminal-session behavior on-device |

## Camera / Capture

| Step | Mock verified? | Hardware still proves |
|---|---|---|
| Camera permission grant/deny | Not yet run | Real permission UI |
| `addCamera` → `STARTED` | Not yet run | Real streaming setup latency |
| `capturePhoto` returns a usable image | Not yet run | **Actual optics/image quality** — Mock cannot substitute for this, ever |
| Capture timeout / cancellation | **Unit-tested at the JS layer** | Real device responsiveness under cancel |
| Capture writes to app-private storage only, no leaks | Reviewed in source (`DatEngine.kt`) | Confirm on-device with `adb shell` inspection |

## Privacy

| Step | Mock verified? | Hardware still proves |
|---|---|---|
| Glasses capture → privacy sanitizer → `source: 'meta_glasses'` recorded | Reviewed in source, unit-tested for logic | Real face-detection accuracy on a real photo |
| Oversized/malformed capture rejected | Unit-tested (bounds/geometry tests) | N/A — logic-level guarantee |

## Result / StyleMatch

| Step | Mock verified? | Hardware still proves |
|---|---|---|
| `wearable-scan` → canonical result → correct commerce grouping | **Deployed + verified live** (staging v4) | Real end-to-end latency with a real image |
| Result reaches the phone UI | Contract-tested | Real round-trip timing |

## Display (display-capable hardware only)

| Step | Mock verified? | Hardware still proves |
|---|---|---|
| `displayAvailable()` reports true only when hardware supports it | Reviewed in source (capability-driven, not model-name-driven) | Confirm on a real display-capable unit |
| `addDisplay` → glanceable render | Not yet run | **Readability, brightness, field of view** — Mock cannot substitute for this |
| `clearDisplay` | Not yet run | Real render/clear timing |

## Save / Open on Phone

| Step | Mock verified? | Hardware still proves |
|---|---|---|
| Save is idempotent, no optimistic success | Contract-tested | Real network latency |
| Open on Phone routes to the exact result, not app home | Contract-tested | Real deep-link timing |

## Disconnect / Reconnect

| Step | Mock verified? | Hardware still proves |
|---|---|---|
| Disconnect during capture/privacy/analysis/save/open — no stale result resurrection | **Unit-tested** (late-capture-discard test) | Real disconnect timing under each phase |
| Reconnect does not reuse a terminal session | **Unit-tested** | Real device reconnect behavior |

## Thermal / Power

| Step | Mock verified? | Hardware still proves |
|---|---|---|
| Capture refuses at CRITICAL/EMERGENCY thermal | **Unit-tested** (`isThermallyBlocked`) | Real thermal ramp under sustained use |
| No retry storm on repeated thermal refusal | Reviewed in source | Real sustained-use behavior |

## Sign-Out / Revocation

| Step | Mock verified? | Hardware still proves |
|---|---|---|
| Sign-out revokes the K Scan wearable session | Contract-tested (webapp suite) | Real end-to-end confirmation |
| A new login does not resurrect the old session | Contract-tested | Real session-boundary behavior |

## Logs / Evidence to Capture

- `adb logcat` filtered to the app's process for the full session
- Screenshot or screen recording of each major state transition
- The exact commit SHA and `KSCAN_MWDAT_ENABLED` value used for the build
- Battery/thermal readings before and after, if the glasses expose them

## Token Hygiene Reminder

The GitHub Packages token is a **build-time only** credential. It resolves
DAT artifacts during compilation and is never referenced by the running app.
Confirm this before shipping any build used for this checklist: search the
built APK for `GITHUB_TOKEN`, `github_token`, and `maven.pkg.github.com` — see
`META_DAT_UNBLOCK_AND_VALIDATION_REPORT.md`'s Artifact Inspection section for
the exact method. A hit there is a P0.
