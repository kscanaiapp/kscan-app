/**
 * K+ RevenueCat lifecycle webhook handler (Build 35 Phase C).
 *
 *   STORE -> REVENUECAT -> [this] -> reconcile_kplus_provider_transition /
 *   reconcile_kplus_provider_lifetime_transition -> existing apply RPCs ->
 *   Supabase K+ authority
 *
 * The request path, in order, each step failing closed:
 *
 *   1. POST only.
 *   2. Configured at all (Authorization secret present and at least
 *      REVENUECAT_WEBHOOK_MIN_SECRET_LENGTH characters; a configured signing
 *      secret likewise) -- else 503.
 *   3. Body size bound.
 *   4. AUTHENTICATION (revenueCatWebhookAuth.ts) -- before the body is parsed.
 *   5. Strict bounded parse -- malformed => 400, nothing mutated.
 *   6. Normalization (revenueCatWebhookEvent.ts) -- unknown / unmapped /
 *      unsupported => no mutation, bounded outcome.
 *   7. ONE call to the existing transition RPC (service role, server-side only).
 *      Ordering, idempotency, cross-user ownership and environment-mismatch are
 *      owned by those RPCs; this handler never reimplements or bypasses them.
 *
 * HTTP semantics follow RevenueCat's retry contract (any non-200 is retried up to
 * five times over ~2.5 hours): 200 means "settled, do not resend" (applied,
 * duplicate, stale, a permanent refusal, a deliberate ignore); a non-200 means
 * "I could not settle this": unconfigured, transient database trouble, an
 * unmapped product (so a corrected mapping can still pick the retry up), or a
 * provider timestamp that may become acceptable.
 *
 * Observability: bounded fields only -- event category, store, environment,
 * outcome, reason, and OPAQUE digests of the event id / product id. Never the raw
 * body, a receipt, a transaction id, a purchase token, an email, a name, or the
 * app user id.
 */
import {
  KPLUS_PROVIDER_ENVIRONMENTS,
  KPLUS_RECONCILE_PROVIDER_LIFETIME_TRANSITION_RPC,
  KPLUS_RECONCILE_PROVIDER_TRANSITION_RPC,
  toApplyKPlusProviderLifetimeTransitionArgs,
  toApplyKPlusProviderTransitionArgs,
  type KPlusProviderEnvironment,
} from '../kplus/kplusEntitlementContract.ts';
import {
  KPLUS_PRODUCT_CLASSIFICATION_ENV,
  parseKPlusProductClassification,
} from './revenueCatProductClassification.ts';
import {
  REVENUECAT_WEBHOOK_AUTHORIZATION_ENV,
  REVENUECAT_WEBHOOK_SIGNING_SECRET_ENV,
  revenueCatWebhookConfigFault,
  verifyRevenueCatWebhook,
} from './revenueCatWebhookAuth.ts';
import { normalizeRevenueCatEvent, parseRevenueCatWebhook } from './revenueCatWebhookEvent.ts';

