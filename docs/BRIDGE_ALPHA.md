# K Scan ↔ Meta Glasses Bridge — Alpha (Phase 16)

## Purpose

This phase moves the glasses bridge from planning/prototype into an **alpha
implementation inside the real K Scan mobile app**. It establishes the
app-level bridge that will eventually connect K Scan to Meta glasses capture,
while keeping the (still-unknown) Meta DAT/Bluetooth transports cleanly behind
adapter interfaces.

> **Bluetooth/Wi-Fi transport in this repo is not a verified Meta glasses
> transport. It is a K Scan development bridge foundation. Production Meta DAT
> transport remains blocked until official dependency/API evidence is
> available.**

## Branch

All work lands on `feature/glasses-bridge-alpha`. This branch is **not merged**
and **not committed** as part of this phase.

## What was built

App-side bridge modules under `services/bridge/`:

| File | Role |
| --- | --- |
| `bridgeTypes.ts` | App-level message contract + type guards |
| `validateBridgePayload.ts` | JPEG data-URL payload validation |
| `CaptureRequestQueue.ts` | Single-active-request lifecycle + timeout |
| `BridgeService.ts` | Orchestrator: transport + queue + provider + state |
| `BridgeTransport.ts` | Transport interface |
| `WifiDevTransport.ts` | Dev WebSocket client (RN `WebSocket` global) |
| `MockLoopbackTransport.ts` | In-memory transport for tests/UI |
| `DatTransportAdapter.ts` | Blocked DAT adapter stub |
| `BluetoothTransportAdapter.ts` | Blocked Bluetooth adapter stub |
| `BridgePermissionStatus.ts` | Query-only permission status |
| `devCaptureProvider.ts` | Safe dev-only 1×1 JPEG fixture provider |
| `bridgeFixtures.ts` | Payload test fixtures |
| `bridgeDebugGate.ts` | Production gate helper |

Debug screen: `app/debug/bridge.tsx` (Expo Router route `/debug/bridge`).

Node-only dev tooling under `scripts/`:

- `scripts/bridge-dev-server.js`
- `scripts/simulate-glasses-client.js`

Tests under `__tests__/`:

- `bridgePayloadValidation.test.js`
- `bridgeCaptureQueue.test.js`
- `bridgeService.test.js`
- `bridgeAdapters.test.js`

## Architecture

```txt
Mobile Bridge Debug Screen  (app/debug/bridge.tsx, dev-gated)
   ↓
BridgeService               (services/bridge/BridgeService.ts)
   ↓
CaptureRequestQueue         (single active request, requestId-matched)
   ↓
Transport (BridgeTransport interface)
   ├── WifiDevTransport          implemented now  (WebSocket client)
   ├── MockLoopbackTransport     implemented now  (in-memory)
   ├── DatTransportAdapter       interface + BLOCKED stub
   └── BluetoothTransportAdapter interface + BLOCKED stub
   ↓
devCaptureProvider          implemented now, mock only (1×1 JPEG fixture)
```

## Bridge message contract

This is the **K Scan app-level** contract, not a verified Meta platform
contract. The native Meta DAT handoff contract remains UNKNOWN; no Meta bridge
object names are verified or used.

**Glasses/web → mobile**

- `capture.request` — `{ type, requestId, source: 'glasses-web', createdAt, timeoutMs? }`

**Mobile → glasses/web**

- `capture.success` — `{ type, requestId, image, mime: 'image/jpeg', encoding: 'data-url', createdAt }`
- `capture.error` — `{ type, requestId, code, message, createdAt }`

**Error codes:** `BRIDGE_UNAVAILABLE`, `PERMISSION_DENIED`, `CAPTURE_CANCELLED`,
`CAPTURE_TIMEOUT`, `CAPTURE_ALREADY_PENDING`, `INVALID_CAPTURE_RESPONSE`,
`DAT_NOT_CONFIGURED`, `BLUETOOTH_NOT_CONFIGURED`, `NATIVE_CAPTURE_FAILED`,
`HANDOFF_FAILED` (transfer of a captured image to the bridge consumer failed).

### Message size

No maximum payload size is defined in this phase. Future phases must account for
WebSocket frame limits, Bluetooth MTU/chunking, Meta DAT payload limits, and
compression/chunking. **Chunking is intentionally not implemented here.**

## Payload validation

`validateBridgePayload(payload)`:

- requires a string; trims whitespace;
- requires the exact, case-sensitive prefix `data:image/jpeg;base64,`;
- requires a non-empty payload after the comma;
- returns the normalized string when valid;
- throws `InvalidCapturePayloadError` (code `INVALID_CAPTURE_RESPONSE`) otherwise;
- never logs the raw payload and never embeds it in error messages.

PNG/HEIC/HEIF/blob/remote-URL/raw-base64 payloads are rejected. A
**syntactically valid JPEG data URL with malformed image bytes passes this
syntax check by design** — it may fail later in a downstream image
decode/sanitizer stage (there is an explicit test for this).

## Capture request queue

- One active capture at a time; a second `createRequest` while pending throws
  `CAPTURE_ALREADY_PENDING`.
