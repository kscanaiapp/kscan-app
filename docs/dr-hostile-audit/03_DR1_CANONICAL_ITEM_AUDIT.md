# DR-1 canonical item hostile audit

Scope: independently attempt to disprove the DR-1 canonical Dressing Room item contract; verify that Scanner provenance, canonical identity, commerce metadata, and analysis are preserved through every path that creates or transforms a room item.

## Test evidence

- `__tests__/dressingRoomCanonicalItemContract.test.js` — PASS
- `__tests__/dressingRoomItemContract.test.js` — PASS
- `__tests__/dressingRoomSavePolicy.test.js` — PASS
- `__tests__/ownedClosetItemContract.test.js` — PASS
- `__tests__/scanCommerceRouter.test.js` — PASS

All test files pass under Node's built-in runner after typescript was installed. See [`10_TEST_AND_VALIDATION_EVIDENCE.md`](10_TEST_AND_VALIDATION_EVIDENCE.md).

## Source inspection

Verified in `services/dressingRoomItemContract.ts`, `services/dressingRoomCommerce.ts`, `services/dressingRoomDedupe.ts`, and the Scan Result save policy path:

- Canonical item preserves stable source kind and source ID.
- Scanner provenance (`sourceKind`, `sourceId`, `scanId`) survives round trips (SOURCE VERIFIED, plus explicit test:
  `buildProductMatchSnapshot: Scan Result Object save is tagged scanner_single with scanId preserved`).
- A stray `kind` without a `scanId` cannot spoof `scanner_single` (test: `a stray "kind" without "scanId" cannot spoof scanner_single`).
- Nested commerce data (`purchase_options` / `purchaseOptions`, retailer, price, currency, direct + affiliate URLs) is retained in `snapshot_payload` when the commerce preservation path is exercised.
- Missing/malformed images are rejected via `UnsupportedStyleObjectItemError`; a non-remote image (file/relative) is rejected; snake_case/camelCase image URL aliases resolve; thumbnail aliases resolve.
- Dedupe uses the canonical stable source identity and does not degrade snapshots.
- All DR-1 canonical helpers are gated by `DRESSING_ROOM_CANONICAL_ITEM_V1` / `DRESSING_ROOM_COMMERCE_PRESERVATION_V1` / `DRESSING_ROOM_DEDUPE_V1`, all default OFF; legacy behavior is untouched when flags are off.

## Hostile scenarios attempted

| Scenario | Outcome |
| --- | --- |
| Missing image | Throws `UnsupportedStyleObjectItemError` (SOURCE VERIFIED + test) |
| Non-remote image (`file:///…`) | Throws (SOURCE VERIFIED + test) |
| Missing scanId on scanner kind | Rejected as spoof (SOURCE VERIFIED + test) |
| snake_case vs camelCase image URL | Both resolve; camelCase takes precedence (test) |
| Storage bucket + path preferred over local URI | Preferred (test) |
| `imageUrl: null` with storage reference | Storage reference still resolves (test) |
| Missing name → title fallback | Uses "Untitled item" fallback (test) |
| Alternate image aliases (`thumbnail`) | Resolves (test) |
| Bucket without path | Rejected as unusable storage source (test) |

No new DR-1 canonical-item defects found in this audit.

## Verdict

DR-1 canonical item contract: **PASS (SOURCE + BEHAVIORAL TEST VERIFIED)**.
