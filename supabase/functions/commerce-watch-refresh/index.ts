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
import { resolveObservedCurrency } from './watchCurrency.ts';
import { refreshWatchObservation } from './watchRefreshObservation.ts';
import { sendWatchPush } from './pushDelivery.ts';
import {
  drainEligiblePushReceipts,
  persistPendingPushReceipt,
  pruneOldPushReceipts,
  retireStalePushRoute,
} from './receiptProcessing.ts';
import { mapVendorErrorToReasonCode, recordPushOperationalEvent } from './pushObservability.ts';
import {
  MIN_REFRESH_INTERVAL_MS,
  USER_REFRESH_BATCH_CAP,
  WORKER_SWEEP_BATCH_CAP,
  REFRESH_CONCURRENCY,
  UNAVAILABLE_AFTER_CONSECUTIVE_FAILURES,
  MAX_ACTIVE_WATCHES_PER_ACTOR,
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

/**
 * WL-05 - drain the request body before answering on a path that never reads it.
 *
 * A Supabase Edge Function that returns a Response while `req.body` is still
 * unread leaves the edge connection with an un-drained request stream. Bodies
 * above the in-flight transport buffer (~0.5 MB) then stall until the platform
 * idle timeout (~160s) and answer 503. This is not theory: it was reproduced and
 * fixed on `wearable-bridge`, whose early-exit paths had exactly this shape.
 *
 * Three paths here answer without reading a body - method-not-allowed, the
 * requireUser rejection, and the whole worker sweep (which is selected by a
 * header and deliberately ignores the body). An unauthenticated caller can
 * therefore hold an edge connection open for ~160s per request with a single
 * oversized POST. Read-and-discard, never buffer, and never let a drain failure
 * change the answer.
 */
async function drainRequestBody(req: Request): Promise<void> {
  try {
    if (!req.body || req.bodyUsed) return;
    const reader = req.body.getReader();
    let discarded = 0;
    const MAX_DRAIN_BYTES = 16 * 1024 * 1024;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      discarded += value?.byteLength ?? 0;
      if (discarded > MAX_DRAIN_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    // The response is already decided; a drain failure must never change it.
  }
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
  display_title: string;
  push_enabled: boolean;
}

/**
 * Push is sent only for the one alert condition V1 actually arms (§43: "Push
 * notifications in V1 are driven primarily by explicit user alert
 * conditions") and only when the user opted in per-Watch (push_enabled).
 * Never blocks or fails the refresh cycle that triggered it — the price/
 * event write already committed independently of delivery succeeding.
 */
async function deliverPushIfArmed(
  row: WatchRow,
  event: { type: string; priceAmount: number | null; currency: string | null } | null,
): Promise<void> {
  if (!event || event.type !== 'target_price_reached' || !row.push_enabled) return;

  // NOTIF-06: every live device, not just the most recently used one. A user
  // with a phone and a tablet was previously alerted on exactly one of them,
  // silently, with no way to tell which. Each token is delivered and retired
  // INDEPENDENTLY so one dead route cannot suppress a live sibling.
  //
  // N-4: `id` is selected alongside the token now because both the immediate
  // ticket-error path and the deferred receipt path below retire routes by
  // exact row identity + current push_token match, never by device_id alone
  // (see retireStalePushRoute in receiptProcessing.ts).
  const tokenResponse = await rest(
    `user_device_push_tokens?user_id=eq.${row.user_id}&revoked_at=is.null&select=id,push_token,device_id&order=last_used_at.desc.nullslast`,
    { method: 'GET' },
  );
  if (!tokenResponse.ok) return;
  const tokens = (await tokenResponse.json()) as Array<{ id: string; push_token: string; device_id: string }>;
  const liveTokens = (tokens ?? []).filter((t) => Boolean(t?.push_token));
  if (liveTokens.length === 0) return;

  const payload = {
    watchId: row.id,
    eventType: 'target_price_reached' as const,
    displayTitle: row.display_title,
    priceText: event.priceAmount != null ? `${event.currency ?? row.currency} ${event.priceAmount}` : null,
  };

  await Promise.all(
    liveTokens.map(async (tokenRow) => {
      // One token's failure is contained here: no throw escapes, and no
      // sibling delivery is skipped because of it.
      // N-5: emitted BEFORE the send, unlike every receipt-side event below
      // — this one specifically answers "was a push even attempted", which
      // by definition cannot be known only after the fact.
      recordPushOperationalEvent({
        type: 'push_send_attempted',
        component: 'send',
        routeId: tokenRow.id,
      });
      try {
        const result = await sendWatchPush(tokenRow.push_token, payload);
        if (!result.ok) {
          logEvent('watchlist_push_delivery_failed', {
            watchId: row.id.slice(0, 8),
            errorCode: result.errorCode,
          });
          recordPushOperationalEvent({
            type: 'push_ticket_rejected',
            component: 'send',
            reason: mapVendorErrorToReasonCode(result.errorCode),
            routeId: tokenRow.id,
          });
          // A ticket-confirmed dead token is revoked immediately rather than
          // left to accumulate silent future failures (§63 "stale push
          // token"). N-4: scoped to the EXACT token this send used (row id +
          // current push_token match), never to device_id alone — a
          // device_id-scoped revoke here could retire a token the OS
          // refreshed to between the SELECT above and this call landing.
          if (result.tokenInvalid) {
            await retireStalePushRoute({
              tokenRowId: tokenRow.id,
              expectedPushToken: tokenRow.push_token,
            }).catch(() => 'skipped_stale' as const);
          }
        } else {
          recordPushOperationalEvent({
            type: 'push_ticket_accepted',
            component: 'send',
            routeId: tokenRow.id,
          });
          if (result.ticketId) {
            // NOTIF-12/N-4: an accepted ticket is not delivery. Persist it so
            // the deferred receipt drain can later learn the real outcome and
            // retire the route if — and only if — it turns out to be exactly
            // this token incarnation that failed.
            await persistPendingPushReceipt({
              ticketId: result.ticketId,
              tokenRowId: tokenRow.id,
              pushToken: tokenRow.push_token,
              userId: row.user_id,
            });
          }
        }
      } catch (error) {
        logEvent('watchlist_push_delivery_failed', {
          watchId: row.id.slice(0, 8),
          errorCode: error instanceof Error ? error.name : 'unknown',
        });
        recordPushOperationalEvent({
          type: 'push_ticket_rejected',
          component: 'send',
          reason: 'network_error',
          routeId: tokenRow.id,
        });
      }
    }),
  );
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

  // WL-02 - `deleted_at=is.null` is load-bearing, not decoration. Without it
  // this PATCH matched (and mutated) a watch the user deleted while the provider
  // call was in flight: a tombstoned row kept acquiring fresh prices and a fresh
  // last_checked_at.
  const patchResponse = await rest(
    `user_commerce_watches?id=eq.${row.id}&user_id=eq.${row.user_id}&deleted_at=is.null`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        current_price_amount: result.newCurrentPriceAmount,
        last_status: result.newLastStatus,
        consecutive_failures: result.newConsecutiveFailures,
        target_reached_at: result.newTargetReachedAt,
        last_checked_at: observedAt,
      }),
    },
  );

  // WL-03 - this write IS the deduplication. There is no idempotency key on
  // user_commerce_watch_events; the same $100 -> $90 transition stops re-firing
  // only because current_price_amount (and target_reached_at) advanced here. If
  // the advance did not commit, the next cycle observes the identical transition
  // and would emit a SECOND event and a SECOND push for one real price change.
  // So a failed observation write ends the cycle: nothing is recorded, nothing is
  // announced, and the unchanged state is re-evaluated cleanly next time.
  if (!patchResponse.ok) {
    logEvent('watchlist_refresh_write_failed', { watchId: row.id.slice(0, 8), status: patchResponse.status });
    return {
      watchId: row.id,
      refreshStatus: 'write_failed',
      observedAt,
      currentPrice: row.current_price_amount,
      currency: row.currency,
      event: null,
      refreshMetadata: { ...outcome.metadata, errorCode: outcome.metadata.errorCode ?? 'observation_write_failed' },
    };
  }

  let eventRecorded = false;
  if (result.event) {
    const appendResponse = await rpc('append_user_commerce_watch_event', {
      p_watch_id: row.id,
      p_user_id: row.user_id,
      p_event_type: result.event.type,
      p_price_amount: result.event.priceAmount,
      p_currency: result.event.currency,
    });
    eventRecorded = appendResponse.ok;
    if (!appendResponse.ok) {
      logEvent('watchlist_event_append_failed', { watchId: row.id.slice(0, 8), status: appendResponse.status });
    }
  }

  // WL-02 - the alert is gated on the event having actually been recorded.
  // append_user_commerce_watch_event refuses (P0002) when the watch is deleted,
  // so this is also the liveness check: a Watch deleted mid-cycle no longer
  // produces a late push whose tap opens a Watch that is gone. Section 39 still
  // holds in the direction it was written - a DELIVERY failure never rolls back
  // the event - but an event that was never written must not be announced.
  if (eventRecorded) {
    await deliverPushIfArmed(row, result.event);
  }

  return {
    watchId: row.id,
    refreshStatus: result.refreshStatus,
    observedAt,
    currentPrice: result.newCurrentPriceAmount,
    currency: row.currency,
    event: eventRecorded ? (result.event?.type ?? null) : null,
    refreshMetadata: outcome.metadata,
  };
}

