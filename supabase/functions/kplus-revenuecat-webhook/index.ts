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
 * file only wires the real environment, clock, logger and service-role database
 * call into it.
 *
 * Server-only configuration (Edge Function secrets; none is set by this repo):
 *   KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION   required
 *   KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET  optional; when set, signatures are required
 *   KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION  required for any grant (JSON)
 *   KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS   optional; default "production"
 */
import { alertEvent, envOptional, logEvent, rpc } from '../_shared/deletion/common.ts';
import { handleRevenueCatWebhook } from '../_shared/revenuecat/revenueCatWebhookHandler.ts';

Deno.serve((req) =>
  handleRevenueCatWebhook(req, {
    env: envOptional,
    now: () => Date.now(),
    callRpc: async (fn, args) => {
      const response = await rpc(fn, args);
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // A non-JSON answer is reported as a failed call, never parsed further.
      }
      return { ok: response.ok, status: response.status, body };
    },
    log: logEvent,
    alert: alertEvent,
  })
);
