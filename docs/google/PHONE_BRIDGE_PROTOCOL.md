# K Scan Google XR — Phone Bridge Protocol v1

Status: **v1 locked** · Implemented in `android-xr/app/src/main/java/com/kscan/glasses/phonebridge/`
Supersedes the pre-versioned `bridge/` + `shared/bridge.schema.json` contract for the
Google XR glasses runtime (the legacy contract remains for the legacy mobile app path).

## 1. Authority model

The **phone is the authority**: auth, account, capture, scan lifecycle, backend calls,
results, session approval/revocation. The **glasses** own: pairing display, connection
status, scan trigger, processing display, result rendering, focus/D-pad, outbound
actions, and safe disconnect/recovery.

**Result-first guarantee:** no camera images, no base64 image payloads, and no raw
bytes ever cross this bridge. Payloads carry structured result data and opaque
references only (e.g. `captureRef`). A static contract test asserts that no serialized
frame contains `base64`, `data:image`, `Bearer`, or `token`.

## 2. Envelope

Every message is one JSON object with these fields on every frame:

| Field | Type | Rule |
|---|---|---|
| `messageType` | string | Wire discriminator, dot-namespaced by family (e.g. `pair.request`). |
| `protocolVersion` | int | Must be `1`. Unknown versions fail closed. |
| `requestId` | string | Non-blank on every frame. Correlates replies to glasses-initiated requests. |
| `sessionId` | string | Empty (`""`) **only** on `pair.request`. Everywhere else it must be the active session. |
| `deviceId` | string | **Sender's** device id. After pairing, non-pair frames must come from the paired peer. |
| `timestamp` | long | Sender wall-clock millis. |
| `expiresAt` | long? | Optional per-message expiry (millis). A frame past its `expiresAt` is stale. |
| `payload` | object | Family-specific body. Empty payloads serialize as `{}`. |

## 3. Limits and freshness

| Rule | Value | Rejection |
|---|---|---|
| Frame byte ceiling (UTF-8) | **65,536 bytes** (64 KiB) — checked before parsing | `PAYLOAD_TOO_LARGE` |
| Clock-skew tolerance | **30,000 ms** in either direction | `STALE_MESSAGE` |
| Message expiry | `expiresAt < now` | `STALE_MESSAGE` |
| Session expiry | `pair.approved.sessionExpiresAt < now` | `SESSION_EXPIRED` |

The 64 KiB ceiling sits well below the 100 KB product hard limit to leave headroom
for future envelope fields.

## 4. Message families (26 types)

- **pair.\*** — `pair.request` (glasses→phone; the only empty-session frame),
  `pair.approved` (grants `sessionId` + `sessionExpiresAt`), `pair.denied`,
  `pair.expired` (pairing timed out with no decision).
- **session.\*** — `session.ready` (completes the handshake; enables actions),
  `session.revoked` (kills the session), `session.error` (safe code + recoverable flag).
- **capture.\*** — `capture.request`, `capture.started`, `capture.completed`
  (opaque `captureRef`, never image data), `capture.failed` (`ScanErrorCode`).
- **scan.\*** — `scan.processing`, `scan.progress` (stage + percent),
  `scan.completed` (yields `resultId`), `scan.failed` (`ScanErrorCode`).
- **result.\*** — `result.show` (full structured result), `result.update`
  (revision-bumped replace; doubles as the save ack), `result.dismiss`.
- **action.\*** — `action.save`, `action.open_on_phone`, `action.retry`,
  `action.cancel` (glasses→phone; require `session.ready`).
- **connection.\*** — `connection.ping` / `connection.pong` (nonce echo),
  `connection.lost`, `connection.restored`.

### Result payload rules

- `confidence` must be within `0..1`.
- `thumbnailUrl` must be HTTPS, must not be a `data:` URI, and must not carry
  token-ish query params (`token`, `access_token`, `auth`, `signature`, `sig`,
  `jwt`, `key`, `api_key`, `session`, …).
- `scanStatus` is `COMPLETED` / `PARTIAL` / `FAILED`; failure details use
  `errorCode` (`ScanErrorCode`) — never free text.
- Glasses may only invoke actions listed in `availableActions`.

## 5. Session, correlation, and ordering rules

1. **Pairing** establishes the session: on `pair.approved` the validator records
   `sessionId`, the peer `deviceId`, and `sessionExpiresAt`.
