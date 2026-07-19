# 04 — Protocol and Security Audit

## Protocol v1

- 26 sealed subtypes / 7 families
- Discriminator: `messageType`
- Version: `1` only (`UNSUPPORTED_PROTOCOL` otherwise)
- Ceiling: **65,536 UTF-8 bytes** inbound (before typed parse) and outbound encode
- Skew: ±30s; message `expiresAt` past → `STALE_MESSAGE`
- Session grant: `timestamp < sessionExpiresAt ≤ timestamp + 24h` (post-repair)

## Validation order

1. Byte ceiling → `PAYLOAD_TOO_LARGE`
2. JSON object structure
3. `messageType` known
4. `protocolVersion`
5. `requestId` non-blank
6. `sessionId` present (string)
7. Typed decode
8. Semantics (freshness, pair-hijack guards, device, session, duplicates, correlation, ordering)
9. Payload safety (confidence, thumbnail URL)

## Session security (post-repair)

- Active non-revoked session blocks further `pair.approved/denied/expired` (`INVALID_MESSAGE`).
- Re-pair allowed only after `session.revoked`.
- Wrong-device enforced for non-pair frames.
- Revoked session rejects subsequent session-bearing traffic (`SESSION_REVOKED`), including `connection.restored`.
- `connection.restored` cannot revive a revoked/expired session without a new pair grant.

## Result / action integrity (post-repair)

- `result.update` requires prior known `resultId` from `result.show`.
- Duplicate `resultId:revision` → `DUPLICATE_EVENT`.
- HUD `ACTION_CONFIRMED` only when `pendingAction != null` and `ResultUpdated` arrives.
- Ack watchdog (3s) surfaces `ACTION_TIMEOUT` — never synthesizes success.

## Image / credential boundary

- No Bitmap/base64/data-URI image transport on the bridge.
- `captureRef` opaque; thumbnail must be `https://` without token-ish query params.
- Contract test asserts encoded frames lack `base64` / `data:image` / `bearer` / `token`.
- Logs: `SafeLog` only; reject logs are code-name only.

## Mock / release seam

- Mock selected only when `DEBUG && KSCAN_DEBUG_MOCK_PHONE_BRIDGE`.
- Release BuildConfig forces mock phone-bridge flag **false**.
- Instance-level guard rejects `MockPhoneBridgeProvider` in release.
- Debug `MockScenarioReceiver` exported for adb; double-gated; absent from release (lint ExportedReceiver = accepted debug P3).

## Transport implementer contract

Real transports must abort before assembling frames larger than 64 KiB. Documented on `PhoneBridgeTransport` and in `PHONE_BRIDGE_PROTOCOL.md`.
