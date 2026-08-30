/**
 * commerce-watch-refresh — K5-C2/C3/C4/C7: the entire authenticated-write
 * and refresh surface for K+ Smart Watchlist V1.
 *
 * Two callers, two auth modes, one function (§30-§34, §67):
 *   - Tier 1 (user-open): Authorization: Bearer <user JWT>. Actions: create,
 *     pause, resume, delete, refresh. Identity is derived exclusively from
 *     requireUser() — the request body is never trusted for a user id.
 *   - Tier 2 (background sweep): x-watchlist-worker-secret header, no JWT.
 *     Claims a small bounded batch of due, K+-active watches and refreshes
 *     them the same way Tier 1 does (evaluateWatchRefresh is the ONLY
 *     change-detection path either mode uses — §57, "no duplicate monitoring
 *     implementation").
 *
 * This function does NOT own commerce ranking, retailer ranking, discovery,
 * affiliate routing, Scanner, or search (§31). It never calls
 * services/commerceDestination.ts or anything that fires a click/affiliate
 * event — automated refresh is server observation, not a user action (§33).
 *
 * verify_jwt = false at the platform level (see supabase/config.toml): this
 * function authenticates itself, exactly like scan-identify and the other
 * worker-secret functions, because it must accept BOTH an unauthenticated
 * worker call and a normal user bearer token on the same endpoint.
 */
import {
  corsHeaders,
  json,
  logEvent,
  alertEvent,
  envOptional,
  isValidUuid,
  readAppConfigFlag,
  requireUser,
  rest,
  rpc,
  shortUserId,
  type AuthUser,
} from '../_shared/deletion/common.ts';
import { normalizeUrl } from '../scan-identify/shoppingProvider.ts';
import { parseOfferPrice } from '../scan-identify/canonicalCommerce.ts';
import { deriveWatchCapability, watchProviderForUrl } from '../scan-identify/watchlistCapability.ts';
import { evaluateWatchRefresh, type WatchState } from './changeEngine.ts';
import { refreshWatchObservation } from './watchRefreshObservation.ts';
import {
  MIN_REFRESH_INTERVAL_MS,
  USER_REFRESH_BATCH_CAP,
  WORKER_SWEEP_BATCH_CAP,
  REFRESH_CONCURRENCY,
  UNAVAILABLE_AFTER_CONSECUTIVE_FAILURES,
} from './watchRefreshConfig.ts';

// ── Worker authentication (mirrors process-account-deletions) ──────────────

