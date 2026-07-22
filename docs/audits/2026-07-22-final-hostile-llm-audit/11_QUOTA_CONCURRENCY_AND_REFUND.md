# Quota concurrency and refund

## Defect and repair

The Step 2B quota RPC used an ambiguous unqualified `messages_used` reference. Authenticated Elise calls failed with HTTP 500 before Gemini invocation. Both consume and refund RPCs were replaced in a forward-only migration; the already-applied migration was not edited.

The repaired functions use:

- fully qualified identifiers;
- `search_path = ''`;
- schema-qualified tables/functions;
- narrow transaction-scoped serialization derived from the quota identity/request;
- idempotent request-linked consume/refund behavior;
- server-derived authenticated identity.

## Live migrations

- `20260722004639_stylechat_request_quota_events`
- `20260722022830_lock_down_stylechat_quota_refunds`
- `20260722024920_fix_stylechat_quota_rpc_ambiguity`

## Validation matrix

| Case | Result |
| --- | --- |
| Original ambiguous consume | Reproduced HTTP 500 tied to `messages_used` |
| Consume after migration | PASS |
| Refund after migration | PASS |
| Duplicate consume | Idempotent; no second charge |
| Duplicate refund | No-op; no second credit |
| Same-user simultaneous requests | Serialized; no overspend |
| Different users | Not globally serialized |
| Authentication failure | No quota consumption |
| Primary retry/fallback | One request, one charge |
| Fallback success | Remains consumed |
| Total provider failure | Refunded exactly once |
| Safe valid response | Remains consumed |

Elise subsequently reached Gemini and returned authenticated HTTP 200 responses. Rollback is forward-fix only; applied migrations must not be deleted or rewritten.
