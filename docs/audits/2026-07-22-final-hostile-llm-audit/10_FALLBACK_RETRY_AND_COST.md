# Fallback, retry, and cost

## Scanner

```text
Gemini 3.6 Flash primary
  ├─ valid → return once
  ├─ eligible timeout/network/429/5xx/unavailable → Flash-Lite fallback once
  └─ auth/ownership/quota/invalid/privacy/policy → stop, no fallback
```

Maximum provider calls are bounded. A fallback response cannot coexist with a primary response, and the request consumes at most one quota unit.

## TextScan

Flash-Lite is primary. One same-model retry is permitted only for eligible transient failures. Invalid/security failures do not retry. There is no escalation to the more expensive reasoning model.

## Elise

Gemini 3.6 Flash is primary and Flash-Lite is the operational fallback. Controlled fault injection proved fallback success, one-answer behavior, and total provider failure refund. An incomplete primary response may fall back, and telemetry records the reason and attempts.

## Cost controls

- Auth and quota checks occur before provider invocation.
- One request ID is charged once despite retry/fallback.
- Duplicate requests are idempotent.
- Fallback success remains consumed.
- Total provider/system failure refunds once.
- ElevenLabs failure does not refund completed chat generation.
- Legacy Render route invokes zero providers.

Temporary fault-injection controls were removed after testing and never merged. No production Gemini outage was intentionally induced.
