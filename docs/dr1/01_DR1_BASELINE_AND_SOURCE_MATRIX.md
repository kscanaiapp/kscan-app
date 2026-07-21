# 01 — DR-1 Baseline and Source Matrix

## Preflight

| Field | Value |
| ----- | ----- |
| Workspace | `C:\src\KScan-dressingrooms-canonical-item-contract-20260721` |
| Branch | `feature/dressingrooms-canonical-item-contract-v1` |
| Starting HEAD | `f73d414745d366c5945fbb776231de6741012888` |
| Remote baseline | `origin/integration/ios-v16-qa` @ same SHA |
| Production project | `wyyuqfdxucjksghsmhry` |
| Node | v24.14.0 |
| npm | 11.9.0 |
| Deno | 2.8.2 |
| Supabase CLI | 2.109.1 |

## Migration reconciliation

| Ledger | Count | Last version |
| ------ | ----- | ------------ |
| Local (pre-reconcile) | 59 | `20260718151651` |
| Production | 60 | `20260720115423_scan_commerce_events` |

**Result:** Production was one migration ahead. Source restored as  
`supabase/migrations/20260720115423_scan_commerce_events.sql`  
(already applied in production — do not re-apply).

Elise E-1/E-2/E-3 migrations are **not** on this ios-v16 baseline and were not pulled in.

## Source matrix (write paths into `dressing_room_items`)

| Source | Entry | Write | Image | Commerce (pre-DR-1) | Provenance |
| ------ | ----- | ----- | ----- | ------------------- | ---------- |
| Catalog / ProductShelf | `AddToRoomModal` | `addProductToDressingRoom` | remote HTTPS | single link+price | `product_match` + product id |
| Scan Result Object | `saveScanResultToDressingRoom` | same | remote HTTPS | primary match only | same |
| Live / upload scan | `AddScanToDressingRoomModal` | `addScanImageToDressingRoom` | local→upload / storage / remote | **dropped** | `scan_image` + payload sourceType |
| Style Library saved scan | `app/library.tsx` | same | storage preferred | **dropped** | `style_library_scan` + saved id |
| Inspiration | link table only | **not** DR items | inspiration storage | n/a | link row |

## shared-room-image-url

Deployed production version **6**. Durable bucket/path signing; inspirations included; path encoding segment-safe. Unchanged by DR-1.
