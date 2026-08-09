const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');

process.env.KSCAN_EMAIL_INTERNAL_SECRET = 'test-internal-secret';
process.env.RESEND_API_KEY = 're_test_key';

const {
  RESEND_EMAILS_URL,
  WAITLIST_WELCOME_FROM,
  WAITLIST_WELCOME_REPLY_TO,
  WAITLIST_WELCOME_SUBJECT,
  WAITLIST_WELCOME_HTML,
  validateWaitlistWelcomeRequest,
} = require('../services/transactionalEmail');
const { app } = require('../server');

const REQUEST = {
  recipientEmail: 'tester@example.com',
  eventType: 'waitlist_welcome',
  idempotencyKey: 'waitlist:123e4567-e89b-42d3-a456-426614174000',
};

let server;
let baseUrl;
let providerCalls;
let originalFetch;

before(async () => {
  originalFetch = global.fetch;
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
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
  return originalFetch(`${baseUrl}/internal/email/waitlist-welcome`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kscan-email-secret': secret },
    body: JSON.stringify(body),
  });
}

test('recovers the exact approved Resend sender, subject, and template', () => {
  assert.equal(WAITLIST_WELCOME_FROM, 'K Scan <hello@info.kscan.app>');
  assert.equal(WAITLIST_WELCOME_REPLY_TO, 'kscanai.app@gmail.com');
  assert.equal(WAITLIST_WELCOME_SUBJECT, "You're on the K Scan waitlist");
  assert.match(WAITLIST_WELCOME_HTML, /You're in\./);
  assert.match(WAITLIST_WELCOME_HTML, /K Scan turns what you see into shoppable discovery\./);
  assert.match(WAITLIST_WELCOME_HTML, /rolling out access in small waves/);
  assert.match(WAITLIST_WELCOME_HTML, /We'll reach out when it's ready\./);
});

test('accepts only the fixed event contract and rejects template injection', () => {
  assert.equal(validateWaitlistWelcomeRequest(REQUEST).ok, true);
  assert.deepEqual(validateWaitlistWelcomeRequest({ ...REQUEST, html: '<b>override</b>' }), { ok: false, code: 'UNSUPPORTED_FIELDS' });
  assert.equal(validateWaitlistWelcomeRequest({ ...REQUEST, eventType: 'search' }).ok, false);
  assert.equal(validateWaitlistWelcomeRequest({ ...REQUEST, recipientEmail: 'not-an-email' }).ok, false);
});

test('rejects missing or invalid server secret before provider invocation', async () => {
  const missing = await originalFetch(`${baseUrl}/internal/email/waitlist-welcome`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(REQUEST),
  });
  const invalid = await post(REQUEST, 'wrong-secret');
  assert.equal(missing.status, 401);
  assert.equal(invalid.status, 401);
  assert.equal(providerCalls.length, 0);
});

test('authorized request sends fixed welcome email with provider idempotency', async () => {
  const response = await post(REQUEST);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(result, { status: 'sent', eventType: 'waitlist_welcome', code: 'SENT' });
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].options.headers['Idempotency-Key'], REQUEST.idempotencyKey);
  assert.deepEqual(JSON.parse(providerCalls[0].options.body), {
    from: WAITLIST_WELCOME_FROM, to: REQUEST.recipientEmail, reply_to: WAITLIST_WELCOME_REPLY_TO,
    subject: WAITLIST_WELCOME_SUBJECT, html: WAITLIST_WELCOME_HTML,
  });
  assert.equal(JSON.stringify(result).includes('provider-id-not-exposed'), false);
});

test('same idempotency key cannot create a second provider delivery', async () => {
  const delivered = new Set();
  let deliveries = 0;
  global.fetch = async (url, options) => {
    if (url !== RESEND_EMAILS_URL) return originalFetch(url, options);
    providerCalls.push({ url, options });
    const key = options.headers['Idempotency-Key'];
    if (!delivered.has(key)) { delivered.add(key); deliveries += 1; }
    return new Response(JSON.stringify({ id: 'same-provider-result' }), { status: 200 });
  };
  assert.equal((await post(REQUEST)).status, 200);
  assert.equal((await post(REQUEST)).status, 200);
  assert.equal(providerCalls.length, 2);
  assert.equal(deliveries, 1);
});

test('provider failures are classified without exposing provider response bodies', async () => {
  global.fetch = async (url) => {
    if (url !== RESEND_EMAILS_URL) return originalFetch(url);
    return new Response(JSON.stringify({ name: 'rate_limit_exceeded', message: 'sensitive provider detail' }), { status: 429 });
  };
  const retryable = await post(REQUEST);
  assert.equal(retryable.status, 503);
  assert.deepEqual(await retryable.json(), {
    status: 'failed_retryable', eventType: 'waitlist_welcome', code: 'rate_limit_exceeded',
  });

  global.fetch = async (url) => {
    if (url !== RESEND_EMAILS_URL) return originalFetch(url);
    return new Response(JSON.stringify({ name: 'validation_error', message: 'sensitive provider detail' }), { status: 400 });
  };
  const permanent = await post(REQUEST);
  assert.equal(permanent.status, 422);
  assert.deepEqual(await permanent.json(), {
    status: 'failed_permanent', eventType: 'waitlist_welcome', code: 'validation_error',
  });
});

test('audit log excludes full recipient, secret, provider payload, and template', async () => {
  const entries = [];
  const originalLog = console.log;
  console.log = (...args) => entries.push(args);
  try {
    assert.equal((await post(REQUEST)).status, 200);
  } finally {
    console.log = originalLog;
  }
  const logged = JSON.stringify(entries);
  assert.equal(logged.includes(REQUEST.recipientEmail), false);
  assert.equal(logged.includes('test-internal-secret'), false);
  assert.equal(logged.includes('provider-id-not-exposed'), false);
  assert.equal(logged.includes("You're in."), false);
});

test('retired public analysis route remains a body-blind tombstone', async () => {
  const response = await originalFetch(`${baseUrl}/api/analyze`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'must not be processed' }),
  });
  assert.equal(response.status, 410);
  assert.equal(providerCalls.length, 0);
});

test('legacy catalog retrieval is also disabled', async () => {
  const response = await originalFetch(`${baseUrl}/catalog-images/example.jpg`);
  assert.equal(response.status, 410);
  assert.equal(providerCalls.length, 0);
});
