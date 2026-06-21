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

## Handoff Model (Phase 2)

Phase 2 uses **Android intents and deep links** as the transport layer. No custom BLE or Wi-Fi transport is implemented in this phase.

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

## Message Contracts

See Kotlin source under `mobilebridge/` for compile-safe message shapes.

- `MobileAppBridge` — interface for all bridge operations
- `MobileAppBridgeMessage` — sealed message hierarchy
- `MobileAppHandoffResult` — result payload for handoff actions
- `MobileAppRoute` — validated route enum
- `SessionSnapshot` — lightweight session state snapshot
- `MockMobileAppBridge` — in-memory mock implementation for tests

## Privacy and Safety

- No real tokens in bridge messages
- Session identifiers are placeholder refs only
- No dependency on the main mobile app repo
- All implementations are compile-safe and mock-ready
- No raw image bytes or base64 in bridge messages by default

## Future Work

- Real deep-link handling in the main mobile app (see `docs/MAIN_APP_HANDOFF_TODO.md`)
- Optional Bluetooth/Wi-Fi transport (Phase 3+ only)
- Session token negotiation via Supabase (Phase 3+ only)
