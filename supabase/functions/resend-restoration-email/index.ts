import {
  buildRestorationUrl,
  corsHeaders,
  generateRestorationToken,
  hashRestorationToken,
  json,
  logEvent,
  rpc,
  sendRestorationEmail,
} from '../_shared/deletion/common.ts';

/**
 * Account-enumeration-safe restoration email resend.
 * Always returns a generic success payload regardless of account existence.
 */

const GENERIC = {
  status: 'ok',
  message:
    'If an eligible deletion request exists for that email, a restoration message has been sent.',
};

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || !trimmed.includes('@') || trimmed.length > 320) return null;
  return trimmed;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body?.email);
    if (!email) {
      return json(GENERIC);
    }

    const rawToken = generateRestorationToken();
    const tokenHash = await hashRestorationToken(rawToken);

    const rotateResponse = await rpc('rotate_restoration_token_by_email', {
      p_email: email,
      p_token_hash: tokenHash,
    });

    if (!rotateResponse.ok) {
      logEvent('resend_rotate_rpc_failed', { status: rotateResponse.status });
      return json(GENERIC);
    }

    const rows = await rotateResponse.json();
    const match = Array.isArray(rows) ? rows[0] : null;
    if (!match?.matched) {
      return json(GENERIC);
    }

    await sendRestorationEmail({
      to: email,
      requestId: String(match.request_id),
      requestedAt: match.requested_at,
      gracePeriodEndsAt: match.grace_period_ends_at,
      restorationUrl: buildRestorationUrl(rawToken),
      kind: 'resend',
      emailCount: Number(match.email_count ?? 1),
    });

    logEvent('resend_restoration_email_attempted', {
      requestIdPrefix: String(match.request_id ?? '').slice(0, 8),
      emailCount: match.email_count,
    });

    return json(GENERIC);
  } catch (error) {
    if (error instanceof Response) return error;
    logEvent('resend_unexpected_error', {
      type: error instanceof Error ? error.name : 'unknown',
    });
    return json(GENERIC);
  }
});
