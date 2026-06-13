# Bridge Contract — K Scan Google Glasses

## Provider interface (Kotlin)

`GlassesBridgeProvider` is the shared abstraction across Google, Mock, and future Meta implementations.

### Photo capture

```kotlin
suspend fun capturePhoto(): CaptureResult
```

```kotlin
data class CaptureResult(
    val base64: String,
    val mimeType: String,
    val source: CaptureSource // glasses | phone | mock
)
```

### Optional preview

```kotlin
suspend fun startPreview(): BridgeResult<Unit>  // optional
suspend fun stopPreview(): BridgeResult<Unit>   // optional
```

### Device & permissions

```kotlin
suspend fun getDeviceState(): DeviceState
suspend fun requestPermissions(): PermissionState
```

### Phone integration

```kotlin
suspend fun sendToPhone(message: BridgeMessage): BridgeResult<Unit>
suspend fun openOnPhone(deepLinkOrUrl: String): BridgeResult<Unit>
```

### Feedback

```kotlin
suspend fun vibrateOrHaptic(pattern: HapticPattern = HapticPattern.LIGHT): BridgeResult<Unit>  // optional
suspend fun speak(text: String): BridgeResult<Unit>
```

## Bridge message types

Schema: `shared/bridge.schema.json`

| Type | Direction | Purpose |
|------|-----------|---------|
| `HELLO` | bidirectional | Session handshake, client version |
| `DEVICE_STATE` | glasses → phone | Capabilities, battery, connection |
| `REQUEST_PERMISSIONS` | glasses → phone | Delegate permission UI to phone |
| `PERMISSIONS_RESULT` | phone → glasses | Grant/deny summary |
| `CAPTURE_PHOTO` | glasses → phone | Request phone camera capture |
| `PHOTO_CAPTURED` | phone → glasses | Photo ready (ref or inline dev payload) |
| `PHOTO_ERROR` | either | Capture failure |
| `ANALYSIS_STARTED` | glasses → phone | Scan in progress |
| `ANALYSIS_RESULT` | glasses → phone | Top products + summary |
| `SAVE_ITEM` | glasses → phone | Persist to library on phone |
| `OPEN_ON_PHONE` | glasses → phone | Open product URL |
| `AUTH_SESSION` | phone → glasses | Relay Supabase session (no logging) |
| `ERROR` | either | Structured error |

All messages include: `type`, `timestamp`, `sessionId`, optional `requestId`, `payload`.

## Lifecycle

1. Phone bridge `start()` → emit `HELLO`
2. Glasses app boot → `getDeviceState()` → emit `DEVICE_STATE`
3. Optional `sendAuthSession()` from phone → `AUTH_SESSION`
4. Scan flow → capture → analyze → `ANALYSIS_RESULT`
5. User actions → `SAVE_ITEM`, `OPEN_ON_PHONE`
6. `stop()` → tear down listeners (Bluetooth / Supabase / Wi-Fi sessions)

## Error codes

| Code | Meaning | Recoverable |
|------|---------|-------------|
| `BRIDGE_NOT_CONNECTED` | No phone / relay session | yes |
| `PERMISSION_DENIED` | Camera/mic denied | yes |
| `CAPTURE_FAILED` | Photo capture error | yes |
| `SANITIZER_BLOCKED` | Privacy pipeline blocked upload | yes |
| `ANALYZE_FAILED` | Backend or network error | yes |
| `UNSUPPORTED_CAPABILITY` | Hardware feature missing | yes |
| `INTERNAL_ERROR` | Unexpected failure | maybe |

## Pairing / session assumptions

- **Alpha:** mock session ID generated at app start; no cryptographic pairing yet
- **Phone-hosted projection:** glasses app assumes companion phone is signed into K Scan
- **Auth:** Supabase session relayed once per session; tokens never logged
- **Wi-Fi transfer:** optional parallel session for large images; falls back to compressed bridge payload
- **Bluetooth:** control lane for low-bandwidth messages when Wi-Fi unavailable

## Future MetaBridgeProvider

Must implement the same `GlassesBridgeProvider` interface and emit identical `BridgeMessage` types so phone-bridge code remains OEM-agnostic.
