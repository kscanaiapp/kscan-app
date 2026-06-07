# StyleChat v0.3 — Style Memory Foundation

Branch: `feature/stylechat-v0.3`  
Base: `feature/stylechat-v0.2` @ `19b1a77 feat(stylechat): persist sessions messages and usage`  
Status: style memory infrastructure built; passive signals read from source tables; no live LLM; no historical backfill

---

## What v0.3 Added

v0.2 gave StyleChat durable session and message persistence. v0.3 adds the **Style Memory Foundation**: a deterministic, privacy-safe layer that reads passive style signals from existing Dressing Room data and builds a structured memory summary for future LLM context injection.

- Schema hardening on `style_memory_events` — new columns + unique dedup index + atomic upsert RPC
- `upsert_style_memory_event()` Postgres RPC — `SECURITY DEFINER`, atomic `INSERT ... ON CONFLICT DO UPDATE`
- New constants and type layer: `constants/styleMemory.ts`, `services/style-chat/styleMemoryTypes.ts`
- New repository: `services/style-chat/styleMemoryRepository.ts`
- New cache utility: `services/style-chat/styleMemoryCache.ts`
- New summary builder: `services/style-chat/buildStyleMemorySummary.ts`
- `buildStyleChatContext` made async; now populates `memoryContext` from the summary
- `StyleChatContext` extended with optional `memoryContext` field (backward compatible)
- `useStyleChat.ts` updated to `await buildStyleChatContext()`
- Development-only debug screen: `app/style-chat/debug-memory.tsx`

No live LLM. No historical backfill. No new npm dependencies. No Expo SDK upgrade.

---

## Signal Discovery

Schema was inspected across all migration files and `services/styleObjects.ts` before implementation.

### Discovery Matrix

| Signal | Source table | Source field | Exists? | Implemented? | Notes |
|---|---|---|---|---|---|
| brand | `dressing_room_items` | `brand` (text) | Yes | Yes | Top-level column; also boosted by reactions |
| category | `dressing_room_items` | `category` (text) | Yes | Yes | Top-level column; also boosted by reactions |
| color | `dressing_room_items` | `snapshot_payload->'metadata'->>'color'` | Yes (scan only) | Yes | JSONB path; extracted in JS for scan_image items |
| budget/price | `dressing_room_items` | `price_amount` (numeric), `currency` | Yes | Yes | product_match items only |
| DR positive reaction | `dressing_room_item_reactions` | `reaction_type` ('like','love','favorite','looking') | Yes | Yes | Joined to items for brand/category boost |
| silhouette | `dressing_room_items.snapshot_payload` | `metadata.silhouette` | JSONB only | No | No top-level indexed column; extractable but not aggregated in v0.3 |
| style tags | — | — | No | No | No style tags table or structured field found |
| formality | — | — | No | No | No formality field in any table |
| DR negative feedback | — | — | No | No | No negative reaction type; all reactions are positive |
| purchase/transaction price | — | — | No | No | No purchase or transaction table found |

### Tables Inspected

- `dressing_rooms` — room metadata only; no signal fields
- `dressing_room_items` — brand, category, price_amount, currency, source_type, snapshot_payload
- `dressing_room_item_reactions` — reaction_type per user+item
- `looks` / `look_items` — brand, category present but look_items not queried in v0.3 (dressing_room_items covers the same data at lower join complexity)
- `profiles` — id, email, account_status, age_group: **age_group NOT used** (protected trait)
- `style_memory_events` — hardened in this milestone
- `style_chat_sessions`, `style_chat_messages`, `style_chat_usage` — StyleChat persistence; not signal sources

---

## Migration

**File:** `supabase/migrations/202606070003_style_memory_hardening.sql`  
**Applied:** Yes — dev project `yzqjvdfgefveprobvvyw` ("K Scan Privacy Controls")  
**Production:** Not applied.

### Changes to `style_memory_events`

```sql
alter table public.style_memory_events
  add column if not exists signal_key text,
  add column if not exists signal_date date default current_date,
  add column if not exists source_refs jsonb default '[]'::jsonb,
  add column if not exists stale_source_count integer default 0;
```

- `signal_key` — normalized signal identifier (brand name, color, category); used in unique index
- `signal_date` — date of signal observation; enables daily deduplication
- `source_refs` — array of `{kind, id}` objects tracking which app objects produced the signal
- `stale_source_count` — incremented when source refs become unreachable; reset on upsert

### Deduplication Index

```sql
create unique index style_memory_events_unique_daily_signal
  on public.style_memory_events (user_id, event_type, source, signal_key, signal_date)
  where signal_key is not null;
```

Prevents duplicate events for the same signal on the same day without application-level read-before-write.

---

## Upsert RPC

