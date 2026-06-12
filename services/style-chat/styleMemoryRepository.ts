import { supabase } from '../supabaseClient';
import {
  STYLE_MEMORY_NEGATIVE_REACTION_TYPES,
  STYLE_MEMORY_POSITIVE_REACTION_TYPES,
} from '../../constants/styleMemory';
import type {
  StyleMemoryEvent,
  StyleMemoryEventType,
  StyleMemorySourceKind,
  StyleMemorySourceRef,
} from './styleMemoryTypes';
import {
  isNegativeMemoryReactionType,
  validateStyleMemoryPayload,
} from './memoryPayloadValidators';

const ITEM_FETCH_LIMIT = 200;
const REACTION_FETCH_LIMIT = 200;
const POSITIVE_REACTIONS = new Set<string>(STYLE_MEMORY_POSITIVE_REACTION_TYPES);
const NEGATIVE_REACTIONS = new Set<string>(STYLE_MEMORY_NEGATIVE_REACTION_TYPES);

// Mirrors requireUserId() in styleChatRepository.ts - never trust a user_id from the UI.
export async function requireUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const id = data.session?.user?.id ?? null;
  if (!id) throw new Error('Sign in to use StyleChat.');
  return id;
}

function safeString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return null;
}

function safePositiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseSourceRefs(raw: unknown): StyleMemorySourceRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is StyleMemorySourceRef => {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).kind === 'string' &&
      typeof (value as Record<string, unknown>).id === 'string'
    );
  });
}

function isNegativeMemoryEvent(row: Record<string, unknown>): boolean {
  if (row.event_type !== 'dressing_room_positive_feedback') return false;
  const payload = row.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return isNegativeMemoryReactionType((payload as Record<string, unknown>).reactionType);
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

// Reads existing memory events. Negative thumbs_down rows are filtered out so
// legacy bad data cannot inflate debug counts or future summaries.
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
    .filter((row) => !isNegativeMemoryEvent(row as Record<string, unknown>))
    .map((row) => mapMemoryEvent(row as Record<string, unknown>))
    .filter((event): event is StyleMemoryEvent => event !== null);
}

// Reads dressing room items for passive signal extraction.
// RLS on dressing_room_items automatically scopes to the user's own rooms.
export async function readDressingRoomItemSignals(): Promise<DressingRoomItemSignal[]> {
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
        const metadata = payload?.metadata as Record<string, unknown> | undefined;
        colorFromScan = safeString(metadata?.color);
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
// reacted items. Negative reactions are intentionally excluded from positive
// preference aggregation in v0.3.1.
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
        .map((reaction) => reaction.item_id)
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
    .map((reaction): ReactionSignal | null => {
      const itemId = typeof reaction.item_id === 'string' ? reaction.item_id : null;
      const reactionType =
        typeof reaction.reaction_type === 'string' ? reaction.reaction_type : null;
      if (!itemId || !reactionType) return null;
      if (NEGATIVE_REACTIONS.has(reactionType)) return null;
      if (!POSITIVE_REACTIONS.has(reactionType)) return null;

      const itemMeta = itemMap.get(itemId) ?? { brand: null, category: null };
      return {
        itemId,
        reactionType,
        brand: itemMeta.brand,
        category: itemMeta.category,
      };
    })
    .filter((reaction): reaction is ReactionSignal => reaction !== null);
}

// Calls the upsert_style_memory_event SECURITY DEFINER RPC.
// Not called in the v0.3 active chat flow. Validation is enforced here so
// arbitrary JSONB payloads never reach the RPC boundary.
export async function upsertStyleMemoryEvent(input: {
  source: StyleMemorySourceKind;
  eventType: StyleMemoryEventType;
  signalKey: string;
  signalDate?: Date;
  payload: Record<string, unknown>;
  confidence: number;
  sourceRefs: StyleMemorySourceRef[];
}): Promise<string | null> {
  await requireUserId();

  const validatedPayload = validateStyleMemoryPayload(input.eventType, input.payload);
  if (!validatedPayload) {
    if (__DEV__) {
      console.warn('[styleMemory] skipped invalid memory payload');
    }
    return null;
  }

  if (validatedPayload.signalKey !== input.signalKey || validatedPayload.source !== input.source) {
    if (__DEV__) {
      console.warn('[styleMemory] skipped mismatched memory payload metadata');
    }
    return null;
  }

  const payloadSourceRefs = validatedPayload.sourceRefs;
  if (payloadSourceRefs.length !== input.sourceRefs.length) {
    if (__DEV__) {
      console.warn('[styleMemory] skipped mismatched memory source refs');
    }
    return null;
  }

  for (let index = 0; index < payloadSourceRefs.length; index += 1) {
    if (
      payloadSourceRefs[index].kind !== input.sourceRefs[index]?.kind ||
      payloadSourceRefs[index].id !== input.sourceRefs[index]?.id
    ) {
      if (__DEV__) {
        console.warn('[styleMemory] skipped reordered or mismatched source refs');
      }
      return null;
    }
  }

  const { data, error } = await supabase.rpc('upsert_style_memory_event', {
    p_source: input.source,
    p_event_type: input.eventType,
    p_signal_key: validatedPayload.signalKey,
    p_signal_date: input.signalDate
      ? input.signalDate.toISOString().slice(0, 10)
      : null,
    p_payload: validatedPayload,
    p_confidence: input.confidence,
    p_source_refs: payloadSourceRefs,
  });

  if (error) throw new Error(error.message || 'Unable to save style memory event.');
  return String(data);
}
