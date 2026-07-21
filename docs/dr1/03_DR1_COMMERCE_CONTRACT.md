# 03 — DR-1 Commerce Contract

## Module

`services/dressingRoomCommerce.ts`

## Canonical purchase option fields

title, retailer, price, currency, productUrl, affiliateUrl, imageUrl, availability, size, variant, matchScore, confidence, provider, productId

## Rules

1. Preserve first-seen retailer order (no commission ranking).
2. Deduplicate exact repeated offers.
3. HTTPS product/affiliate URLs only.
4. Malformed entries skipped (fail-open).
5. Empty commerce is valid.
6. Do not re-run shopping search on save.
7. Alias intake: `purchaseOptions`, `purchase_options`, `recommendedProducts`, `products`, etc.

## Write behavior

Only when `DRESSING_ROOM_COMMERCE_PRESERVATION_V1=true`:

- product path embeds normalized options into snapshot
- scan path embeds options when caller supplies arrays

Flags OFF → legacy single `productUrl`/`price` behavior unchanged for testers.
