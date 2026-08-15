// Build 29 Closet V2 / S5 — wear-history service contract.
//
// AUTHORITY
// ---------
//     public.wardrobe_wear_events        CANONICAL. One row per logical wear.
//     public.wardrobe_wear_event_items   One row per garment in that wear.
//     WearTrackingEntry (local)          DERIVED CACHE ONLY. Never authority.
//
// The local counter model in services/free-tier/costPerWear.ts predates this
// and stores `wearCount` + `lastWornAt` per item in AsyncStorage. It is not
// deleted — Build 28 clients and the free-tier surfaces still read it — but it
// may no longer be treated as truth. `projectWearTrackingFromEvents` below is
// the ONLY sanctioned direction: events -> counter. There is deliberately no
// function going the other way, because a counter cannot reconstruct the dated
// events it was summarising, and pretending otherwise would fabricate history.
//
// SAVED LOOK != WORN LOOK
// -----------------------
// Nothing in this module is reachable from creating, editing, opening or
// deleting a Saved Look. Wear history is written ONLY by the two explicit
// actions below. That separation is enforced by tests rather than by
// convention, because a wear event the user never performed is a
// data-integrity defect, not a cosmetic one.

import { supabase } from './supabaseClient';

export const WEAR_HISTORY_CONTRACT_VERSION = 1 as const;

/** Where a wear was logged from. Not a garment taxonomy. */
export type WearEventSource = 'item' | 'saved_look' | 'custom';

export type WearEventItemInput = {
  /** Stable identity of the garment. Never an array index, title or URL. */
  sourceItemId: string;
  /** 'saved_scan' | 'closet_item' | 'inspiration_item' | 'look_item' | ... */
  sourceType?: string;
  /** Point-in-time display title. Bounded; never a full item payload. */
  titleSnapshot?: string | null;
  categorySnapshot?: string | null;
};

export type LogWearInput = {
  /**
   * Stable key for the logical user action. Two submissions carrying the same
   * key are the same wear, however many times the button was pressed or the
   * request retried.
   */
  actionKey?: string;
  /** ISO instant. Defaults to now. */
  wornAt?: string;
  savedLookId?: string | null;
};

export type WearEventRecord = {
  id: string;
  wornAt: string;
  savedLookId: string | null;
  sourceItemId: string | null;
  items: Array<{
    sourceItemId: string;
    sourceType: string;
    titleSnapshot: string | null;
    categorySnapshot: string | null;
  }>;
};

export type WearHistoryResult =
  | { ok: true; event: WearEventRecord; deduplicated: boolean }
  | { ok: false; reason: 'unauthenticated' | 'invalid_input' | 'network'; error: string };

const MAX_ITEMS_PER_EVENT = 24;
const MAX_SNAPSHOT_CHARS = 80;

function bounded(value: unknown, max = MAX_SNAPSHOT_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function isoOrNow(value?: string): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

/** Calendar day of a wear, used as the default idempotency grain. */
export function wearDateKey(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Default idempotency key.
 *
 * Grain is (target, calendar day). A double tap, a retry after a slow network,
 * an offline replay and a re-render all produce the same key and therefore the
 * same single event.
 *
 * This deliberately collapses two same-day taps on the same garment into one
 * wear. Wear history is a day-grained record — "I wore this on the 14th" — and
 * silently double-counting a fat-fingered tap corrupts every downstream
 * statistic. A caller that genuinely needs to record a distinct second wear
 * passes its own `actionKey`.
 */
export function defaultActionKey(input: {
  source: WearEventSource;
  targetId: string;
  wornAt: string;
}): string {
  return `wear:${input.source}:${input.targetId}:${wearDateKey(input.wornAt)}`;
}

/**
 * De-duplicate the garments of one logical wear.
 *
 * A corrupt or hand-edited look payload can list the same garment more than
 * once. Each garment must count exactly once for the event, so this collapses
 * by sourceItemId, keeping the first occurrence's snapshot.
 */
export function dedupeWearItems(items: WearEventItemInput[]): WearEventItemInput[] {
  const seen = new Set<string>();
  const out: WearEventItemInput[] = [];
  for (const item of items) {
    const id = bounded(item?.sourceItemId, 128);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      sourceItemId: id,
      sourceType: bounded(item.sourceType, 40) ?? 'unknown',
      titleSnapshot: bounded(item.titleSnapshot),
      categorySnapshot: bounded(item.categorySnapshot, 40),
    });
    if (out.length >= MAX_ITEMS_PER_EVENT) break;
  }
  return out;
}

