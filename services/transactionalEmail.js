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

const ACCOUNT_DELETION_RESTORATION_EVENT = 'account_deletion_restoration';
const ACCOUNT_DELETION_RESTORATION_FROM = 'K Scan AI <hello@info.kscan.app>';
const ACCOUNT_DELETION_RESTORATION_REPLY_TO = 'kscanai.app@gmail.com';
const ACCOUNT_DELETION_KINDS = new Set(['request', 'resend', 'restored']);

const UUID_IDEMPOTENCY_KEY = /^waitlist:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DELETION_IDEMPOTENCY_KEY =
  /^deletion-(?:restore|restored):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?::(?:resend:\d+|v\d+))?$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const RESTORATION_URL =
  /^https:\/\/(?:www\.)?kscan\.app\/account\/restore\?token=[A-Za-z0-9_-]{32,256}$/;

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

function validateAccountDeletionRestorationRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 'INVALID_BODY' };

  const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
  if (!ACCOUNT_DELETION_KINDS.has(kind)) return { ok: false, code: 'INVALID_KIND' };

  const allowed =
    kind === 'restored'
      ? ['eventType', 'gracePeriodEndsAt', 'idempotencyKey', 'kind', 'recipientEmail', 'requestedAt']
      : [
          'eventType',
          'gracePeriodEndsAt',
          'idempotencyKey',
          'kind',
          'recipientEmail',
          'requestedAt',
          'restorationUrl',
        ];

  const keys = Object.keys(body).sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    return { ok: false, code: 'UNSUPPORTED_FIELDS' };
  }

  const recipientEmail = typeof body.recipientEmail === 'string' ? body.recipientEmail.trim().toLowerCase() : '';
  if (!EMAIL.test(recipientEmail) || recipientEmail.length > 254) return { ok: false, code: 'INVALID_RECIPIENT' };
  if (body.eventType !== ACCOUNT_DELETION_RESTORATION_EVENT) return { ok: false, code: 'UNSUPPORTED_EVENT' };
  if (typeof body.idempotencyKey !== 'string' || !DELETION_IDEMPOTENCY_KEY.test(body.idempotencyKey)) {
    return { ok: false, code: 'INVALID_IDEMPOTENCY_KEY' };
  }
  if (typeof body.requestedAt !== 'string' || !ISO_TIMESTAMP.test(body.requestedAt)) {
    return { ok: false, code: 'INVALID_REQUESTED_AT' };
  }
  if (typeof body.gracePeriodEndsAt !== 'string' || !ISO_TIMESTAMP.test(body.gracePeriodEndsAt)) {
    return { ok: false, code: 'INVALID_GRACE_PERIOD' };
  }

  let restorationUrl = null;
  if (kind !== 'restored') {
    if (typeof body.restorationUrl !== 'string' || !RESTORATION_URL.test(body.restorationUrl)) {
      return { ok: false, code: 'INVALID_RESTORATION_URL' };
    }
    restorationUrl = body.restorationUrl;
  }

  return {
    ok: true,
    value: {
      recipientEmail,
      eventType: body.eventType,
      idempotencyKey: body.idempotencyKey,
      kind,
      requestedAt: body.requestedAt,
      gracePeriodEndsAt: body.gracePeriodEndsAt,
      restorationUrl,
    },
  };
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

function auditEmailEvent({ eventType, recipientEmail, idempotencyKey, status, providerCode, durationMs, kind }) {
  const [local = '', domain = ''] = recipientEmail.split('@');
  const maskedRecipient = `${local.slice(0, 2)}***@${domain}`;
  console.log('[email]', eventType, {
    eventType,
    kind: kind || null,
    recipient: maskedRecipient,
    requestHash: crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12),
    status,
    providerCode: providerCode || null,
    durationMs,
  });
}

