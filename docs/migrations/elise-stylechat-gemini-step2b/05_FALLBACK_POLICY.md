# 05 — Fallback policy

## Completeness criteria (preserved)

- `finishReason === MAX_TOKENS`
- empty / dangling endings / missing terminal punctuation (with short-question exception)

## Budgets

| Path | Calls |
| --- | --- |
| Operational (timeout/network/429/5xx) | primary → Lite (max 2) |
| Malformed/completeness | primary → same-model retry → Lite (max 3) |

## Non-fallback

Auth, account lifecycle, session ownership, malformed request, empty message, quota exhausted, burst, missing key — unchanged; no Lite bypass.

Canned `buildStyleChatFallback()` after total provider failure → quota refund (not a Gemini usable reply).
