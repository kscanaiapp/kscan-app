const { describe, it } = require('node:test');
const assert = require('node:assert');
const { validateGlassesAnalyzeRequest } = require('../middleware/validateGlassesAnalyzeRequest');
const { mapGlassesAnalyzeError } = require('../utils/mapGlassesAnalyzeError');
const { MockGlassesAnalyzeService, RealGlassesAnalyzeService } = require('../services/glassesAnalyzeService');

function mockReq(overrides = {}) {
  return {
    method: 'POST',
    headers: {},
    body: {},
    is: (type) => type === 'application/json',
    ...overrides,
  };
}

function mockRes() {
  return {
    statusCode: 200,
    jsonBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
  };
}

function mockNext() {
  let err = null;
  const next = (e) => {
    if (e !== undefined) err = e;
  };
  next.error = () => err;
  return next;
}

describe('glasses-analyze-debug validation', () => {
  it('rejects non-POST', () => {
    const req = mockReq({ method: 'GET' });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, mockRes(), next);
    assert.strictEqual(next.error().message, 'METHOD_NOT_ALLOWED');
  });

  it('rejects missing image', () => {
    const req = mockReq({ body: {} });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, mockRes(), next);
    assert.strictEqual(next.error().message, 'MISSING_IMAGE');
  });

  it('rejects image that is not a string', () => {
    const req = mockReq({ body: { image: 12345 } });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, mockRes(), next);
    assert.strictEqual(next.error().message, 'MISSING_IMAGE');
  });

  it('rejects image that is null', () => {
    const req = mockReq({ body: { image: null } });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, mockRes(), next);
    assert.strictEqual(next.error().message, 'MISSING_IMAGE');
  });

  it('rejects non-JSON content type', () => {
    const req = mockReq({
      is: () => false,
      body: { image: 'data:image/jpeg;base64,abc' },
    });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, mockRes(), next);
    assert.strictEqual(next.error().message, 'INVALID_JSON');
  });
  it('rejects non-JPEG data URL', () => {
    const req = mockReq({ body: { image: 'data:image/png;base64,abc' } });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, mockRes(), next);
    assert.strictEqual(next.error().message, 'INVALID_IMAGE');
  });

  it('rejects oversized payload', () => {
    const huge = 'data:image/jpeg;base64,' + 'a'.repeat(8 * 1024 * 1024 + 1);
    const req = mockReq({ body: { image: huge } });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, mockRes(), next);
    assert.strictEqual(next.error().message, 'PAYLOAD_TOO_LARGE');
  });

  it('disabled by default when KSCAN_GLASSES_ANALYZE_ENABLED is not true', () => {
    delete process.env.KSCAN_GLASSES_ANALYZE_ENABLED;
    delete process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN;
    const req = mockReq({ body: { image: 'data:image/jpeg;base64,abc' } });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, mockRes(), next);
    assert.strictEqual(next.error().message, 'CONFIG_DISABLED');
  });

  it('enabled=true without token returns CONFIG_DISABLED', () => {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    delete process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN;
    const req = mockReq({ body: { image: 'data:image/jpeg;base64,abc' } });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, mockRes(), next);
    assert.strictEqual(next.error().message, 'CONFIG_DISABLED');
    delete process.env.KSCAN_GLASSES_ANALYZE_ENABLED;
  });

  it('enabled=false returns CONFIG_DISABLED', () => {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'false';
    process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN = 'secret-token';
    const req = mockReq({
      headers: { authorization: 'Bearer secret-token' },
      body: { image: 'data:image/jpeg;base64,abc' },
    });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, mockRes(), next);
    assert.strictEqual(next.error().message, 'CONFIG_DISABLED');
    delete process.env.KSCAN_GLASSES_ANALYZE_ENABLED;
    delete process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN;
  });

  it('rejects unauthorized request when token is configured', () => {
    process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN = 'secret-token';
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    const req = mockReq({
      headers: { authorization: 'Bearer wrong' },
      body: { image: 'data:image/jpeg;base64,abc' },
    });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, mockRes(), next);
    assert.strictEqual(next.error().message, 'UNAUTHORIZED');
    delete process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN;
    delete process.env.KSCAN_GLASSES_ANALYZE_ENABLED;
  });

  it('allows authorized request when token is configured', () => {
    process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN = 'secret-token';
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    const req = mockReq({
      headers: { authorization: 'Bearer secret-token' },
      body: { image: 'data:image/jpeg;base64,abc' },
    });
    const next = mockNext();
    validateGlassesAnalyzeRequest(req, mockRes(), next);
    assert.strictEqual(next.error(), null);
    delete process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN;
    delete process.env.KSCAN_GLASSES_ANALYZE_ENABLED;
  });
});

