# 06 — Quota schema and refund design

## Pre-migration

- Table: `style_chat_daily_usage` (`user_id`, `usage_date`, `messages_used`)
- RPC: `increment_stylechat_daily_usage()` — atomic consume, no request_id, no refund
- Burst: `check_and_increment_stylechat_burst`

## Why a migration was required

Existing schema cannot represent request-linked consume/refund or idempotent duplicate refunds.

## Design

Table `stylechat_quota_events` + RPCs:

- `consume_stylechat_request_quota(p_request_id)`
- `refund_stylechat_request_quota(p_request_id)`

States: `unconsumed` → `consumed` → `refunded` (once). Duplicate consume/refund are no-ops. Refunded request cannot re-consume under same id.

Daily limit remains **25** (unchanged).

## Client persistence boundary

Usable response returned by `stylechat-generate` = successful quota outcome. Later client persist failure does not refund.
