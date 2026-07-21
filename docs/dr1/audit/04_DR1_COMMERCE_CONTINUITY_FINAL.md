# 04 — DR-1 Commerce Continuity (Final)

## Module

`services/dressingRoomCommerce.ts` — `normalizePurchaseOptions`,
`collectRawPurchaseOptions`.

## Verified rules

- **Retailer neutrality:** `normalizePurchaseOptions` preserves first-seen
  order from the input array; there is no sort/rank by retailer, commission,
  or provider anywhere in the module. Confirmed by reading the full function
  body — the only ordering operation is the original array iteration order.
- **Exact-duplicate dedupe:** `optionFingerprint` hashes
  `retailer|productUrl-or-affiliateUrl|price|size|variant|productId`
  (lowercased); a `Set` skips repeats. Two options that differ in retailer,
  size, variant, or product id produce different fingerprints and are both
  kept — same-product-different-retailer and same-retailer-different-variant
  are never falsely collapsed.
- **HTTPS-only links:** `cleanHttpsUrl` requires `^https:\/\//i`; `http://`
  and any other scheme are rejected for `productUrl`, `affiliateUrl`, and
  `imageUrl`. An option with no `productUrl`/`affiliateUrl` and no
  `title`+`retailer` pair is dropped (fail-open on everything else).
- **Bounded input:** `MAX_OPTIONS = 24`, `MAX_TEXT = 200`, `MAX_URL = 2000`;
  the raw array is sliced to `MAX_OPTIONS * 2` before iterating, so a
  pathologically large or malformed array cannot cause unbounded work.
- **Alias intake:** `collectRawPurchaseOptions` checks, in priority order,
  `purchaseOptions`, `purchase_options`, `recommendedProducts`,
  `recommended_products`, `products`, `productMatches`, `shoppingResults`,
  `shopping`, `similarityMatches` — returns the first non-empty array found
  (no merge across aliases, so commerce is never double-counted from two
  aliases carrying the same data under different keys).
- **No re-run of shopping search on save:** the module only ever transforms
  data already present on the caller-supplied source object; it makes no
  network or database call.
- **Fail-open on malformed entries:** a malformed individual entry
  (non-object, array, or missing both a link and a title+retailer pair) is
  skipped with `continue`; it does not abort normalization of the rest of the
  array, and it never throws.

## Write behavior (unchanged from original DR-1 pass, re-verified)

Both write paths (`addProductToDressingRoom` → `buildProductMatchSnapshot`,
`addScanImageToDressingRoom`) only populate `snapshotPayload.purchaseOptions`
when `DRESSING_ROOM_COMMERCE_PRESERVATION_V1` is true; with the flag off, the
legacy single `productUrl`/`price` fields are the only commerce data written,
identical to pre-DR-1 behavior.

## Round-trip

An item saved through either path with commerce enabled carries
`snapshot_payload.purchaseOptions` through `getDressingRoomDetail` (plain
`SELECT *` + `mapDressingRoomItem`, no field-stripping) on every subsequent
room reopen. There is no code path that re-derives or discards
`purchaseOptions` after the initial write.

## Known, pre-existing (non-DR-1) limitation

The public/shared-room preview function (`get_public_room_preview`, untouched
by DR-1) never selects `snapshot_payload` or `purchaseOptions` at all — an
item's commerce data does not reach a public/shared preview today, flag state
notwithstanding. This is not a regression: the same limitation existed before
`f73d4147` and is outside DR-1's changed-file footprint and this audit's
repair authority (redesigning the public preview contract is explicitly out
of scope). Recorded here so E-4 does not assume commerce is visible through
that surface.

## Verdict for this section

Commerce continuity through Scanner → Saved Scan → Dressing Room → room
reopen: **confirmed, with the public-preview commerce gap noted as
pre-existing and out of DR-1's scope.**
