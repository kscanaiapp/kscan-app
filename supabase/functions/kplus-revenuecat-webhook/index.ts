/**
 * kplus-revenuecat-webhook -- the inbound RevenueCat lifecycle endpoint
 * (Build 35 Phase C).
 *
 * Authenticated by a shared Authorization secret (and, when configured, an HMAC
 * signature) -- NOT by a Supabase user JWT, which RevenueCat cannot send; hence
 * `verify_jwt = false` in supabase/config.toml. It is not a client RPC: no
 * mobile input reaches it, and the mobile app keeps resolving K+ only from
 * get_my_kplus_entitlement_summary().
 *
 * All behaviour lives in _shared/revenuecat/revenueCatWebhookHandler.ts; this
 * file only wires the real environment, clock, logger and ONE service-role
 * database call into it.
 *
 * It deliberately does NOT import _shared/deletion/common.ts. That module carries
 * auth-admin and lifecycle code; this endpoint is reachable without a JWT, so its
 * deployed closure is kept to exactly what it needs: read config, call the two
 * provider transition RPCs, log bounded fields. (deletion-status is built the
 * same way, for the same reason.)
 *
 * Server-only configuration (Edge Function secrets; none is set by this repo):
 *   KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION   required; at least 32 characters
 *   KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET  optional; when set, signatures are required
 *                                            and it must be at least 32 characters
 *   (a configured secret shorter than 32 characters is treated as NOT configured:
 *   the endpoint answers 503 to everything -- see revenueCatWebhookAuth.ts, K-06)
 *   KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION  required for any grant (JSON)
 *   KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS   optional; default "production"
 */
import { handleRevenueCatWebhook } from '../_shared/revenuecat/revenueCatWebhookHandler.ts';

function envOptional(name: string): string | null {
  const value = Deno.env.get(name)?.trim();
  return value ? value : null;
}

/** The single privileged operation: a service-role call to a provider transition function. */
async function callTransitionRpc(fn: string, args: Record<string, unknown>) {
  const supabaseUrl = envOptional('SUPABASE_URL');
  const serviceRoleKey = envOptional('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) throw new Error('database credentials are not configured');
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON answer is reported as a failed call, never parsed further.
  }
  return { ok: response.ok, status: response.status, body };
}

Deno.serve((req) =>
  handleRevenueCatWebhook(req, {
    env: envOptional,
    now: () => Date.now(),
    callRpc: callTransitionRpc,
    log: (event, fields) => console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields })),
    alert: (event, fields) =>
      console.error(JSON.stringify({
        severity: 'alert',
        event: event.startsWith('ALERT') ? event : `ALERT_${event}`,
        ts: new Date().toISOString(),
        ...fields,
      })),
  })
);
