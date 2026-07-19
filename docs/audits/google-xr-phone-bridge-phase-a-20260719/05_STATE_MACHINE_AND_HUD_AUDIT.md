# 05 — State Machine and HUD Audit

## Authoritative owner

`ConnectedRuntimeStateMachine` is the sole mutator of `ConnectedState`. The ViewModel only feeds `ConnectedInput` and renders `ConnectedUiState`.

## States (12)

`DISCONNECTED`, `PAIRING`, `CONNECTED`, `READY`, `CAPTURE_REQUESTED`, `CAPTURING_ON_PHONE`, `PRIVACY_PROCESSING`, `ANALYZING`, `RESULTS`, `ACTION_CONFIRMED`, `ERROR`, `RECONNECTING`

## Critical transition rules verified

| Rule | Behavior |
|---|---|
| Pair approve only in PAIRING | Else ignored |
| Session ready only from CONNECTED | Else ignored |
| Scan completion requires matching `scanId` + analyzing states | Stale ignored |
| Result show can land mid-pipeline or refresh RESULTS | No duplicate card |
| Result update + pending action → ACTION_CONFIRMED | Unsolicited update refreshes RESULTS only |
| Session revoked from any non-DISCONNECTED | → DISCONNECTED, context cleared |
| Connection lost | → RECONNECTING; restore returns prior state |
| Save/Open require RESULTS | Effects emitted; confirm waits for ack |
| Illegal inputs | Silent ignore (safe; no crash) |

## HUD

- True-black root preserved via existing theme/screens.
- Metadata supplies title, supporting copy, ≤3 actions, default focus.
- Progress percent shown for analyzing states.
- Provider status badge distinguishes DISABLED / UNAVAILABLE / ACTIVE / mock.

## Input

| Key | Mapping |
|---|---|
| D-pad / Select | FocusNavigator |
| Back / Escape | Connected cancel/back paths |
| KEYCODE_C | Capture/scan shortcut path (connected: scan when READY) |

Overlapping scans blocked by state gates (ScanTapped ignored outside READY).