function buildRestorationHtml({ kind, requestedAt, gracePeriodEndsAt, restorationUrl }) {
  const permanentDate = new Date(gracePeriodEndsAt).toUTCString();
  const requestedDate = new Date(requestedAt).toUTCString();

  if (kind === 'restored') {
    return {
      subject: 'Your K Scan AI account has been restored',
      html: `
      <div style="margin:0;padding:32px 20px;background:#0B0B0F;color:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <div style="max-width:560px;margin:0 auto;border:1px solid rgba(248,250,252,0.12);">
          <div style="height:4px;background:#22D3EE;"></div>
          <div style="padding:40px 32px;">
            <p style="margin:0 0 16px;font-size:22px;line-height:1.3;">Your account has been restored</p>
            <p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:#CBD5E1;">You can sign in again and use K Scan normally.</p>
            <p style="margin:0;font-size:14px;line-height:1.7;color:#94A3B8;">If you did not request this restoration, contact support at https://kscan.app/support.</p>
          </div>
        </div>
      </div>
    `,
    };
  }

  const intro =
    kind === 'resend'
      ? 'Here is a new single-use restoration link for your K Scan AI account.'
      : 'We received your account deletion request.';

  return {
    subject: 'Restore your K Scan AI account within 30 days',
    html: `
      <div style="margin:0;padding:32px 20px;background:#0B0B0F;color:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <div style="max-width:560px;margin:0 auto;border:1px solid rgba(248,250,252,0.12);">
          <div style="height:4px;background:#22D3EE;"></div>
          <div style="padding:40px 32px;">
            <p style="margin:0 0 16px;font-size:22px;line-height:1.3;">Restore your account</p>
            <p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:#CBD5E1;">${intro}</p>
            <p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:#CBD5E1;">Requested on <strong>${requestedDate}</strong>. Cloud data is preserved until <strong>${permanentDate}</strong>.</p>
            <p style="margin:0 0 24px;font-size:16px;line-height:1.7;color:#CBD5E1;">Your account is deactivated. Shared Dressing Rooms may remain available to other participants during this window.</p>
            <p style="margin:0 0 24px;"><a href="${restorationUrl}" style="display:inline-block;padding:12px 20px;background:#22D3EE;color:#0B0B0F;text-decoration:none;font-weight:600;">Restore my account</a></p>
            <p style="margin:0;font-size:14px;line-height:1.7;color:#94A3B8;">This link works once and expires at the permanent-deletion date. If you did not request deletion, restore immediately and contact https://kscan.app/support.</p>
          </div>
        </div>
      </div>
    `,
  };
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
      auditEmailEvent({
        eventType: WAITLIST_WELCOME_EVENT,
        recipientEmail,
        idempotencyKey,
        status: 'sent',
        durationMs: Date.now() - startedAt,
      });
      return { status: 'sent', code: 'SENT' };
    }
    let providerCode = 'provider_error';
    try {
      const result = await response.json();
      providerCode = safeProviderCode(result?.name || result?.code);
    } catch {}
    const status = classifyProviderFailure(response.status, providerCode);
    auditEmailEvent({
      eventType: WAITLIST_WELCOME_EVENT,
      recipientEmail,
      idempotencyKey,
      status,
      providerCode,
      durationMs: Date.now() - startedAt,
    });
    return { status, code: providerCode };
  } catch {
    auditEmailEvent({
      eventType: WAITLIST_WELCOME_EVENT,
      recipientEmail,
      idempotencyKey,
      status: 'failed_retryable',
      providerCode: 'network_error',
      durationMs: Date.now() - startedAt,
    });
    return { status: 'failed_retryable', code: 'network_error' };
  }
}

async function sendAccountDeletionRestorationEmail({
  recipientEmail,
  idempotencyKey,
  kind,
  requestedAt,
  gracePeriodEndsAt,
  restorationUrl,
  fetchImpl = global.fetch,
}) {
  const startedAt = Date.now();
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { status: 'failed_retryable', code: 'PROVIDER_NOT_CONFIGURED' };

  const { subject, html } = buildRestorationHtml({
    kind,
    requestedAt,
    gracePeriodEndsAt,
    restorationUrl,
  });

  try {
    const response = await fetchImpl(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        from: process.env.KSCAN_EMAIL_PRIVACY_FROM || ACCOUNT_DELETION_RESTORATION_FROM,
        to: recipientEmail,
        reply_to: process.env.KSCAN_EMAIL_REPLY_TO || ACCOUNT_DELETION_RESTORATION_REPLY_TO,
        subject,
        html,
      }),
    });
    if (response.ok) {
      auditEmailEvent({
        eventType: ACCOUNT_DELETION_RESTORATION_EVENT,
        recipientEmail,
        idempotencyKey,
        status: 'sent',
        durationMs: Date.now() - startedAt,
        kind,
      });
      return { status: 'sent', code: 'SENT' };
    }
    let providerCode = 'provider_error';
    try {
      const result = await response.json();
      providerCode = safeProviderCode(result?.name || result?.code);
    } catch {}
    const status = classifyProviderFailure(response.status, providerCode);
    auditEmailEvent({
      eventType: ACCOUNT_DELETION_RESTORATION_EVENT,
      recipientEmail,
      idempotencyKey,
      status,
      providerCode,
      durationMs: Date.now() - startedAt,
      kind,
    });
    return { status, code: providerCode };
  } catch {
    auditEmailEvent({
      eventType: ACCOUNT_DELETION_RESTORATION_EVENT,
      recipientEmail,
      idempotencyKey,
      status: 'failed_retryable',
      providerCode: 'network_error',
      durationMs: Date.now() - startedAt,
      kind,
    });
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
  ACCOUNT_DELETION_RESTORATION_EVENT,
  ACCOUNT_DELETION_RESTORATION_FROM,
  ACCOUNT_DELETION_RESTORATION_REPLY_TO,
  secretsMatch,
  validateWaitlistWelcomeRequest,
  validateAccountDeletionRestorationRequest,
  classifyProviderFailure,
  sendWaitlistWelcomeEmail,
  sendAccountDeletionRestorationEmail,
  buildRestorationHtml,
};
