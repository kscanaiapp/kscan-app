# 03 — DR-4 Scanner, Commerce, and Elise Regression

## Verdict

| Area | Classification | Status |
| ---- | -------------- | ------ |
| Scanner provenance / canonical item | NOT A DEFECT | Preserved via DR-1 contract paths |
| Purchase-options survival | NOT A DEFECT | `dressingRoomCommerce` + `DRESSING_ROOM_COMMERCE_PRESERVATION_V1` |
| Affiliate URL survival | NOT A DEFECT | Commerce layer retains `affiliateUrl` / `affiliate_url` |
| Elise never receives product arrays | NOT A DEFECT | `attachmentContext` contract |
| Model text uses presence boolean only | NOT A DEFECT | `purchaseUrlPresent` in visual pipeline |
| Reactions rewrite item snapshots | NOT A DEFECT | Reaction RPC does not `UPDATE dressing_room_items` / `snapshot_payload` |

## Path verified (source)

Scanner → Scan Result → Dressing Room save → room render → Elise attachment → commerce UI

## Commerce continuity paths

| Layer | Path | What is preserved |
| ----- | ---- | ----------------- |
| Commerce helpers | `services/dressingRoomCommerce.ts` | Affiliate + purchase options normalization |
| Item contract | `services/dressingRoomItemContract.ts` | `normalizePurchaseOptions` / `purchaseOptions` |
| Style objects writer | `services/styleObjects.ts` | Snapshot write gated by commerce preservation flag |
| Collab reaction RPC | DR-3/DR-4 migrations | Desired-state reaction only — no snapshot mutation |

## Elise separation

| Rule | Evidence |
| ---- | -------- |
| No product arrays in model text | `attachmentContext.ts` — "NEVER contains … product arrays"; uses `dressingRoomItemToEvidence` |
| No raw affiliate/purchase URLs in attachment model text | Source does not inject `affiliateUrl` / `purchaseOptions` into that builder |
| Boolean presence only | `eliseVisualContextPipeline.ts` — `purchaseUrlPresent: Boolean(...)` / equivalent |
| Raw room messages | Not fed into Elise model context |
| Owned/shared attach auth | DR-2 server-resolved evidence; revoke rejects shared attach (contract inherited) |

## Regression tests (source contract)

| Test | File |
| ---- | ---- |
| Commerce fields survive contract + styleObjects writers | `__tests__/dr4Hardening.test.js` |
| Elise model text excludes raw purchase/affiliate URLs | `__tests__/dr4Hardening.test.js` |
| Reaction migration does not rewrite snapshots | `__tests__/dr4Hardening.test.js` |

## Non-claims

| Claim | Status |
| ----- | ------ |
| Live Elise attachment against production | Not exercised (READ ONLY) |
| Physical Scanner → Room → Elise device run | NEXT-BUILD GATE |
| Production flag enablement | Not done |
