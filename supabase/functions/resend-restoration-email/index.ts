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
 *
 * Order: send email first, then rotate token hash so a failed send does not
 * invalidate the previous working link.
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

    // Peek eligibility without rotating yet.
    const peekResponse = await rpc('peek_restoration_resend_by_email', {
      p_email: email,
    });

    if (!peekResponse.ok) {
      // Fallback: if peek RPC missing, keep prior rotate-first behavior unavailable —
      // fail closed to generic response.
      logEvent('resend_peek_rpc_failed', { status: peekResponse.status });
      return json(GENERIC);
    }

    const peekRows = await peekResponse.json();
    const peek = Array.isArray(peekRows) ? peekRows[0] : null;
    if (!peek?.matched) {
      return json(GENERIC);
    }

    const rawToken = generateRestorationToken();
    const tokenHash = await hashRestorationToken(rawToken);
    const nextCount = Number(peek.email_count ?? 0) + 1;

    const emailResult = await sendRestorationEmail({
      to: email,
      requestId: String(peek.request_id),
      requestedAt: peek.requested_at,
      gracePeriodEndsAt: peek.grace_period_ends_at,
      restorationUrl: buildRestorationUrl(rawToken),
      kind: 'resend',
      emailCount: nextCount,
    });

    if (!emailResult.queued) {
      logEvent('resend_email_failed_token_not_rotated', {
        requestIdPrefix: String(peek.request_id ?? '').slice(0, 8),
      });
      return json(GENERIC);
    }

    const rotateResponse = await rpc('rotate_restoration_token_by_email', {
      p_email: email,
      p_token_hash: tokenHash,
    });

    if (!rotateResponse.ok) {
      logEvent('resend_rotate_after_send_failed', { status: rotateResponse.status });
      // Email already sent with token that is not yet hashed — emergency rotate retry.
      await rpc('rotate_restoration_token_by_email', {
        p_email: email,
        p_token_hash: tokenHash,
      });
    }

    logEvent('resend_restoration_email_attempted', {
      requestIdPrefix: String(peek.request_id ?? '').slice(0, 8),
      emailCount: nextCount,
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
