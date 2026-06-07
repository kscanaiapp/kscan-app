# StyleChat v0.3.1 - Style Memory Hardening

Branch: `feature/stylechat-v0.3.1`  
Base: `feature/stylechat-v0.3` @ `19f0c7e feat(stylechat): add deterministic style memory foundation`  
Status: hardening pass applied to the v0.3 memory foundation; no live LLM; no historical backfill; two-user RLS runtime validation still outstanding

---

## What Changed

v0.3.1 fixes the merge-gating issues found in the independent audit without expanding StyleChat scope.

- Memory cache is now keyed by authenticated user id
- Cache is bounded to 5 entries and evicts the oldest entry when full
- Cache is invalidated on auth state changes and explicit sign-out
- Runtime payload validation now blocks arbitrary JSONB payloads before the memory RPC write path
- `thumbs_down` is treated as negative feedback and excluded from positive preference aggregation
- Existing malformed negative memory-event rows are filtered out of read results
- Favorite colors, brands, and categories are bounded to top 5 with deterministic tie-breaking
- Debug route now renders a safe non-dev placeholder and shows a visible internal-use label in dev

No live LLM. No new npm dependencies. No Expo SDK upgrade.

---

## Signal Discovery

Schema was re-checked across the relevant migrations and current StyleChat files.

| Signal | Source table | Source field | Exists? | Implemented? | Notes |
|---|---|---|---|---|---|
| brand | `dressing_room_items` | `brand` | Yes | Yes | Top-level column; boosted by positive reactions only |
| category | `dressing_room_items` | `category` | Yes | Yes | Top-level column; boosted by positive reactions only |
| color | `dressing_room_items` | `snapshot_payload->metadata.color` | Yes | Yes | Scan items only |
| budget/price | `dressing_room_items` | `price_amount`, `currency` | Yes | Yes | `product_match` items only |
| DR positive reaction | `dressing_room_item_reactions` | `reaction_type in ('like','love','favorite','looking')` | Yes | Yes | Joined to items for brand/category boost |
| DR negative reaction | `dressing_room_item_reactions` | `reaction_type = 'thumbs_down'` | Yes | Partially | Explicitly excluded from positive memory in v0.3.1 |
| silhouette | `dressing_room_items.snapshot_payload` | `metadata.silhouette` | JSONB only | No | No indexed top-level column |
| style tags | - | - | No | No | No structured source found |
| formality | - | - | No | No | No source field found |

---

## Payload Validation

`services/style-chat/memoryPayloadValidators.ts` now validates every supported write payload before `upsert_style_memory_event` can be called.

Validated requirements:

- payload must be an object
- `signalKey` must be a non-empty string
- `count` must be a positive finite number
- `source` must be one of `scan`, `saved_item`, `dressing_room`, `product`, `profile`
- `sourceRefs` must be a bounded array of `1..50` valid `{ kind, id }` objects
- event-specific normalized fields must be present
- positive Dressing Room feedback payloads accept only `like`, `love`, `favorite`, or `looking`

Failure behavior:

- invalid payloads are skipped before the RPC call
- no sensitive preference payload contents are logged
- no user-facing alert is shown
- the active chat flow is not supposed to fail just because a memory write is skipped

---

## Negative Reaction Handling

`thumbs_down` exists in the current reaction schema.

v0.3.1 behavior:

- positive reactions: `like`, `love`, `favorite`, `looking`
- negative reaction: `thumbs_down`
- `thumbs_down` does not boost favorite brands, categories, or colors
- `thumbs_down` is not converted into avoided brands, categories, colors, or silhouettes
- legacy `style_memory_events` rows that claim positive feedback but carry `reactionType = 'thumbs_down'` are filtered out of memory-event reads

This keeps prior bad negative data from inflating positive confidence.

---

## Cache Isolation and Invalidation

`services/style-chat/styleMemoryCache.ts` now provides a user-scoped in-memory cache.

- cache key: authenticated `userId`
- optional session scope is supported by the cache API, though not currently used by StyleChat
- cache TTL: 2 hours
- max entries: 5
- eviction strategy: oldest cached entry is removed first

Read/write API:

- `getCachedStyleMemorySummary(userId, sessionId?)`
- `setCachedStyleMemorySummary(userId, summary, sessionId?)`
- `invalidateMemoryCache(userId?, sessionId?)`
- `invalidateAllMemoryCache()`

Auth invalidation:

- any auth state change except token refresh clears the memory cache
- explicit sign-out clears the memory cache
- invalid boot sessions clear the memory cache before sign-out

The cache remains in-memory only. It does not use AsyncStorage, SecureStore, filesystem storage, or any other persistent storage.

---

## Summary Behavior and Bounds

Active user-facing signals still come from live source tables, not `style_memory_events`, so deleted or unauthorized source rows naturally drop out of the summary.

Summary bounds:

- favorite colors: top 5
- favorite brands: top 5
- favorite categories: top 5
- favorite silhouettes: empty in v0.3.1
- favorite style tags: empty in v0.3.1
- avoided colors: empty in v0.3.1

Sort order:

1. `count` descending
2. `confidence` descending
3. alphabetical by `value`

Ties at the boundary are truncated after the first 5 deterministic results.

Stale source references:

- `style_memory_events` are read only for debug/source counts
- they are not used to contribute active confidence-bearing favorite signals
- deleted live source rows therefore do not create ghost-state confidence in the current summary design

---

## RPC Safety

`upsert_style_memory_event` was re-checked during v0.3.1.

Confirmed:

- no trusted client `user_id` parameter exists
- user identity is derived from `auth.uid()`
- `search_path` is fixed to `public`
- execute is revoked from `public`
- execute is granted only to `authenticated`
- `ON CONFLICT (user_id, event_type, source, signal_key, signal_date)` matches the unique index columns
- the write path is atomic

No SQL migration was needed in v0.3.1.

---

## Debug Route Gating

Route: `app/style-chat/debug-memory.tsx`

Current gating:

- dev builds: full debug view for the current authenticated user only
- visible label: `DEBUG ONLY - INTERNAL USE`
- non-dev builds: safe `Not Available` placeholder with no memory data
- still not linked from production navigation

Limitation:

- this is still a file-based Expo Router route under `app/`
- there is no stronger internal build flag in the current repo
- remove the route file, move it outside `app/`, or add an internal build flag before broad public/beta distribution if route discoverability is unacceptable

---

## Privacy Boundaries

Still excluded from memory:

- age or age-group inference
- gender assumptions
- protected traits
- biometric or facial data
- body measurements and body-type inference
- size-based inference
- sentiment analysis

Third-party identifiers are not displayed by the debug screen. Dressing Room reactions from other users do not appear in the current user's memory summary because active aggregation remains owner-scoped through live-table RLS.

---

## Validation Status

- TypeScript: re-run required after hardening changes
- Metro smoke test: re-run required after hardening changes
- two-user RLS runtime validation: still required for merge/release readiness

Do not claim release readiness until the two-user runtime RLS check is actually performed.
