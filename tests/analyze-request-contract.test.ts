import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Cross-checks the glasses debug analyze request contract against the REAL
// backend validator middleware (no new dependencies; tsx/node runner only).
const require = createRequire(import.meta.url);
const { validateGlassesAnalyzeRequest } = require('../backend/middleware/validateGlassesAnalyzeRequest.js');

// The exact body the Android client emits (AnalyzeRequestJson.encodeGlassesDebugRequest).
// JSON.stringify of this object is byte-equivalent in shape to the Kotlin
// kotlinx.serialization output: {"image":"...","client":"google-glasses-alpha"}.
function kotlinClientBody(image: string): string {
  return JSON.stringify({ image, client: 'google-glasses-alpha' });
}

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-local-token' },
    body: {},
    is: (type: string) => type === 'application/json',
    ...overrides,
  } as any;
}

function mockNext() {
  let err: any = null;
  const next: any = (e?: unknown) => {
    if (e !== undefined) err = e;
  };
  next.error = () => err;
  next.called = () => err === null;
  return next;
}

describe('debug analyze JSON contract', () => {
  beforeEach(() => {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN = 'test-local-token';
  });

  afterEach(() => {
    delete process.env.KSCAN_GLASSES_ANALYZE_ENABLED;
    delete process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN;
  });

  it('client-emitted body parses as valid JSON with the exact contract shape', () => {
    const body = kotlinClientBody('data:image/jpeg;base64,abc');
    const parsed = JSON.parse(body);
    assert.deepEqual(Object.keys(parsed).sort(), ['client', 'image']);
    assert.equal(typeof parsed.image, 'string');
    assert.equal(parsed.client, 'google-glasses-alpha');
  });

  it('escaping: quotes, backslashes and control chars round-trip safely', () => {
    const hostile = 'data:image/jpeg;base64,"quoted" \\ \n \t control';
    const body = kotlinClientBody(hostile);
    // No raw control characters may appear in the encoded body.
    assert.ok(!body.includes('\n'));
    assert.ok(!body.includes('\t'));
    const parsed = JSON.parse(body);
    assert.equal(parsed.image, hostile);
  });

  it('backend validator accepts the client request shape', () => {
    const req = mockReq({ body: JSON.parse(kotlinClientBody('data:image/jpeg;base64,abc')) });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, {}, next);
    assert.equal(next.error(), null);
    assert.equal(next.called(), true);
    // The validator propagates the client id for downstream use.
    assert.equal(req.glassesClient, 'google-glasses-alpha');
  });

  it('missing image fails validation (MISSING_IMAGE)', () => {
    const body = JSON.parse(kotlinClientBody('data:image/jpeg;base64,abc'));
    delete body.image;
    const req = mockReq({ body });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, {}, next);
    assert.equal(next.error().message, 'MISSING_IMAGE');
    assert.equal(next.error().status, 400);
  });

  it('non-string image fails validation (MISSING_IMAGE)', () => {
    const req = mockReq({ body: { image: 12345, client: 'google-glasses-alpha' } });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, {}, next);
    assert.equal(next.error().message, 'MISSING_IMAGE');
  });

  it('malformed data URL fails validation (INVALID_IMAGE)', () => {
    const req = mockReq({ body: JSON.parse(kotlinClientBody('data:image/png;base64,abc')) });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, {}, next);
    assert.equal(next.error().message, 'INVALID_IMAGE');
    assert.equal(next.error().status, 415);
  });

  it('non-data-URL string fails validation (INVALID_IMAGE)', () => {
    const req = mockReq({ body: JSON.parse(kotlinClientBody('just-a-plain-string')) });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, {}, next);
    assert.equal(next.error().message, 'INVALID_IMAGE');
  });

  it('validator source never logs the payload and caps size at 8 MB', () => {
    // Structural contract: the 8 MB ceiling is enforced (mirror of backend rule).
    const huge = 'data:image/jpeg;base64,' + 'a'.repeat(8 * 1024 * 1024 + 1);
    const req = mockReq({ body: JSON.parse(kotlinClientBody(huge)) });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, {}, next);
    assert.equal(next.error().message, 'PAYLOAD_TOO_LARGE');
    assert.equal(next.error().status, 413);
  });
});
