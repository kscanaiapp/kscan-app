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