async function currentUserId(client: typeof supabase): Promise<string | null> {
  try {
    const { data, error } = await client.auth.getSession();
    if (error || !data?.session) return null;
    return data.session.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Write one logical wear event and its garment relationships.
 *
 * Idempotency rests on the `(user_id, client_id)` unique index that already
 * exists on wardrobe_wear_events: the upsert resolves onto the same row for a
 * repeated action rather than inserting a second one. The event-item upsert
 * then resolves on `(wear_event_id, source_item_id)`, so replaying the action
 * cannot multiply relationships either.
 */
async function writeWearEvent(
  client: typeof supabase,
  input: {
    source: WearEventSource;
    targetId: string;
    items: WearEventItemInput[];
    sourceItemId: string | null;
    savedLookId: string | null;
    savedLookRef: string | null;
    actionKey?: string;
    wornAt?: string;
  },
): Promise<WearHistoryResult> {
  const userId = await currentUserId(client);
  if (!userId) {
    return { ok: false, reason: 'unauthenticated', error: 'Sign in to record a wear.' };
  }

  const items = dedupeWearItems(input.items);
  if (items.length === 0) {
    return { ok: false, reason: 'invalid_input', error: 'A wear must include at least one item.' };
  }

  const wornAt = isoOrNow(input.wornAt);
  const clientId =
    bounded(input.actionKey, 200) ??
    defaultActionKey({ source: input.source, targetId: input.targetId, wornAt });

  try {
    const { data: eventRow, error: eventError } = await client
      .from('wardrobe_wear_events')
      .upsert(
        {
          user_id: userId,
          client_id: clientId,
          source_item_id: input.sourceItemId,
          saved_look_id: input.savedLookId,
          // Durable identity. saved_look_id is a real FK and nulls out when
          // the look is deleted; without this an outfit-level event would be
          // left with no identity at all and the delete would be refused.
          saved_look_ref: input.savedLookRef,
          worn_at: wornAt,
        },
        { onConflict: 'user_id,client_id' },
      )
      .select('id, worn_at, saved_look_id, saved_look_ref, source_item_id, created_at, updated_at')
      .single();

    if (eventError || !eventRow) {
      return { ok: false, reason: 'network', error: 'Could not record the wear. Try again.' };
    }

    const eventId = String(eventRow.id);
    const { error: itemsError } = await client
      .from('wardrobe_wear_event_items')
      .upsert(
        items.map((item) => ({
          user_id: userId,
          wear_event_id: eventId,
          // Scoped by event so replaying the action resolves onto the same
          // relationship rather than creating a parallel one.
          client_id: `${clientId}#${item.sourceItemId}`,
          source_item_id: item.sourceItemId,
          source_type: item.sourceType ?? 'unknown',
          title_snapshot: item.titleSnapshot ?? null,
          category_snapshot: item.categorySnapshot ?? null,
        })),
        { onConflict: 'user_id,client_id' },
      );

    if (itemsError) {
      // The event exists but is incompletely populated. Report failure rather
      // than a partial success: a caller told "recorded" would not retry, and
      // the retry is what repairs it. The retry is safe — both upserts are
      // idempotent on the same keys.
      return { ok: false, reason: 'network', error: 'Could not record every item. Try again.' };
    }

    // created_at !== updated_at means the upsert resolved onto an existing row.
    const deduplicated =
      typeof eventRow.created_at === 'string' &&
      typeof eventRow.updated_at === 'string' &&
      eventRow.created_at !== eventRow.updated_at;

    return {
      ok: true,
      deduplicated,
      event: {
        id: eventId,
        wornAt: String(eventRow.worn_at ?? wornAt),
        savedLookId: (eventRow.saved_look_id as string | null) ?? null,
        sourceItemId: (eventRow.source_item_id as string | null) ?? null,
        items: items.map((item) => ({
          sourceItemId: item.sourceItemId,
          sourceType: item.sourceType ?? 'unknown',
          titleSnapshot: item.titleSnapshot ?? null,
          categorySnapshot: item.categorySnapshot ?? null,
        })),
      },
    };
  } catch {
    return { ok: false, reason: 'network', error: 'Could not record the wear. Try again.' };
  }
}

/** "Wore this" — one garment, one event. */
export function logItemWear(
  item: WearEventItemInput,
  options: LogWearInput = {},
  client: typeof supabase = supabase,
): Promise<WearHistoryResult> {
  const id = bounded(item?.sourceItemId, 128);
  if (!id) {
    return Promise.resolve({
      ok: false,
      reason: 'invalid_input',
      error: 'A wear needs a garment.',
    });
  }
  return writeWearEvent(client, {
    source: 'item',
    targetId: id,
    items: [item],
    // Legacy single-item shape stays populated, so a Build 28 reader sees
    // exactly the row it already understands.
    sourceItemId: id,
    savedLookId: options.savedLookId ?? null,
    savedLookRef: options.savedLookId ?? null,
    actionKey: options.actionKey,
    wornAt: options.wornAt,
  });
}

/**
 * "Wore this look" — ONE event, N garment relationships.
 *
 * `source_item_id` is left null: an outfit has no single source garment, and
 * electing one would invent a claim the user never made. The database CHECK
 * accepts the row because `saved_look_id` supplies identity instead.
 */
export function logLookWear(
  lookId: string,
  items: WearEventItemInput[],
  options: LogWearInput = {},
  client: typeof supabase = supabase,
): Promise<WearHistoryResult> {
  const id = bounded(lookId, 128);
  if (!id) {
    return Promise.resolve({
      ok: false,
      reason: 'invalid_input',
      error: 'A look wear needs a look.',
    });
  }
  return writeWearEvent(client, {
    source: 'saved_look',
    targetId: id,
    items: Array.isArray(items) ? items : [],
    sourceItemId: null,
    savedLookId: id,
    savedLookRef: id,
    actionKey: options.actionKey,
    wornAt: options.wornAt,
  });
}

// ── Derived projections (read-only; never authority) ─────────────────────────

export type WearStats = {
  sourceItemId: string;
  timesWorn: number;
  lastWornAt: string | null;
};

/**
 * Fold canonical events into per-garment statistics.
 *
 * This is the sanctioned replacement for reading the local counter. It is a
 * pure function so S6 can call it on whatever page of history it has loaded
 * without a second round trip.
 */
export function projectWearStats(
  events: Array<{ wornAt: string; items: Array<{ sourceItemId: string }> }>,
): WearStats[] {
  const byItem = new Map<string, WearStats>();
  for (const event of events) {
    // One event contributes at most one wear per garment, regardless of how
    // many times the garment appears in its item list.
    const counted = new Set<string>();
    for (const item of event.items ?? []) {
      const id = item?.sourceItemId;
      if (!id || counted.has(id)) continue;
      counted.add(id);
      const existing = byItem.get(id) ?? { sourceItemId: id, timesWorn: 0, lastWornAt: null };
      existing.timesWorn += 1;
      if (!existing.lastWornAt || event.wornAt > existing.lastWornAt) {
        existing.lastWornAt = event.wornAt;
      }
      byItem.set(id, existing);
    }
  }
  return [...byItem.values()];
}

/**
 * Project canonical events into the legacy local cache shape.
 *
 * ONE DIRECTION ONLY. There is no inverse, deliberately: a `wearCount` of 7
 * does not say when those wears happened, so reconstructing events from it
 * would require inventing seven dates. If local state disagrees with the
 * canonical events, the events win and the cache is overwritten.
 *
 * `estimatedPrice` is intentionally not set here. It belongs to Cost Per Wear,
 * which is out of Build 29 scope, and this projection must not become the
 * thing that quietly starts populating it.
 */
export function projectWearTrackingFromEvents(
  events: Array<{ wornAt: string; items: Array<{ sourceItemId: string }> }>,
  now: string,
): Record<string, { itemId: string; wearCount: number; lastWornAt?: string; updatedAt: string }> {
  const out: Record<
    string,
    { itemId: string; wearCount: number; lastWornAt?: string; updatedAt: string }
  > = {};
  for (const stat of projectWearStats(events)) {
    out[stat.sourceItemId] = {
      itemId: stat.sourceItemId,
      wearCount: stat.timesWorn,
      ...(stat.lastWornAt ? { lastWornAt: stat.lastWornAt } : {}),
      updatedAt: now,
    };
  }
  return out;
}

/**
 * Items with no recorded wear that are old enough for the statement to mean
 * something.
 *
 * The age guard is the point: a garment added four days ago has not "not been
 * worn in 30 days", it simply has not existed for 30 days, and reporting it as
 * neglected is a false statement about the user's wardrobe.
 */
export function itemsNotWornSince(
  candidates: Array<{ sourceItemId: string; addedAt: string }>,
  stats: WearStats[],
  options: { since: string; minimumAgeDays: number; now: string },
): string[] {
  const statById = new Map(stats.map((s) => [s.sourceItemId, s]));
  const nowMs = Date.parse(options.now);
  const minimumAgeMs = options.minimumAgeDays * 24 * 60 * 60 * 1000;

  return candidates
    .filter((candidate) => {
      const addedMs = Date.parse(candidate.addedAt);
      if (!Number.isFinite(addedMs)) return false;
      if (nowMs - addedMs < minimumAgeMs) return false;
      const stat = statById.get(candidate.sourceItemId);
      if (!stat || !stat.lastWornAt) return true;
      return stat.lastWornAt < options.since;
    })
    .map((candidate) => candidate.sourceItemId);
}

// ── Read contract (S6) ───────────────────────────────────────────────────────
//
// The ONLY sanctioned way to read wear history. UI components must not query
// Supabase directly, must not load the whole table, and must not fall back to
// the local counter when a page is slow — all three reintroduce the dual
// authority S5 removed.

/** Keyset cursor. Opaque to callers; ordering is owned by this module. */
export type WearHistoryCursor = { wornAt: string; id: string };

export type WearHistoryEntry = {
  id: string;
  wornAt: string;
  /** 'saved_look' when the wear came from a look, else 'item'. */
  kind: WearEventSource;
  /** Durable look id. Present even after the look itself is deleted. */
  savedLookRef: string | null;
  /** True while the look still exists; false once it has been deleted. */
  savedLookLive: boolean;
  items: Array<{
    sourceItemId: string;
    sourceType: string;
    titleSnapshot: string | null;
    categorySnapshot: string | null;
  }>;
};

export type WearHistoryPage = {
  entries: WearHistoryEntry[];
  /** Null when the last page has been reached. */
  nextCursor: WearHistoryCursor | null;
  hasMore: boolean;
};

export type WearHistoryReadResult =
  | { ok: true; page: WearHistoryPage }
  | { ok: false; reason: 'unauthenticated' | 'invalid_input' | 'network'; error: string };

const WEAR_CURSOR_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WEAR_CURSOR_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidWearHistoryCursor(value: unknown): value is WearHistoryCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Record<string, unknown>;
  if (typeof cursor.wornAt !== 'string' || typeof cursor.id !== 'string') return false;
  // PostgREST's `.or()` accepts a raw filter expression. Restrict both cursor
  // components to values this service itself emits so caller input cannot add
  // another predicate or alter the keyset boundary.
  if (!WEAR_CURSOR_TIMESTAMP_RE.test(cursor.wornAt)) return false;
  return Number.isFinite(Date.parse(cursor.wornAt)) && WEAR_CURSOR_ID_RE.test(cursor.id);
}

/** Bounded by construction. A caller cannot ask for an unbounded page. */
export const WEAR_HISTORY_PAGE_SIZE = 25;
export const WEAR_HISTORY_MAX_PAGE_SIZE = 100;

/** Rows scanned when computing wardrobe-wide statistics. */
export const WEAR_STATS_SCAN_LIMIT = 1000;

const EVENT_COLUMNS =
  'id, worn_at, saved_look_id, saved_look_ref, source_item_id, ' +
  'wardrobe_wear_event_items(source_item_id, source_type, title_snapshot, category_snapshot, deleted_at)';

function toEntry(row: Record<string, unknown>): WearHistoryEntry {
  const rawItems = Array.isArray(row.wardrobe_wear_event_items)
    ? (row.wardrobe_wear_event_items as Array<Record<string, unknown>>)
    : [];
  const items = rawItems
    .filter((item) => !item.deleted_at)
    .map((item) => ({
      sourceItemId: String(item.source_item_id ?? ''),
      sourceType: String(item.source_type ?? 'unknown'),
      titleSnapshot: (item.title_snapshot as string | null) ?? null,
      categorySnapshot: (item.category_snapshot as string | null) ?? null,
    }))
    .filter((item) => item.sourceItemId.length > 0);

  const savedLookRef = (row.saved_look_ref as string | null) ?? null;
  return {
    id: String(row.id),
    wornAt: String(row.worn_at),
    kind: savedLookRef ? 'saved_look' : 'item',
    savedLookRef,
    // saved_look_id nulls out when the look is deleted; saved_look_ref does
    // not. The pair is what lets the UI say "this look no longer exists"
    // instead of either crashing or inventing a current look.
    savedLookLive: !!row.saved_look_id,
    items,
  };
}

/**
 * One bounded, ordered, owner-scoped page of wear history.
 *
 * Ordering is `worn_at DESC, id DESC`. The id tie-breaker is not cosmetic:
 * `worn_at` is only second-granular and two wears can share it, and without a
 * stable second key a row can appear on two consecutive pages or be skipped
 * entirely — the classic keyset paging bug.
 */
export async function getWearHistory(
  options: { cursor?: WearHistoryCursor | null; pageSize?: number } = {},
  client: typeof supabase = supabase,
): Promise<WearHistoryReadResult> {
  const userId = await currentUserId(client);
  if (!userId) {
    return { ok: false, reason: 'unauthenticated', error: 'Sign in to see your wear history.' };
  }

  const pageSize = Math.min(
    Math.max(1, options.pageSize ?? WEAR_HISTORY_PAGE_SIZE),
    WEAR_HISTORY_MAX_PAGE_SIZE,
  );

  try {
    let query = client
      .from('wardrobe_wear_events')
      .select(EVENT_COLUMNS)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('worn_at', { ascending: false })
      .order('id', { ascending: false })
      // Fetch one extra to detect a further page without a second round trip
      // or a COUNT over the whole table.
      .limit(pageSize + 1);

    const cursor = options.cursor;
    if (cursor && !isValidWearHistoryCursor(cursor)) {
      return {
        ok: false,
        reason: 'invalid_input',
        error: 'Could not load that page of your wear history.',
      };
    }
    if (cursor) {
      query = query.or(
        [
          'worn_at.lt.' + cursor.wornAt,
          'and(worn_at.eq.' + cursor.wornAt + ',id.lt.' + cursor.id + ')',
        ].join(','),
      );
    }

    const { data, error } = await query;
    if (error) {
      return { ok: false, reason: 'network', error: 'Could not load your wear history.' };
    }

    // PostgREST types an embedded select as a union with GenericStringError.
    // Narrowed through unknown once, here, rather than at each field access.
    const rows = (Array.isArray(data) ? data : []) as unknown as Array<Record<string, unknown>>;
    const hasMore = rows.length > pageSize;
    const entries = rows.slice(0, pageSize).map(toEntry);
    const last = entries.length > 0 ? entries[entries.length - 1] : null;

    return {
      ok: true,
      page: {
        entries,
        hasMore,
        nextCursor: hasMore && last ? { wornAt: last.wornAt, id: last.id } : null,
      },
    };
  } catch {
    return { ok: false, reason: 'network', error: 'Could not load your wear history.' };
  }
}

/** Every recorded wear of one garment, newest first. Bounded. */
export async function getItemWearHistory(
  sourceItemId: string,
  options: { limit?: number } = {},
  client: typeof supabase = supabase,
): Promise<WearHistoryReadResult> {
  const userId = await currentUserId(client);
  if (!userId) {
    return { ok: false, reason: 'unauthenticated', error: 'Sign in to see your wear history.' };
  }
  const id = bounded(sourceItemId, 128);
  if (!id) return { ok: true, page: { entries: [], hasMore: false, nextCursor: null } };

  const limit = Math.min(
    Math.max(1, options.limit ?? WEAR_HISTORY_PAGE_SIZE),
    WEAR_HISTORY_MAX_PAGE_SIZE,
  );

  try {
    const { data, error } = await client
      .from('wardrobe_wear_event_items')
      .select(
        'wear_event_id, source_item_id, source_type, title_snapshot, category_snapshot, ' +
          'wardrobe_wear_events(id, worn_at, saved_look_id, saved_look_ref)',
      )
      .eq('user_id', userId)
      .eq('source_item_id', id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    if (error) {
      return { ok: false, reason: 'network', error: 'Could not load this wear history.' };
    }

    const entries = (Array.isArray(data) ? data : [])
      .map((raw) => {
        const row = raw as unknown as Record<string, unknown>;
        const event = row.wardrobe_wear_events as Record<string, unknown> | null;
        if (!event) return null;
        const savedLookRef = (event.saved_look_ref as string | null) ?? null;
        const entry: WearHistoryEntry = {
          id: String(event.id),
          wornAt: String(event.worn_at),
          kind: savedLookRef ? 'saved_look' : 'item',
          savedLookRef,
          savedLookLive: !!event.saved_look_id,
          items: [
            {
              sourceItemId: String(row.source_item_id ?? ''),
              sourceType: String(row.source_type ?? 'unknown'),
              titleSnapshot: (row.title_snapshot as string | null) ?? null,
              categorySnapshot: (row.category_snapshot as string | null) ?? null,
            },
          ],
        };
        return entry;
      })
      .filter((entry): entry is WearHistoryEntry => entry !== null);

    const hasMore = entries.length > limit;

    return {
      ok: true,
      page: { entries: entries.slice(0, limit), hasMore, nextCursor: null },
    };
  } catch {
    return { ok: false, reason: 'network', error: 'Could not load this wear history.' };
  }
}

export type WearStatsResult =
  | { ok: true; stats: WearStats[]; truncated: boolean }
  | { ok: false; reason: 'unauthenticated' | 'network'; error: string };

/**
 * Wardrobe-wide statistics.
 *
 * Deliberately a SEPARATE query from getWearHistory. Deriving "most worn" from
 * whichever page happened to be on screen would produce a ranking that changes
 * as the user scrolls — a statistic that is wrong in a way the user cannot see.
 *
 * Bounded at WEAR_STATS_SCAN_LIMIT events. When that bound is hit, `truncated`
 * is true and the caller must not present the result as a complete wardrobe
 * ranking. Reporting the limit is the honest alternative to silently ranking a
 * sample as if it were everything.
 */
export async function getWearStats(
  options: { scanLimit?: number } = {},
  client: typeof supabase = supabase,
): Promise<WearStatsResult> {
  const userId = await currentUserId(client);
  if (!userId) {
    return { ok: false, reason: 'unauthenticated', error: 'Sign in to see your wardrobe stats.' };
  }

  const scanLimit = Math.min(
    Math.max(1, options.scanLimit ?? WEAR_STATS_SCAN_LIMIT),
    WEAR_STATS_SCAN_LIMIT,
  );

  try {
    const { data, error } = await client
      .from('wardrobe_wear_events')
      .select('id, worn_at, wardrobe_wear_event_items(source_item_id, deleted_at)')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('worn_at', { ascending: false })
      .limit(scanLimit + 1);

    if (error) {
      return { ok: false, reason: 'network', error: 'Could not load your wardrobe stats.' };
    }

    const rows = Array.isArray(data) ? data : [];
    const truncated = rows.length > scanLimit;
    const events = rows.slice(0, scanLimit).map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      const rawItems = Array.isArray(row.wardrobe_wear_event_items)
        ? (row.wardrobe_wear_event_items as Array<Record<string, unknown>>)
        : [];
      return {
        wornAt: String(row.worn_at),
        items: rawItems
          .filter((item) => !item.deleted_at)
          .map((item) => ({ sourceItemId: String(item.source_item_id ?? '') }))
          .filter((item) => item.sourceItemId.length > 0),
      };
    });

    return { ok: true, stats: projectWearStats(events), truncated };
  } catch {
    return { ok: false, reason: 'network', error: 'Could not load your wardrobe stats.' };
  }
}