- Each request has a generated `requestId`; responses are matched by
  `requestId`, never by arrival order. Mismatched IDs are ignored safely.
- Caller-provided timeout (default 10s) rejects with `CAPTURE_TIMEOUT`.
- Timers are always cleared on resolve/reject/timeout/reset.
- `getSnapshot()` returns metadata only: `state`, `activeRequestId`,
  `createdAt`, `timeoutMs`, `lastErrorCode`, `lastEvent`. **No image payload.**

## Bridge service

Orchestrates transport, queue, dev capture provider, permission status, bridge
state, and UI subscribers. States: `idle` → `starting` → `ready` →
`capturePending` → (`ready` | `error`), plus `stopped`.

Methods: `startDevBridge`, `stopBridge`, `resetBridge`,
`simulateGlassesCaptureRequest`, `handleIncomingMessage`, `sendMessage`,
`getStatus`, `subscribe`, `setTransport`, `refreshPermissions`.

On an incoming `capture.request`, the service runs the **dev capture provider**
(this phase), validates the result, and replies `capture.success` /
`capture.error`. It never uploads to a backend, never writes images to disk,
and never logs image payloads. The status object carries metadata only.

## Wi-Fi / WebSocket dev transport

`WifiDevTransport` is a dev-only WebSocket **client** using React Native's
built-in `WebSocket` global (default URL `ws://localhost:8787`, configurable).
It parses JSON safely, drops invalid/non-bridge frames, and logs only message
type + requestId + status — never payload data. It does **not** import Node
`ws` or any Node-only API, so it is safe for Metro to bundle.

## Local bridge server / client commands

```bash
# Terminal A — start the dev bridge server (default port 8787)
npm run bridge:server
# modes: BRIDGE_DEV_MODE=success | dat-blocked | invalid-payload

# Terminal B — run the mock glasses client
npm run bridge:client
```

Both are Node-only tools under `scripts/` and use the `ws` devDependency
(server) / Node's built-in `WebSocket` (client). They never use real photos,
never upload, and never write image data to disk. Logs are restricted to
message type, requestId, status, and error code.

### Relay mode (Phase 17)

`BRIDGE_DEV_MODE=relay` turns the dev server into a message **relay** so the
glasses web app (Phase 17 mobile bridge client) and a mobile peer can talk
end-to-end without glasses hardware:

```bash
# Terminal A — relay server
$env:BRIDGE_DEV_MODE="relay"; npm run bridge:server   # PowerShell
# BRIDGE_DEV_MODE=relay npm run bridge:server          # bash

# Terminal B — mobile peer (responds with the safe dev JPEG fixture)
npm run bridge:mobile
```

Relay behavior:

- Tracks the set of connected clients.
- On `capture.request`, broadcasts to all **non-sender** peers.
- The **first** matching `capture.success` / `capture.error` is forwarded back
  to the original requester; later duplicates are dropped (safe log only).
- If no non-sender peer is connected → immediate `capture.error`
  `BRIDGE_UNAVAILABLE`.
- If no peer responds within `BRIDGE_RELAY_TIMEOUT_MS` (default 10s) →
  `capture.error` `CAPTURE_TIMEOUT`.
- If the requester disconnects, its in-flight relayed requests are cleared.
- Logs only type / requestId / status / code — never payloads.

`scripts/simulate-mobile-client.js` (`npm run bridge:mobile`) is the mobile
peer: it connects to the relay, waits for `capture.request`, and replies
`capture.success` with the **same** deterministic 1×1 JPEG dev fixture used by
`devCaptureProvider.ts` (no new fixture is created). It never logs payloads,
never uploads, and never writes image data to disk.

The other modes (`success`, `dat-blocked`, `invalid-payload`) remain
self-contained as before.

## Debug screen usage & production gating

Route: `/debug/bridge` (Expo Router). It shows bridge state, active transport,
Wi-Fi/DAT/Bluetooth status, permission statuses, active requestId, last message
type, last error code, and `updatedAt`, with buttons: **Start Dev Bridge**,
**Stop Bridge**, **Simulate Glasses Capture**, **Refresh Permissions**,
**Reset Bridge**.

**Production gating:** `bridgeDebugGate.isBridgeDebugEnabled()` returns true only
when `__DEV__` is true, or when `EXPO_PUBLIC_ENABLE_BRIDGE_DEBUG=true` is set for
a deliberate internal/debug build. When the gate is closed, the screen renders
`<Redirect href="/" />` and exposes nothing. The screen is **not linked from any
production navigation**; open it in a dev build by navigating to `/debug/bridge`
(or the `kscan://debug/bridge` deep link).

The screen never renders image payloads or raw base64 and never uploads.

## DAT adapter status

**BLOCKED.** `DatTransportAdapter` implements the transport interface but every
operation reports `DAT_NOT_CONFIGURED`. Official Meta Android DAT SDK
coordinate, API surface, result types, and permission model are required before
this can be implemented. No DAT method names are invented; no fake SDK is
imported.

## Bluetooth adapter status