// ── Tier 2: worker sweep ────────────────────────────────────────────────--

async function runWorkerSweep(): Promise<Response> {
  const enabled = await readAppConfigFlag('watchlist_worker_enabled');
  if (!enabled) {
    logEvent('watchlist_worker_kill_switch_skip', {});
    recordPushOperationalEvent({
      type: 'watchlist_worker_disabled',
      component: 'worker',
      reason: 'worker_disabled',
    });
    return json({ mode: 'sweep', enabled: false, claimed: 0, results: [] });
  }

  const startedAtMs = Date.now();
  recordPushOperationalEvent({ type: 'watchlist_worker_started', component: 'worker' });

  // N-4: drain any receipts due for a verdict BEFORE claiming new refresh
  // work, so a dead route discovered this cycle cannot receive one more push
  // attempt in the SAME invocation. Gated behind the same kill switch as the
  // rest of Tier 2 on purpose — this is background delivery-hygiene work, not
  // a user-facing action, and an operator who has not turned the worker on
  // should not have a second, differently-gated background job running
  // anyway. Bounded and best-effort: neither call ever throws, and both are
  // no-ops on an empty table (no rows due, nothing to prune).
  const receiptSummary = await drainEligiblePushReceipts();
  await pruneOldPushReceipts();

  const claimResponse = await rpc('claim_watchable_commerce_watches', {
    p_limit: WORKER_SWEEP_BATCH_CAP,
    p_min_interval_ms: MIN_REFRESH_INTERVAL_MS,
  });
  if (!claimResponse.ok) {
    logEvent('watchlist_worker_claim_failed', { status: claimResponse.status });
    recordPushOperationalEvent({
      type: 'watchlist_worker_failed',
      component: 'worker',
      reason: 'worker_claim_failed',
      counters: { durationMs: Date.now() - startedAtMs },
    });
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

  // N-5: a bounded rollup, not a per-watch log line — see COUNTER_KEYS in
  // pushObservability.ts. receiptsTerminal folds terminal_other and expired
  // together: both mean "no further receipt check will happen and it was not
  // a success", the one distinction observability needs at this granularity.
  recordPushOperationalEvent({
    type: 'watchlist_worker_completed',
    component: 'worker',
    counters: {
      watchesEvaluated: claimed.length,
      receiptsChecked: receiptSummary.checked,
      receiptsSuccess: receiptSummary.success,
      receiptsTransient: receiptSummary.stillPending,
      receiptsTerminal: receiptSummary.terminalOther + receiptSummary.expired,
      deadRoutesRetired: receiptSummary.retired,
      staleReceiptsIgnored: receiptSummary.staleSkipped,
      durationMs: Date.now() - startedAtMs,
    },
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
  pushToken?: unknown;
  platform?: unknown;
  deviceId?: unknown;
  enabled?: unknown;
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
  // WL-01 - the currency a Watch is STORED in decides every later comparison, so
  // it is resolved by the same authority the refresh path uses, not by the shared
  // substring scan that reads "CA$1,299.99" as USD. §25 already required a
  // confident currency read; this makes the read actually confident.
  const listingCurrency = resolveObservedCurrency(listing.price);
  if (parsedPrice.value === null || !listingCurrency) {
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

  // WL-08 - bounded provider exposure. Every active Watch is one paid listing
  // re-read per refresh cycle, and nothing else in this function limits how many
  // an actor may hold: `create` performs no provider call, so a caller can mint
  // Watches cheaply and then drain 25 provider calls per `refresh` request, for
  // as many Watches as exist. Every other paid-provider function in this codebase
  // carries a quota; this one carried none.
  //
  // This is a COST CEILING, not a product limit: the default is far above any
  // plausible real Watchlist and is env-overridable, matching the batch-cap idiom
  // in watchRefreshConfig.ts. Re-watching an existing listing is idempotent and
  // is deliberately NOT blocked by it -- only genuinely new rows are counted, so
  // a user at the ceiling can still retarget what they already watch.
  const activeCountResponse = await rest(
    `user_commerce_watches?user_id=eq.${authUser.id}&deleted_at=is.null&canonical_url=neq.${encodeURIComponent(safeUrl)}&select=id`,
    { method: 'GET', headers: { Prefer: 'count=exact', Range: '0-0' } },
  );
  const activeCount = Number(
    activeCountResponse.headers.get('content-range')?.split('/')?.[1] ?? Number.NaN,
  );
  if (Number.isFinite(activeCount) && activeCount >= MAX_ACTIVE_WATCHES_PER_ACTOR) {
    logEvent('watchlist_create_ceiling_reached', {
      uid: shortUserId(authUser.id),
      activeCount,
    });
    return json({ error: 'watch_limit_reached', code: 'watch_limit_reached' }, 429);
  }

  const createResponse = await rpc('create_user_commerce_watch', {
    p_user_id: authUser.id,
    p_source: provider,
    p_canonical_url: safeUrl,
    p_provider_listing_id: null,
    p_display_title: title,
    p_display_image_url: imageUrl ?? null,
    p_initial_price_amount: parsedPrice.value,
    p_currency: listingCurrency,
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

  const singleWatchId = typeof watchId === 'string' && isValidUuid(watchId) ? watchId : null;

  // INT-KPLUS-008 — CLAIM the due rows, do not merely select them.
  //
  // last_checked_at is not written until runRefreshCycle finishes, so a plain
  // staleness SELECT is not mutual exclusion: two concurrent manual refreshes
  // of the same Watch both passed the filter, both called the provider, and
  // both could emit an event and a push for one user intent. This RPC stamps
  // last_checked_at as the claim itself under FOR UPDATE SKIP LOCKED -- the
  // same discipline the Tier 2 background sweep already used -- so the loser
  // of the race claims nothing and does no provider work.
  const claimResponse = await rpc('claim_user_commerce_watches_for_refresh', {
    p_user_id: authUser.id,
    p_watch_id: singleWatchId,
    p_limit: USER_REFRESH_BATCH_CAP,
    p_min_interval_ms: MIN_REFRESH_INTERVAL_MS,
  });
  if (!claimResponse.ok) {
    return json({ error: 'lookup_failed', code: 'lookup_failed' }, 502);
  }
  const rows = (await claimResponse.json()) as WatchRow[];

  if (singleWatchId && rows.length === 0) {
    // Distinguish "not due yet" / "not active" / "not found" for the
    // single-watch case, so a manual Refresh button reports honestly instead
    // of claiming freshness for a watch that is merely paused or absent.
    const existsResponse = await rest(
      `user_commerce_watches?id=eq.${singleWatchId}&user_id=eq.${authUser.id}&deleted_at=is.null&select=id,status,last_checked_at`,
      { method: 'GET' },
    );
    const existsRows = existsResponse.ok ? await existsResponse.json() : [];
    const existing = Array.isArray(existsRows) ? existsRows[0] : undefined;
    if (existing) {
      return json({
        refreshed: [],
        skipped: [{ watchId: singleWatchId, reason: existing.status === 'active' ? 'too_recent' : 'not_active' }],
      });
    }
    return json({ error: 'not_found', code: 'not_found' }, 404);
  }

  const refreshed = await mapWithConcurrency(rows, REFRESH_CONCURRENCY, runRefreshCycle);
  return json({ refreshed });
}

/**
 * NOTIF-10: Expo push tokens have exactly one shape. Accepting any 1–400
 * character string let a caller write arbitrary text into the delivery
 * registry, which is both a junk-data vector and a way to make a route that
 * can never deliver and never reports DeviceNotRegistered.
 */
const EXPO_PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[A-Za-z0-9._%+-]{1,180}\]$/;

function isValidExpoPushToken(token: string | undefined): token is string {
  return typeof token === 'string' && EXPO_PUSH_TOKEN_PATTERN.test(token);
}

/**
 * NOTIF-10: every push mutation must be refused for an actor whose account is
 * not active (pending deletion, locked, or already purged). requireUser only
 * proves the JWT is valid — it says nothing about account state, so a token
 * minted before a deletion request stayed able to arm and re-arm delivery.
 * Mirrors the eligibility the claim/refresh RPCs already enforce server-side.
 */
async function isEligibleAccountActor(userId: string): Promise<boolean> {
  try {
    const response = await rpc('watchlist_actor_is_active', { p_user_id: userId });
    if (!response.ok) return false;
    return (await response.json()) === true;
  } catch {
    return false;
  }
}

async function handleRegisterPushToken(authUser: AuthUser, body: UserActionBody): Promise<Response> {
  const pushToken = str(body.pushToken, 400);
  const platform = body.platform === 'ios' || body.platform === 'android' ? body.platform : undefined;
  const deviceId = str(body.deviceId, 200);
  if (!isValidExpoPushToken(pushToken) || !platform || !deviceId) {
    recordPushOperationalEvent({
      type: 'push_registration_rejected',
      component: 'registration',
      reason: 'invalid_token_registration',
    });
    return json({ error: 'invalid_token_registration', code: 'invalid_token_registration' }, 400);
  }

  recordPushOperationalEvent({ type: 'push_registration_started', component: 'registration' });

  if (!(await isEligibleAccountActor(authUser.id))) {
    recordPushOperationalEvent({
      type: 'push_registration_rejected',
      component: 'registration',
      reason: 'account_not_eligible',
    });
    return json({ error: 'account_not_eligible', code: 'account_not_eligible' }, 403);
  }

  // N-5: registration vs. token-refresh distinguishability (§ observability
  // architecture). register_device_push_token's ON CONFLICT ... DO UPDATE
  // does not itself reveal whether this (user, device) row already existed,
  // so a bounded existence check runs first -- once per registration call,
  // never per-push. Read-only and never gates the RPC below: a failed check
  // simply falls back to reporting a first-time registration rather than
  // blocking anything.
  let existedBefore = false;
  try {
    const existingResponse = await rest(
      `user_device_push_tokens?user_id=eq.${authUser.id}&device_id=eq.${encodeURIComponent(deviceId)}&select=id`,
      { method: 'GET' },
    );
    if (existingResponse.ok) {
      const rows = await existingResponse.json().catch(() => []);
      existedBefore = Array.isArray(rows) && rows.length > 0;
    }
  } catch {
    existedBefore = false;
  }

  const response = await rpc('register_device_push_token', {
    p_user_id: authUser.id,
    p_push_token: pushToken,
    p_platform: platform,
    p_device_id: deviceId,
  });
  if (!response.ok) {
    logEvent('watchlist_push_token_register_failed', { uid: shortUserId(authUser.id), status: response.status });
    recordPushOperationalEvent({
      type: 'push_registration_rejected',
      component: 'registration',
      reason: 'registration_rpc_failed',
    });
    return json({ error: 'register_failed', code: 'register_failed' }, 502);
  }
  recordPushOperationalEvent({
    type: existedBefore ? 'push_token_refreshed' : 'push_registration_succeeded',
    component: 'registration',
  });
  return json({ registered: true });
}

/**
 * DEF-WL-01: sign-out / account-switch revocation. Retires THIS device's
 * delivery route for the calling actor so a Watch alert can never be pushed
 * to a handset the owner has left. Identity comes only from requireUser --
 * the body supplies the device id, never a user id, and the RPC scopes its
 * update to (that actor, that device).
 */
async function handleRevokePushToken(authUser: AuthUser, body: UserActionBody): Promise<Response> {
  const deviceId = str(body.deviceId, 200);
  if (!deviceId) {
    return json({ error: 'invalid_token_registration', code: 'invalid_token_registration' }, 400);
  }
  const response = await rpc('revoke_device_push_token', {
    p_user_id: authUser.id,
    p_device_id: deviceId,
  });
  if (!response.ok) {
    logEvent('watchlist_push_token_revoke_failed', { uid: shortUserId(authUser.id), status: response.status });
    // N-5: this is the single server-side effect shared by BOTH RP-104's
    // explicit-off (disableDeviceNotifications) and RP-109's logout
    // revocation (revokeWatchAlertsForThisDevice) -- both ultimately POST
    // action: 'revoke_push_token'. One event, distinguished by reason, covers
    // both without any client-side change to either hardened invariant path.
    recordPushOperationalEvent({
      type: 'push_route_revoked',
      component: 'revoke',
      reason: 'revoke_rpc_failed',
    });
    return json({ error: 'revoke_failed', code: 'revoke_failed' }, 502);
  }
  const revoked = (await response.json()) === true;
  recordPushOperationalEvent({
    type: 'push_route_revoked',
    component: 'revoke',
    reason: revoked ? undefined : 'already_inactive',
  });
  return json({ revoked });
}

/**
 * SEC-KPLUS-001 — assert current custody of this physical device.
 *
 * Retires every OTHER actor's live push route on this device. Requires no
 * notification permission and registers nothing, so the client can call it on
 * every actor transition whether or not the arriving actor ever wants alerts.
 * That is the case register_push_token structurally cannot reach: a new owner
 * who never enables Watch alerts previously left the departed actor's route
 * live and deliverable.
 *
 * Reports how many routes were retired so the caller can observe and retry.
 */
async function handleClaimDevice(authUser: AuthUser, body: UserActionBody): Promise<Response> {
  const deviceId = str(body.deviceId, 200);
  if (!deviceId) {
    return json({ error: 'invalid_token_registration', code: 'invalid_token_registration' }, 400);
  }
  const response = await rpc('claim_device_for_actor', {
    p_user_id: authUser.id,
    p_device_id: deviceId,
  });
  if (!response.ok) {
    logEvent('watchlist_device_claim_failed', {
      uid: shortUserId(authUser.id),
      status: response.status,
    });
    recordPushOperationalEvent({
      type: 'push_device_claim_rejected',
      component: 'claim',
      reason: 'claim_rpc_failed',
    });
    return json({ error: 'claim_failed', code: 'claim_failed' }, 502);
  }
  const retired = await response.json().catch(() => 0);
  const retiredCount = typeof retired === 'number' ? retired : 0;
  if (retiredCount > 0) {
    // Worth seeing: a device changed hands and the previous owner's sign-out
    // revocation had not already retired their route.
    logEvent('watchlist_device_claim_retired_foreign_routes', {
      uid: shortUserId(authUser.id),
      retired,
    });
  }
  recordPushOperationalEvent({
    type: 'push_device_claimed',
    component: 'claim',
    counters: { deadRoutesRetired: retiredCount },
  });
  return json({ retired: retiredCount });
}

async function handleSetPushEnabled(authUser: AuthUser, body: UserActionBody): Promise<Response> {
  if (typeof body.watchId !== 'string' || !isValidUuid(body.watchId)) {
    return json({ error: 'invalid_watch_id', code: 'invalid_watch_id' }, 400);
  }
  // NOTIF-10: arming delivery requires an eligible account. Disarming does
  // not -- `enabled: false` must stay reachable for an account in the
  // deletion grace period, exactly as revoke/claim do, so no actor can be
  // trapped with alerts they cannot turn off.
  if (body.enabled === true && !(await isEligibleAccountActor(authUser.id))) {
    return json({ error: 'account_not_eligible', code: 'account_not_eligible' }, 403);
  }
  const response = await rpc('set_watch_push_enabled', {
    p_user_id: authUser.id,
    p_watch_id: body.watchId,
    p_enabled: body.enabled === true,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (detail.includes('P0002')) {
      return json({ error: 'not_found', code: 'not_found' }, 404);
    }
    return json({ error: 'set_push_enabled_failed', code: 'set_push_enabled_failed' }, 502);
  }
  const rows = await response.json();
  const watch = Array.isArray(rows) ? rows[0] : rows;
  return json({ watch });
}

// ── Entry point ──────────────────────────────────────────────────────────-

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    // WL-05 - every path that answers without reading the body drains it first.
    await drainRequestBody(req);
    return json({ error: 'Method not allowed' }, 405);
  }

  if (requireWorkerSecret(req)) {
    // The sweep is selected by the header and deliberately ignores the body
    // (see .github/workflows/watchlist-tier2-sweep.yml), so nothing downstream
    // will ever read it.
    await drainRequestBody(req);
    try {
      return await runWorkerSweep();
    } catch (err) {
      alertEvent('watchlist_worker_unexpected_error', {
        message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      });
      recordPushOperationalEvent({
        type: 'watchlist_worker_failed',
        component: 'worker',
        reason: 'worker_threw',
      });
      return json({ error: 'Worker failed' }, 500);
    }
  }

  let authUser: AuthUser;
  try {
    authUser = await requireUser(req);
  } catch (response) {
    // requireUser rejects on the Authorization header alone and never touches
    // the body -- the one unauthenticated path into this function, and so the
    // one an anonymous caller could otherwise use to hold an edge connection.
    await drainRequestBody(req);
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
    case 'register_push_token':
      return handleRegisterPushToken(authUser, body);
    case 'revoke_push_token':
      return handleRevokePushToken(authUser, body);
    case 'claim_device':
      return handleClaimDevice(authUser, body);
    case 'set_push_enabled':
      return handleSetPushEnabled(authUser, body);
    default:
      return json({ error: 'unknown_action', code: 'unknown_action' }, 400);
  }
});
