# Mobile App Bridge Architecture and Contracts

## Philosophy

The projected glasses app is a **lightweight companion surface**, not a standalone replacement for the main K Scan mobile app.

- The **main mobile app** remains the source of truth for:
  - Authentication and session management
  - Closet / Dressing Rooms
  - Full scan results with rich UI
  - Account, settings, and privacy controls
- The **glasses app** provides:
  - Quick capture and scan initiation
  - Lightweight HUD results
  - Voice-activated shortcuts
  - Save/open-on-phone handoff actions

## Current authority (Google XR Phase A)

The versioned phone bridge lives under:

```text
android-xr/app/src/main/java/com/kscan/glasses/phonebridge/
```

See [`docs/google/PHONE_BRIDGE_PROTOCOL.md`](google/PHONE_BRIDGE_PROTOCOL.md) for the
locked v1 envelope, 26 message types, validation rules, and mock companion notes.

The pre-versioned `mobilebridge/` package has been removed. Do not reintroduce it.

Legacy mobile-app path schemas under `shared/bridge.schema.json` and the TypeScript
`phone-bridge/` package remain Phase-1 baseline artifacts; they are **not** the
Google XR Phase A Kotlin protocol.

## Handoff Model (historical Phase 2 notes)

Phase 2 planning used **Android intents and deep links** as a transport sketch.
The active Google XR connected runtime uses the versioned JSON phone bridge above;
deep-link handoff remains a future mobile-companion concern.

## Deep Link Placeholder Contract

The following schemes are placeholders for future integration with the main mobile app. The main mobile app does not yet handle these URLs.

```text
kscan://glasses/handoff/result/{resultId}
kscan://glasses/handoff/save/{itemId}
kscan://glasses/handoff/open/{resultId}
kscan://glasses/session/request
```

### Routes

- `handoff/result/{resultId}` — glasses requests the phone to display a full result
- `handoff/save/{itemId}` — glasses requests the phone to save an item to the user's Closet
- `handoff/open/{resultId}` — glasses requests the phone to open a detailed view
- `session/request` — glasses requests the phone to share current session state

## Privacy and Safety

- No real tokens in bridge messages
- Session identifiers are opaque refs only
- No raw image bytes or base64 in bridge messages
- Release builds cannot select the mock phone companion

## Future Work

- Real Android phone companion implementing `PhoneBridgeTransport` + protocol v1
- BLE/Wi-Fi/socket transport with read-side 64 KiB frame cap before UTF-8 assembly
- Production session issuance (pairing approval from the signed-in mobile app)
