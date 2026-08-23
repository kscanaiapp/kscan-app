# Meta DAT — API Signature Authority

Status date: 2026-08-23
Adapter under audit: `modules/kscan-meta-wearable/android/src/mwdat/java/com/kscan/metawearable/dat/DatEngine.kt`
Declared SDK version: `kscan.mwdat.version` default `0.9.0`
Registry: `https://maven.pkg.github.com/facebook/meta-wearables-dat-android`

## Why nothing here is CONFIRMED yet

Every symbol below is referenced by source that **has never been compiled against
the real SDK**, because the artifacts cannot be resolved from this environment.
That is not a guess about the blocker — it was measured:

| Probe | Result |
|---|---|
| `GET …/com/meta/wearable/mwdat-core/0.9.0/mwdat-core-0.9.0.pom`, no credential | `401` |
| Same URL, authenticated as `kscanaiapp` with the current token | `401` |
| Current token scopes | `gist, read:org, repo, workflow` — **no `read:packages`** |
| `GET /user/packages?package_type=maven` | `"You need at least read:packages scope to list packages."` |
| `GET /repos/facebook/meta-wearables-dat-android` | `200`, **`visibility=public`** |
| Control: `GET /user` | `200` (`kscanaiapp`) — the token itself is healthy |

The upstream repository is **public**, so no Meta-side entitlement, allowlist or
partner approval is implicated. GitHub Packages simply requires an authenticated
Maven request even for public packages, and this token cannot make one.

**The entire blocker is one scope on one token** (issue #191):

```
gh auth refresh -h github.com -s read:packages
```

That command needs an interactive browser and so cannot be run from an
unattended session. Until it is run, `kscan.mwdat.enabled=true` fails at
dependency resolution and every row below stays unverified.

## Evidence classification

| Class | Meaning |
|---|---|
| `CONFIRMED — COMPILED` | The adapter compiled against the real artifact. |
| `RUNTIME VERIFIED` | Exercised at runtime against MockDeviceKit or hardware. |
| `DOCUMENTED ONLY` | Taken from Meta documentation; not executed. |
| `NOT VERIFIED` | Assumed by our source; nothing has checked it. |

Nothing may be promoted by inference. Compiling does not make a member
`RUNTIME VERIFIED`; MockDeviceKit does not make it hardware-verified.

## Assumed surface

### Core — `com.meta.wearable.dat.core`

| Symbol | Assumed shape | Status |
|---|---|---|
| `Wearables.initialize(...)` | Process-level init | NOT VERIFIED |
| `Wearables.devices` | Observable collection; `.value.firstOrNull()`, `.collect {}` | NOT VERIFIED |
| `Wearables.getDeviceState(id)` | Returns a state holder with `.value` | NOT VERIFIED |
| `Wearables.checkPermissionStatus(...)` | Permission query | NOT VERIFIED |
| `Wearables.startRegistration(...)` | Begins device registration | NOT VERIFIED |
| `Wearables.registrationState` | `.value.name`, `.collect {}` | NOT VERIFIED |
| `Wearables.registrationErrorStream` | `.collect {}` | NOT VERIFIED |
| `Wearables.createSession(...)` | Returns `DeviceSession` | NOT VERIFIED |
| `AutoDeviceSelector` | Default device selector | NOT VERIFIED |

### Session — `com.meta.wearable.dat.core.session`

| Symbol | Assumed shape | Status |
|---|---|---|
| `DeviceSession` | Has `.state` flow; `first {}` awaitable | NOT VERIFIED |
| `DeviceSessionState` | `STARTED`, `STOPPING`, `STOPPED` | NOT VERIFIED |
| `DeviceSessionError` | `BATTERY_CRITICAL`, `PEAK_POWER_SHUTDOWN`, `THERMAL_CRITICAL`, `DAT_APP_ON_THE_GLASSES_UPDATE_REQUIRED` | NOT VERIFIED |
| `ThermalLevel` | `CRITICAL`, `EMERGENCY`; reachable as `deviceState.thermalLevel` | NOT VERIFIED |

### Camera — `com.meta.wearable.dat.camera`

| Symbol | Assumed shape | Status |
|---|---|---|
| `Camera` | Attached to a started session | NOT VERIFIED |
| `CameraState` | `STARTED`, `STOPPED` | NOT VERIFIED |
| `PhotoData` | **`photo.bytes` yields JPEG `ByteArray`** | NOT VERIFIED — highest risk, see below |

### Display — `com.meta.wearable.dat.display`

| Symbol | Assumed shape | Status |
|---|---|---|
| `Display` | Nullable capability handle; `clearDisplay()` | NOT VERIFIED |

### MockDeviceKit — `com.meta.wearable.dat.mockdevice`

| Symbol | Assumed shape | Status |
|---|---|---|
| `MockDeviceKit.enable/disable/isEnabled` | Global toggle | NOT VERIFIED |
| `MockDeviceKit.glasses` | Mock device handle | NOT VERIFIED |
| `MockDeviceKit.pairGlasses(...)` | Pairs a mock device | NOT VERIFIED |
| `MockDeviceKitConfig` | Configuration holder | NOT VERIFIED |

## PhotoData is the single highest-risk assumption

`DatEngine.kt` reduces the whole uncertainty to one line:

```kotlin
private fun photoBytes(photo: PhotoData): ByteArray = photo.bytes
```

That is deliberate and good: if `PhotoData` turns out to expose a
`ByteBuffer`, a file handle, a `suspend` accessor, a reference-counted buffer
with a bounded lifetime, or bytes that are not JPEG, **only this function
changes**. Everything downstream — dimension decode, private-file write,
privacy detection, masking, upload — consumes a plain `ByteArray`.

When #191 clears, verify and record: byte representation, image format,
dimensions, nullability, buffer lifetime/ownership, and which thread the
accessor may be called on.

## Reflection boundary — reviewed, KEEP

There is exactly one reflective call in the module:

```kotlin
// MetaWearableEngine.kt:220
Class.forName("com.kscan.metawearable.dat.DatEngine")
  .getDeclaredField("INSTANCE").get(null) as MetaWearableEngine
```

It is **not** a DAT API call. It is the bridge between Gradle source sets:
`src/mwdat` is only added to the compilation when `kscan.mwdat.enabled=true`, so
the always-compiled `src/main` cannot hold a static reference to `DatEngine`
without breaking every flag-off build.

Every actual DAT call inside `DatEngine` is already **typed** — direct
`com.meta.wearable.dat.*` imports, not reflective lookups. So the "replace
reflection with typed APIs once signatures are known" task has no work in it:
the typed form already exists, and the one remaining reflective hop is exactly
the optional-isolation case that must be kept.

## Verification checklist for when #191 clears

1. `gh auth refresh -h github.com -s read:packages`, then confirm the `.pom` fetch returns `200`.
2. Record the actual resolved artifact names, versions and dependency graph — do not assume `mwdat-core` / `mwdat-camera` / `mwdat-display` / `mwdat-mockdevice` or `0.9.0` are current.
3. Build in order: dependency resolution → `mwdat` source-set compile → native module compile → full DAT-enabled app build. A flag-off build proves none of this.
4. Promote each row above from `NOT VERIFIED` to `CONFIRMED — COMPILED`, and correct any that the compiler contradicts.
5. Run a real DAT-shaped capture through the privacy pipeline and settle `PhotoData`.
6. Exercise MockDeviceKit: discovery, session lifecycle, camera capability, capture, disconnect, reconnect, capability change — and display where mockable.
7. Keep `MOCKDEVICEKIT VERIFIED` and `PHYSICAL META HARDWARE VERIFIED` as separate claims.
