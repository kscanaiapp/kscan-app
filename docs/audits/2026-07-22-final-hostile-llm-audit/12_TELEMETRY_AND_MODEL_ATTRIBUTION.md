# Telemetry and model attribution

## Schema

`public.llm_routing_events` is an append-only routing ledger with RLS enabled. It records only bounded categorical fields such as request ID, surface, primary/served model, fallback reason, attempts, latency, provider status, response validity, quota status, and Signature Style inclusion.

It stores no message, prompt, image, base64, email, user ID, JWT, secret, raw Signature Style history, audio, or provider response body.

## Migrations

- `20260722030304_create_llm_routing_events`
- `20260722031812_limit_llm_routing_event_privileges`

The second forward-only migration revoked `UPDATE` and `DELETE` from `service_role`, retained deliberate `SELECT`/`INSERT`, and left `anon`/`authenticated` with no access.

## Fresh model proof

| Request ID | Surface | Primary | Served | Fallback | Provider | Valid | Quota |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `abf3f0bc-50fe-498e-8c93-27204fab9883` | scanner | `gemini-3.6-flash` | `gemini-3.6-flash` | false | ok | true | consumed |
| `audit-textscan-postpriv-1784690645078-8ced543f` | textscan | `gemini-3.5-flash-lite` | `gemini-3.5-flash-lite` | false | ok | true | consumed |
| `d5554274-de66-4bf0-8732-9cadb3162883` | elise | `gemini-3.6-flash` | `gemini-3.6-flash` | false | ok | true | consumed |

Earlier controlled evidence also recorded Scanner fallback to Flash-Lite and Elise fallback/refund cases.

## Probe discipline

Runtime probes used strict connection/total timeouts, no automatic retry, non-sensitive request IDs/payloads, and redacted/categorical evidence. A stalled PowerShell harness and a failed curl transport attempt produced no usable runtime evidence, source changes, deployment changes, provider state, or quota changes; both are recorded as tooling failures only.