describe('glasses-analyze-debug service', () => {
  it('returns safe mock result', async () => {
    const service = new MockGlassesAnalyzeService({ model: 'mock' });
    const result = await service.analyze({ requestId: 'req-1' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.result.safeForHud, true);
    assert.strictEqual(result.meta.model, 'mock');
  });

  it('never includes base64 or data:image in response', async () => {
    const service = new MockGlassesAnalyzeService({ model: 'mock' });
    const result = await service.analyze({
      image: 'data:image/jpeg;base64,abc',
      requestId: 'req-2',
    });
    const json = JSON.stringify(result);
    assert.ok(!json.includes('base64'));
    assert.ok(!json.includes('data:image'));
  });

  it('createGlassesAnalyzeService returns mock when backendUrl is blank', () => {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    delete process.env.KSCAN_GLASSES_ANALYZE_BACKEND_URL;
    const { createGlassesAnalyzeService } = require('../services/glassesAnalyzeService');
    const service = createGlassesAnalyzeService();
    assert.ok(service instanceof MockGlassesAnalyzeService);
    delete process.env.KSCAN_GLASSES_ANALYZE_ENABLED;
  });

  it('createGlassesAnalyzeService returns disabled service when enabled is false', () => {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'false';
    process.env.KSCAN_GLASSES_ANALYZE_BACKEND_URL = 'https://example.com';
    const { createGlassesAnalyzeService, DisabledGlassesAnalyzeService } = require('../services/glassesAnalyzeService');
    const service = createGlassesAnalyzeService();
    assert.ok(service instanceof DisabledGlassesAnalyzeService);
    delete process.env.KSCAN_GLASSES_ANALYZE_ENABLED;
    delete process.env.KSCAN_GLASSES_ANALYZE_BACKEND_URL;
  });

  it('toBareBase64 strips data-URL prefix for upstream contract', () => {
    const { toBareBase64 } = require('../services/glassesAnalyzeService');
    assert.strictEqual(toBareBase64('data:image/jpeg;base64,abc123'), 'abc123');
    assert.strictEqual(toBareBase64('alreadyBare'), 'alreadyBare');
  });

  it('mock mode returns deterministic HUD-safe response', async () => {
    const service = new MockGlassesAnalyzeService({ model: 'mock-debug' });
    const result1 = await service.analyze({ requestId: 'req-d' });
    const result2 = await service.analyze({ requestId: 'req-d' });
    assert.deepStrictEqual(result1, result2);
    assert.strictEqual(result1.ok, true);
    assert.strictEqual(result1.result.safeForHud, true);
    assert.strictEqual(result1.meta.model, 'mock-debug');
  });

  it('RealGlassesAnalyzeService is never called when mock is used', async () => {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    delete process.env.KSCAN_GLASSES_ANALYZE_BACKEND_URL;
    const { createGlassesAnalyzeService } = require('../services/glassesAnalyzeService');
    const service = createGlassesAnalyzeService();
    assert.ok(!(service instanceof RealGlassesAnalyzeService));
    delete process.env.KSCAN_GLASSES_ANALYZE_ENABLED;
  });
});

describe('glasses-analyze-debug error mapping', () => {
  it('maps thrown errors to safe error response', () => {
    const err = new Error('INVALID_IMAGE');
    const safe = mapGlassesAnalyzeError(err, 'req-3');
    assert.strictEqual(safe.status, 415);
    assert.strictEqual(safe.body.error.code, 'INVALID_IMAGE');
    assert.ok(!safe.body.error.message.includes('base64'));
  });

  it('maps unknown errors to SAFE_BACKEND_FAILURE', () => {
    const err = new Error('something bad');
    const safe = mapGlassesAnalyzeError(err, 'req-4');
    assert.strictEqual(safe.status, 500);
    assert.strictEqual(safe.body.error.code, 'SAFE_BACKEND_FAILURE');
  });
});