`public.upsert_style_memory_event(p_source, p_event_type, p_signal_key, p_signal_date, p_payload, p_confidence, p_source_refs)`

- `SECURITY DEFINER` — runs as function owner, bypasses RLS internally
- Enforces `auth.uid()` — callers can only write their own rows
- `INSERT ... ON CONFLICT DO UPDATE` — atomic, no race condition
- Validates required fields (source, event_type, signal_key, payload type) before insert
- Revoked from `public`; granted to `authenticated` only
- Client cannot directly insert or update `style_memory_events` (no client write policies)

**Not called in the v0.3 active chat flow.** Infrastructure is in place; forward-looking event creation wiring is a future milestone.

---

## Event Types

Defined in `services/style-chat/styleMemoryTypes.ts`:

```ts
export type StyleMemoryEventType =
  | 'color_preference'
  | 'brand_preference'
  | 'category_preference'
  | 'budget_signal'
  | 'dressing_room_positive_feedback';
```

---

## Payload Schemas

All payloads are typed with strict interfaces and validated at runtime before any RPC call.

### `BrandPreferencePayload`
```ts
{ signalKey, brandName, normalizedBrandName, count, source, sourceRefs }
```

### `CategoryPreferencePayload`
```ts
{ signalKey, category, normalizedCategory, count, source, sourceRefs }
```

### `ColorPreferencePayload`
```ts
{ signalKey, color, normalizedColor, count, source, sourceRefs }
```

### `BudgetSignalPayload`
```ts
{ signalKey, priceMin?, priceMax?, priceAverage?, currency?, count, source, sourceRefs }
```

### `DressingRoomPositiveFeedbackPayload`
```ts
{ signalKey, reactionType, brandName?, category?, count, source, sourceRefs }
```

---

## Runtime Validation Strategy

`styleMemoryRepository.ts` applies structural guards on every read and write path:

- `safeString()` — rejects null, empty, or non-string values
- `safePositiveNumber()` — rejects NaN, negative, and zero values
- `parseSourceRefs()` — validates each ref has `{ kind: string, id: string }` shape; rejects others
- `mapMemoryEvent()` — wraps row mapping in try/catch; returns `null` on malformed row
- All `null` entries are filtered out after mapping — one bad row never crashes the summary
- `buildStyleMemorySummary()` wraps its entire body in try/catch — returns empty summary on any error

---

## Atomic Deduplication Strategy

Database level (authoritative): the `style_memory_events_unique_daily_signal` partial unique index on `(user_id, event_type, source, signal_key, signal_date)` prevents duplicates at the Postgres level for any row where `signal_key is not null`.

RPC level: `upsert_style_memory_event` uses `INSERT ... ON CONFLICT DO UPDATE` — one SQL statement, no read/modify/write race.

Application level: `buildStyleMemorySummary` reads from source tables directly in v0.3 (not from `style_memory_events`), so no deduplication concern in the active flow. When event writes are wired in a future milestone, the RPC handles deduplication.

---

## Stale Source Reference Handling

Every memory event stores `source_refs: Array<{kind, id}>`. The summary builder tracks `staleSourceCount` in its output.

