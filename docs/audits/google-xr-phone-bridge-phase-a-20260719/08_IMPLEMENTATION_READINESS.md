# 08 — Implementation Readiness

## Branch / HEAD

- Branch: `feature/google-xr-phone-bridge-phase-a`
- Builder start HEAD: `9996d0637267caf93d63b65eedd514878f269370`
- Final HEAD: recorded in `99_FINAL_HANDOFF.md` after push
- Integration target (do not merge in this task): `feature/glasses-xr-native-standalone` @ `d293449` (merge-base)

## Transport seam

| Layer | Status |
|---|---|
| `PhoneBridgeTransport` | Stable raw-frame interface + read-cap contract |
| `PhoneBridgeCodec` / `PhoneBridgeMessage` | v1 locked |
| `PhoneBridgeValidator` | Fail-closed, session-hardened |
| `PhoneBridgeProvider` | Mock / FutureReal / Disabled |
| State machine + HUD | Provider-agnostic |

Real companion replaces **transport + provider send path only** — not validator/state/HUD.

## Real-companion requirements

Implementors must provide:

1. `PhoneBridgeTransport` with ≤64 KiB read abort before UTF-8 frame assembly
2. Protocol version `1` with `messageType` discriminator
3. Pairing exchange (`pair.request` → approve/deny/expire)
4. Session ready / revoke / error
5. Capture + scan lifecycle messages (opaque `captureRef` only)
6. Structured `result.show` / `result.update` / `result.dismiss`
7. Action ack via `result.update` (revision bump) after `action.save` / `action.open_on_phone`
8. Connection lost/restored that cannot revive revoked sessions
9. Safe error codes only — no tokens, images, stack traces
10. Session TTL within 24h of approval timestamp

## Merge-base analysis

- Base: `d293449` (= `feature/glasses-xr-native-standalone` tip at audit time)
- Delta: ~50 files, +~6.7k/−~0.3k from builder range, plus audit repairs/docs
- Expected conflicts: low if standalone tip unchanged; watch `AppRuntimeFactory`, `KScanViewModel`, manifests, `ReleaseSafetyGuard`

## Changed-file inventory (Phase A + audit)

Primary: `android-xr/app/src/main/java/com/kscan/glasses/phonebridge/**`, `runtime/ConnectedRuntimeStateMachine.kt`, `ui/screens/ConnectedHudScreen.kt`, `state/KScanViewModel.kt`, tests under `phonebridge`/`runtime`/`state`, `docs/google/PHONE_BRIDGE_PROTOCOL.md`, this audit pack.

## Dependency / manifest / BuildConfig

- kotlinx.serialization already in use
- Debug-only `MockScenarioReceiver` in `src/debug/AndroidManifest.xml`
- `KSCAN_DEBUG_MOCK_PHONE_BRIDGE` default false; **release forced false**

## Integration order

1. Land this branch after review
2. Wire real transport behind `FutureRealPhoneBridgeProvider` without changing validator
3. Mobile companion implements protocol v1
4. Hardware validation pass
5. Production session/auth issuance

## Rollback

- Revert branch merge; Connected HUD falls back to prior standalone tip
- Mock flag remains off by default — no production mock exposure from rollback of companion alone

## Remaining external gates

- Real mobile companion
- Formal XR hardware
- Production session issuance
- Optional CI workflow wiring (none present today)
