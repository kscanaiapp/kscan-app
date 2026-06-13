# Persistent Dressing Rooms and Looks

K Scan now has two separate style-storage layers.

## Local Style Library

The existing Style Library remains device-local. It is still stored through `expo-file-system` in `services/library.js`, keeps local thumbnails under `kscan_library/thumbnails/`, and reopens saved scans locally in `app/library.tsx`.

This implementation does not migrate, cloud-sync, upload, or replace those saved scans.

## Persistent Objects

Dressing Rooms and Looks are Supabase-backed, authenticated, user-owned objects.

- `dressing_rooms`: curated boards/workspaces such as trips, events, sale watchlists, or styling projects.
- `dressing_room_items`: render-safe product snapshots saved into a room.
- `looks`: outfit compositions owned by a user, optionally associated with one room.
- `look_items`: copied item snapshots inside a Look.

Relationship behavior:

- One user owns many Dressing Rooms.
- One Dressing Room contains many Dressing Room Items.
- One user owns many Looks.
- One Look contains many Look Items.
- One Look may belong to one Dressing Room through nullable `dressing_room_id`.
- Deleting a Dressing Room cascades Room Items and sets related Looks to standalone.
- Removing a Room Item does not break existing Looks because Look Items copy snapshots.
- Deleting a Look cascades Look Items.

## Snapshot Strategy

Item detail rendering uses `snapshot_payload` as the canonical persisted source. Preview columns such as `title`, `image_url`, `brand`, `category`, `price_amount`, `currency`, and `product_url` are populated from the same source at write time for lightweight list/card rendering.

All v1 snapshots store:

```json
{
  "snapshotVersion": 1
}
```

The app renders snapshot version `1`. Unknown future versions render an unavailable fallback instead of crashing. A future migration/version adapter can be added when snapshot shapes evolve.

Stale product titles/prices are acceptable in v1. These are saved render snapshots, not live catalog mirrors.

## Remote-Image-Only V1 Rule

Only items with durable remote `http://` or `https://` image URLs may be persisted in Dressing Rooms or Looks.

Catalog product matches still follow this rule.

Local scan inspiration images are supported through an explicit user action only: `Add Scan to Dressing Room`. That flow uploads the selected local image to the private Supabase Storage bucket `style-library-images`, stores `storage_bucket` and `storage_path` metadata on the Dressing Room Item, and renders the image with short-lived signed URLs.

The app does not upload every local Style Library item, run background sync, or replace the local Expo FileSystem library.

Unsupported local-only flows should show safe copy such as:

> This item can't be added to a Dressing Room yet.

## CRUD Flows

Implemented screens/routes:

- `/dressing-rooms`: list and create Dressing Rooms.
- `/dressing-rooms/[id]`: detail, edit metadata, delete room, remove items, select items, create Look.
- `/looks`: list Looks.
- `/looks/[id]`: detail, edit metadata, delete Look.

The first Add-to-Dressing-Room entry point is `ProductShelf`, because catalog product matches already expose render-safe remote image data (`imageUrl`) plus title, retailer, price, category, and product links.

## Atomic Look Creation

Creating a Look from selected Dressing Room Items uses the Postgres RPC:

`create_look_from_dressing_room_items(p_dressing_room_id, p_title, p_description, p_item_ids)`

The RPC verifies the authenticated user owns the room, verifies all selected items belong to that room, inserts the Look, and copies selected Room Item snapshots into Look Items in one transaction.

## RLS

All four persistent tables have Row Level Security enabled.

- `dressing_rooms` and `looks`: users can only select, insert, update, and delete rows where `user_id = auth.uid()`.
- `dressing_room_items`: users can only manage rows whose parent room belongs to `auth.uid()`.
- `look_items`: users can only manage rows whose parent look belongs to `auth.uid()`.

No cross-user reads, public profiles, user search, or sharing policies are added.

## Out of Scope

Deferred intentionally:

- StyleShare
- external share links
- native user-to-user sharing
- public profiles and recipient search
- social feeds, comments, likes, reactions
- collaborative rooms
- push notifications
- cloud sync of the local Style Library
- Supabase Storage image uploads
- automatic Style Library cloud sync
- drag/drop canvas outfit composer
- algorithmic look suggestions

This object model prepares StyleShare by creating stable, user-owned, snapshot-renderable source objects that future sharing can copy into share snapshots without granting access to private mutable tables.