**BLOCKED.** `BluetoothTransportAdapter` reports `BLUETOOTH_NOT_CONFIGURED`.
Generic Bluetooth is not implemented; Meta glasses Bluetooth
service/characteristic details are UNKNOWN and no UUIDs are invented. There is
no verified evidence that generic Bluetooth can talk to Meta glasses.

## Permission status behavior

`getBridgePermissionStatus(platformOS?)` is **query-only** — it never requests
permissions and never triggers prompts (the "Refresh Permissions" button only
reads current state). For this phase:

- `datPermission`: `not-configured`
- `bluetoothPermission`: `not-configured`
- `localNetworkPermission`: `not-required` on Android (INTERNET already
  declared), `unknown` on iOS / unknown platforms
- `microphonePermission`: `not-required`

No new native permissions were added. The Wi-Fi dev transport does not require
Bluetooth permissions.

## Safe mock capture provider

`devCaptureProvider` returns a hardcoded, deterministic **1×1 pixel JPEG data
URL** (~330 bytes). It is dev-only: no real photos, no phone camera, no DAT, no
backend upload, no file writes.

## Privacy rules (enforced)

- Never log raw or partial base64, byte length, dimensions, EXIF, or any
  image-derived metadata.
- Never persist images to disk; never upload images to a backend (no backend
  upload function exists in this phase).
- Snapshots and status objects contain metadata only.
- The phone camera is never used as a substitute for glasses DAT capture.

## Dependency notes

- Added `ws` as a **devDependency only** (used solely by
  `scripts/bridge-dev-server.js`). It is not imported by any app-side / Metro-
  bundled code.
- The app-side Wi-Fi transport and the mock glasses client use the built-in
  `WebSocket` global, not `ws`.
- No Socket.IO/SocketCluster, no native Bluetooth libraries, no new Expo native
  plugins were added.
- Tests run on the existing Node built-in test runner (`node --test`), the same
  runner already used by the repo. No second test framework was introduced.

## Relationship to the glasses web app

The glasses web app (`C:\Users\jsmit\kscan-glasses-webapp`,
`src/datBridge.js`) was read **read-only** for compatibility:

- It enforces the same capture payload prefix `data:image/jpeg;base64,` and
  rejects non-conforming payloads as `INVALID_CAPTURE_RESPONSE`.
- It defines `CAPTURE_TIMEOUT_MS = 10000` (matches our 10s queue default).
- It enforces one active capture at a time (`pendingCapture`, error
  `CAPTURE_IN_PROGRESS`; our app-level equivalent is `CAPTURE_ALREADY_PENDING`).
- Shared error codes include `BRIDGE_UNAVAILABLE`, `CAPTURE_TIMEOUT`,
  `PERMISSION_DENIED`, `CAPTURE_CANCELLED`, `INVALID_CAPTURE_RESPONSE`.
- It matches responses by `requestId` and uses its own adapter detection
  (`postMessage` / `webkit`) whose native handoff contract remains UNKNOWN —
  consistent with this phase keeping the native transport behind adapters.

The web app repo was **not modified**.

## Relationship to the Android DAT spike

The Android DAT spike (`C:\Users\jsmit\kscan-android-dat-spike`) confirms
official Android DAT capture remains blocked pending the Meta SDK
coordinate/API/result type/permissions. This phase reflects that by keeping
`DatTransportAdapter` blocked. The spike repo was **not modified**.

## Known blockers

- Official Meta Android DAT SDK coordinate / API / result type / permission
  model — required to implement `DatTransportAdapter`.
- Native-to-web (and native-to-app) handoff contract — UNKNOWN.
- Meta glasses Bluetooth service/characteristic details — UNKNOWN.

## Next steps

- When official Meta DAT evidence arrives, implement `DatTransportAdapter`
  behind the existing interface; no contract changes should be required.
- Add payload chunking/size handling for real transports.
- For end-to-end testing, the glasses web app will later need a dev-mode bridge
  endpoint, e.g. a query param or env var `?bridge=ws://<host>:8787`. **That web
  app change is not part of this phase.**

---

## Architecture Decision Record: Alpha Bridge Transport

**Decision.** Implement a Wi-Fi/WebSocket transport (`WifiDevTransport` +
`scripts/bridge-dev-server.js`) as the alpha dev transport, with an in-memory
`MockLoopbackTransport` for tests and offline UI.

**Reason.** It is fully testable today without glasses hardware, exercises the
real `BridgeService` → `CaptureRequestQueue` → transport → capture-provider
flow, and makes no claim to be Meta's production transport.

**Consequence.** Production DAT/Bluetooth transports remain behind adapter
interfaces (`DatTransportAdapter`, `BluetoothTransportAdapter`) in a blocked
state until official Meta SDK/API evidence is available. The bridge is
structurally ready for them without contract changes.

**Rejected alternatives.**

- Guessed Bluetooth UUIDs / services / characteristics.
- A fake DAT SDK or fake SDK imports.
- Using the Android phone camera as a substitute for glasses DAT capture.
- Unsanitized backend upload of captured images.
- Direct modification of the glasses web app in this phase.
- Exposing the debug bridge UI in production builds.