// ── Ranking helpers (pure) ───────────────────────────────────────────────────

/**
 * Rank by wear count.
 *
 * Ties break on sourceItemId so the order is STABLE across renders. An
 * arbitrary tie order would let two equally-worn garments swap places on every
 * refresh, which reads as data changing when nothing has.
 */
export function rankByWear(
  stats: WearStats[],
  direction: 'most' | 'least',
  limit = 5,
): WearStats[] {
  const sorted = [...stats].sort((a, b) => {
    const delta =
      direction === 'most' ? b.timesWorn - a.timesWorn : a.timesWorn - b.timesWorn;
    if (delta !== 0) return delta;
    return a.sourceItemId < b.sourceItemId ? -1 : a.sourceItemId > b.sourceItemId ? 1 : 0;
  });
  return sorted.slice(0, Math.max(0, limit));
}

/**
 * Whether a ranking is worth showing at all.
 *
 * A "most worn" list built from two recorded wears is not a wardrobe insight,
 * it is noise presented with the authority of a statistic. Below this bar the
 * UI says it needs more history rather than ranking a sample.
 */
export const MIN_ITEMS_FOR_RANKING = 3;

export function rankingIsMeaningful(stats: WearStats[]): boolean {
  return stats.length >= MIN_ITEMS_FOR_RANKING;
}