export const KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS_ENV = 'KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS' as const;
export const REVENUECAT_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export interface RpcResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface RevenueCatWebhookDeps {
  /** Reads a server-side secret / config value; null when unset. */
  env: (name: string) => string | null;
  now: () => number;
  /** Service-role call to a database function. */
  callRpc: (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;
  log: (event: string, fields: Record<string, unknown>) => void;
  alert: (event: string, fields: Record<string, unknown>) => void;
}

function respond(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function opaque(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash).slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Environments this deployment may mutate entitlement state from.
 *
 * Default (unset, empty, or nothing valid): PRODUCTION ONLY. A sandbox
 * (TestFlight / Play internal testing / developer) purchase therefore cannot
 * reach a production project unless the owner explicitly accepts it. The
 * database stores each grant's environment and refuses cross-environment
 * mutation of one grant, but its access resolver does not distinguish
 * environments -- so the gate has to be here, at the door.
 */
export function parseAcceptedEnvironments(raw: string | null): KPlusProviderEnvironment[] {
  const accepted = new Set<KPlusProviderEnvironment>();
  for (const part of (raw ?? '').split(',')) {
    const value = part.trim().toLowerCase();
    if ((KPLUS_PROVIDER_ENVIRONMENTS as readonly string[]).includes(value)) accepted.add(value as KPlusProviderEnvironment);
  }
  return accepted.size > 0 ? [...accepted] : ['production'];
}

const SECURITY_REJECTIONS = new Set([
  'subscription_owned_by_other_user',
  'purchase_owned_by_other_user',
  'event_identity_conflict',
  'environment_mismatch',
]);

export async function handleRevenueCatWebhook(req: Request, deps: RevenueCatWebhookDeps): Promise<Response> {
  if (req.method !== 'POST') return respond(405, { status: 'method_not_allowed' });

  const authorizationSecret = deps.env(REVENUECAT_WEBHOOK_AUTHORIZATION_ENV);
  const signingSecret = deps.env(REVENUECAT_WEBHOOK_SIGNING_SECRET_ENV);
  // K-06: a configured-but-too-short secret is "not configured", exactly like an
  // unset one. The fault is a bounded code; it never carries a secret or length.
  const configFault = revenueCatWebhookConfigFault(authorizationSecret, signingSecret);
  if (configFault !== null || !authorizationSecret) {
    deps.alert('kplus_rc_webhook_not_configured', { reason: configFault ?? 'authorization_secret_missing' });
    return respond(503, { status: 'not_configured' });
  }

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > REVENUECAT_WEBHOOK_MAX_BODY_BYTES) {
    return respond(413, { status: 'payload_too_large' });
  }
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return respond(400, { status: 'malformed' });
  }
  if (new TextEncoder().encode(rawBody).length > REVENUECAT_WEBHOOK_MAX_BODY_BYTES) {
    return respond(413, { status: 'payload_too_large' });
  }

  const auth = await verifyRevenueCatWebhook({
    headers: req.headers,
    rawBody,
    authorizationSecret,
    signingSecret,
    nowMs: deps.now(),
  });
  if (!auth.ok) {
    // One generic answer for every authentication failure: the response must not
    // tell a caller which part was wrong.
    deps.log('kplus_rc_webhook_unauthorized', { reason: auth.reason });
    return respond(401, { status: 'unauthorized' });
  }

  const parsed = parseRevenueCatWebhook(rawBody);
  if (!parsed.ok) {
    deps.log('kplus_rc_webhook_malformed', {});
    return respond(400, { status: 'malformed' });
  }
  const event = parsed.event;
  const eventKey = await opaque(event.id);

  const normalized = await normalizeRevenueCatEvent(event, {
    classification: parseKPlusProductClassification(deps.env(KPLUS_PRODUCT_CLASSIFICATION_ENV)),
    acceptedEnvironments: parseAcceptedEnvironments(deps.env(KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS_ENV)),
  });

  const common = { event_type: event.type, store: event.store, environment: event.environment, event_key: eventKey };

  switch (normalized.kind) {
    case 'ignored': {
      deps.log('kplus_rc_webhook_ignored', { ...common, category: normalized.category, detail: normalized.detail });
      if (normalized.category === 'unmappable_actor') deps.alert('kplus_rc_webhook_unmappable_actor', { ...common, detail: normalized.detail });
      return respond(200, { status: 'ignored', category: normalized.category });
    }
    case 'malformed': {
      deps.log('kplus_rc_webhook_malformed', { ...common, reason: normalized.reason });
      return respond(400, { status: 'malformed' });
    }
    case 'configuration_error': {
      deps.alert('kplus_rc_webhook_configuration_error', {
        ...common,
        reason: normalized.reason,
        product_key: await opaque(event.productId),
      });
      // Non-200 on purpose: RevenueCat retries, so a corrected mapping can still
      // settle this event inside the retry window. Nothing was mutated.
      return respond(422, { status: 'configuration_error', reason: normalized.reason });
    }
  }

  const isLifetime = normalized.kind === 'lifetime';
  let rpcResult: RpcResult;
  try {
    rpcResult = isLifetime
      ? await deps.callRpc(
        KPLUS_RECONCILE_PROVIDER_LIFETIME_TRANSITION_RPC,
        toApplyKPlusProviderLifetimeTransitionArgs(normalized.input),
      )
      : await deps.callRpc(
        KPLUS_RECONCILE_PROVIDER_TRANSITION_RPC,
        toApplyKPlusProviderTransitionArgs(normalized.input),
      );
  } catch {
    deps.alert('kplus_rc_webhook_rpc_unreachable', { ...common });
    return respond(503, { status: 'retry' });
  }

  if (!rpcResult.ok || !rpcResult.body || typeof rpcResult.body !== 'object') {
    const code = (rpcResult.body as { code?: unknown } | null)?.code;
    deps.alert('kplus_rc_webhook_rpc_failed', { ...common, http_status: rpcResult.status, pg_code: typeof code === 'string' ? code : null });
    return respond(503, { status: 'retry' });
  }

  const result = rpcResult.body as { classification?: unknown; reason?: unknown };
  const classification = typeof result.classification === 'string' ? result.classification : 'unknown';
  const kind = isLifetime ? 'lifetime' : 'subscription';

  if (classification === 'rejected') {
    const reason = typeof result.reason === 'string' ? result.reason : 'unknown';
    deps.log('kplus_rc_webhook_transition', { ...common, kind, outcome: 'rejected', reason });
    if (SECURITY_REJECTIONS.has(reason)) deps.alert('kplus_rc_webhook_security_rejection', { ...common, kind, reason });
    // A provider timestamp from the future is not recorded and may become
    // acceptable: ask for a retry. Every other refusal is permanent.
    if (reason === 'provider_time_in_future') return respond(503, { status: 'retry', reason });
    return respond(200, { status: 'rejected', reason });
  }

  if (classification === 'applied' || classification === 'duplicate' || classification === 'stale') {
    deps.log('kplus_rc_webhook_transition', { ...common, kind, outcome: classification });
    return respond(200, { status: classification });
  }

  deps.alert('kplus_rc_webhook_unrecognized_rpc_answer', { ...common, kind });
  return respond(503, { status: 'retry' });
}
