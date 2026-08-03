# Provider Abuse Response

Status: deterministic v1 model implemented in SQL (`evaluate_provider_abuse_state`, in the pending migration); not yet live.

## Escalation model

```
NORMAL → THROTTLED → TEMPORARILY_BLOCKED → SECURITY_REVIEW
```

`evaluate_provider_abuse_state(user_id, function_name)` reads `provider_security_events` (the audit trail written by `reserve_provider_request` on every denial) and returns the current state plus a `retry_after_seconds`:

| Condition (per function, per user) | State | retry_after_seconds |
|---|---|---|
| ≥ 3 `temporarily_blocked` events in the last 24 hours | `security_review` | 86400 (24h) |
| ≥ 5 throttle-type events (`throttled`, `reservation_denied`, `concurrency_denied`, `duplicate_denied`) in the last 10 minutes | `temporarily_blocked` | 1800 (30 min) |
| ≥ 1 throttle-type event in the last 10 minutes | `throttled` | 300 (5 min) |
| Otherwise | `normal` | 0 |

These three thresholds (5-min, 30-min, 24h windows) are the only tunable surface, matching the task's suggested block windows (5 min / 30 min / 24h). They live entirely in `evaluate_provider_abuse_state`'s SQL body — changing them is a single small migration, no Edge Function redeploy required.

`reserve_provider_request` calls this function automatically on a rolling-limit or daily-limit denial (not on a plain concurrency denial, which is treated as a lighter-weight, likely-innocent race rather than sustained abuse) and returns the escalated state and `retry_after_seconds` to the caller, which the Edge Function surfaces as:

```
HTTP 429
Retry-After: <retry_after_seconds>
{ "error": "rate_limited", "retryAfterSeconds": <n>, "requestId": "<safe-id>" }
```

(`securityErrorResponse('rate_limited', ...)` in `security/errors.ts` builds this exact shape and sets the header.)

## Signals used (v1)

- Verified `auth.uid()` — never a client-supplied ID.
- Rolling request frequency and short-term burst volume (via `provider_request_reservations` counts).
- Concurrent reservations (in-flight `reserved` rows).
- Repeated request fingerprints (duplicate detection, see `provider-cost-controls.md`).
- Recent throttle/block history (`provider_security_events`).

Not yet used, and explicitly out of scope for this phase per the task: request-origin/IP-based signals, and any integration with a broader WAF/DDoS system. Both are noted as future work, not implemented here.

## What this is not

This is not the full adaptive abuse system the task addendum describes as a longer-term goal — it's the deterministic v1 that the addendum explicitly scopes this phase to. It has no IP reputation, no device fingerprinting, and no cross-function correlation beyond what `provider_security_events` already captures per `(user_id, function_name)`.
