# Authentication, privacy, and security

## Authentication boundaries

- `scan-identify` and `stylechat-generate` both have `verify_jwt=true`.
- Client adapters require a current session before invoking paid analysis.
- Auth, ownership, quota, invalid-payload, and policy failures stop before provider fallback.
- StyleChat quota identity is server-derived; the refund path is not client-authoritative.

## Image handling

The final mobile pipeline accepts only local `file://` or `content://` selections, creates a bounded JPEG derivative, and strips source metadata before remote analysis. Scanner compression produces the transmitted base64 transiently. Invalid/missing preparation fails closed.

Face and license-plate detection/masking are not installed. The code records these capabilities as false and does not claim that masking occurred. The earlier global block that required nonexistent masking was removed because it made all real Scanner execution impossible. If pixel masking becomes a formal release requirement for a particular surface, a real on-device implementation and new regression/runtime evidence are required; booleans must never be forged.

## Telemetry privacy

`llm_routing_events` has RLS enabled and contains no content or identity columns. Forbidden identity/content column count was zero. Events contain only request correlation and categorical routing metadata. No raw prompts, messages, images, base64, JWTs, API keys, email addresses, Signature Style history, audio, or provider response bodies were retained in audit evidence.

## Ledger privileges

| Role | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `anon` | No | No | No | No |
| `authenticated` | No | No | No | No |
| `service_role` | Yes, deliberately retained | Yes | No | No |

Metadata queries and transactional `SET ROLE service_role` probes proved this matrix. Active functions can append events; normal application credentials cannot rewrite or delete them.

## Legacy service

The public Render analysis route is a non-processing tombstone and repeated anonymous requests return 410. Administrative provider-secret revocation and service retirement remain unverified and prevent final PASS.