In v0.3, the summary reads directly from source tables rather than `style_memory_events`, so stale ref counting is always `0` (deleted items simply don't appear in the live query). When forward-looking events are written, the `stale_source_count` column on each row will be incremented by a future batch process that cross-references live source rows.

---

## Confidence Scoring

Defined in `constants/styleMemory.ts`:

```ts
export function confidenceFromCount(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 0.2;
  if (count === 2) return 0.4;
  if (count >= 3 && count < 5) return 0.6;
  return 0.85; // STYLE_MEMORY_MAX_PASSIVE_CONFIDENCE
}
```

Rules:
- Passive signal confidence never reaches 1.0
- A signal with fewer than `STYLE_MEMORY_MIN_SIGNAL_COUNT = 3` observations is **not included** in the summary
- Overall `confidenceScore` = mean of the top-10 signal confidences across brands, categories, and colors
- Budget range confidence uses the price count, same formula
- Reaction signals boost brand/category counts by +1 (additive, not multiplicative)

---

## Summary Caching and Invalidation

`services/style-chat/styleMemoryCache.ts` provides a module-level in-memory cache.

- Cache TTL: 2 hours (`STYLE_MEMORY_CACHE_TTL_MS`)
- `getCachedStyleMemorySummary()` — returns null if missing or stale
- `setCachedStyleMemorySummary(summary)` — stores with timestamp
- `invalidateMemoryCache()` — explicit invalidation; called by debug screen refresh

**Invalidation triggers (v0.3):**
- User manually refreshes the debug memory screen (calls `invalidateMemoryCache()` before reload)
- Cache TTL expires (2 hours)

**Future invalidation triggers (not yet wired):**
- New memory event written via `upsertStyleMemoryEvent`
- Scan or product item added to a Dressing Room
- Item deleted from a Dressing Room

The cache is process-local (module scope). App restart clears it. This is appropriate for v0.3 given the read-only source query approach.

---

## Debug Route Gating

Route: `app/style-chat/debug-memory.tsx`

Gating strategy: `__DEV__` global from React Native/Expo.

```ts
export default function StyleChatDebugMemoryScreen() {
  if (!__DEV__) {
    router.replace('/style-chat');
    return null;
  }
  return <DebugMemoryContent />;
}
```

- In development builds: shows full memory debug view with refresh button
- In production/release builds: immediately redirects to `/style-chat`
- Not linked from any production navigation (not in home, style-chat index, or any tab)
- Not accessible from the home screen or any user-facing nav

---

## Privacy Exclusions

The following were explicitly excluded from Style Memory:

| Field | Location | Reason |
|---|---|---|
| `age_group` | `profiles` | Age-related — protected characteristic |
| `account_status` | `profiles` | Account management data, not style signal |
| Body measurements | — | No table found; would be biometric/protected if it existed |
| Body type inference | — | No source data; prohibited by design |
| Size inference | — | `metadata.size` exists in snapshot_payload but not used (size inference is a protected proxy) |
| Gender assumptions | — | No source field; prohibited |
| Facial/biometric data | — | No source field; prohibited |
| Sentiment inference | — | No LLM; reactions are tallied as counts only |
| Cross-user data | — | All queries owner-scoped via RLS + `auth.uid()`; reaction signals limited to items in user's own rooms |

Third-party identifiers are never stored in memory payloads. Dressing Room reactions from other users do not appear in the current user's memory.

---

## Context Integration

`buildStyleChatContext()` is now async. It calls `buildStyleMemorySummary()` and populates:
- `preferences.preferredColors` — from `favoriteColors` signal items
- `preferences.budgetRange` — from `budgetRange.min` / `max`
- `memoryContext` — full summary slice including confidence, source counts, signals lists

`memoryContext` is `optional` on `StyleChatContext` — existing callers are unaffected. If memory fails, the field is `undefined` and chat continues normally.

`useStyleChat.ts` change: `await buildStyleChatContext()` (one-line addition; function was already in an async context).

---

## Sparse-Memory Expectation for Existing Users

Existing users have dressing room items, but `style_memory_events` is empty. The v0.3 summary builder reads directly from `dressing_room_items` and `dressing_room_item_reactions`, so:

- Users with Dressing Room items will see signals immediately (no backfill required)
- Signals below `STYLE_MEMORY_MIN_SIGNAL_COUNT = 3` will not appear in the summary
- New users with no items will receive an empty summary (valid, handled gracefully)
- The empty summary has `confidenceScore: 0` and all arrays empty — no crash risk

---

## Historical Backfill

Historical backfill was **skipped** in v0.3 by design.

Writing `style_memory_events` rows from historical scan/save history is a future milestone. It requires:
1. Identifying safe trigger points in scan/save flows
2. Batching historical records without blocking active flows
3. Applying rate limiting or background job execution

---

## Future AI Integration Point

When a real `StyleChatProvider` is wired:

1. `buildStyleChatContext()` already populates `memoryContext` — no additional work needed for the context shape
2. The LLM prompt builder should read `memoryContext.favoriteBrands`, `favoriteCategories`, `favoriteColors`, and `budgetRange`
3. `memoryContext.confidenceScore` can gate whether memory is injected (e.g., skip if `< 0.3`)
4. `memoryContext.missingSignals` documents gaps — useful for prompt calibration
5. `style_memory_events` writes via `upsertStyleMemoryEvent` should be triggered after LLM sessions extract explicit preferences

---

## Follow-ups Before Live LLM Integration

In addition to the v0.2 follow-ups:

1. **Wire `upsertStyleMemoryEvent`** — identify safe trigger points (post-scan-save, post-chat-session) and call the RPC for forward-looking events
2. **Cache invalidation on save** — call `invalidateMemoryCache()` when items are added/removed from Dressing Rooms
3. **look_items as additional signal source** — `look_items` has `brand`/`category`; could boost signals from curated Looks
4. **Message pagination** — carried from v0.2 (sessions > ~100 messages)
5. **Two-user RLS validation** — carried from v0.2
6. **Physical-device keyboard test** — carried from v0.2
7. **stale source ref sweep** — batch job to increment `stale_source_count` when source items are deleted
8. **Production migration** — apply v0.3 SQL file to production with a deployment plan
9. **Silhouette signal** — extractable from `snapshot_payload.metadata.silhouette` for scan items; deferred because no top-level indexed column exists
