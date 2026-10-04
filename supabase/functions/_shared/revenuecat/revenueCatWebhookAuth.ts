/**
 * RevenueCat webhook authentication (Build 35 Phase C).
 *
 * RevenueCat's documented webhook authentication, as of 2026-10-02
 * (https://www.revenuecat.com/docs/integrations/webhooks):
 *
 *   1. AUTHORIZATION HEADER -- an optional value configured in the RevenueCat
 *      dashboard, sent verbatim as the `Authorization` header on every delivery.
 *      A shared secret in a header: it proves the caller knows the secret, and
 *      nothing about the body.
 *   2. HMAC-SHA256 SIGNING -- optional. When enabled, each delivery carries
 *        X-RevenueCat-Webhook-Signature: t=<unix_timestamp>,v1=<hmac_sha256_hex>
 *      where the HMAC is over  "<timestamp>.<raw_json_body>"  keyed by a signing
 *      secret that the dashboard shows once. It binds the body and a timestamp.
 *      There is no IP allowlist.
 *
 * Policy implemented here -- the strongest the provider supports, fail closed:
 *   - The Authorization secret is REQUIRED. Unset => the endpoint is not
 *     configured and refuses everything (it is never open by omission).
 *   - If a signing secret is ALSO configured, a valid signature is REQUIRED on
 *     top: a missing, malformed, stale or wrong signature is rejected.
 *   - If no signing secret is configured the signature header is ignored (it
 *     cannot be verified), and the Authorization secret is the whole boundary.
 *     The owner enables signing in the dashboard AND sets the secret to move up.
 *
 * VERIFY BEFORE RELYING ON IT: the signature format above was read from the
 * provider's documentation; no live RevenueCat delivery was available in this
 * phase, so the HMAC path is proven only against that documented format. Confirm
 * it with a dashboard TEST event before enabling signing in production.
 *
 * Secrets are server-only (Edge Function secrets). They are never logged, never
 * echoed, and compared in constant time.
 */

export const REVENUECAT_WEBHOOK_AUTHORIZATION_ENV = 'KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION' as const;
export const REVENUECAT_WEBHOOK_SIGNING_SECRET_ENV = 'KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET' as const;
export const REVENUECAT_WEBHOOK_SIGNATURE_HEADER = 'x-revenuecat-webhook-signature' as const;
export const REVENUECAT_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

export type RevenueCatWebhookAuthResult =
  | { ok: true; signatureVerified: boolean }
  | { ok: false; reason: 'not_configured' | 'missing_authorization' | 'invalid_authorization' | 'signature_required' | 'invalid_signature' | 'stale_signature' };

const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** Constant-time string equality: compares fixed-length digests, so neither the
 *  length nor the first differing byte of the secret is observable. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i += 1) diff |= da[i] ^ db[i];
  return diff === 0;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computeRevenueCatWebhookSignature(secret: string, timestamp: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)));
}

function parseSignatureHeader(header: string): { t: string; v1: string } | null {
  let t: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index < 1) return null;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name === 't') t = value;
    else if (name === 'v1') v1 = value;
  }
  if (!t || !v1 || !/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) return null;
  return { t, v1 };
}

export async function verifyRevenueCatWebhook(params: {
  headers: Headers;
  rawBody: string;
  authorizationSecret: string | null;
  signingSecret: string | null;
  nowMs: number;
}): Promise<RevenueCatWebhookAuthResult> {
  const { headers, rawBody, authorizationSecret, signingSecret, nowMs } = params;
  if (!authorizationSecret) return { ok: false, reason: 'not_configured' };

  const presented = headers.get('authorization');
  if (presented === null || presented === '') return { ok: false, reason: 'missing_authorization' };
  if (!(await constantTimeEqual(presented, authorizationSecret))) return { ok: false, reason: 'invalid_authorization' };

  if (!signingSecret) return { ok: true, signatureVerified: false };

  const header = headers.get(REVENUECAT_WEBHOOK_SIGNATURE_HEADER);
  if (header === null || header === '') return { ok: false, reason: 'signature_required' };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'invalid_signature' };

  const expected = await computeRevenueCatWebhookSignature(signingSecret, parsed.t, rawBody);
  if (!(await constantTimeEqual(parsed.v1, expected))) return { ok: false, reason: 'invalid_signature' };

  const ageSeconds = Math.abs(nowMs / 1000 - Number(parsed.t));
  if (!(ageSeconds <= REVENUECAT_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS)) return { ok: false, reason: 'stale_signature' };
  return { ok: true, signatureVerified: true };
}
