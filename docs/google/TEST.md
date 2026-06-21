# Test — K Scan Google Glasses

## Mock tests (CI / local)

| ID | Test | Command / location |
|----|------|-------------------|
| M1 | Bridge schema message types validate | `phone-bridge/tests/bridge-contract.test.ts` |
| M2 | Sanitizer strict mode blocks on failure | `phone-bridge/tests/sanitizer.test.ts` |
| M3 | Voice command parser recognizes phrases | Android unit tests (TODO) |
| M4 | Mock scan flow end-to-end | Manual: emulator + mock API |
| M5 | Top 3 results only in UI | Manual visual check |

```bash
cd phone-bridge && npm test
```

## Emulator tests

| ID | Scenario | Expected |
|----|----------|----------|
| E1 | Launch on API 34 emulator | Compose UI renders 600×600 frame |
| E2 | D-pad navigation | Focus moves, Select activates |
| E3 | Scan shortcut | Processing → Results without crash |
| E4 | Settings toggle audio-only | No result cards; TTS summary |
| E5 | Offline + real API disabled | Error screen, recoverable |

## Physical device tests

| ID | Scenario | Expected |
|----|----------|----------|
| P1 | Install debug APK on phone | Mock mode works as emulator |
| P2 | Real `/api/analyze` with mock image | Fashion or non-fashion response |
| P3 | Network timeout (airplane mode) | Offline error, no payload logs |
| P4 | Phone bridge stub wired from RN app | HELLO + DEVICE_STATE received |

## Privacy tests

| ID | Scenario | Expected |
|----|----------|----------|
| PR1 | Mock sanitizer success | Upload proceeds with sanitized payload |
| PR2 | Simulated sanitizer block | No network call |
| PR3 | Logcat review after scan | No base64, tokens, or raw image logs |
| PR4 | Production sanitizer flag off mock | Real FaceMasker required (TODO) |

## Regression checklist (pre-release)

- [ ] Backend payload exactly `{ "image": base64 }`
- [ ] 10s client timeout honored
- [ ] Non-2xx and malformed JSON handled
- [ ] Top 3 products displayed / spoken
- [ ] `sendToPhone` emits `ANALYSIS_RESULT`
- [ ] Save and Open on Phone actions work in mock bridge
- [ ] Audio-only mode never crashes without display
- [ ] Missing camera falls back to phone capture message (stub)
- [ ] No secrets in repo or logs

## Not in scope (alpha)

- Physical Google XR glasses hardware
- Always-on wake word
- Production ML Kit integration
- Supabase production relay
