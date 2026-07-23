const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');

process.env.KSCAN_EMAIL_INTERNAL_SECRET = 'test-internal-secret';
process.env.RESEND_API_KEY = 're_test_key';

const {
  RESEND_EMAILS_URL,
  ACCOUNT_DELETION_RESTORATION_EVENT,
  ACCOUNT_DELETION_RESTORATION_FROM,
  validateAccountDeletionRestorationRequest,
} = require('../services/transactionalEmail');
const { app } = require('../server');

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const TOKEN = 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXx';
const REQUEST = {
  eventType: ACCOUNT_DELETION_RESTORATION_EVENT,
  gracePeriodEndsAt: '2026-08-21T12:00:00.000Z',
  idempotencyKey: `deletion-restore:${REQUEST_ID}`,
  kind: 'request',
  recipientEmail: 'tester@example.com',
  requestedAt: '2026-07-22T12:00:00.000Z',
  restorationUrl: `https://kscan.app/account/restore?token=${TOKEN}`,
};

let server;
let baseUrl;
let providerCalls;
let originalFetch;

before(async () => {
  originalFetch = global.fetch;
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  global.fetch = originalFetch;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  providerCalls = [];
  process.env.KSCAN_EMAIL_INTERNAL_SECRET = 'test-internal-secret';
  process.env.RESEND_API_KEY = 're_test_key';
  global.fetch = async (url, options) => {
    if (url === RESEND_EMAILS_URL) {
      providerCalls.push({ url, options });
      return new Response(JSON.stringify({ id: 'provider-id-not-exposed' }), { status: 200 });
    }
    return originalFetch(url, options);
  };
});

async function post(body, secret = 'test-internal-secret') {
  return originalFetch(`${baseUrl}/internal/email/account-deletion-restoration`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kscan-email-secret': secret },
    body: JSON.stringify(body),
  });
}

test('accepts only the fixed account-deletion restoration contract', () => {
  assert.equal(validateAccountDeletionRestorationRequest(REQUEST).ok, true);
  assert.equal(
    validateAccountDeletionRestorationRequest({ ...REQUEST, html: '<b>x</b>' }).ok,
    false,
  );
  assert.equal(
    validateAccountDeletionRestorationRequest({ ...REQUEST, eventType: 'waitlist_welcome' }).ok,
    false,
  );
  assert.equal(
    validateAccountDeletionRestorationRequest({
      ...REQUEST,
      restorationUrl: 'https://evil.example/restore?token=abc',
    }).ok,
    false,
  );
});

test('rejects unauthorized restoration email requests before provider call', async () => {
  const missing = await originalFetch(`${baseUrl}/internal/email/account-deletion-restoration`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(REQUEST),
  });
  const invalid = await post(REQUEST, 'wrong-secret');
  assert.equal(missing.status, 401);
  assert.equal(invalid.status, 401);
  assert.equal(providerCalls.length, 0);
});

test('authorized restoration request sends privacy email with idempotency key', async () => {
  const response = await post(REQUEST);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(result, {
    status: 'sent',
    eventType: ACCOUNT_DELETION_RESTORATION_EVENT,
    kind: 'request',
    code: 'SENT',
  });
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].options.headers['Idempotency-Key'], REQUEST.idempotencyKey);
  const body = JSON.parse(providerCalls[0].options.body);
  assert.equal(body.from, ACCOUNT_DELETION_RESTORATION_FROM);
  assert.equal(body.to, REQUEST.recipientEmail);
  assert.match(body.html, /Restore my account/);
  assert.match(body.html, new RegExp(TOKEN));
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes('provider-id-not-exposed'), false);
});

test('resend uses a distinct idempotency key and still delivers', async () => {
  const resendBody = {
    ...REQUEST,
    kind: 'resend',
    idempotencyKey: `deletion-restore:${REQUEST_ID}:resend:2`,
  };
  const response = await post(resendBody);
  assert.equal(response.status, 200);
  assert.equal(providerCalls[0].options.headers['Idempotency-Key'], resendBody.idempotencyKey);
});

test('restored confirmation omits restorationUrl and does not include a token', async () => {
  const restoredBody = {
    eventType: ACCOUNT_DELETION_RESTORATION_EVENT,
    gracePeriodEndsAt: '2026-08-21T12:00:00.000Z',
    idempotencyKey: `deletion-restored:${REQUEST_ID}`,
    kind: 'restored',
    recipientEmail: 'tester@example.com',
    requestedAt: '2026-07-22T12:00:00.000Z',
  };
  const response = await post(restoredBody);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.kind, 'restored');
  const body = JSON.parse(providerCalls[0].options.body);
  assert.match(body.subject, /restored/i);
  assert.equal(body.html.includes('token='), false);
});

test('waitlist route remains unchanged and separate', async () => {
  const waitlist = await originalFetch(`${baseUrl}/internal/email/waitlist-welcome`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kscan-email-secret': 'test-internal-secret',
    },
    body: JSON.stringify({
      recipientEmail: 'tester@example.com',
      eventType: 'waitlist_welcome',
      idempotencyKey: 'waitlist:123e4567-e89b-42d3-a456-426614174000',
    }),
  });
  assert.equal(waitlist.status, 200);
  const analyze = await originalFetch(`${baseUrl}/api/analyze`, { method: 'POST' });
  assert.equal(analyze.status, 410);
});
