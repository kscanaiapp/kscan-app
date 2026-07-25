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
 * Ordering (P2-7): rotate the stored token hash FIRST, then send. This
 * guarantees the invariant that matters most -- a restoration link that is
 * actually delivered always resolves to a stored hash. (The previous
 * send-first ordering could deliver an email whose token was never persisted
 * if the rotate RPC failed afterward, producing a link that never works.)
 * The accepted tradeoff is that a rotate-succeeds/send-fails case supersedes
 * the prior link without delivering a new one; the account is never
 * permanently stranded because a subsequent resend rotates and sends again.
 *
 * Timing (P1-8): the matched path does strictly more work (rotate RPC + email
 * send) than the unmatched path, which leaked -- via response latency --
 * whether an eligible deletion request existed for a given email. Mitigations:
 * the token generate+hash CPU work runs on BOTH paths, and every response is
 * padded to a fixed floor so the fast (unmatched) path cannot return
 * observably sooner. This does not achieve true constant time over a network
 * email call; residual timing variance is documented as an accepted low
 * (P3-level) risk.
 */

const GENERIC = {
  status: 'ok',
  message:
    'If an eligible deletion request exists for that email, a restoration message has been sent.',
};

// Response-time floor. Chosen to comfortably exceed the typical matched-path
// duration (rotate RPC + Render email call) so the unmatched path cannot
// return sooner and act as an existence oracle.
const MIN_RESPONSE_MS = 900;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || !trimmed.includes('@') || trimmed.length > 320) return null;
  return trimmed;
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  const respond = async (payload: unknown, status = 200) => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_RESPONSE_MS) await sleep(MIN_RESPONSE_MS - elapsed);
    return json(payload, status);
  };

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body?.email);

    // Do the token crypto work unconditionally so the matched and unmatched
    // paths perform comparable CPU work (part of the P1-8 mitigation).
    const rawToken = generateRestorationToken();
    const tokenHash = await hashRestorationToken(rawToken);

    if (!email) {
      return respond(GENERIC);
    }

    // Peek eligibility without mutating anything.
    const peekResponse = await rpc('peek_restoration_resend_by_email', {
      p_email: email,
    });
    if (!peekResponse.ok) {
      logEvent('resend_peek_rpc_failed', { status: peekResponse.status });
      return respond(GENERIC);
    }

    const peekRows = await peekResponse.json();
    const peek = Array.isArray(peekRows) ? peekRows[0] : null;
    if (!peek?.matched) {
      return respond(GENERIC);
    }

    const nextCount = Number(peek.email_count ?? 0) + 1;

    // Rotate-first: persist the new hash before sending so a delivered link
    // is always backed by a stored hash.
    const rotateResponse = await rpc('rotate_restoration_token_by_email', {
      p_email: email,
      p_token_hash: tokenHash,
    });
    if (!rotateResponse.ok) {
      logEvent('resend_rotate_failed_before_send', {
        status: rotateResponse.status,
        requestIdPrefix: String(peek.request_id ?? '').slice(0, 8),
      });
      return respond(GENERIC);
    }

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
      // The stored hash was already rotated to this (undelivered) token, so
      // the prior link is now superseded. This is alertable: the user asked
      // for a link and did not get one. Recovery path is another resend.
      logEvent('ALERT_resend_email_failed_after_rotate', {
        requestIdPrefix: String(peek.request_id ?? '').slice(0, 8),
        emailCount: nextCount,
      });
      return respond(GENERIC);
    }

    logEvent('resend_restoration_email_attempted', {
      requestIdPrefix: String(peek.request_id ?? '').slice(0, 8),
      emailCount: nextCount,
    });

    return respond(GENERIC);
  } catch (error) {
    if (error instanceof Response) return error;
    logEvent('resend_unexpected_error', {
      type: error instanceof Error ? error.name : 'unknown',
    });
    return respond(GENERIC);
  }
});
