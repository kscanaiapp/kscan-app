import { supabase } from '../supabaseClient';
import type {
  StyleMemoryEvent,
  StyleMemoryEventType,
  StyleMemorySourceRef,
} from './styleMemoryTypes';

const ITEM_FETCH_LIMIT = 200;
const REACTION_FETCH_LIMIT = 200;

// Mirrors requireUserId() in styleChatRepository.ts — never trust a user_id from the UI.
async function requireUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const id = data.session?.user?.id ?? null;
  if (!id) throw new Error('Sign in to use StyleChat.');
  return id;
}

function safeString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return null;
}

function safePositiveNumber(v: unknown): number | null {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : null;
}

function parseSourceRefs(raw: unknown): StyleMemorySourceRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is StyleMemorySourceRef => {
    return (
      r !== null &&
      typeof r === 'object' &&
      typeof (r as Record<string, unknown>).kind === 'string' &&
      typeof (r as Record<string, unknown>).id === 'string'
    );
  });
}

function mapMemoryEvent(row: Record<string, unknown>): StyleMemoryEvent | null {
  try {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      source: String(row.source),
      eventType: row.event_type as StyleMemoryEventType,
      signalKey: safeString(row.signal_key),
      signalDate: safeString(row.signal_date),
      payload:
        typeof row.payload === 'object' && row.payload !== null
          ? (row.payload as Record<string, unknown>)
          : {},
      confidence: typeof row.confidence === 'number' ? row.confidence : 0.5,
      sourceRefs: parseSourceRefs(row.source_refs),
      staleSourceCount:
        typeof row.stale_source_count === 'number' ? row.stale_source_count : 0,
      createdAt: String(row.created_at),
    };
  } catch {
    return null;
  }
}

// ── Public shapes returned to the summary builder ─────────────────────────────

export interface DressingRoomItemSignal {
  id: string;
  brand: string | null;
  category: string | null;
  priceAmount: number | null;
  currency: string | null;
  sourceType: string | null;
  colorFromScan: string | null;
}

export interface ReactionSignal {
  itemId: string;
  reactionType: string;
  brand: string | null;
  category: string | null;
}

// ── Read functions ─────────────────────────────────────────────────────────────

// Reads existing memory events. Returns empty in v0.3 until forward-looking
// event writing is wired via upsertStyleMemoryEvent.
export async function readMemoryEvents(): Promise<StyleMemoryEvent[]> {
  await requireUserId();
  const { data, error } = await supabase
    .from('style_memory_events')
    .select(
      'id, user_id, source, event_type, signal_key, signal_date, payload, confidence, source_refs, stale_source_count, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message || 'Unable to load style memory.');
  return (data ?? [])
    .map((row) => mapMemoryEvent(row as Record<string, unknown>))
    .filter((e): e is StyleMemoryEvent => e !== null);
}

// Reads dressing room items for passive signal extraction.
// RLS on dressing_room_items automatically scopes to the user's own rooms
// via the exists(select 1 from dressing_rooms where user_id = auth.uid()) policy.
export async function readDressingRoomItemSignals(): Promise<
  DressingRoomItemSignal[]
> {
  await requireUserId();
  const { data, error } = await supabase
    .from('dressing_room_items')
    .select('id, brand, category, price_amount, currency, source_type, snapshot_payload')
    .limit(ITEM_FETCH_LIMIT);
  if (error) throw new Error(error.message || 'Unable to read item signals.');

  return (data ?? []).map((row: Record<string, unknown>): DressingRoomItemSignal => {
    let colorFromScan: string | null = null;
    if (row.source_type === 'scan_image') {
      try {
        const payload = row.snapshot_payload as Record<string, unknown> | null;
        const meta = payload?.metadata as Record<string, unknown> | undefined;
        colorFromScan = safeString(meta?.color);
      } catch {
        colorFromScan = null;
      }
    }
    return {
      id: String(row.id),
      brand: safeString(row.brand),
      category: safeString(row.category),
      priceAmount: safePositiveNumber(row.price_amount),
      currency: safeString(row.currency),
      sourceType: safeString(row.source_type),
      colorFromScan,
    };
  });
}

// Reads the current user's item reactions and joins brand/category from the
// reacted items. Items RLS limits results to the user's own rooms, so reactions
// on publicly-shared items the user doesn't own will not contribute signals.
export async function readReactionSignals(): Promise<ReactionSignal[]> {
  await requireUserId();
  const { data: reactions, error: reactionsError } = await supabase
    .from('dressing_room_item_reactions')
    .select('item_id, reaction_type')
    .limit(REACTION_FETCH_LIMIT);
  if (reactionsError) {
    throw new Error(reactionsError.message || 'Unable to read reaction signals.');
  }

  const reactionRows = (reactions ?? []) as Array<Record<string, unknown>>;
  if (reactionRows.length === 0) return [];

  const itemIds = Array.from(
    new Set(
      reactionRows
        .map((r) => r.item_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );
  if (itemIds.length === 0) return [];

  const { data: items, error: itemsError } = await supabase
    .from('dressing_room_items')
    .select('id, brand, category')
    .in('id', itemIds);
  if (itemsError) {
    throw new Error(itemsError.message || 'Unable to read item details for reactions.');
  }

  const itemMap = new Map<string, { brand: string | null; category: string | null }>();
  ((items ?? []) as Array<Record<string, unknown>>).forEach((item) => {
    itemMap.set(String(item.id), {
      brand: safeString(item.brand),
      category: safeString(item.category),
    });
  });

  return reactionRows
    .map((r): ReactionSignal | null => {
      const itemId = typeof r.item_id === 'string' ? r.item_id : null;
      if (!itemId) return null;
      const meta = itemMap.get(itemId) ?? { brand: null, category: null };
      return {
        itemId,
        reactionType: String(r.reaction_type),
        brand: meta.brand,
        category: meta.category,
      };
    })
    .filter((r): r is ReactionSignal => r !== null);
}

// ── Write function (via RPC) ───────────────────────────────────────────────────

// Calls the upsert_style_memory_event SECURITY DEFINER RPC.
// Not called in the v0.3 active chat flow — wired in a future milestone
// when forward-looking event creation trigger points are identified.
export async function upsertStyleMemoryEvent(input: {
  source: string;
  eventType: StyleMemoryEventType;
  signalKey: string;
  signalDate?: Date;
  payload: Record<string, unknown>;
  confidence: number;
  sourceRefs: StyleMemorySourceRef[];
}): Promise<string> {
  await requireUserId();
  const { data, error } = await supabase.rpc('upsert_style_memory_event', {
    p_source: input.source,
    p_event_type: input.eventType,
    p_signal_key: input.signalKey,
    p_signal_date: input.signalDate
      ? input.signalDate.toISOString().slice(0, 10)
      : null,
    p_payload: input.payload,
    p_confidence: input.confidence,
    p_source_refs: input.sourceRefs,
  });
  if (error) throw new Error(error.message || 'Unable to save style memory event.');
  return String(data);
}
