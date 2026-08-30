/**
 * K+ Smart Watchlist V1 client.
 *
 * Reads go straight through Supabase (RLS: `user_id = auth.uid()`, no K+
 * required -- an expired-K+ user must still see a Watch they already made).
 * Every write (create/pause/resume/delete/refresh) goes through the
 * commerce-watch-refresh Edge Function, never a direct table write -- there
 * is no client INSERT/UPDATE/DELETE policy on either table to write through.
 */
import { supabase } from '../supabaseClient';
import { resolveAuthenticatedFunctionSession } from '../authenticatedFunctionSession';
import type {
  CommerceWatch,
  CommerceWatchEvent,
  WatchIntent,
  WatchableListing,
} from '../../types/watchlist';

type RawWatchRow = {
  id: string;
  source: string;
  canonical_url: string;
  display_title: string;
  display_image_url: string | null;
  initial_price_amount: number | null;
  current_price_amount: number | null;
  currency: string;
  watch_intent: WatchIntent;
  target_price_amount: number | null;
  target_reached_at: string | null;
  status: CommerceWatch['status'];
  last_checked_at: string | null;
  last_status: CommerceWatch['lastStatus'];
  created_at: string;
};

function fromRow(row: RawWatchRow): CommerceWatch {
  return {
    id: row.id,
    source: row.source,
    canonicalUrl: row.canonical_url,
    displayTitle: row.display_title,
    displayImageUrl: row.display_image_url,
    initialPriceAmount: row.initial_price_amount,
    currentPriceAmount: row.current_price_amount,
    currency: row.currency,
    watchIntent: row.watch_intent,
    targetPriceAmount: row.target_price_amount,
    targetReachedAt: row.target_reached_at,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastStatus: row.last_status,
    createdAt: row.created_at,
  };
}

const WATCH_COLUMNS =
  'id, source, canonical_url, display_title, display_image_url, initial_price_amount, ' +
  'current_price_amount, currency, watch_intent, target_price_amount, target_reached_at, ' +
  'status, last_checked_at, last_status, created_at';

export type WatchlistResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'signed_out' | 'session_expired' | 'read_failed' | 'request_failed' | string };

/** Every non-deleted Watch for the current user, most recent first. */
export async function fetchWatchlist(): Promise<WatchlistResult<CommerceWatch[]>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user?.id) return { ok: false, reason: 'signed_out' };

  const { data, error } = await supabase
    .from('user_commerce_watches')
    .select(WATCH_COLUMNS)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) return { ok: false, reason: 'read_failed' };
  return { ok: true, data: (data as unknown as RawWatchRow[]).map(fromRow) };
}

export async function fetchWatch(watchId: string): Promise<WatchlistResult<CommerceWatch>> {
  const { data, error } = await supabase
    .from('user_commerce_watches')
    .select(WATCH_COLUMNS)
    .eq('id', watchId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error || !data) return { ok: false, reason: 'read_failed' };
  return { ok: true, data: fromRow(data as unknown as RawWatchRow) };
}

export async function fetchWatchEvents(watchId: string): Promise<WatchlistResult<CommerceWatchEvent[]>> {
  const { data, error } = await supabase
    .from('user_commerce_watch_events')
    .select('id, watch_id, event_type, price_amount, currency, observed_at')
    .eq('watch_id', watchId)
    .order('observed_at', { ascending: false })
    .limit(20);

  if (error) return { ok: false, reason: 'read_failed' };
  return {
    ok: true,
    data: (data as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      watchId: String(row.watch_id),
      eventType: row.event_type as CommerceWatchEvent['eventType'],
      priceAmount: row.price_amount as number | null,
      currency: row.currency as string | null,
      observedAt: String(row.observed_at),
    })),
  };
}

async function invokeWatchAction(body: Record<string, unknown>): Promise<WatchlistResult<Record<string, unknown>>> {
  const session = await resolveAuthenticatedFunctionSession();
  if (session.ok === false) {
    return { ok: false, reason: session.reason };
  }
  const { data, error } = await supabase.functions.invoke('commerce-watch-refresh', { body });
  if (error) return { ok: false, reason: 'request_failed' };
  if (data && typeof data === 'object' && 'error' in data) {
    return { ok: false, reason: String((data as { code?: string }).code ?? (data as { error?: string }).error) };
  }
  return { ok: true, data: data as Record<string, unknown> };
}

export async function createWatch(params: {
  listing: WatchableListing;
  watchIntent: WatchIntent;
  targetPriceAmount?: number;
}): Promise<WatchlistResult<CommerceWatch>> {
  const result = await invokeWatchAction({
    action: 'create',
    listing: params.listing,
    watchIntent: params.watchIntent,
    targetPriceAmount: params.targetPriceAmount,
  });
  if (!result.ok) {
    return { ok: false, reason: 'reason' in result ? result.reason : 'request_failed' };
  }
  return { ok: true, data: fromRow(result.data.watch as RawWatchRow) };
}

export async function pauseWatch(watchId: string): Promise<WatchlistResult<CommerceWatch>> {
  const result = await invokeWatchAction({ action: 'pause', watchId });
  if (!result.ok) {
    return { ok: false, reason: 'reason' in result ? result.reason : 'request_failed' };
  }
  return { ok: true, data: fromRow(result.data.watch as RawWatchRow) };
}

export async function resumeWatch(watchId: string): Promise<WatchlistResult<CommerceWatch>> {
  const result = await invokeWatchAction({ action: 'resume', watchId });
  if (!result.ok) {
    return { ok: false, reason: 'reason' in result ? result.reason : 'request_failed' };
  }
  return { ok: true, data: fromRow(result.data.watch as RawWatchRow) };
}

export async function deleteWatch(watchId: string): Promise<WatchlistResult<boolean>> {
  const result = await invokeWatchAction({ action: 'delete', watchId });
  if (!result.ok) {
    return { ok: false, reason: 'reason' in result ? result.reason : 'request_failed' };
  }
  return { ok: true, data: result.data.deleted === true };
}

/** Manual refresh: one Watch (from the detail screen) or the user's due batch (list open). */
export async function refreshWatches(watchId?: string): Promise<WatchlistResult<Record<string, unknown>>> {
  return invokeWatchAction({ action: 'refresh', ...(watchId ? { watchId } : {}) });
}