function requireWorkerSecret(req: Request): boolean {
  const expected = envOptional('WATCHLIST_WORKER_SECRET');
  const provided = req.headers.get('x-watchlist-worker-secret')?.trim();
  if (!expected || !provided) return false;
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

// ── Small bounded concurrency helper (no cross-watch cache to share — §59) ─

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Row shape from PostgREST ────────────────────────────────────────────--

interface WatchRow {
  id: string;
  user_id: string;
  source: string;
  canonical_url: string;
  currency: string;
  current_price_amount: number | null;
  target_price_amount: number | null;
  watch_intent: 'just_watching' | 'buy_under';
  target_reached_at: string | null;
  last_status: WatchState['lastStatus'];
  consecutive_failures: number;
  last_checked_at: string | null;
  status: 'active' | 'paused' | 'deleted';
}

function toWatchState(row: WatchRow): WatchState {
  return {
    currency: row.currency,
    currentPriceAmount: row.current_price_amount,
    targetPriceAmount: row.target_price_amount,
    watchIntent: row.watch_intent,
    targetReachedAt: row.target_reached_at,
    lastStatus: row.last_status,
    consecutiveFailures: row.consecutive_failures,
  };
}

/** One refresh cycle for one already-fetched watch row. Never throws. */
async function runRefreshCycle(row: WatchRow): Promise<{
  watchId: string;
  refreshStatus: string;
  observedAt: string;
  currentPrice: number | null;
  currency: string;
  event: string | null;
  refreshMetadata: { provider: string; latencyMs: number; errorCode?: string };
}> {
  const observedAt = new Date().toISOString();
  const outcome = await refreshWatchObservation({
    source: row.source,
    canonicalUrl: row.canonical_url,
    currency: row.currency,
  });
  const result = evaluateWatchRefresh(toWatchState(row), outcome.observation, {
    unavailableAfterFailures: UNAVAILABLE_AFTER_CONSECUTIVE_FAILURES,
    observedAt,
  });

  const patchResponse = await rest(`user_commerce_watches?id=eq.${row.id}&user_id=eq.${row.user_id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      current_price_amount: result.newCurrentPriceAmount,
      last_status: result.newLastStatus,
      consecutive_failures: result.newConsecutiveFailures,
      target_reached_at: result.newTargetReachedAt,
      last_checked_at: observedAt,
    }),
  });
  if (!patchResponse.ok) {
    logEvent('watchlist_refresh_write_failed', { watchId: row.id.slice(0, 8), status: patchResponse.status });
  }

  if (result.event) {
    const appendResponse = await rpc('append_user_commerce_watch_event', {
      p_watch_id: row.id,
      p_user_id: row.user_id,
      p_event_type: result.event.type,
      p_price_amount: result.event.priceAmount,
      p_currency: result.event.currency,
    });
    if (!appendResponse.ok) {
      logEvent('watchlist_event_append_failed', { watchId: row.id.slice(0, 8), status: appendResponse.status });
    }
  }

  return {
    watchId: row.id,
    refreshStatus: result.refreshStatus,
    observedAt,
    currentPrice: result.newCurrentPriceAmount,
    currency: row.currency,
    event: result.event?.type ?? null,
    refreshMetadata: outcome.metadata,
  };
}

// ── Tier 2: worker sweep ────────────────────────────────────────────────--

async function runWorkerSweep(): Promise<Response> {
  const enabled = await readAppConfigFlag('watchlist_worker_enabled');
  if (!enabled) {
    logEvent('watchlist_worker_kill_switch_skip', {});
    return json({ mode: 'sweep', enabled: false, claimed: 0, results: [] });
  }

  const claimResponse = await rpc('claim_watchable_commerce_watches', {
    p_limit: WORKER_SWEEP_BATCH_CAP,
    p_min_interval_ms: MIN_REFRESH_INTERVAL_MS,
  });
  if (!claimResponse.ok) {
    logEvent('watchlist_worker_claim_failed', { status: claimResponse.status });
    return json({ error: 'Claim failed' }, 500);
  }
  const claimed = (await claimResponse.json()) as WatchRow[];
  logEvent('watchlist_worker_claim', { count: claimed.length });

  const results = await mapWithConcurrency(claimed, REFRESH_CONCURRENCY, async (row) => {
    try {
      return await runRefreshCycle(row);
    } catch (err) {
      alertEvent('watchlist_worker_refresh_threw', {
        watchId: row.id.slice(0, 8),
        message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      });
      return { watchId: row.id, refreshStatus: 'error', observedAt: new Date().toISOString(), currentPrice: null, currency: row.currency, event: null, refreshMetadata: { provider: row.source, latencyMs: 0, errorCode: 'threw' } };
    }
  });

  return json({ mode: 'sweep', enabled: true, claimed: claimed.length, results });
}

// ── Tier 1: authenticated user actions ──────────────────────────────────--

type UserActionBody = {
  action?: unknown;
  watchId?: unknown;
  listing?: {
    productUrl?: unknown;
    title?: unknown;
    price?: unknown;
    source?: unknown;
    imageUrl?: unknown;
    type?: unknown;
    commerceType?: unknown;
  };
  watchIntent?: unknown;
  targetPriceAmount?: unknown;
};

function str(v: unknown, max = 2048): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

async function handleCreate(authUser: AuthUser, body: UserActionBody): Promise<Response> {
  const listing = body.listing;
  if (!listing || typeof listing !== 'object') {
    return json({ error: 'listing_required', code: 'listing_required' }, 400);
  }

  // Re-derive capability server-side. Any client-echoed watchCapability is
  // ignored -- the audit is explicit that a client must never be trusted to
  // self-report eligibility (§54, §21).
  const capability = deriveWatchCapability(listing as Record<string, unknown>);
  if (capability !== 'refreshable_listing') {
    return json({ error: 'unsupported_listing', code: 'unsupported_listing' }, 422);
  }

  const safeUrl = normalizeUrl(listing.productUrl);
  const provider = watchProviderForUrl(safeUrl);
  if (!safeUrl || !provider) {
    return json({ error: 'unsafe_url', code: 'unsafe_url' }, 422);
  }

  const title = str(listing.title, 200);
  if (!title) {
    return json({ error: 'title_required', code: 'title_required' }, 400);
  }
  const imageUrl = str(listing.imageUrl, 2048);

  const parsedPrice = parseOfferPrice(listing.price);
  if (parsedPrice.value === null || !parsedPrice.currency) {
    // §25: a watch cannot be armed (nor even created as "just watching" with
    // a trustworthy starting price) without a confident currency read.
    return json({ error: 'currency_required', code: 'currency_required' }, 422);
  }

  const watchIntent = body.watchIntent === 'buy_under' ? 'buy_under' : 'just_watching';
  let targetPriceAmount: number | null = null;
  if (watchIntent === 'buy_under') {
    const raw = body.targetPriceAmount;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return json({ error: 'invalid_target', code: 'invalid_target' }, 400);
    }
    targetPriceAmount = n;
  }

  const createResponse = await rpc('create_user_commerce_watch', {
    p_user_id: authUser.id,
    p_source: provider,
    p_canonical_url: safeUrl,
    p_provider_listing_id: null,
    p_display_title: title,
    p_display_image_url: imageUrl ?? null,
    p_initial_price_amount: parsedPrice.value,
    p_currency: parsedPrice.currency,
    p_watch_intent: watchIntent,
    p_target_price_amount: targetPriceAmount,
  });

  if (!createResponse.ok) {
    const detail = await createResponse.text().catch(() => '');
    if (detail.includes('42501')) {
      return json({ error: 'kplus_required', code: 'kplus_required' }, 403);
    }
    logEvent('watchlist_create_failed', { uid: shortUserId(authUser.id), status: createResponse.status });
    return json({ error: 'create_failed', code: 'create_failed' }, 502);
  }

  const rows = await createResponse.json();
  const watch = Array.isArray(rows) ? rows[0] : rows;
  logEvent('watchlist_watch_created', { uid: shortUserId(authUser.id), provider });
  return json({ watch });
}

async function handleLifecycleAction(
  authUser: AuthUser,
  action: 'pause' | 'resume' | 'delete',
  watchId: unknown,
): Promise<Response> {
  if (typeof watchId !== 'string' || !isValidUuid(watchId)) {
    return json({ error: 'invalid_watch_id', code: 'invalid_watch_id' }, 400);
  }

  const fnName = action === 'pause'
    ? 'pause_user_commerce_watch'
    : action === 'resume'
      ? 'resume_user_commerce_watch'
      : 'delete_user_commerce_watch';

  const response = await rpc(fnName, { p_user_id: authUser.id, p_watch_id: watchId });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (detail.includes('42501')) {
      return json({ error: 'kplus_required', code: 'kplus_required' }, 403);
    }
    if (detail.includes('P0002')) {
      return json({ error: 'not_found', code: 'not_found' }, 404);
    }
    logEvent('watchlist_lifecycle_failed', { uid: shortUserId(authUser.id), action, status: response.status });
    return json({ error: `${action}_failed`, code: `${action}_failed` }, 502);
  }

  if (action === 'delete') {
    const deleted = await response.json();
    return json({ deleted: deleted === true });
  }
  const rows = await response.json();
  const watch = Array.isArray(rows) ? rows[0] : rows;
  return json({ watch });
}

async function handleRefresh(authUser: AuthUser, watchId: unknown): Promise<Response> {
  const kplus = await rpc('kplus_has_active_entitlement', { p_user_id: authUser.id, p_entitlement_key: 'k_plus' });
  const kplusActive = kplus.ok && (await kplus.json()) === true;
  if (!kplusActive) {
    return json({ error: 'kplus_required', code: 'kplus_required' }, 403);
  }

  const staleCutoff = new Date(Date.now() - MIN_REFRESH_INTERVAL_MS).toISOString();
  let path = `user_commerce_watches?user_id=eq.${authUser.id}&status=eq.active&deleted_at=is.null`;
  if (typeof watchId === 'string' && isValidUuid(watchId)) {
    path += `&id=eq.${watchId}`;
  } else {
    // §38: opening/re-rendering Watchlist must not repeatedly invoke
    // providers -- watches checked inside the min interval are skipped, not
    // re-fetched, regardless of how often the screen refreshes.
    path += `&or=(last_checked_at.is.null,last_checked_at.lt.${staleCutoff})`;
    path += `&limit=${USER_REFRESH_BATCH_CAP}`;
  }

  const rowsResponse = await rest(path, { method: 'GET' });
  if (!rowsResponse.ok) {
    return json({ error: 'lookup_failed', code: 'lookup_failed' }, 502);
  }
  const rows = (await rowsResponse.json()) as WatchRow[];

  if (typeof watchId === 'string' && isValidUuid(watchId) && rows.length === 0) {
    // Distinguish "not due yet" versus "not found" only for the single-watch
    // case, so a manual Refresh button can show "already fresh" honestly.
    const existsResponse = await rest(
      `user_commerce_watches?id=eq.${watchId}&user_id=eq.${authUser.id}&deleted_at=is.null&select=id,last_checked_at`,
      { method: 'GET' },
    );
    const existsRows = existsResponse.ok ? await existsResponse.json() : [];
    if (Array.isArray(existsRows) && existsRows.length > 0) {
      return json({ refreshed: [], skipped: [{ watchId, reason: 'too_recent' }] });
    }
    return json({ error: 'not_found', code: 'not_found' }, 404);
  }

  const refreshed = await mapWithConcurrency(rows, REFRESH_CONCURRENCY, runRefreshCycle);
  return json({ refreshed });
}

// ── Entry point ──────────────────────────────────────────────────────────-

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (requireWorkerSecret(req)) {
    try {
      return await runWorkerSweep();
    } catch (err) {
      alertEvent('watchlist_worker_unexpected_error', {
        message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      });
      return json({ error: 'Worker failed' }, 500);
    }
  }

  let authUser: AuthUser;
  try {
    authUser = await requireUser(req);
  } catch (response) {
    if (response instanceof Response) return response;
    return json({ error: 'Authentication required' }, 401);
  }

  let body: UserActionBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  }

  switch (body.action) {
    case 'create':
      return handleCreate(authUser, body);
    case 'pause':
    case 'resume':
    case 'delete':
      return handleLifecycleAction(authUser, body.action, body.watchId);
    case 'refresh':
      return handleRefresh(authUser, body.watchId);
    default:
      return json({ error: 'unknown_action', code: 'unknown_action' }, 400);
  }
});