2. **Device binding:** after pairing, every non-`pair.*` frame whose sender
   `deviceId` is not the paired peer is `WRONG_DEVICE`.
3. **Unknown session:** a non-pair frame naming any other `sessionId` is
   `SESSION_NOT_READY`.
4. **Readiness:** `action.*` frames require an accepted `session.ready` — before
   it they are `SESSION_NOT_READY`; after `session.revoked` they are
   `SESSION_REVOKED`; after session expiry they are `SESSION_EXPIRED`.
5. **Correlation:** replies to glasses-initiated requests (`pair.approved`,
   `pair.denied`, `pair.expired`, `capture.started`, `capture.completed`,
   `capture.failed`) must echo a currently pending `requestId` registered by
   `validateOutgoing`; otherwise `INVALID_MESSAGE`. Phone-initiated lifecycles
   (`session.*`, `scan.*`, `result.*`, `connection.*`) open their own requestIds.
6. **Ordering:** `scan.completed` / `scan.failed` require a prior
   `scan.processing` for that `scanId`; otherwise `INVALID_MESSAGE`.
7. **Duplicates:** repeated terminal events (`capture.completed/failed` per
   `captureId`, `scan.completed/failed` per `scanId`, `result.show` per
   `requestId + resultId`) are `DUPLICATE_EVENT`.

## 6. Rejection codes

Rejections carry a stable code only — never payload text, exception messages, or
frame bytes. Logs are code-only via `SafeLog`.

`UNSUPPORTED_PROTOCOL` · `INVALID_MESSAGE` · `MISSING_REQUEST_ID` ·
`SESSION_NOT_READY` · `SESSION_EXPIRED` · `SESSION_REVOKED` · `WRONG_DEVICE` ·
`STALE_MESSAGE` · `DUPLICATE_EVENT` · `PAYLOAD_TOO_LARGE` ·
`UNSUPPORTED_MESSAGE_TYPE` · `BRIDGE_UNAVAILABLE` · `CONNECTION_LOST`

Validator probe order: byte ceiling → JSON structure → `messageType` →
`protocolVersion` → `requestId` → `sessionId` presence → typed decode →
semantic checks → payload checks. First violation wins.

## 7. Transport and codec

- `PhoneBridgeTransport` carries **raw string frames** (`incoming: Flow<String>`,
  `send(raw)`, `close()`) so malformed/oversized frames reach the validator
  instead of dying in a decoder. `InMemoryTransportPair` provides loopback
  endpoints for the mock companion and tests.
- `PhoneBridgeCodec` uses kotlinx.serialization with
  `classDiscriminator = "messageType"`, `ignoreUnknownKeys = false` (unknown
  fields are contract violations), and `encodeDefaults = true` (stable wire
  shape). `encode` enforces the 64 KiB ceiling; the mock may bypass it solely to
  exercise the `PAYLOAD_TOO_LARGE` path.

## 8. Legacy → v1 mapping

| Legacy (`shared/bridge.schema.json`) | v1 |
|---|---|
| `HELLO` | `pair.request` + `connection.ping` handshake |
| `DEVICE_STATE` | `connection.ping` / `connection.pong` liveness |
| `REQUEST_PERMISSIONS` | folded into pairing approval (`pair.request` / `pair.approved`) |
| `PERMISSIONS_RESULT` | `pair.approved` / `pair.denied` |
| `CAPTURE_PHOTO` | `capture.request` |
| `PHOTO_CAPTURED` | `capture.completed` — minus any image reference; opaque `captureRef` only |
| `ANALYSIS_STARTED` | `scan.processing` |
| `ANALYSIS_RESULT` | `scan.completed` + `result.show` |
| `SAVE_ITEM` | `action.save` (ack = `result.update` with revision bump) |
| `OPEN_ON_PHONE` | `action.open_on_phone` |
| `AUTH_SESSION` | `session.ready` |
| `ERROR` | `session.error` / `scan.failed` / `capture.failed` with safe codes |

## 9. Mock companion

`phonebridge/mock/MockPhoneCompanion` is deterministic (injected clock,
sequential ids) and covers: happy path, pairing denied, pairing expiry, link
loss mid-scan, restore, `scan.failed(BACKEND_UNAVAILABLE)`, oversized result
frames, duplicate scan completion, stale timestamps, wrong-device frames, and
post-revoke action rejection. It exists so the glasses runtime can be developed
and tested without a real phone build.
