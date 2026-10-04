/**
 * Authenticated, per-actor RevenueCat -> Supabase K+ repair primitive.
 * Inert unless explicitly called; its response never grants client access.
 */
import {
  assertAccountActive,
  corsHeaders,
  isEligibleAccountActor,
  json,
  logEvent,
  requireUser,
  rpc,
  shortUserId,
} from '../_shared/deletion/common.ts';
import {
  reconcileRevenueCatProviderState,
  type LocalProviderGrant,
} from '../_shared/revenuecat/revenueCatProviderReconciliation.ts';
import {
  KPLUS_REVENUECAT_RECONCILE_ENVIRONMENT_ENV,
  KPLUS_REVENUECAT_RECONCILE_MAX_PAGES_ENV,
  KPLUS_REVENUECAT_RECONCILE_TIMEOUT_MS_ENV,
  REVENUECAT_PROJECT_ID_ENV,
  REVENUECAT_RECONCILE_SECRET_API_KEY_ENV,
  type RevenueCatEnvironment,
  type RevenueCatProductResource,
} from '../_shared/revenuecat/revenueCatProviderStateClient.ts';
import {
  KPLUS_PRODUCT_CLASSIFICATION_ENV,
  parseKPlusProductClassification,
} from '../_shared/revenuecat/revenueCatProductClassification.ts';

const MAX_BODY_BYTES = 2048;
const CLAIM_RPC = 'claim_kplus_provider_reconciliation';
const FINISH_RPC = 'finish_kplus_provider_reconciliation';
const PRODUCT_CACHE_GET_RPC = 'get_kplus_revenuecat_product_cache';
const PRODUCT_CACHE_PUT_RPC = 'put_kplus_revenuecat_product_cache';
const LIST_GRANTS_RPC = 'list_kplus_provider_grants_for_reconciliation';

type Trigger = 'post_purchase_unresolved' | 'restore_unresolved' | 'check_again';
const TRIGGERS = new Set<Trigger>(['post_purchase_unresolved', 'restore_unresolved', 'check_again']);

function env(name: string): string | null {
  const value = Deno.env.get(name)?.trim();
  return value || null;
}

function boundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid ${name}`);
  return value;
}

async function responseBody(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

async function callRpc(fn: string, args: Record<string, unknown>) {
  const response = await rpc(fn, args);
  return { ok: response.ok, status: response.status, body: await responseBody(response) };
}

function finishOutcome(status: string, unresolvedDrift = 0, applied = 0): string {
  if (status === 'provider_unavailable' || status === 'provider_malformed') return 'provider_unavailable';
  if (status === 'provider_throttled') return 'provider_throttled';
  if (status === 'canonical_transition_failed') return 'transition_failed';
  if (status === 'ownership_conflict') return 'rejected';
  if (unresolvedDrift > 0) return 'unresolved_drift';
  return applied > 0 ? 'resolved' : 'no_drift';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ status: 'method_not_allowed' }, 405);

  let user;
  try { user = await requireUser(req); }
  catch (response) { return response instanceof Response ? response : json({ status: 'unauthorized' }, 401); }

  if (!isEligibleAccountActor(user)) {
    return json({ status: 'not_eligible', reason: 'anonymous_identity' }, 403);
  }
  try { await assertAccountActive(user.id); }
  catch (response) {
    if (response instanceof Response) return response;
    return json({ status: 'not_eligible', reason: 'account_not_active' }, 403);
  }

  // No query input is part of this contract. In particular, actor/customer
  // selectors are refused rather than silently ignored.
  if ([...new URL(req.url).searchParams.keys()].length > 0) {
    return json({ status: 'malformed_request' }, 400);
  }

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json({ status: 'payload_too_large' }, 413);
  let body: unknown;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ status: 'payload_too_large' }, 413);
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return json({ status: 'malformed_request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ status: 'malformed_request' }, 400);
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'trigger' && key !== 'force')) {
    // This is the actor-injection guard: userId/actor/customer fields are not
    // merely ignored; the request is refused.
    return json({ status: 'malformed_request' }, 400);
  }
  const trigger = input.trigger === undefined ? 'check_again' : input.trigger;
  if (typeof trigger !== 'string' || !TRIGGERS.has(trigger as Trigger) ||
      (input.force !== undefined && typeof input.force !== 'boolean')) {
    return json({ status: 'malformed_request' }, 400);
  }
  const force = input.force === true;

  const secretApiKey = env(REVENUECAT_RECONCILE_SECRET_API_KEY_ENV);
  const projectId = env(REVENUECAT_PROJECT_ID_ENV);
  const environment = env(KPLUS_REVENUECAT_RECONCILE_ENVIRONMENT_ENV);
  const classification = parseKPlusProductClassification(env(KPLUS_PRODUCT_CLASSIFICATION_ENV));
  if (!secretApiKey || !projectId || (environment !== 'production' && environment !== 'sandbox') ||
      classification.status !== 'configured') {
    logEvent('kplus_rc_pull_configuration_error', { uid: shortUserId(user.id) });
    return json({ status: 'not_configured' }, 503);
  }

  let cooldownSeconds: number;
  let leaseSeconds: number;
  let timeoutMs: number;
  let maxPages: number;
  let cacheTtlSeconds: number;
  try {
    cooldownSeconds = boundedInt('KPLUS_REVENUECAT_RECONCILE_COOLDOWN_SECONDS', 300, 0, 86400);
    leaseSeconds = boundedInt('KPLUS_REVENUECAT_RECONCILE_LEASE_SECONDS', 30, 5, 300);
    timeoutMs = boundedInt(KPLUS_REVENUECAT_RECONCILE_TIMEOUT_MS_ENV, 8000, 1000, 20000);
    maxPages = boundedInt(KPLUS_REVENUECAT_RECONCILE_MAX_PAGES_ENV, 3, 1, 5);
    cacheTtlSeconds = boundedInt('KPLUS_REVENUECAT_PRODUCT_CACHE_TTL_SECONDS', 86400, 60, 2592000);
  } catch {
    return json({ status: 'not_configured' }, 503);
  }

  const claimResponse = await callRpc(CLAIM_RPC, {
    p_user_id: user.id,
    p_environment: environment,
    p_cooldown_seconds: cooldownSeconds,
    p_lease_seconds: leaseSeconds,
    p_force: force,
  }).catch(() => null);
  const claim = claimResponse?.body as { classification?: unknown; claimToken?: unknown; retryAfterSeconds?: unknown } | null;
  if (!claimResponse?.ok || !claim || typeof claim.classification !== 'string') {
    return json({ status: 'canonical_transition_failed', retryable: true }, 503);
  }
  if (claim.classification === 'in_flight' || claim.classification === 'cooldown') {
    const retryAfterSeconds = typeof claim.retryAfterSeconds === 'number' ? claim.retryAfterSeconds : 30;
    return json({ status: 'rate_limited', retryAfterSeconds }, 429);
  }
  if (claim.classification !== 'claimed' || typeof claim.claimToken !== 'string') {
    return json({ status: 'not_eligible', reason: claim.classification === 'rejected' ? 'account_not_active' : 'account_not_active' }, 403);
  }

  const actorFields = { uid: shortUserId(user.id), trigger, force, environment };
  logEvent('kplus_rc_pull_requested', actorFields);
  let outcome = 'transition_failed';
  try {
    const providerEnvironment = environment as RevenueCatEnvironment;
    const result = await reconcileRevenueCatProviderState(user.id, {
      provider: { secretApiKey, projectId, environment: providerEnvironment, timeoutMs, maxPages },
      classification,
    }, {
      fetch,
      now: () => Date.now(),
      callRpc,
      log: (event, fields) => logEvent(event, { uid: shortUserId(user.id), ...fields }),
      listLocalGrants: async (actorId, providerEnvironment) => {
        const response = await callRpc(LIST_GRANTS_RPC, { p_user_id: actorId, p_environment: providerEnvironment });
        if (!response.ok || !Array.isArray(response.body)) throw new Error('grant list unavailable');
        return response.body as LocalProviderGrant[];
      },
      getProductCache: async (projectDigest, productDigest) => {
        const response = await callRpc(PRODUCT_CACHE_GET_RPC, {
          p_project_ref_digest: projectDigest,
          p_product_ref_digest: productDigest,
        });
        if (!response.ok || !Array.isArray(response.body)) throw new Error('product cache unavailable');
        const row = response.body[0] as { store_identifier?: unknown; product_type?: unknown } | undefined;
        return row && typeof row.store_identifier === 'string' && typeof row.product_type === 'string'
          ? { resourceId: productDigest, storeIdentifier: row.store_identifier, type: row.product_type } as RevenueCatProductResource
          : null;
      },
      putProductCache: async (projectDigest, productDigest, product) => {
        const response = await callRpc(PRODUCT_CACHE_PUT_RPC, {
          p_project_ref_digest: projectDigest,
          p_product_ref_digest: productDigest,
          p_store_identifier: product.storeIdentifier,
          p_product_type: product.type,
          p_ttl_seconds: cacheTtlSeconds,
        });
        if (!response.ok) throw new Error('product cache unavailable');
      },
    });
    outcome = finishOutcome(
      result.status,
      result.status === 'reconciled' ? result.unresolvedDrift : 0,
      result.status === 'reconciled' ? result.transitions.applied : 0,
    );
    logEvent('kplus_rc_pull_result', {
      ...actorFields,
      status: result.status,
      unresolved_drift: result.status === 'reconciled' ? result.unresolvedDrift : 0,
    });
    if (result.status === 'provider_throttled') return json(result, 429);
    if (result.status === 'provider_unavailable' || result.status === 'canonical_transition_failed') return json(result, 503);
    if (result.status === 'provider_malformed') return json(result, 502);
    if (result.status === 'ownership_conflict') return json(result, 409);
    return json(result, 200);
  } finally {
    await callRpc(FINISH_RPC, {
      p_user_id: user.id,
      p_environment: environment,
      p_claim_token: claim.claimToken,
      p_outcome: outcome,
    }).catch(() => null);
  }
});
