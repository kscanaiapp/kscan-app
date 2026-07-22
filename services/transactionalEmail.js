const crypto = require('crypto');

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const WAITLIST_WELCOME_EVENT = 'waitlist_welcome';
const WAITLIST_WELCOME_FROM = 'K Scan <hello@info.kscan.app>';
const WAITLIST_WELCOME_REPLY_TO = 'kscanai.app@gmail.com';
const WAITLIST_WELCOME_SUBJECT = "You're on the K Scan waitlist";
const WAITLIST_WELCOME_HTML = `
      <div style="margin:0;padding:32px 20px;background:#FAFAF8;color:#0F172A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <div style="max-width:560px;margin:0 auto;background:#FAFAF8;border:1px solid rgba(15,23,42,0.08);">
          <div style="height:4px;background:#B6E6EE;"></div>
          <div style="padding:40px 32px;text-align:left;">
            <p style="margin:0 0 20px;font-size:24px;line-height:1.3;font-weight:500;">You're in.</p>
            <p style="margin:0 0 16px;font-size:16px;line-height:1.7;">K Scan turns what you see into shoppable discovery.</p>
            <p style="margin:0 0 16px;font-size:16px;line-height:1.7;">We're rolling out access in small waves as we refine the experience.</p>
            <p style="margin:0 0 16px;font-size:16px;line-height:1.7;">We'll reach out when it's ready.</p>
            <p style="margin:0;font-size:16px;line-height:1.7;">K Scan AI</p>
          </div>
        </div>
      </div>
    `;

const UUID_IDEMPOTENCY_KEY = /^waitlist:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function digest(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) return false;
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

function validateWaitlistWelcomeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 'INVALID_BODY' };
  const keys = Object.keys(body).sort();
  const expected = ['eventType', 'idempotencyKey', 'recipientEmail'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return { ok: false, code: 'UNSUPPORTED_FIELDS' };
  }
  const recipientEmail = typeof body.recipientEmail === 'string' ? body.recipientEmail.trim().toLowerCase() : '';
  if (!EMAIL.test(recipientEmail) || recipientEmail.length > 254) return { ok: false, code: 'INVALID_RECIPIENT' };
  if (body.eventType !== WAITLIST_WELCOME_EVENT) return { ok: false, code: 'UNSUPPORTED_EVENT' };
  if (typeof body.idempotencyKey !== 'string' || !UUID_IDEMPOTENCY_KEY.test(body.idempotencyKey)) {
    return { ok: false, code: 'INVALID_IDEMPOTENCY_KEY' };
  }
  return { ok: true, value: { recipientEmail, eventType: body.eventType, idempotencyKey: body.idempotencyKey } };
}

function classifyProviderFailure(status, providerCode) {
  if (providerCode === 'invalid_idempotent_request') return 'failed_permanent';
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
    ? 'failed_retryable'
    : 'failed_permanent';
}

function safeProviderCode(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value) ? value : 'provider_error';
}

function auditEmailEvent({ recipientEmail, idempotencyKey, status, providerCode, durationMs }) {
  const [local = '', domain = ''] = recipientEmail.split('@');
  const maskedRecipient = `${local.slice(0, 2)}***@${domain}`;
  console.log('[email] waitlist welcome', {
    eventType: WAITLIST_WELCOME_EVENT,
    recipient: maskedRecipient,
    requestHash: crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12),
    status,
    providerCode: providerCode || null,
    durationMs,
  });
}

async function sendWaitlistWelcomeEmail({ recipientEmail, idempotencyKey, fetchImpl = global.fetch }) {
  const startedAt = Date.now();
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { status: 'failed_retryable', code: 'PROVIDER_NOT_CONFIGURED' };

  try {
    const response = await fetchImpl(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        from: process.env.KSCAN_EMAIL_FROM || WAITLIST_WELCOME_FROM,
        to: recipientEmail,
        reply_to: process.env.KSCAN_EMAIL_REPLY_TO || WAITLIST_WELCOME_REPLY_TO,
        subject: WAITLIST_WELCOME_SUBJECT,
        html: WAITLIST_WELCOME_HTML,
      }),
    });
    if (response.ok) {
      auditEmailEvent({ recipientEmail, idempotencyKey, status: 'sent', durationMs: Date.now() - startedAt });
      return { status: 'sent', code: 'SENT' };
    }
    let providerCode = 'provider_error';
    try {
      const result = await response.json();
      providerCode = safeProviderCode(result?.name || result?.code);
    } catch {}
    const status = classifyProviderFailure(response.status, providerCode);
    auditEmailEvent({ recipientEmail, idempotencyKey, status, providerCode, durationMs: Date.now() - startedAt });
    return { status, code: providerCode };
  } catch {
    auditEmailEvent({ recipientEmail, idempotencyKey, status: 'failed_retryable', providerCode: 'network_error', durationMs: Date.now() - startedAt });
    return { status: 'failed_retryable', code: 'network_error' };
  }
}

module.exports = {
  RESEND_EMAILS_URL,
  WAITLIST_WELCOME_EVENT,
  WAITLIST_WELCOME_FROM,
  WAITLIST_WELCOME_REPLY_TO,
  WAITLIST_WELCOME_SUBJECT,
  WAITLIST_WELCOME_HTML,
  secretsMatch,
  validateWaitlistWelcomeRequest,
  classifyProviderFailure,
  sendWaitlistWelcomeEmail,
};