/**
 * How a garment's wear state should be described to a user.
 *
 * `unknown` exists because of a real honesty problem. Wear tracking began at
 * Build 29; a garment saved before that has no recorded wears, but the user
 * may well have worn it many times. Telling them "Never worn" would be a
 * false statement about their own wardrobe. The UI says "No wears recorded"
 * for those and reserves "Not worn yet" for garments added after tracking
 * started, where the absence really is evidence.
 */
export type WearDisplayState = 'worn' | 'none_recorded' | 'unknown_legacy';

/**
 * When canonical wear tracking began.
 *
 * Anything saved before this date has no recorded wears for a reason that has
 * nothing to do with whether the user wore it, so the UI must not treat the
 * absence as evidence. Pinned to the S5 migration date.
 */
export const WEAR_TRACKING_STARTED_AT = '2026-08-14T00:00:00.000Z';

export function describeWearState(input: {
  timesWorn: number;
  itemAddedAt?: string | null;
  trackingStartedAt: string;
}): WearDisplayState {
  if (input.timesWorn > 0) return 'worn';
  const addedAt = input.itemAddedAt ? Date.parse(input.itemAddedAt) : Number.NaN;
  const trackingStart = Date.parse(input.trackingStartedAt);
  if (!Number.isFinite(addedAt) || !Number.isFinite(trackingStart)) return 'unknown_legacy';
  return addedAt >= trackingStart ? 'none_recorded' : 'unknown_legacy';
}
